import type { FetchLike, AuthProvider } from "@modelcontextprotocol/client";
import type { Logger, McpOAuthConfig } from "@nibi/contracts";
import type { SharedNibiCredentialStore } from "../auth/shared-credentials.js";
import { isCanonicalTokenNearExpiry, loadCredentialPair } from "./oauth-credentials.js";
import { createInteractiveAuthorizationRequiredError } from "./oauth-errors.js";
import { refreshMcpOAuthTokensUnderLock } from "./oauth-refresh.js";

type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

export interface CreateMcpOAuthTokenProviderInput {
  config: McpAuthorizationCodeOAuthConfig;
  credentialStore: SharedNibiCredentialStore;
  fetchFn?: FetchLike;
  keyPrefix: string;
  logger?: Logger;
  serverName: string;
  serverUrl: string;
}

/**
 * Phase 1 运行期 AuthProvider。
 *
 * 只实现 `token()` 与 `onUnauthorized()`，**不是** `OAuthClientProvider`：transport 的
 * `isOAuthClientProvider()` 判定因此为 false，`_oauthProvider` 保持为空
 * （client@2.0.0 `index.mjs:4977-4980`），于是：
 *
 * - 建连不做 discovery、不做 DCR、不开 callback listener；
 * - 401 只调用我们的 `onUnauthorized()` 并自动重试一次，SDK 的 `auth()` 完全不参与，
 *   所有 refresh 都被强制汇入我们的跨进程单飞锁。
 *
 * 绝不要把 `OAuthClientProvider` 传给运行期 transport：它会被 `adaptOAuthProvider` 包裹，
 * 401 走 SDK 的 `handleOAuthUnauthorized()` → `auth()`，绕过 refresh 锁，并发刷新问题立即复发。
 */
export function createMcpOAuthTokenProvider(
  input: CreateMcpOAuthTokenProviderInput,
): AuthProvider {
  const refreshInput = {
    credentialStore: input.credentialStore,
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    keyPrefix: input.keyPrefix,
    ...(input.logger ? { logger: input.logger } : {}),
    serverName: input.serverName,
    serverUrl: input.serverUrl,
    ...(input.config.clientId ? { staticClientId: input.config.clientId } : {}),
  };

  // 401 钩子只知道「某个请求被拒」，不知道那个请求带的是哪个 token。跨进程并发下这会让
  // follower 把 leader 刚发布的凭据误当成被拒的凭据：请求发出时还没有 token（无认证 401），
  // 等 onUnauthorized 读凭据时 leader 已经发布，于是它刷新的是一枚从未被资源服务器拒绝的
  // refresh token。这会多换一次代；在 rotation 严格、资源服务器对 token 有额外绑定
  // （本测试的严格假服务器只认授权码换来的那一枚）的场景下，重试会继续被拒（实测另一侧
  // 重连报 `401 after re-authentication`）。
  // 记录本 provider 最后一次交给 SDK 的 token，onUnauthorized 只刷新「确实被拒」的那一枚。
  let tokenRequested = false;
  let lastIssuedAccessToken: string | undefined;

  const issueToken = async (): Promise<string | undefined> => {
    const pair = await loadCredentialPair(input.credentialStore, input.keyPrefix);
    // 没有 token 时返回 undefined：请求照发、拿到 401，再由 onUnauthorized 统一分类。
    if (!pair?.tokens) return undefined;
    if (!isCanonicalTokenNearExpiry(pair)) return pair.tokens.access_token;
    // 临期主动刷新。没有 refresh token 就直接用现值撑到 401，不虚构刷新。
    if (!pair.tokens.refresh_token) return pair.tokens.access_token;
    return await refreshMcpOAuthTokensUnderLock({
      ...refreshInput,
      observedGeneration: pair.generation,
      reactive: false,
    });
  };

  return {
    async token(): Promise<string | undefined> {
      tokenRequested = true;
      const token = await issueToken();
      lastIssuedAccessToken = token;
      return token;
    },

    async onUnauthorized(): Promise<void> {
      const pair = await loadCredentialPair(input.credentialStore, input.keyPrefix);
      if (!pair?.tokens?.refresh_token) {
        throw createInteractiveAuthorizationRequiredError({
          reason: pair?.tokens ? "no_refresh_token" : "no_credentials",
          serverName: input.serverName,
        });
      }
      if (tokenRequested && pair.tokens.access_token !== lastIssuedAccessToken) {
        // 被拒的请求带的不是当前这枚凭据：要么它发出时还没有凭据（leader 随后才发布），
        // 要么另一个进程已经完成换代。直接返回，让 SDK 的重试重新调 token() 拿新凭据；
        // 在这里刷新会把一枚未被拒绝的 token 换掉，反而污染共享凭据。
        return;
      }
      // 契约是「让下一次 token() 返回可用 token」，返回值本身被 SDK 忽略；刷新结果已发布到
      // canonical，下一次 token() 会重新读取。
      await refreshMcpOAuthTokensUnderLock({
        ...refreshInput,
        observedGeneration: pair.generation,
        reactive: true,
      });
    },
  };
}
