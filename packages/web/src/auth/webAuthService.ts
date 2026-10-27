import {
  NIBI_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  resolveJwtExpiration,
  type UserInfo,
} from "@nibi/shared";
import {
  BrowserOAuthCredentialRepo,
  type WebOAuthProviderId,
} from "./browserOAuthCredentialRepo.js";
import {
  buildOAuthState,
  buildReturnToCallbackUrl,
  buildWebRemoteOAuthRedirectUri,
  isTrustedDevReturnTo,
  parseOAuthState,
  parseOptionalUrl,
  resolveSafeAppReturnTo,
} from "./oauthStateCodec.js";
import {
  NIBI_WEB_OAUTH_CONFIG,
  NibiWebOAuthProvider,
  createNibiCodeChallenge,
  createNibiCodeVerifier,
  type NibiWebOAuthConfig,
} from "./nibiWebOAuth.js";
import { WEB_ZAI_OAUTH_CONFIG, type WebZaiOAuthConfig } from "./webZaiOAuthConfig.js";
import { ZaiWebOAuthProvider } from "./zaiWebOAuthProvider.js";

interface WebAuthServiceRuntime {
  assign(url: string): void;
  createNonce(): string;
  getCurrentHref(): string;
  getCurrentOrigin(): string;
  replace(url: string): void;
}

interface WebAuthServiceDependencies {
  now?: () => number;
  config?: WebZaiOAuthConfig;
  nibiConfig?: NibiWebOAuthConfig;
  provider?: ZaiWebOAuthProvider;
  nibiProvider?: NibiWebOAuthProvider;
  repo?: BrowserOAuthCredentialRepo;
  runtime?: WebAuthServiceRuntime;
}

interface WebAuthLoginOptions {
  devReturnTo?: string;
  appReturnTo?: string;
  redirectUri?: string;
  /** 缺省 zai，保持 /remote 等既有入口行为不变。 */
  provider?: WebOAuthProviderId;
  /** NIBI：强制 IdP 重新认证（切换账号时必须，否则 SSO 会登回原账号）。 */
  forceLogin?: boolean;
}

export interface WebAuthCallbackResult {
  userInfo: UserInfo;
  appReturnTo: string | null;
}

function createBrowserNonce(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random generator is unavailable");
  }

  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createDefaultRuntime(): WebAuthServiceRuntime {
  return {
    assign: (url) => {
      window.location.assign(url);
    },
    createNonce: createBrowserNonce,
    getCurrentHref: () => window.location.href,
    getCurrentOrigin: () => window.location.origin,
    replace: (url) => {
      window.location.replace(url);
    },
  };
}

const NIBI_REFRESH_MARGIN_MS = 5 * 60_000;

export class WebAuthService {
  private readonly config: WebZaiOAuthConfig;
  private readonly nibiConfig: NibiWebOAuthConfig;
  private readonly provider: ZaiWebOAuthProvider;
  private readonly nibiProvider: NibiWebOAuthProvider;
  private readonly repo: BrowserOAuthCredentialRepo;
  private readonly runtime: WebAuthServiceRuntime;
  private readonly now: () => number;
  private refreshPromise: Promise<boolean> | null = null;
  private autoRefreshStarted = false;

  constructor(dependencies: WebAuthServiceDependencies = {}) {
    this.config = dependencies.config ?? WEB_ZAI_OAUTH_CONFIG;
    this.nibiConfig = dependencies.nibiConfig ?? NIBI_WEB_OAUTH_CONFIG;
    this.provider = dependencies.provider ?? new ZaiWebOAuthProvider(this.config);
    this.nibiProvider = dependencies.nibiProvider ?? new NibiWebOAuthProvider(this.nibiConfig);
    this.repo = dependencies.repo ?? new BrowserOAuthCredentialRepo();
    this.runtime = dependencies.runtime ?? createDefaultRuntime();
    this.now = dependencies.now ?? Date.now;
  }

  startLogin(options: WebAuthLoginOptions = {}): void | Promise<void> {
    if (options.provider === NIBI_PROVIDER_ID) return this.startNibiLogin(options);
    const nonce = this.runtime.createNonce();
    const provider = options.provider ?? ZAI_PROVIDER_ID;
    const appReturnTo = options.appReturnTo ?? this.runtime.getCurrentHref();
    const returnToOptions = { currentOrigin: this.runtime.getCurrentOrigin() };
    const redirectUri = buildWebRemoteOAuthRedirectUri(
      options.redirectUri ?? this.config.redirectUri,
      appReturnTo,
      returnToOptions,
    );
    this.repo.savePendingLogin({ nonce, provider, redirectUri });

    const state = buildOAuthState({
      nonce,
      app_return_to: appReturnTo,
      ...(options.devReturnTo
        ? {
            return_to: buildWebRemoteOAuthRedirectUri(
              options.devReturnTo,
              appReturnTo,
              returnToOptions,
            ),
          }
        : {}),
    });

    this.runtime.assign(
      this.provider.buildAuthorizeUrl({
        state,
        provider,
        redirectUri,
      }),
    );
  }

  /**
   * NIBI：授权码 + PKCE。回调地址必须与页面同源且不带参数（Zitadel 做完全匹配），
   * 二维码参数只进 state.app_return_to，登录完成后再跳回完整 URL。
   * 生成 S256 challenge 需要 SubtleCrypto，所以这条路径是异步的；调用方不需要等待跳转。
   */
  private async startNibiLogin(options: WebAuthLoginOptions): Promise<void> {
    const nonce = this.runtime.createNonce();
    const appReturnTo = options.appReturnTo ?? this.runtime.getCurrentHref();
    const redirectUri = options.redirectUri ?? this.nibiConfig.redirectUri;
    const codeVerifier = createNibiCodeVerifier();
    const codeChallenge = await createNibiCodeChallenge(codeVerifier);
    this.repo.savePendingLogin({
      nonce,
      provider: NIBI_PROVIDER_ID,
      redirectUri,
      codeVerifier,
    });
    const state = buildOAuthState({ nonce, app_return_to: appReturnTo });
    this.runtime.assign(
      this.nibiProvider.buildAuthorizeUrl({
        state,
        redirectUri,
        codeChallenge,
        ...(options.forceLogin ? { forceLogin: true } : {}),
      }),
    );
  }

  async handleCallback(url: string): Promise<WebAuthCallbackResult | null> {
    const callback = this.provider.parseCallbackParams(url);
    const statePayload = parseOAuthState(callback.state);
    if (!statePayload) {
      throw new Error("OAuth state is invalid");
    }

    const returnToUrl = parseOptionalUrl(statePayload.return_to);
    if (returnToUrl && returnToUrl.origin !== this.runtime.getCurrentOrigin()) {
      if (this.config.allowDevReturnToRedirect && isTrustedDevReturnTo(returnToUrl)) {
        const redirectUrl = buildReturnToCallbackUrl(returnToUrl.toString(), {
          ...(callback.code ? { code: callback.code } : {}),
          ...(callback.error ? { error: callback.error } : {}),
          state: callback.state,
        });
        if (redirectUrl) {
          this.runtime.replace(redirectUrl);
          return null;
        }
      }
    }

    if (callback.error) {
      throw new Error(`OAuth login failed: ${callback.error}`);
    }

    if (!callback.code) {
      throw new Error("OAuth callback missing code");
    }

    // provider 与回调地址必须取跳转前记下的那条：authorize 参数名和 token 响应里 access_token
    // 的位置都是 provider 特定的，token 请求也要用授权时的完整回调地址。
    const pendingLogin = this.repo.takePendingLogin(statePayload.nonce);
    if (!pendingLogin) {
      throw new Error("OAuth CSRF 检测失败");
    }
    const { provider, redirectUri, codeVerifier } = pendingLogin;
    let exchange;
    if (provider === NIBI_PROVIDER_ID) {
      if (!codeVerifier) {
        // 没有 verifier 就无法完成 PKCE；宁可让用户重登，也不能静默降级成无 PKCE 流程。
        throw new Error("OAuth PKCE verifier missing");
      }
      exchange = await this.nibiProvider.exchangeToken({
        code: callback.code,
        redirectUri,
        codeVerifier,
      });
    } else {
      exchange = await this.provider.exchangeToken({
        code: callback.code,
        state: callback.state,
        provider,
        redirectUri,
      });
    }

    this.repo.saveTokenSet(exchange.tokenSet, provider);
    this.repo.saveUserInfo(exchange.rawUserInfo, provider);
    this.repo.setActiveProvider(provider);

    return {
      userInfo: exchange.userInfo,
      appReturnTo: resolveSafeAppReturnTo(statePayload.app_return_to, {
        currentOrigin: this.runtime.getCurrentOrigin(),
      }),
    };
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    // 先续期再判定：access token 只有 ~12h，过期后 loadCachedSession 会把凭据清掉。
    await this.refreshNibiSessionIfNeeded();
    return this.repo.loadCachedSession();
  }

  /**
   * NIBI access token 续期。并发调用共享同一个 promise；仅在临近到期（5 分钟）
   * 或已被判定过期时才真正请求。IdP 明确拒绝（400/401）才清凭据，网络错误保留以便重试。
   */
  async refreshNibiSessionIfNeeded(force = false): Promise<boolean> {
    if (this.refreshPromise) return this.refreshPromise;
    const state = this.repo.loadNibiRefreshState();
    if (!state?.refreshToken) return false;
    if (!force && !this.shouldRefreshNibiToken(state)) return false;

    const run = (async () => {
      try {
        const refreshed = await this.nibiProvider.refreshToken(state.refreshToken!);
        this.repo.saveNibiRefreshedTokenSet(refreshed);
        return true;
      } catch (error) {
        const status = (error as { status?: number } | null)?.status;
        if (status === 400 || status === 401) this.repo.clearAll();
        return false;
      } finally {
        this.refreshPromise = null;
      }
    })();
    this.refreshPromise = run;
    return run;
  }

  private shouldRefreshNibiToken(state: {
    accessToken: string | null;
    expiresAt: number | null;
  }): boolean {
    const now = this.now;
    if (state.expiresAt) return state.expiresAt - now() <= NIBI_REFRESH_MARGIN_MS;
    if (!state.accessToken) return true;
    const expiration = resolveJwtExpiration(state.accessToken, now());
    if (expiration.kind === "expired") return true;
    if (expiration.kind === "valid") {
      return expiration.expiresAt - now() <= NIBI_REFRESH_MARGIN_MS;
    }
    // 非标准 token 且没有本地到期时间：交给 401 触发重新登录，不做无依据的刷新。
    return false;
  }

  /** 页面常驻时每 5 分钟检查一次；回到前台/恢复网络时立即检查。返回清理函数。 */
  startNibiAutoRefresh(): () => void {
    // 单测会注入最小 window stub（没有 setInterval/addEventListener）；这里必须全部防御，
    // 否则只是 import main.tsx 就会在模块求值阶段抛错。
    if (
      typeof window === "undefined" ||
      typeof window.setInterval !== "function" ||
      typeof window.addEventListener !== "function" ||
      typeof document === "undefined" ||
      typeof document.addEventListener !== "function" ||
      this.autoRefreshStarted
    ) {
      return () => {};
    }
    // 没有已持久化的 NIBI 会话时不起定时器：单测/未登录首屏不留下 5 分钟间隔。
    // 登录走整页 OAuth 回跳，页面重载后才会到这里，因此不会漏掉刚登录的会话。
    if (!this.repo.loadNibiRefreshState()?.refreshToken) {
      return () => {};
    }
    this.autoRefreshStarted = true;
    const tick = () => {
      void this.refreshNibiSessionIfNeeded().catch(() => {});
    };
    const interval = window.setInterval(tick, NIBI_REFRESH_MARGIN_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", tick);
    tick();
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", tick);
      this.autoRefreshStarted = false;
    };
  }

  restoreCachedSessionState() {
    return this.repo.loadCachedSessionState();
  }

  getZCodeJwtToken(): string | null {
    return this.repo.loadZCodeJwtToken();
  }

  /** 设备页账号行的展示资料；只读，不参与登录判断。 */
  getActiveAccount(): {
    displayName: string;
    avatarUrl?: string;
    provider: WebOAuthProviderId;
  } | null {
    const account = this.repo.loadActiveAccount();
    if (!account) return null;
    const { userInfo, provider } = account;
    return {
      displayName: userInfo.displayName.trim() || userInfo.username,
      ...(userInfo.avatarUrl ? { avatarUrl: userInfo.avatarUrl } : {}),
      provider,
    };
  }

  async logout(): Promise<void> {
    this.repo.clearAll();
  }
}

export function createWebAuthService(): WebAuthService {
  return new WebAuthService();
}
