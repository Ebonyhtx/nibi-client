import {
  BIGMODEL_PROVIDER_ID,
  NIBI_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthProviderId,
  type OAuthTokenSet,
  type OAuthCachedSessionRestoreResult,
  type UserInfo,
  resolveJwtExpiration,
} from "@nibi/shared";
import { toUserInfo } from "./oauthUserInfo.js";

const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
const NIBI_JWT_TOKEN_KEY = "zcodejwttoken";
const ZAI_ACCESS_TOKEN_KEY = "oauth:zai:access_token";
const ZAI_USER_INFO_KEY = "oauth:zai:user_info";
const BIGMODEL_ACCESS_TOKEN_KEY = "oauth:bigmodel:access_token";
const BIGMODEL_USER_INFO_KEY = "oauth:bigmodel:user_info";
// NIBI 账号中心的 access token 同时就是中继/业务 API 的 JWT（与桌面端同一套账号）。
const NIBI_ACCESS_TOKEN_KEY = "oauth:nibi:access_token";
const NIBI_USER_INFO_KEY = "oauth:nibi:user_info";
// refresh_token 与 access token 的到期时刻。手机页可能挂几天，access token 只有 ~12h。
const NIBI_REFRESH_TOKEN_KEY = "oauth:nibi:refresh_token";
const NIBI_TOKEN_EXPIRES_AT_KEY = "oauth:nibi:token_expires_at";
const OAUTH_PENDING_LOGINS_KEY = "oauth_pending_logins";
// 同一浏览器多个标签页可以同时发起登录；只留最近几条，放弃的登录不会无限累积。
const MAX_PENDING_LOGINS = 5;

/** 本仓支持的登录 provider。private 分享的 owner 身份是 provider 特定的，两边都要能登。 */
export type WebOAuthProviderId =
  | typeof ZAI_PROVIDER_ID
  | typeof BIGMODEL_PROVIDER_ID
  | typeof NIBI_PROVIDER_ID;

export function isWebOAuthProviderId(value: unknown): value is WebOAuthProviderId {
  return value === ZAI_PROVIDER_ID || value === BIGMODEL_PROVIDER_ID || value === NIBI_PROVIDER_ID;
}

/**
 * 每个 provider 用独立的 key 段。
 *
 * 刻意不复用一套「中性」key：zai 的两个 key 已经在线上承载着 /remote 的登录态，换 key 会
 * 让所有已登录用户在发版当天掉线。加一段 bigmodel 前缀是零风险的做法，代价只是多一个映射。
 */
function providerKeys(provider: WebOAuthProviderId): { accessToken: string; userInfo: string } {
  if (provider === BIGMODEL_PROVIDER_ID) {
    return { accessToken: BIGMODEL_ACCESS_TOKEN_KEY, userInfo: BIGMODEL_USER_INFO_KEY };
  }
  if (provider === NIBI_PROVIDER_ID) {
    return { accessToken: NIBI_ACCESS_TOKEN_KEY, userInfo: NIBI_USER_INFO_KEY };
  }
  return { accessToken: ZAI_ACCESS_TOKEN_KEY, userInfo: ZAI_USER_INFO_KEY };
}

interface BrowserOAuthCredentialRepoStorage {
  localStorage: Storage;
}

/** 一次跳出去的登录：回调页靠它校验 state，并用同一 provider 与回调地址换 token。 */
export interface PendingOAuthLogin {
  nonce: string;
  provider: WebOAuthProviderId;
  redirectUri: string;
  /** NIBI（授权码 + PKCE）专用：回调换 token 时原样回传，缺失则拒绝完成登录。 */
  codeVerifier?: string;
}

function isPendingOAuthLogin(value: unknown): value is PendingOAuthLogin {
  if (!value || typeof value !== "object") return false;
  const login = value as Partial<Record<keyof PendingOAuthLogin, unknown>>;
  return (
    typeof login.nonce === "string" &&
    hasText(login.nonce) &&
    isWebOAuthProviderId(login.provider) &&
    typeof login.redirectUri === "string" &&
    hasText(login.redirectUri) &&
    (login.codeVerifier === undefined ||
      (typeof login.codeVerifier === "string" && /^[A-Za-z0-9._~-]{43,128}$/u.test(login.codeVerifier)))
  );
}

interface BrowserOAuthCredentialRepoOptions {
  now?: () => number;
}

interface WebZaiTokenSet {
  zcodeJwtToken: string;
  zaiAccessToken: string;
  expiresAt?: number;
}

function getBrowserStorage(): BrowserOAuthCredentialRepoStorage {
  return { localStorage: window.localStorage };
}

function hasText(value: string | null): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 浏览器 OAuth 凭据仓储：统一收敛 localStorage 读写，避免业务层散落认证状态判断。 */
export class BrowserOAuthCredentialRepo {
  private readonly localStorage: Storage;
  private readonly now: () => number;

  constructor(
    storage: BrowserOAuthCredentialRepoStorage = getBrowserStorage(),
    options: BrowserOAuthCredentialRepoOptions = {},
  ) {
    this.localStorage = storage.localStorage;
    this.now = options.now ?? Date.now;
  }

  saveTokenSet(tokenSet: WebZaiTokenSet | OAuthTokenSet, provider: WebOAuthProviderId): void {
    const accessToken =
      "zaiAccessToken" in tokenSet ? tokenSet.zaiAccessToken : tokenSet.accessToken;
    const zcodeJwtToken = tokenSet.zcodeJwtToken;

    this.localStorage.setItem(providerKeys(provider).accessToken, accessToken);
    if (zcodeJwtToken) {
      this.localStorage.setItem(NIBI_JWT_TOKEN_KEY, zcodeJwtToken);
    } else {
      this.localStorage.removeItem(NIBI_JWT_TOKEN_KEY);
    }
    if (provider === NIBI_PROVIDER_ID) {
      const refreshToken =
        "refreshToken" in tokenSet ? tokenSet.refreshToken?.trim() ?? "" : "";
      const expiresAt = "expiresAt" in tokenSet ? tokenSet.expiresAt : undefined;
      if (refreshToken) {
        this.localStorage.setItem(NIBI_REFRESH_TOKEN_KEY, refreshToken);
      } else {
        this.localStorage.removeItem(NIBI_REFRESH_TOKEN_KEY);
      }
      if (typeof expiresAt === "number" && Number.isFinite(expiresAt) && expiresAt > 0) {
        this.localStorage.setItem(NIBI_TOKEN_EXPIRES_AT_KEY, String(expiresAt));
      } else {
        this.localStorage.removeItem(NIBI_TOKEN_EXPIRES_AT_KEY);
      }
    }
  }

  saveUserInfo(user: unknown, provider: WebOAuthProviderId): void {
    const rawUserInfo = JSON.stringify(user);
    this.localStorage.setItem(providerKeys(provider).userInfo, rawUserInfo);
  }

  setActiveProvider(provider: WebOAuthProviderId | null): void {
    if (!provider) {
      this.localStorage.removeItem(ACTIVE_PROVIDER_KEY);
      return;
    }

    this.localStorage.setItem(ACTIVE_PROVIDER_KEY, provider);
  }

  getActiveProvider(): OAuthProviderId | null {
    return this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
  }

  loadCachedSession(): UserInfo | null {
    const result = this.loadCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  /**
   * 只读的账号展示资料（设备页账号行）。不是登录门禁：不校验 JWT、不清理残缺凭据，
   * 否则渲染一次列表就可能提前登出；登录事实仍由 loadCachedSessionState / JWT 决定。
   */
  loadActiveAccount(): { provider: WebOAuthProviderId; userInfo: UserInfo } | null {
    try {
      const provider = this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
      if (!isWebOAuthProviderId(provider)) return null;
      const rawUserInfo = this.localStorage.getItem(providerKeys(provider).userInfo);
      if (!hasText(rawUserInfo)) return null;
      const userInfo = toUserInfo(JSON.parse(rawUserInfo));
      return userInfo ? { provider, userInfo } : null;
    } catch {
      return null;
    }
  }

  loadCachedSessionState(): OAuthCachedSessionRestoreResult {
    const activeProvider = this.localStorage.getItem(ACTIVE_PROVIDER_KEY);
    const zcodeJwtToken = this.localStorage.getItem(NIBI_JWT_TOKEN_KEY);
    // 一次只有一个 activeProvider（切换 provider = 重新登录并覆盖），所以按它选 key 段读。
    const keys = isWebOAuthProviderId(activeProvider) ? providerKeys(activeProvider) : null;
    const accessToken = keys ? this.localStorage.getItem(keys.accessToken) : null;
    const rawUserInfo = keys ? this.localStorage.getItem(keys.userInfo) : null;

    if (!keys || !hasText(zcodeJwtToken) || !hasText(accessToken) || !hasText(rawUserInfo)) {
      if (this.hasAnyStoredCredential()) {
        this.clearAll();
      }
      return { status: "signed-out" };
    }

    if (resolveJwtExpiration(zcodeJwtToken, this.now()).kind === "expired") {
      // Web localStorage 之前只检查 JWT 是否存在，过期后仍会恢复伪登录态。
      // NIBI 有 refresh_token 时先保留凭据，让 restore/refresh 去续期；续期失败再清。
      if (
        activeProvider === NIBI_PROVIDER_ID &&
        hasText(this.localStorage.getItem(NIBI_REFRESH_TOKEN_KEY))
      ) {
        return { status: "reauthentication-required", reason: "jwt-expired" };
      }
      this.clearAll();
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    try {
      const userInfo = toUserInfo(JSON.parse(rawUserInfo));
      if (userInfo) {
        return { status: "authenticated", userInfo };
      }
    } catch {
      // localStorage 可能留下旧版或手工写入的损坏 JSON。
      // 这里按未登录处理并清理残缺态，避免 Web 远控入口误判成已登录后继续连接。
    }

    this.clearAll();
    return { status: "signed-out" };
  }

  loadZCodeJwtToken(): string | null {
    const session = this.loadCachedSessionState();
    if (session.status !== "authenticated") return null;
    return this.localStorage.getItem(NIBI_JWT_TOKEN_KEY)?.trim() || null;
  }

  /** 续期所需的 refresh_token 与本地记录的到期时刻；非 NIBI 登录返回 null。 */
  loadNibiRefreshState(): {
    accessToken: string | null;
    refreshToken: string | null;
    expiresAt: number | null;
  } | null {
    if (this.localStorage.getItem(ACTIVE_PROVIDER_KEY) !== NIBI_PROVIDER_ID) return null;
    const accessToken = this.localStorage.getItem(NIBI_ACCESS_TOKEN_KEY)?.trim() || null;
    const refreshToken = this.localStorage.getItem(NIBI_REFRESH_TOKEN_KEY)?.trim() || null;
    const rawExpiresAt = this.localStorage.getItem(NIBI_TOKEN_EXPIRES_AT_KEY);
    const parsed = rawExpiresAt ? Number(rawExpiresAt) : NaN;
    return {
      accessToken,
      refreshToken,
      expiresAt: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
    };
  }

  /** 刷新成功后只覆盖令牌与到期时间，保留账号资料；refresh_token 轮换时同步替换。 */
  saveNibiRefreshedTokenSet(tokenSet: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
  }): void {
    this.localStorage.setItem(NIBI_ACCESS_TOKEN_KEY, tokenSet.accessToken);
    this.localStorage.setItem(NIBI_JWT_TOKEN_KEY, tokenSet.accessToken);
    if (tokenSet.refreshToken?.trim()) {
      this.localStorage.setItem(NIBI_REFRESH_TOKEN_KEY, tokenSet.refreshToken.trim());
    }
    if (
      typeof tokenSet.expiresAt === "number" &&
      Number.isFinite(tokenSet.expiresAt) &&
      tokenSet.expiresAt > 0
    ) {
      this.localStorage.setItem(NIBI_TOKEN_EXPIRES_AT_KEY, String(tokenSet.expiresAt));
    } else {
      this.localStorage.removeItem(NIBI_TOKEN_EXPIRES_AT_KEY);
    }
  }

  private hasAnyStoredCredential(): boolean {
    return Boolean(
      this.localStorage.getItem(ACTIVE_PROVIDER_KEY) ||
      this.localStorage.getItem(NIBI_JWT_TOKEN_KEY) ||
      this.localStorage.getItem(ZAI_ACCESS_TOKEN_KEY) ||
      this.localStorage.getItem(ZAI_USER_INFO_KEY) ||
      this.localStorage.getItem(BIGMODEL_ACCESS_TOKEN_KEY) ||
      this.localStorage.getItem(BIGMODEL_USER_INFO_KEY) ||
      this.localStorage.getItem(NIBI_ACCESS_TOKEN_KEY) ||
      this.localStorage.getItem(NIBI_USER_INFO_KEY) ||
      this.localStorage.getItem(NIBI_REFRESH_TOKEN_KEY),
    );
  }

  clearAll(): void {
    this.localStorage.removeItem(ACTIVE_PROVIDER_KEY);
    this.localStorage.removeItem(NIBI_JWT_TOKEN_KEY);
    // 两个 provider 的 key 段一起清：切换 provider 时不能留下上一个身份的残片，
    // 否则 loadCachedSessionState 可能读到半套凭据。
    this.localStorage.removeItem(ZAI_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(ZAI_USER_INFO_KEY);
    this.localStorage.removeItem(BIGMODEL_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(BIGMODEL_USER_INFO_KEY);
    this.localStorage.removeItem(NIBI_ACCESS_TOKEN_KEY);
    this.localStorage.removeItem(NIBI_USER_INFO_KEY);
    this.localStorage.removeItem(NIBI_REFRESH_TOKEN_KEY);
    this.localStorage.removeItem(NIBI_TOKEN_EXPIRES_AT_KEY);
  }

  /**
   * 记住这次跳出去的登录，按 nonce 区分。
   *
   * 修复：原先 nonce/provider/回调地址存在发起页的 sessionStorage。部分手机浏览器的 OAuth
   * 回调不在发起登录的标签页里，或标签页被系统回收后重建，回调页读不到 nonce，换 token 前
   * 就报 “OAuth CSRF 检测失败”，重新登录也一样失败。改存同源 localStorage 后，同一浏览器的
   * 任意标签页都能完成回调；nonce 仍随机且只用一次，CSRF 校验强度不变。
   */
  savePendingLogin(login: PendingOAuthLogin): void {
    const logins = this.readPendingLogins().filter((pending) => pending.nonce !== login.nonce);
    this.writePendingLogins([...logins, login].slice(-MAX_PENDING_LOGINS));
  }

  /** 取出并删除 nonce 对应的登录记录；找不到时不改动其他标签页的记录。 */
  takePendingLogin(nonce: string): PendingOAuthLogin | null {
    const logins = this.readPendingLogins();
    const login = logins.find((pending) => pending.nonce === nonce);
    if (!login) return null;
    this.writePendingLogins(logins.filter((pending) => pending !== login));
    return login;
  }

  private readPendingLogins(): PendingOAuthLogin[] {
    const raw = this.localStorage.getItem(OAUTH_PENDING_LOGINS_KEY);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isPendingOAuthLogin) : [];
    } catch {
      // 损坏的记录不能当成本次登录；下一次发起登录会整体覆盖。
      return [];
    }
  }

  private writePendingLogins(logins: PendingOAuthLogin[]): void {
    if (logins.length > 0) {
      this.localStorage.setItem(OAUTH_PENDING_LOGINS_KEY, JSON.stringify(logins));
    } else {
      this.localStorage.removeItem(OAUTH_PENDING_LOGINS_KEY);
    }
  }
}
