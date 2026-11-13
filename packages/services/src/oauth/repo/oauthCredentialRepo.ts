/* eslint-disable max-lines -- OAuth 凭据仓储集中维护 NIBI 登录 key 边界，拆分会让鉴权事实源更难追踪。 */
import type {
  OAuthLoginAttribution,
  OAuthProviderId,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@nibi/shared";
import { NIBI_PROVIDER_ID, isCredentialDecryptError } from "@nibi/shared";
import type { ICredentialService } from "../../credential/credential.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const LOGIN_ATTRIBUTION_KEY = "oauth:login_attribution";
const NIBI_JWT_TOKEN_KEY = "nibi-jwttoken";
const KNOWN_OAUTH_PROVIDER_IDS = [NIBI_PROVIDER_ID] as const;
const log = createServiceLogger("oauthCredentialRepo");

interface OAuthCredentialRepoOptions {
  providerIds?: readonly OAuthProviderId[];
  onCorruptOAuthSessionCleared?: (providerIds: readonly OAuthProviderId[]) => Promise<void>;
}

function accessTokenKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:access_token`;
}

function refreshTokenKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:refresh_token`;
}

function userInfoKey(provider: OAuthProviderId): string {
  return `oauth:${provider}:user_info`;
}

function collectKnownOAuthProviderIds(
  providerIds: readonly OAuthProviderId[] = [],
): OAuthProviderId[] {
  const uniqueProviderIds = new Set<OAuthProviderId>(KNOWN_OAUTH_PROVIDER_IDS);
  for (const providerId of providerIds) {
    uniqueProviderIds.add(providerId);
  }
  return [...uniqueProviderIds];
}

/** OAuth 凭据仓储：统一 NIBI provider 命名空间 */
export class OAuthCredentialRepo {
  private readonly knownProviderIds: OAuthProviderId[];

  constructor(
    private credentialService: ICredentialService,
    options: OAuthCredentialRepoOptions = {},
  ) {
    this.knownProviderIds = collectKnownOAuthProviderIds(options.providerIds);
    this.onCorruptOAuthSessionCleared = options.onCorruptOAuthSessionCleared;
  }

  private readonly onCorruptOAuthSessionCleared?: (
    providerIds: readonly OAuthProviderId[],
  ) => Promise<void>;

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return this.loadActiveProvider();
  }

  async setActiveProvider(provider: OAuthProviderId | null): Promise<void> {
    await this.saveActiveProvider(provider);
  }

  async loadActiveProvider(): Promise<OAuthProviderId | null> {
    try {
      return await this.credentialService.load(ACTIVE_PROVIDER_KEY);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async saveActiveProvider(provider: OAuthProviderId | null): Promise<void> {
    if (!provider) {
      await this.credentialService.delete(ACTIVE_PROVIDER_KEY);
      return;
    }

    // App 登录恢复为 oauth:* 镜像，active provider 是互斥 provider 域的唯一事实源。
    await this.credentialService.save(ACTIVE_PROVIDER_KEY, provider);
  }

  async loadActiveTokenSet(): Promise<OAuthTokenSet | null> {
    const provider = await this.loadActiveProvider();
    if (!provider) {
      return null;
    }

    const tokenSet = await this.loadTokenSet(provider);
    if (tokenSet) {
      return tokenSet;
    }

    return null;
  }

  async saveActiveTokenSet(tokenSet: OAuthTokenSet): Promise<void> {
    const provider = await this.loadActiveProvider();
    if (!provider) {
      throw new Error("保存当前登录 token 前缺少 active provider");
    }
    await this.saveTokenSet(provider, tokenSet);
  }

  async loadActiveUserProfile(): Promise<OAuthUserProfile | null> {
    const provider = await this.loadActiveProvider();
    if (!provider) {
      return null;
    }

    const profile = await this.loadUserProfile(provider);
    if (profile) {
      return profile;
    }

    return null;
  }

  async saveActiveUserProfile(profile: OAuthUserProfile): Promise<void> {
    const provider = await this.loadActiveProvider();
    if (!provider) {
      throw new Error("保存当前登录 user 前缺少 active provider");
    }
    await this.saveUserProfile(provider, profile);
  }

  async saveLoginAttribution(attribution: OAuthLoginAttribution): Promise<void> {
    const persistAttribution = Object.fromEntries(
      Object.entries(attribution).flatMap(([key, value]) => {
        const trimmed = typeof value === "string" ? value.trim() : "";
        return trimmed ? [[key, trimmed]] : [];
      }),
    );

    if (Object.keys(persistAttribution).length === 0) {
      return;
    }

    await this.credentialService.save(LOGIN_ATTRIBUTION_KEY, JSON.stringify(persistAttribution));
  }

  async loadLoginAttribution(): Promise<OAuthLoginAttribution | null> {
    let raw: string | null;
    try {
      raw = await this.credentialService.load(LOGIN_ATTRIBUTION_KEY);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }
      return null;
    }

    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // 兼容本分支早期保存过的 { params, expiresAt } 结构；取消 TTL 后只读取 params。
      const storedParams =
        parsed.params && typeof parsed.params === "object"
          ? (parsed.params as Record<string, unknown>)
          : parsed;

      const params = Object.fromEntries(
        Object.entries(storedParams).flatMap(([key, value]) =>
          (key === "channel_id" || key === "utm_source" || key === "utm_campaign") &&
          typeof value === "string" &&
          value.trim()
            ? [[key, value.trim()]]
            : [],
        ),
      ) as OAuthLoginAttribution;
      if (Object.keys(params).length === 0) {
        await this.credentialService.delete(LOGIN_ATTRIBUTION_KEY);
        return null;
      }
      return params;
    } catch {
      await this.credentialService.delete(LOGIN_ATTRIBUTION_KEY);
      return null;
    }
  }

  async clearActiveSession(): Promise<void> {
    const activeProvider = await this.loadActiveProvider();
    if (activeProvider) {
      await this.clearProvider(activeProvider);
    }
    await this.credentialService.delete(ACTIVE_PROVIDER_KEY);
  }

  async loadTokenSet(provider: OAuthProviderId): Promise<OAuthTokenSet | null> {
    try {
      const accessToken = await this.credentialService.load(accessTokenKey(provider));
      if (!accessToken) {
        return null;
      }

      const refreshToken = await this.credentialService.load(refreshTokenKey(provider));

      const nibiJwtToken =
        provider === NIBI_PROVIDER_ID
          ? await this.credentialService.load(NIBI_JWT_TOKEN_KEY)
          : null;

      return {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(nibiJwtToken ? { nibiJwtToken } : {}),
      };
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async loadCachedSessionTokens(
    provider: OAuthProviderId,
  ): Promise<{ key: string; value: string }[] | null> {
    try {
      return await Promise.all(
        [NIBI_JWT_TOKEN_KEY, accessTokenKey(provider)].map(async (key) => ({
          key,
          value: (await this.credentialService.load(key))?.trim() ?? "",
        })),
      );
    } catch (error) {
      if (!isCredentialDecryptError(error)) throw error;
      // 启动轻量检查曾绕过仓储的解密异常分类，导致业务 token 损坏时恢复直接失败。
      // 复用既有 OAuth 清理边界，不读取 refresh token，也不触发远端资料迁移。
      await this.clearCorruptOAuthSession();
      return null;
    }
  }

  async saveTokenSet(provider: OAuthProviderId, tokenSet: OAuthTokenSet): Promise<void> {
    await this.credentialService.save(accessTokenKey(provider), tokenSet.accessToken);

    if (tokenSet.refreshToken) {
      await this.credentialService.save(refreshTokenKey(provider), tokenSet.refreshToken);
    } else {
      await this.credentialService.delete(refreshTokenKey(provider));
    }

    if (provider === NIBI_PROVIDER_ID) {
      if (tokenSet.nibiJwtToken) {
        await this.credentialService.save(NIBI_JWT_TOKEN_KEY, tokenSet.nibiJwtToken);
      } else {
        await this.credentialService.delete(NIBI_JWT_TOKEN_KEY);
      }
    }
  }

  async loadUserProfile(provider: OAuthProviderId): Promise<OAuthUserProfile | null> {
    return this.loadUserProfileFromKey(userInfoKey(provider));
  }

  private async loadUserProfileFromKey(key: string): Promise<OAuthUserProfile | null> {
    let raw: string | null;
    try {
      raw = await this.credentialService.load(key);
    } catch (error) {
      if (!isCredentialDecryptError(error)) {
        throw error;
      }

      await this.clearCorruptOAuthSession();
      return null;
    }

    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as Partial<OAuthUserProfile>;
      if (
        typeof parsed.id === "string" &&
        typeof parsed.username === "string" &&
        typeof parsed.displayName === "string"
      ) {
        const avatarUrl = typeof parsed.avatarUrl === "string" ? parsed.avatarUrl : undefined;
        const rawProfile =
          typeof parsed.rawProfile === "object" && parsed.rawProfile !== null
            ? parsed.rawProfile
            : undefined;
        return {
          id: parsed.id,
          username: parsed.username,
          displayName: parsed.displayName,
          ...(avatarUrl ? { avatarUrl } : {}),
          ...(rawProfile ? { rawProfile } : {}),
        };
      }

    } catch {
      // ignore parse error and fallback to null
    }

    return null;
  }

  async saveUserProfile(provider: OAuthProviderId, profile: OAuthUserProfile): Promise<void> {
    await this.credentialService.save(userInfoKey(provider), JSON.stringify(profile));
  }

  async clearUserProfile(provider: OAuthProviderId): Promise<void> {
    await this.credentialService.delete(userInfoKey(provider));
  }

  async clearProvider(provider: OAuthProviderId): Promise<void> {
    await this.credentialService.delete(accessTokenKey(provider));
    await this.credentialService.delete(refreshTokenKey(provider));
    await this.credentialService.delete(userInfoKey(provider));
    if (shouldClearNibiJwtOnLogout(provider)) {
      await this.credentialService.delete(NIBI_JWT_TOKEN_KEY);
    }
  }

  async clearAll(providers: OAuthProviderId[]): Promise<void> {
    for (const provider of providers) {
      await this.clearProvider(provider);
    }

    await this.saveActiveProvider(null);
  }

  private async clearCorruptOAuthSession(): Promise<void> {
    // AES-GCM 解密失败说明当前运行时已经无法信任本地 OAuth 登录态。
    // 等价于强制登出已注册 OAuth provider：先清 provider 命名空间与共享 zcode JWT，
    // 再通知 service 层清理 Start/Coding Plan 这类派生模型凭据，同时避免误删 SSH 等其他独立凭据。
    for (const provider of this.knownProviderIds) {
      await this.clearProvider(provider);
    }
    await this.credentialService.delete(ACTIVE_PROVIDER_KEY);
    try {
      await this.onCorruptOAuthSessionCleared?.(this.knownProviderIds);
    } catch (error) {
      // 派生模型 provider 清理失败不能阻断 OAuth 损坏态恢复。
      // 主 OAuth 凭据已经删除，用户必须能回到可重新登录的未登录态。
      log.warn(undefined, "clear derived provider keys after corrupt OAuth session failed", error);
    }
  }
}

function shouldClearNibiJwtOnLogout(provider: OAuthProviderId): boolean {
  return provider === NIBI_PROVIDER_ID;
}
