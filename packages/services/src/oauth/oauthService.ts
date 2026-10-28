/* eslint-disable max-lines -- OAuthService 集中维护 OAuth 会话生命周期和 provider 切换边界，当前 review 修复只收窄后台迁移写入条件。 */
import { randomBytes } from "node:crypto";
import { Emitter } from "@nibi/rpc";
import {
  ApiError,
  formatLogPrefix,
  type ApiClient,
  BIGMODEL_PROVIDER_ID,
  NIBI_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  type OAuthCallbackResult,
  type OAuthCachedSessionRestoreResult,
  type OAuthProviderId,
  type OAuthProviderMeta,
  type OAuthSessionState,
  type OAuthStartResponse,
  type OAuthTokenSet,
  type OAuthUserProfile,
  type UserInfo,
  resolveJwtExpiration,
  isCredentialDecryptError,
} from "@nibi/shared";
import type { ICredentialService } from "../credential/credential.js";
import { readLicenseDecision } from "../license/nibiLicenseClient.js";
import { loadNibiAccountIdentity, type NibiLicenseSync } from "../license/nibiLicenseSync.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { readApiJson } from "../providers/api/apiJson.js";
import type { IOAuthService, NibiMembershipStatus } from "./oauth.js";
import { NIBI_API_BASE_URL, NIBI_MEMBERSHIP_SITE_URL } from "./providers/nibiProviderConfig.js";
import { isTrustedNibiMembershipWebviewUrl } from "@nibi/shared";
import { isCurrentOAuthCredentialRequest } from "#src/oauth/oauthUnauthorizedRequest.js";
import { hasOAuthAuthorizationCode, parseOAuthLoginAttribution } from "./callbackAttribution.js";
import {
  refreshLegacyBigModelCachedProfile,
  withProviderProfileSchema,
} from "./oauthProfileSchema.js";
import { createOAuthProviderAdapters, type OAuthProviderAdapter } from "./providers/index.js";
import { OAuthCredentialRepo } from "./repo/oauthCredentialRepo.js";
import { createOAuthRuntimeConfig } from "./runtimeConfig.js";
import {
  buildDesktopOAuthRedirectUriFromEnv,
  buildZCodeApiUrlFromEnv,
} from "./providers/configUtils.js";

/** OAuth 超时时间（5 分钟） */
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_POLLING_STATE_GRACE_MS = 30 * 1000;
const NIBI_JWT_TOKEN_KEY = "zcodejwttoken";
// access token ~12h。提前 5 分钟续期，避免远控重连/会员接口在边界上拿到刚过期的令牌。
const NIBI_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** 网络类刷新失败的指数退避序列；走完后停止定时重试（下次启动/用户操作再触发）。 */
const NIBI_TOKEN_REFRESH_BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000] as const;
const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("oauthService", process.pid), ...args);
const serviceLog = createServiceLogger("oauthService");

interface PendingState {
  state: string;
  provider: OAuthProviderId;
  timeout: NodeJS.Timeout;
  phase: "awaiting-attribution-or-code" | "awaiting-code-after-attribution";
  completionPromise?: Promise<OAuthCallbackResult | null>;
  polling?: {
    expiresAt: number;
    flowId: string;
    nextPollAt: number;
    pollIntervalMs: number;
    pollToken: string;
    pollUrl: string;
  };
}

interface OAuthFlowEnvelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

interface OAuthServiceDependencies {
  adapters?: OAuthProviderAdapter[];
  apiClient?: ApiClient;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  onProviderLogout?: (provider: OAuthProviderId, accountIdentity?: string | null) => Promise<void>;
  /** 购买/续费后 force 一次真实 /licenses/check 用；缺省时 force 退化为读缓存。 */
  nibiLicenseSync?: NibiLicenseSync;
}

function readTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toUserInfo(profile: OAuthUserProfile): UserInfo {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

function isSameOAuthProfile(left: OAuthUserProfile, right: OAuthUserProfile): boolean {
  return (
    left.id === right.id &&
    left.username === right.username &&
    left.displayName === right.displayName &&
    left.avatarUrl === right.avatarUrl &&
    JSON.stringify(left.rawProfile ?? null) === JSON.stringify(right.rawProfile ?? null)
  );
}

function resolveInactiveOAuthProvider(provider: OAuthProviderId): OAuthProviderId | null {
  if (provider === ZAI_PROVIDER_ID) {
    return BIGMODEL_PROVIDER_ID;
  }
  if (provider === BIGMODEL_PROVIDER_ID) {
    return ZAI_PROVIDER_ID;
  }
  return null;
}

/**
 * OAuth 认证服务实现
 *
 * 在 host process 中运行，管理 OAuth 流程的完整生命周期。
 */
export class OAuthService implements IOAuthService {
  private readonly sessionChanges = new Emitter<OAuthSessionState>();
  readonly onDidChangeSession = this.sessionChanges.event;
  private readonly credentialService: ICredentialService;
  private readonly repo: OAuthCredentialRepo;
  private readonly adapters = new Map<OAuthProviderId, OAuthProviderAdapter>();
  private readonly now: () => number;
  private readonly onProviderLogout?: (
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ) => Promise<void>;
  private readonly apiClient?: ApiClient;
  private readonly env: NodeJS.ProcessEnv;
  private readonly nibiLicenseSync?: NibiLicenseSync;
  private pendingState: PendingState | null = null;
  private oauthFlowStartGeneration = 0;
  private oauthFlowStartProvider: OAuthProviderId | null = null;
  private oauthSessionGeneration = 0;
  private nibiRefreshTimer?: ReturnType<typeof setTimeout>;
  private nibiRefreshRetryScheduled = false;
  private nibiRefreshRetryAttempts = 0;
  private sessionMutationQueue: Promise<unknown> = Promise.resolve();
  private recentlyCompletedPollingState: {
    generation: number;
    expiresAt: number;
    provider: OAuthProviderId;
    state: string;
  } | null = null;

  constructor(credentialService: ICredentialService, dependencies: OAuthServiceDependencies = {}) {
    this.credentialService = credentialService;
    this.now = dependencies.now ?? Date.now;
    this.onProviderLogout = dependencies.onProviderLogout;
    this.apiClient = dependencies.apiClient;
    this.env = dependencies.env ?? process.env;
    this.nibiLicenseSync = dependencies.nibiLicenseSync;

    const adapters =
      dependencies.adapters ??
      createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
        apiClient: dependencies.apiClient,
      });

    for (const adapter of adapters) {
      this.adapters.set(adapter.providerId, adapter);
    }
    this.repo = new OAuthCredentialRepo(credentialService, {
      providerIds: adapters.map((adapter) => adapter.providerId),
      onCorruptOAuthSessionCleared: async (providers) => {
        this.sessionChanges.fire("signed-out");
        // 本地 OAuth 凭据解密失败后等价于强制 logout。
        // repo 只能清 OAuth 命名空间，派生的 Start/Coding Plan provider key 必须回到 service 层清理。
        await this.notifyProvidersLogout(providers);
      },
    });
  }

  async getProviders(): Promise<OAuthProviderMeta[]> {
    return [...this.adapters.values()]
      .map((adapter) => adapter.meta)
      .filter((meta) => meta.enabled)
      .sort((a, b) => a.order - b.order);
  }

  async getActiveProvider(): Promise<OAuthProviderId | null> {
    return this.repo.getActiveProvider();
  }

  async restoreCachedSession(): Promise<UserInfo | null> {
    const result = await this.restoreCachedSessionState();
    return result.status === "authenticated" ? result.userInfo : null;
  }

  async restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult> {
    const restoreGeneration = this.oauthSessionGeneration;
    const activeProvider = await this.repo.getActiveProvider();
    if (!activeProvider) {
      log("restoreCachedSession skipped: no active provider");
      return { status: "signed-out" };
    }

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreCachedSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      await this.repo.setActiveProvider(null);
      return { status: "signed-out" };
    }

    const profile = await this.repo.loadActiveUserProfile();
    if (!profile) {
      // zai / bigmodel 这类 OAuth token 生命周期很短，启动时如果强依赖远端 userinfo 校验，
      // 用户明明刚登录过，也会因为 access_token 过期被误判成未登录。
      // 这里改为优先读取登录成功时持久化的 user_info，只要用户没有手动退出，就按缓存恢复展示态。
      log("restoreCachedSession skipped: missing cached user profile:", activeProvider);
      return { status: "signed-out" };
    }

    // 业务 JWT 过期而共享 JWT 仍有效时，旧实现会恢复伪登录态；直接读两个凭据做本地检查，
    // 不调用 loadActiveTokenSet，避免把后台 profile 迁移或网络请求带回首屏恢复链路。
    // NIBI 不消费 legacy zcodejwttoken：那是 ZAI 时代的共享 JWT，残留过期会把 NIBI 会话误清。
    const credentialKeys =
      activeProvider === NIBI_PROVIDER_ID
        ? [`oauth:${activeProvider}:access_token`]
        : [NIBI_JWT_TOKEN_KEY, `oauth:${activeProvider}:access_token`];
    let tokens: { key: string; value: string }[];
    try {
      tokens = await Promise.all(
        credentialKeys.map(async (key) => ({
          key,
          value: (await this.credentialService.load(key))?.trim() ?? "",
        })),
      );
    } catch (error) {
      if (!isCredentialDecryptError(error)) throw error;
      const cleared = await this.runSessionMutation(async () => {
        // 损坏凭据清理也是会话写入；旧恢复须在队列内重读，不能删除已提交的新登录。
        if (this.oauthSessionGeneration !== restoreGeneration) return false;
        const currentTokens = await this.repo.loadCachedSessionTokens(activeProvider);
        if (currentTokens !== null) return false;
        this.oauthSessionGeneration += 1;
        return true;
      });
      return cleared ? { status: "signed-out" } : this.restoreCachedSessionState();
    }
    const expired = tokens.find(
      ({ value }) => value && resolveJwtExpiration(value, this.now()).kind === "expired",
    );
    const zcodeJwtToken = tokens.find(({ key }) => key === NIBI_JWT_TOKEN_KEY)?.value ?? "";
    if (expired) {
      // NIBI 的 access token 过期时先走 refresh：refresh token 通常还有效，
      // 旧实现直接清会话会逼用户重新走浏览器登录（关机超过 token 生命期必现）。
      if (
        activeProvider === NIBI_PROVIDER_ID &&
        expired.key === `oauth:${NIBI_PROVIDER_ID}:access_token`
      ) {
        const refreshOutcome = await this.refreshExpiredNibiSessionOnRestore();
        if (refreshOutcome === "refreshed") {
          log("restoreCachedSession: NIBI session refreshed from refresh token");
          return this.restoreCachedSessionState();
        }
        if (refreshOutcome === "network-error") {
          // 网络失败不能误清凭据：refresh token 仍有效，按已登录恢复，后台定时刷新继续重试。
          log("restoreCachedSession: NIBI refresh failed on network; keeping session");
          void this.scheduleNibiTokenRefreshFromCredentials(activeProvider);
          return { status: "authenticated", userInfo: toUserInfo(profile) };
        }
        // "invalid-grant"：refresh token 已失效，落到旧清理路径。
      }
      serviceLog.info("cached session invalidated because login JWT expired", {
        provider: activeProvider,
        credentialKey: expired.key,
      });
      const invalidated = await this.invalidateExpiredCachedSession(
        restoreGeneration,
        activeProvider,
        profile,
        expired.value,
        expired.key,
      );
      if (!invalidated) {
        return this.restoreCachedSessionState();
      }
      return { status: "reauthentication-required", reason: "jwt-expired" };
    }

    if (activeProvider === BIGMODEL_PROVIDER_ID) {
      const migrationGeneration = this.oauthSessionGeneration;
      void refreshLegacyBigModelCachedProfile({
        adapter,
        cachedProfile: profile,
        loadTokenSet: () =>
          this.loadBigModelCachedProfileMigrationTokenSet(migrationGeneration, profile),
        now: this.now,
        runWithAdapterError: (run) => this.runWithAdapterError(adapter, run),
        saveProfile: (nextProfile) =>
          this.saveBigModelCachedProfileMigration(migrationGeneration, profile, nextProfile),
      })
        .then((migratedProfile) => {
          if (migratedProfile !== profile) {
            log(
              "restoreCachedSession migrated cached profile:",
              activeProvider,
              migratedProfile.id,
            );
          }
        })
        .catch((error: unknown) => {
          log(
            "restoreCachedSession background profile migration failed:",
            activeProvider,
            error instanceof Error ? error.message : String(error),
          );
        });
    }

    if (activeProvider === ZAI_PROVIDER_ID) {
      if (!zcodeJwtToken) {
        // sidebar 登录入口之前只看缓存 user_info，会把“缺少 zcodejwttoken”的状态误判成已登录。
        // 这里补充 zcodejwttoken 门槛，确保没有后端 JWT 时统一按未登录处理。
        log("restoreCachedSession skipped: missing zcodejwttoken:", activeProvider);
        return { status: "signed-out" };
      }
    }

    log("restoreCachedSession restored:", activeProvider, profile.id);
    void this.scheduleNibiTokenRefreshFromCredentials(activeProvider);
    return { status: "authenticated", userInfo: toUserInfo(profile) };
  }

  /**
   * 启动恢复时 NIBI access token 已过期的自救：先试 refresh。
   * 返回 "refreshed"（成功续期）/ "invalid-grant"（refresh token 失效，该清会话）/
   * "network-error"（网络问题，凭据必须保留）。
   */
  private async refreshExpiredNibiSessionOnRestore(): Promise<
    "refreshed" | "invalid-grant" | "network-error"
  > {
    const tokenSet = await this.repo.loadActiveTokenSet();
    if (!tokenSet?.refreshToken) return "invalid-grant";
    try {
      await this.refreshToken(NIBI_PROVIDER_ID);
      return "refreshed";
    } catch (error) {
      const status = error instanceof ApiError ? error.status : undefined;
      // Zitadel 对失效 refresh token 返回 400 invalid_grant；401/403 同属认证类失败。
      if (status === 400 || status === 401 || status === 403) return "invalid-grant";
      serviceLog.warn("NIBI session refresh on restore failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return "network-error";
    }
  }

  private async invalidateExpiredCachedSession(
    expectedGeneration: number,
    expectedProvider: OAuthProviderId,
    expectedProfile: OAuthUserProfile,
    expectedJwt: string,
    credentialKey = NIBI_JWT_TOKEN_KEY,
  ): Promise<boolean> {
    const invalidated = await this.runSessionMutation(async () => {
      const currentProvider = await this.repo.getActiveProvider();
      const currentProfile = await this.repo.loadUserProfile(expectedProvider);
      const currentJwt = (await this.credentialService.load(credentialKey))?.trim() ?? "";
      if (
        this.oauthSessionGeneration !== expectedGeneration ||
        currentProvider !== expectedProvider ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedProfile) ||
        currentJwt !== expectedJwt
      ) {
        // 启动恢复读取过期凭据后，新登录或 provider 切换可能已经完成；
        // 旧恢复任务只能清理仍与其快照完全一致的会话，不能误删刚写入的新认证状态。
        serviceLog.info("skipped stale expired JWT session invalidation", {
          provider: expectedProvider,
        });
        return false;
      }
      this.oauthSessionGeneration += 1;
      await this.repo.clearActiveSession();
      this.sessionChanges.fire("signed-out");
      return true;
    });
    if (!invalidated) {
      return false;
    }
    await this.cancelPending(expectedProvider);
    try {
      await this.notifyProviderLogout(expectedProvider, expectedProfile.id);
    } catch (error) {
      // JWT 已过期时主认证事实必须先失效；派生 provider 清理失败不能把 UI 留在伪登录态。
      serviceLog.warn("expired JWT derived provider cleanup failed", {
        provider: expectedProvider,
        error,
      });
    }
    return true;
  }

  private async loadBigModelCachedProfileMigrationTokenSet(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
  ): Promise<OAuthTokenSet | null> {
    return this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel token migration");
        return null;
      }

      const activeProvider = await this.repo.getActiveProvider();
      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
      if (
        activeProvider !== BIGMODEL_PROVIDER_ID ||
        !currentProfile ||
        !isSameOAuthProfile(currentProfile, expectedCachedProfile)
      ) {
        // 迁移请求目标固定是 BigModel，token 也必须固定读取 BigModel 命名空间；
        // 发请求前先复核持久化快照，避免切换到 ZAI 后把其他 provider token 发给 BigModel。
        log("restoreCachedSession skipped stale BigModel token migration:", activeProvider);
        return null;
      }

      return this.repo.loadTokenSet(BIGMODEL_PROVIDER_ID);
    });
  }

  private async saveBigModelCachedProfileMigration(
    expectedGeneration: number,
    expectedCachedProfile: OAuthUserProfile,
    nextProfile: OAuthUserProfile,
  ): Promise<void> {
    await this.runSessionMutation(async () => {
      if (this.oauthSessionGeneration !== expectedGeneration) {
        log("restoreCachedSession skipped stale BigModel profile migration");
        return;
      }

      const activeProvider = await this.repo.getActiveProvider();
      if (activeProvider !== BIGMODEL_PROVIDER_ID) {
        log("restoreCachedSession skipped stale BigModel profile migration:", activeProvider);
        return;
      }

      const currentProfile = await this.repo.loadUserProfile(BIGMODEL_PROVIDER_ID);
      if (!currentProfile || !isSameOAuthProfile(currentProfile, expectedCachedProfile)) {
        // BigModel 旧缓存迁移在后台完成，期间用户可能 logout、切到 ZAI，
        // 或重新登录 BigModel。只有当前缓存仍是启动时那份旧缓存时，旧迁移结果才允许落盘。
        log("restoreCachedSession skipped outdated BigModel profile migration");
        return;
      }

      await this.repo.saveUserProfile(BIGMODEL_PROVIDER_ID, nextProfile);
    });
  }

  private runSessionMutation<T>(run: () => Promise<T>): Promise<T> {
    // 后台 profile 迁移、logout、provider 切换都会改 OAuth 凭据；
    // 必须串行化，避免旧迁移在退出或切换清理之后重新写回 user_info。
    const next = this.sessionMutationQueue.catch(() => undefined).then(run);
    this.sessionMutationQueue = next.catch(() => undefined);
    return next;
  }

  private async persistOAuthSession(
    provider: OAuthProviderId,
    tokenSet: OAuthTokenSet,
    profile: OAuthUserProfile,
    isStillCurrent?: () => boolean,
  ): Promise<void> {
    const inactiveProvider = resolveInactiveOAuthProvider(provider);
    const previousTokenSet = await this.repo.loadTokenSet(provider);
    const previousProfile = await this.repo.loadUserProfile(provider);
    const previousInactiveTokenSet = inactiveProvider
      ? await this.repo.loadTokenSet(inactiveProvider)
      : null;
    const previousInactiveProfile = inactiveProvider
      ? await this.repo.loadUserProfile(inactiveProvider)
      : null;
    const previousActiveProvider = await this.repo.getActiveProvider();
    const rollback = async () => {
      if (previousTokenSet) await this.repo.saveTokenSet(provider, previousTokenSet);
      else await this.repo.clearProvider(provider);
      if (previousProfile) await this.repo.saveUserProfile(provider, previousProfile);
      else await this.repo.clearUserProfile(provider);
      if (inactiveProvider) {
        if (previousInactiveTokenSet)
          await this.repo.saveTokenSet(inactiveProvider, previousInactiveTokenSet);
        else await this.repo.clearProvider(inactiveProvider);
        if (previousInactiveProfile)
          await this.repo.saveUserProfile(inactiveProvider, previousInactiveProfile);
        else await this.repo.clearUserProfile(inactiveProvider);
      }
      if (previousActiveProvider) await this.repo.setActiveProvider(previousActiveProvider);
      else await this.repo.setActiveProvider(null);
    };
    const assertCurrent = async () => {
      if (isStillCurrent && !isStillCurrent()) {
        await rollback();
        throw new Error("OAuth flow 已取消");
      }
    };
    this.oauthSessionGeneration += 1;
    if (inactiveProvider) {
      await assertCurrent();
      // ZAI 与 BigModel 是互斥身份域。切换 provider 时必须先清旧 provider，
      // 再保存当前 token；反序会让 clearProvider 误删共享的 zcodejwttoken。
      await this.repo.clearProvider(inactiveProvider);
    }
    await assertCurrent();
    await this.repo.saveTokenSet(provider, tokenSet);
    await assertCurrent();
    await this.repo.saveUserProfile(provider, withProviderProfileSchema(provider, profile));
    await assertCurrent();
    await this.repo.setActiveProvider(provider);
    if (isStillCurrent && !isStillCurrent()) {
      // active provider 写入无法被底层 credential IO 取消；失效 flow 不能仅按
      // provider 清理，否则同 provider 的新 flow 可能被旧 flow 误删。
      await rollback();
      throw new Error("OAuth flow 已取消");
    }
    if (provider === NIBI_PROVIDER_ID) {
      // NIBI 登录成功即清掉 ZAI 时代的 legacy 共享 JWT：残留的过期 token 曾在
      // 启动恢复时把 NIBI 会话误判为过期（恢复链路现在也不再看它）。
      await this.credentialService.delete(NIBI_JWT_TOKEN_KEY);
    }
    this.scheduleNibiTokenRefresh(provider, tokenSet);
    // 凭据是认证事实源；同账号重登也必须通知，不能等 renderer 的设置更新或成功计数。
    this.sessionChanges.fire("signed-in");
  }

  private async runPendingSessionCompletion(
    pending: PendingState,
    complete: () => Promise<{ tokenSet: OAuthTokenSet; profile: OAuthUserProfile }>,
    preserveAttribution?: () => Promise<void>,
  ): Promise<OAuthCallbackResult | null> {
    const completion = this.runSessionMutation(async () => {
      // polling 与 deep link 可能同时完成，也可能在等待期间开始新登录。
      // 只有仍指向同一 pending 对象的路径能落盘，防止迟到结果覆盖更新的登录选择。
      if (this.pendingState !== pending) {
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          // 回调入队时已通过有效性检查，不能因队列等待超过去重窗口而丢失归因。
          await preserveAttribution?.();
          return { kind: "duplicate" as const, provider: pending.provider };
        }
        return null;
      }
      await preserveAttribution?.();
      if (this.pendingState !== pending) return null;
      const { tokenSet, profile } = await complete();
      // exchangeToken 期间用户可能取消或切换到新 flow；旧请求返回后必须再次校验，
      // 否则已取消的登录仍会把旧凭据写回本地。
      if (this.pendingState !== pending) {
        return null;
      }
      await this.persistOAuthSession(
        pending.provider,
        tokenSet,
        profile,
        () => this.pendingState === pending,
      );
      if (this.pendingState === pending) {
        this.clearPendingState();
      }
      this.recentlyCompletedPollingState = {
        generation: this.oauthFlowStartGeneration,
        expiresAt: this.now() + COMPLETED_POLLING_STATE_GRACE_MS,
        provider: pending.provider,
        state: pending.state,
      };
      return {
        kind: "session" as const,
        provider: pending.provider,
        userInfo: toUserInfo(profile),
      };
    });
    // 共享首个兑换 Promise 会让失败传播给另一条已拿到凭据的路径。
    // 复用会话串行队列，每个候选独立执行；失败只在已排队候选均失败后向 UI 报告。
    pending.completionPromise = completion;
    try {
      return await completion;
    } catch (error) {
      const fallback = pending.completionPromise;
      if (fallback && fallback !== completion) {
        try {
          await fallback;
        } catch {
          // 两条路径均失败时保留各自的错误，不能让备用路径覆盖首条失败原因。
          throw error;
        }
        if (
          !this.pendingState &&
          this.recentlyCompletedPollingState?.state === pending.state &&
          this.recentlyCompletedPollingState.generation === this.oauthFlowStartGeneration
        ) {
          return { kind: "duplicate", provider: pending.provider };
        }
        if (this.pendingState !== pending) return null;
      }
      throw error;
    } finally {
      if (pending.completionPromise === completion) pending.completionPromise = undefined;
    }
  }

  async restoreSession(): Promise<UserInfo | null> {
    const activeProvider = await this.repo.getActiveProvider();
    if (!activeProvider) {
      log("restoreSession skipped: no active provider");
      return null;
    }

    log("restoreSession started:", activeProvider);

    const adapter = this.adapters.get(activeProvider);
    if (!adapter || !adapter.meta.enabled) {
      log(
        "restoreSession aborted: provider unavailable, clearing active provider:",
        activeProvider,
      );
      await this.repo.setActiveProvider(null);
      return null;
    }

    let tokenSet = await this.repo.loadActiveTokenSet();
    if (!tokenSet && adapter.loadLegacyTokenSet) {
      log("restoreSession fallback: trying provider legacy token set:", activeProvider);
      tokenSet = await adapter.loadLegacyTokenSet((key) => this.credentialService.load(key));

      // 多 provider 改造后，旧版 BigModel 仍可能只保留 legacy token key。
      // 这里在 provider 兼容读取成功后回填命名空间 key，避免每次启动都重复走 legacy 分支。
      if (tokenSet) {
        log("restoreSession fallback hit: migrating legacy token set:", activeProvider);
        await this.repo.saveActiveTokenSet(tokenSet);
        await this.repo.saveTokenSet(activeProvider, tokenSet);
      }
    }

    if (!tokenSet || !adapter.fetchUserInfo) {
      log(
        "restoreSession failed: missing token or user-info capability, logging out:",
        activeProvider,
      );
      await this.logout();
      return null;
    }

    try {
      log("restoreSession validating token with provider userinfo endpoint:", activeProvider);
      const profile = await this.runWithAdapterError(adapter, () =>
        adapter.fetchUserInfo!(tokenSet, {
          providerId: activeProvider,
          state: "",
          redirectUri: adapter.redirectUri,
          now: this.now,
        }),
      );

      await this.repo.saveActiveUserProfile(withProviderProfileSchema(activeProvider, profile));
      await this.repo.setActiveProvider(activeProvider);
      log("restoreSession validated:", activeProvider, profile.id);
      return toUserInfo(profile);
    } catch (error) {
      const normalized = adapter.normalizeError(error);

      // 启动恢复只看本地凭据会把“过期 token”误判成已登录。
      // 当远端明确返回未授权（401/403）时，立即按退出流程清理本地登录态。
      if (this.isUnauthorizedError(normalized)) {
        log("restoreSession unauthorized, logging out:", activeProvider, normalized.message);
        await this.logout();
        return null;
      }

      log("restoreSession validation error:", activeProvider, normalized.message);

      throw normalized;
    }
  }

  async startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    return this.startOAuthInternal(provider);
  }

  async startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    if (provider !== ZAI_PROVIDER_ID && provider !== BIGMODEL_PROVIDER_ID) {
      return this.startOAuthInternal(provider);
    }

    const adapter = this.getEnabledAdapter(provider);
    if (!this.apiClient) {
      throw new Error("ApiClient 注入缺失：OAuth polling 必须通过 Providers 传入 apiClient");
    }
    // 两个 init 并发时，先发但后返回的旧响应会覆盖较新的 pending flow。
    // generation 让最后一次用户操作拥有 flow，旧响应只结束自己的调用方。
    const startGeneration = ++this.oauthFlowStartGeneration;
    this.oauthFlowStartProvider = provider;
    this.clearPendingState();
    const pollToken = randomBytes(32).toString("hex");
    const initUrl = buildZCodeApiUrlFromEnv(this.env, "/api/v1/oauth/cli/init");
    const envelope = await readApiJson<OAuthFlowEnvelope>(this.apiClient, initUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pollToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ provider }),
    });
    if (this.oauthFlowStartGeneration !== startGeneration) {
      throw new Error("OAuth flow 已被新的登录请求替换");
    }
    this.oauthFlowStartProvider = null;
    const data = envelope.data;
    if (
      envelope.code !== 0 ||
      !isUnknownRecord(data) ||
      !readTrimmedString(data.flow_id) ||
      !readTrimmedString(data.authorize_url) ||
      !Number.isFinite(data.expires_at) ||
      !Number.isFinite(data.poll_interval_sec)
    ) {
      throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 初始化响应无效");
    }

    const flowId = readTrimmedString(data.flow_id)!;
    const authorizeUrlString = readTrimmedString(data.authorize_url)!;
    const expiresAt = (data.expires_at as number) * 1_000;
    const pollIntervalMs = (data.poll_interval_sec as number) * 1_000;
    let authorizeUrl: URL;
    try {
      authorizeUrl = new URL(authorizeUrlString);
    } catch {
      throw new Error("OAuth flow 初始化响应无效");
    }
    if (provider === BIGMODEL_PROVIDER_ID) {
      // BigModel CLI callback 的失败页会截断原有 Desktop deep link 回调体验。
      // flow 仍由 Host 轮询，但浏览器回调恢复到官网中转页，再透传到 nibi://oauth/callback。
      authorizeUrl.searchParams.set("redirect", buildDesktopOAuthRedirectUriFromEnv(this.env));
    } else if (provider === ZAI_PROVIDER_ID) {
      // Z.AI 后端 init 仍可能返回 provider-specific callback，导致回跳行为与 BigModel 不一致。
      // Desktop 统一改写为官网中转页，再由官网透传到 nibi://oauth/callback。
      authorizeUrl.searchParams.set("redirect_uri", buildDesktopOAuthRedirectUriFromEnv(this.env));
    }
    const state = authorizeUrl.searchParams.get("state")?.trim();
    const remainingLifetimeMs = expiresAt - this.now();
    if (
      authorizeUrl.protocol !== "https:" ||
      !state ||
      !Number.isFinite(expiresAt) ||
      !Number.isFinite(pollIntervalMs) ||
      remainingLifetimeMs <= 0 ||
      pollIntervalMs < 1_000 ||
      pollIntervalMs >= remainingLifetimeMs
    ) {
      throw new Error("OAuth flow 初始化响应无效");
    }

    const timeoutMs = Math.min(OAUTH_TIMEOUT_MS, remainingLifetimeMs);
    const timeout = setTimeout(() => {
      const pending = this.pendingState;
      // polling flow 超时必须立即收口，不能等待下一次 UI 轮询；同时校验 flowId，避免旧定时器清掉新 flow。
      if (pending?.state === state && pending.polling?.flowId === flowId) {
        this.clearPendingState();
      }
    }, timeoutMs);
    this.pendingState = {
      state,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
      polling: {
        expiresAt,
        flowId,
        nextPollAt: this.now(),
        pollIntervalMs,
        pollToken,
        pollUrl: buildZCodeApiUrlFromEnv(
          this.env,
          `/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`,
        ),
      },
    };

    serviceLog.info("OAuth polling flow started", {
      expiresInMs: timeoutMs,
      pollIntervalMs,
      provider,
    });
    return { provider, authorizeUrl: authorizeUrl.toString(), state };
  }

  async pollPendingOAuth(): Promise<OAuthCallbackResult | null> {
    const apiClient = this.apiClient;
    if (!apiClient) {
      return null;
    }
    const pending = this.pendingState;
    const polling = pending?.polling;
    if (!pending || !polling) {
      return null;
    }
    if (this.now() >= polling.expiresAt) {
      this.clearPendingState();
      throw new Error("OAuth flow 已过期");
    }
    if (this.now() < polling.nextPollAt) {
      return null;
    }
    polling.nextPollAt = this.now() + polling.pollIntervalMs;

    let envelope: OAuthFlowEnvelope;
    try {
      envelope = await readApiJson<OAuthFlowEnvelope>(apiClient, polling.pollUrl, {
        headers: { Authorization: `Bearer ${polling.pollToken}` },
      });
    } catch (error) {
      if (this.pendingState !== pending) return null;
      if (
        error instanceof ApiError &&
        error.status &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        try {
          return await this.runPendingSessionCompletion(pending, async () => {
            throw error;
          });
        } catch (terminalError) {
          if (this.pendingState === pending) this.clearPendingState();
          throw terminalError;
        }
      }
      // 轮询是 deep link 丢失时的可靠路径，单次断网或 5xx 不能立即取消 flow。
      // 保留服务端下发的查询间隔，下一轮继续尝试；高频状态只记 debug，避免生产日志膨胀。
      serviceLog.debug("OAuth polling request will retry", {
        error: error instanceof Error ? error.message : String(error),
        provider: pending.provider,
      });
      return null;
    }
    if (this.pendingState !== pending) {
      return null;
    }
    if (
      envelope.code === 0 &&
      isUnknownRecord(envelope.data) &&
      readTrimmedString(envelope.data.status) === "pending"
    ) {
      return null;
    }
    try {
      const result = await this.runPendingSessionCompletion(pending, async () => {
        const pollData = envelope.data;
        if (envelope.code !== 0 || !isUnknownRecord(pollData)) {
          throw new Error(readTrimmedString(envelope.msg) || "OAuth flow 查询响应无效");
        }
        const status = readTrimmedString(pollData.status);
        if (status === "failed") {
          throw new Error("OAuth flow 授权失败");
        }
        if (status !== "ready") {
          throw new Error("OAuth flow 查询响应无效");
        }

        const ready = pollData;
        const user = isUnknownRecord(ready.user) ? ready.user : null;
        const zai = isUnknownRecord(ready.zai) ? ready.zai : null;
        const bigmodel = isUnknownRecord(ready.bigmodel) ? ready.bigmodel : null;
        const providerAccessToken =
          pending.provider === ZAI_PROVIDER_ID
            ? readTrimmedString(zai?.access_token)
            : readTrimmedString(bigmodel?.access_token) || readTrimmedString(bigmodel?.accessToken);
        const zcodeJwtToken = readTrimmedString(ready.token);
        const userId = readTrimmedString(user?.user_id);
        if (!zcodeJwtToken || !providerAccessToken || !userId) {
          throw new Error("OAuth flow 查询响应无效");
        }
        const username = readTrimmedString(user?.name) || readTrimmedString(user?.email) || userId;
        const avatarUrl = readTrimmedString(user?.avatar);
        const profile: OAuthUserProfile = {
          id: userId,
          username,
          displayName: username,
          ...(avatarUrl ? { avatarUrl } : {}),
          rawProfile: user,
        };
        const adapter = this.getAdapter(pending.provider);
        const refreshToken =
          pending.provider === BIGMODEL_PROVIDER_ID
            ? readTrimmedString(bigmodel?.refresh_token) ||
              readTrimmedString(bigmodel?.refreshToken)
            : undefined;
        const tokenSet = adapter.normalizePolledTokenSet
          ? await adapter.normalizePolledTokenSet({
              accessToken: providerAccessToken,
              zcodeJwtToken,
              ...(refreshToken ? { refreshToken } : {}),
            })
          : {
              accessToken: providerAccessToken,
              zcodeJwtToken,
              ...(refreshToken ? { refreshToken } : {}),
            };
        return { tokenSet, profile };
      });
      if (result?.kind === "session") {
        serviceLog.info("OAuth polling flow completed", { provider: pending.provider });
      }
      return result;
    } catch (error) {
      if (this.pendingState === pending) this.clearPendingState();
      throw error;
    }
  }

  private async startOAuthInternal(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    const adapter = this.getEnabledAdapter(provider);

    // 同窗口快速连续点击不同 provider 时，旧 state 如果不先取消，
    // 两条并发流程会共享同一回调通道，导致后回调抢占前回调并触发 state 错配。
    await this.runSessionMutation(async () => {
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      this.clearPendingState();
    });

    const state = randomBytes(32).toString("hex");
    const timeout = setTimeout(() => {
      if (this.pendingState?.state === state) {
        this.pendingState = null;
      }
    }, OAUTH_TIMEOUT_MS);

    this.pendingState = {
      state,
      provider: adapter.providerId,
      timeout,
      phase: "awaiting-attribution-or-code",
    };

    const authorizeUrl = adapter.buildAuthorizeUrl({
      providerId: adapter.providerId,
      state,
      redirectUri: adapter.redirectUri,
      now: this.now,
    });

    return {
      provider: adapter.providerId,
      authorizeUrl,
      state,
    };
  }

  async handleCallback(url: string): Promise<OAuthCallbackResult | null> {
    const pending = this.pendingState;
    if (!pending) {
      const callbackState = new URL(url).searchParams.get("state")?.trim();
      const completed = this.recentlyCompletedPollingState;
      if (
        callbackState &&
        completed?.state === callbackState &&
        completed.generation === this.oauthFlowStartGeneration &&
        this.now() < completed.expiresAt
      ) {
        const attribution = parseOAuthLoginAttribution(new URL(url).searchParams);
        await this.runSessionMutation(async () => {
          // 修复原因：轮询先成功时仍需保存浏览器归因，不能把登录去重当作丢弃整条回调。
          if (
            !this.pendingState &&
            this.recentlyCompletedPollingState === completed &&
            completed.generation === this.oauthFlowStartGeneration &&
            attribution
          ) {
            await this.repo.saveLoginAttribution(attribution);
          }
        });
        return { kind: "duplicate", provider: completed.provider };
      }
      throw new Error("OAuth state 不匹配或已过期");
    }

    const parsedUrl = new URL(url);
    const state = parsedUrl.searchParams.get("state");
    if (!state || state !== pending.state) {
      throw new Error("OAuth state 不匹配或已过期");
    }
    if (pending.polling && this.now() >= pending.polling.expiresAt) {
      this.clearPendingState();
      throw new Error("OAuth flow 已过期");
    }

    const attribution = parseOAuthLoginAttribution(parsedUrl.searchParams);
    if (attribution && !hasOAuthAuthorizationCode(parsedUrl.searchParams)) {
      if (pending.phase === "awaiting-code-after-attribution") {
        throw new Error("OAuth 归因回调已处理");
      }

      // 修复原因：纯归因回调是最终授权码前的中转步骤，不能清掉仍需继续登录的 state；
      // 但若不显式推进 phase，同一 state 可重复写入归因并隐式复用 pending 生命周期。
      pending.phase = "awaiting-code-after-attribution";
      try {
        await this.repo.saveLoginAttribution(attribution);
      } catch (error) {
        if (this.pendingState === pending) {
          pending.phase = "awaiting-attribution-or-code";
        }
        throw error;
      }
      return {
        kind: "attribution",
        provider: pending.provider,
        attribution,
      };
    }

    const adapter = this.getAdapter(pending.provider);
    const fallbackProfile: OAuthUserProfile = {
      id: "unknown",
      username: "user",
      displayName: "User",
    };

    return this.runPendingSessionCompletion(
      pending,
      async () => {
        const callback = adapter.parseCallbackParams(url);
        const context = {
          providerId: adapter.providerId,
          state: callback.state,
          redirectUri: adapter.redirectUri,
          now: this.now,
        };
        const tokenSet = await this.runWithAdapterError(adapter, () =>
          adapter.exchangeToken(callback, context),
        );
        let profile = fallbackProfile;
        if (adapter.fetchUserInfo) {
          try {
            profile = await this.runWithAdapterError(adapter, () =>
              adapter.fetchUserInfo!(tokenSet, context),
            );
          } catch {
            // 获取用户信息失败不阻塞登录
          }
        }
        return { tokenSet, profile };
      },
      attribution ? () => this.repo.saveLoginAttribution(attribution) : undefined,
    );
  }

  async refreshToken(provider?: OAuthProviderId): Promise<void> {
    const generation = this.oauthSessionGeneration;
    const targetProvider = await this.resolveProvider(provider);
    if (!targetProvider) {
      throw new Error("当前没有可用的登录 provider");
    }

    const adapter = this.getEnabledAdapter(targetProvider);
    if (!adapter.refreshToken) {
      throw new Error(
        `${adapter.meta.displayName} OAuth 暂未提供 refresh token 交换接口，请重新登录`,
      );
    }

    const activeProvider = await this.repo.getActiveProvider();
    if (targetProvider !== activeProvider) {
      throw new Error("只能刷新当前 App 登录 provider，请重新登录");
    }

    const tokenSet = await this.repo.loadActiveTokenSet();
    if (!tokenSet?.refreshToken) {
      throw new Error("当前账号缺少 refresh_token，请重新登录");
    }

    const refreshed = await this.runWithAdapterError(adapter, () =>
      adapter.refreshToken!(tokenSet, {
        providerId: targetProvider,
        state: "",
        redirectUri: adapter.redirectUri,
        now: this.now,
      }),
    );

    await this.runSessionMutation(async () => {
      // 刷新写回若绕过会话队列，会插入 401 的核对/清理窗口，或在退出后复活凭据。
      if (
        this.oauthSessionGeneration !== generation ||
        (await this.repo.getActiveProvider()) !== targetProvider ||
        (await this.credentialService.load(`oauth:${targetProvider}:access_token`)) !==
          tokenSet.accessToken
      )
        return;
      await this.repo.saveActiveTokenSet(refreshed);
      this.scheduleNibiTokenRefresh(targetProvider, refreshed);
    });
  }

  /**
   * 启动恢复时只读凭据、不拉整份 token set：用 JWT exp 作为到期时间，
   * 有 refresh_token 才排期。失败只记日志，不阻塞首屏恢复。
   */
  private async scheduleNibiTokenRefreshFromCredentials(
    provider: OAuthProviderId,
  ): Promise<void> {
    if (provider !== NIBI_PROVIDER_ID) return;
    try {
      const [accessToken, refreshToken] = await Promise.all([
        this.credentialService.load(`oauth:${provider}:access_token`),
        this.credentialService.load(`oauth:${provider}:refresh_token`),
      ]);
      const access = accessToken?.trim();
      const refresh = refreshToken?.trim();
      if (!access || !refresh) return;
      const expiration = resolveJwtExpiration(access, this.now());
      if (expiration.kind !== "valid") return;
      this.scheduleNibiTokenRefresh(provider, {
        accessToken: access,
        refreshToken: refresh,
        expiresAt: expiration.expiresAt,
      });
    } catch (error) {
      serviceLog.warn("failed to schedule NIBI token refresh", { provider, error });
    }
  }

  /**
   * 桌面端 NIBI 令牌续期：在 expiresAt 前 5 分钟刷新一次；失败只补一次重试。
   * 定时器 unref，不阻止 host 退出；退出登录时清除。
   */
  private scheduleNibiTokenRefresh(provider: OAuthProviderId, tokenSet: OAuthTokenSet): void {
    if (provider !== NIBI_PROVIDER_ID) return;
    this.clearNibiTokenRefreshTimer();
    this.nibiRefreshRetryScheduled = false;
    const expiresAt = tokenSet.expiresAt;
    if (!expiresAt || !tokenSet.refreshToken || !Number.isFinite(expiresAt)) return;
    const delay = Math.max(expiresAt - this.now() - NIBI_TOKEN_REFRESH_MARGIN_MS, 30_000);
    this.nibiRefreshTimer = setTimeout(() => {
      this.nibiRefreshTimer = undefined;
      void this.runScheduledNibiRefresh(provider);
    }, delay);
    this.nibiRefreshTimer.unref?.();
  }

  private async runScheduledNibiRefresh(provider: OAuthProviderId): Promise<void> {
    try {
      await this.refreshToken(provider);
      this.nibiRefreshRetryAttempts = 0;
    } catch (error) {
      serviceLog.warn("scheduled NIBI token refresh failed", { provider, error });
      if ((await this.repo.getActiveProvider()) !== provider) return;
      // refresh token 已失效（撤销/过期）时退避没有意义：按失效会话登出并广播，
      // 让 UI 立刻回到未登录态，而不是带着过期 token 假装已登录。
      const status = error instanceof ApiError ? error.status : undefined;
      if (status === 400 || status === 401 || status === 403) {
        await this.logoutActiveSession(async () => (await this.repo.getActiveProvider()) === provider);
        return;
      }
      // 网络/服务端错误：指数退避重试；重试不叠层，走完序列后停止等外部触发。
      if (this.nibiRefreshRetryScheduled) return;
      const backoff =
        NIBI_TOKEN_REFRESH_BACKOFF_MS[
          Math.min(this.nibiRefreshRetryAttempts, NIBI_TOKEN_REFRESH_BACKOFF_MS.length - 1)
        ];
      this.nibiRefreshRetryAttempts += 1;
      this.nibiRefreshRetryScheduled = true;
      this.nibiRefreshTimer = setTimeout(() => {
        this.nibiRefreshTimer = undefined;
        void this.runScheduledNibiRefresh(provider);
      }, backoff);
      this.nibiRefreshTimer.unref?.();
    }
  }

  private clearNibiTokenRefreshTimer(): void {
    if (this.nibiRefreshTimer) {
      clearTimeout(this.nibiRefreshTimer);
      this.nibiRefreshTimer = undefined;
    }
    this.nibiRefreshRetryScheduled = false;
    this.nibiRefreshRetryAttempts = 0;
  }

  /** Host 本地 401 提交入口，不扩展 IOAuthService 的跨端契约。 */
  logoutIfCurrentCredentialRequest(input: string | URL, headers: Headers): Promise<boolean> {
    return this.logoutActiveSession(() =>
      isCurrentOAuthCredentialRequest({
        input,
        headers,
        credentialService: this.credentialService,
        env: this.env,
      }),
    );
  }

  private async logoutActiveSession(isCurrent?: () => Promise<boolean>): Promise<boolean> {
    this.clearNibiTokenRefreshTimer();
    const result = await this.runSessionMutation(async () => {
      // 异步分类的 true 不是清理授权；凭据复核与清理必须和登录写入共用队列。
      if (isCurrent && !(await isCurrent())) return null;
      const activeProvider = await this.repo.getActiveProvider();
      // 合并边界：清理前保留原账号身份，不能退回仅按平台清理或在退出后再猜身份。
      const accountIdentity = activeProvider
        ? ((await this.repo.loadUserProfile(activeProvider))?.id ?? null)
        : null;
      this.oauthSessionGeneration += 1;
      await this.repo.clearActiveSession();
      // 登出已生效：后续 provider/设置清理即使失败，也必须先撤销已认证的远控连接。
      this.sessionChanges.fire("signed-out");
      return { activeProvider, accountIdentity };
    });
    if (!result) return false;
    if (result.activeProvider) {
      await this.cancelPending(result.activeProvider);
      try {
        await this.notifyProviderLogout(result.activeProvider, result.accountIdentity);
      } catch (error) {
        if (!isCurrent) throw error;
        // 凭据已经清理，派生配置失败不能吞掉原有过期提示；手动退出仍保留原错误语义。
        serviceLog.warn("Unauthorized session provider cleanup failed", { error });
      }
    }
    return true;
  }

  async logout(provider?: OAuthProviderId): Promise<void> {
    this.clearNibiTokenRefreshTimer();
    if (!provider) {
      await this.logoutActiveSession();
      return;
    }

    const loggedOutIdentity = await this.runSessionMutation(async () => {
      const activeProvider = await this.repo.getActiveProvider();
      if (provider !== activeProvider) {
        return undefined;
      }
      const accountIdentity = (await this.repo.loadUserProfile(provider))?.id ?? null;
      this.oauthSessionGeneration += 1;
      // ZAI/BigModel provider 的 Unlink 已收敛为 App logout。
      // 只有当前 active provider 才代表登录事实，避免旧 unlink 路径误删非当前 provider token。
      await this.repo.clearActiveSession();
      this.sessionChanges.fire("signed-out");
      return accountIdentity;
    });
    if (loggedOutIdentity !== undefined) {
      await this.notifyProviderLogout(provider, loggedOutIdentity);
    }
    await this.cancelPending(provider);
  }

  async logoutAll(): Promise<void> {
    this.clearNibiTokenRefreshTimer();
    const providers = [...this.adapters.keys()];
    const accountIdentities = await this.runSessionMutation(async () => {
      const identities = new Map<OAuthProviderId, string | null>();
      for (const provider of providers) {
        identities.set(provider, (await this.repo.loadUserProfile(provider))?.id ?? null);
      }
      this.oauthSessionGeneration += 1;
      await this.repo.clearAll(providers);
      this.sessionChanges.fire("signed-out");
      return identities;
    });
    await this.cancelPending();
    await this.notifyProvidersLogout(providers, accountIdentities);
  }

  /** NIBI 会员状态（默认读本地缓存，不联网）。`force` 时先真实跑一次 /licenses/check。 */
  async getNibiMembershipStatus(options?: { force?: boolean }): Promise<NibiMembershipStatus> {
    const activeProvider = await this.repo.getActiveProvider();
    if (activeProvider !== NIBI_PROVIDER_ID) {
      return { loggedIn: false, membership: null };
    }
    if (options?.force === true) {
      // 购买/续费完成后的唯一可靠恢复路径：真实在线检查并写回设备 license；
      // 失败不吞——调用方（会员弹窗）要能显示可重试的错误。
      await this.nibiLicenseSync?.sync(true);
    }
    // 设备 + 账号绑定在本地判定层强制：复制来的凭据或上一个账号的 license 不能放行。
    const [deviceId, accountIdentity] = await Promise.all([
      this.credentialService.load("nibi:device:id"),
      loadNibiAccountIdentity(this.credentialService),
    ]);
    const decision = await readLicenseDecision({
      credentials: this.credentialService,
      deviceId: deviceId?.trim() ?? "",
      apiBaseUrl: "",
      request: async () => ({ status: 0, body: {} }),
      now: this.now,
      ...(accountIdentity ? { accountIdentity } : {}),
    });
    if (
      decision.status === "denied" &&
      (decision.reason.includes("设备") || decision.reason.includes("账号"))
    ) {
      // 绑定不匹配：立刻清掉旧 license 并强制重同步，让下一次读取拿到正确的凭证。
      try {
        await this.nibiLicenseSync?.clear();
        await this.nibiLicenseSync?.sync(true);
      } catch {
        // 重同步失败不影响本次"拒绝"的判定；UI 会展示原因并可重试。
      }
    }
    return {
      loggedIn: true,
      membership: {
        status: decision.status,
        plan: decision.claims?.plan ?? null,
        expiresAt: decision.claims?.exp ? new Date(decision.claims.exp * 1000).toISOString() : null,
      },
    };
  }

  /**
   * 客户端已登录 → 换一个带一次性 handoff 码的会员页 URL。
   * 网页用这个码换 2 小时站点会话；客户端未登录时必须回客户端登录，不走网页登录。
   */
  async createNibiCheckoutUrl(): Promise<{ url: string; expiresAt: string }> {
    const activeProvider = await this.repo.getActiveProvider();
    if (activeProvider !== NIBI_PROVIDER_ID) {
      throw new Error("请先在客户端登录 NIBI 账号，再打开会员页");
    }
    const apiClient = this.apiClient;
    if (!apiClient) {
      throw new Error("客户端服务未就绪，请稍后重试");
    }
    const accessToken =
      (await this.credentialService.load("oauth:nibi:access_token"))?.trim() ?? "";
    if (!accessToken) {
      throw new Error("NIBI 登录凭证缺失，请重新登录");
    }
    const apiBase = (this.env.NIBI_API_BASE_URL?.trim() || NIBI_API_BASE_URL).replace(/\/+$/, "");
    const siteUrl = this.env.NIBI_MEMBERSHIP_SITE_URL?.trim() || NIBI_MEMBERSHIP_SITE_URL;
    // handoff 是一次性兑换码（可换站点会话），只允许发往可信的 NIBI 会员页 origin。
    // 可信 origin 本身就排除明文 http（e2e 回环需显式开关），配置错误宁可报错，
    // 也不能把码发到错误 host 或明文 HTTP。
    const trustedMembershipSite = isTrustedNibiMembershipWebviewUrl(siteUrl, {
      e2eStoreBridgeEnabled: this.env.VITE_NIBI_E2E_STORE_BRIDGE === "1",
    });
    if (!trustedMembershipSite) {
      throw new Error("会员页地址配置不可信，已阻止发送登录态；请检查 NIBI_MEMBERSHIP_SITE_URL");
    }

    const requestHandoff = (token: string) =>
      apiClient.request(`${apiBase}/api/v1/auth/handoff`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        // handoff 是 NIBI 自家端点：不能被通用 endpoint 改写到上游，否则会把 NIBI
        // access token 发到别的域名。
        skipEndpointRewrite: true,
        // Fastify 对「JSON 头 + 空 body」直接 400；显式发空对象。
        body: "{}",
        timeoutMs: 15_000,
      });
    // EdgeOne 偶发 502（源站日志里没有这次请求）：单次失败就报错会让用户以为按钮坏了。
    // handoff 只是一次性短码，重试安全（失败的那次最多浪费一个码）。
    const requestHandoffWithRetry = async (token: string) => {
      let attempt = await requestHandoff(token);
      for (let retry = 0; attempt.status >= 500 && retry < 2; retry += 1) {
        await new Promise((resolve) => setTimeout(resolve, 400 * (retry + 1)));
        attempt = await requestHandoff(token);
      }
      return attempt;
    };
    let response = await requestHandoffWithRetry(accessToken);
    if (response.status === 401) {
      // 访问令牌可能只是过期：用 refresh_token 续一次再试，别让用户因为“登录看起来还在”卡死。
      try {
        await this.refreshToken(NIBI_PROVIDER_ID);
      } catch {
        // 刷新失败按下面统一报错。
      }
      const refreshed =
        (await this.credentialService.load("oauth:nibi:access_token"))?.trim() ?? "";
      if (refreshed && refreshed !== accessToken) {
        response = await requestHandoffWithRetry(refreshed);
      }
    }
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      let body: { error?: unknown; code?: unknown } = {};
      try {
        body = (await response.json()) as { error?: unknown; code?: unknown };
        if (typeof body?.error === "string" && body.error.trim()) message = body.error.trim();
      } catch {
        // 非 JSON 错误体按状态码处理。
      }
      if (body.code === "account_banned") {
        const error = new Error("账号已被暂停使用，请联系支持申诉") as Error & { code?: string };
        error.code = "account_banned";
        throw error;
      }
      throw new Error(`获取会员页登录态失败：${message}`);
    }
    const data = (await response.json()) as { code?: unknown; expiresAt?: unknown };
    if (typeof data.code !== "string" || !data.code.trim()) {
      throw new Error("会员页登录态响应无效");
    }
    const url = new URL(siteUrl);
    url.searchParams.set("embedded", "app");
    url.searchParams.set("handoff", data.code.trim());
    return {
      url: url.toString(),
      expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : "",
    };
  }

  async cancelPending(provider?: OAuthProviderId): Promise<void> {
    if (!this.pendingState) {
      if (provider && this.oauthFlowStartProvider && this.oauthFlowStartProvider !== provider)
        return;
      this.oauthFlowStartGeneration += 1;
      this.oauthFlowStartProvider = null;
      return;
    }
    if (provider && this.pendingState.provider !== provider) return;
    this.oauthFlowStartGeneration += 1;
    this.oauthFlowStartProvider = null;
    this.clearPendingState();
  }

  private clearPendingState(): void {
    if (!this.pendingState) {
      return;
    }

    clearTimeout(this.pendingState.timeout);
    this.pendingState = null;
  }

  private async notifyProviderLogout(
    provider: OAuthProviderId,
    accountIdentity?: string | null,
  ): Promise<void> {
    if (!this.onProviderLogout) {
      return;
    }

    await this.onProviderLogout(provider, accountIdentity);
  }

  private async notifyProvidersLogout(
    providers: readonly OAuthProviderId[],
    accountIdentities: ReadonlyMap<OAuthProviderId, string | null> = new Map(),
  ): Promise<void> {
    await Promise.all(
      providers.map((provider) =>
        this.notifyProviderLogout(provider, accountIdentities.get(provider)),
      ),
    );
  }

  private getAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(`不支持的 OAuth provider: ${provider}`);
    }

    return adapter;
  }

  private getEnabledAdapter(provider: OAuthProviderId): OAuthProviderAdapter {
    const adapter = this.getAdapter(provider);
    if (!adapter.meta.enabled) {
      throw new Error(`OAuth provider 未启用: ${provider}`);
    }

    return adapter;
  }

  private async resolveProvider(provider?: OAuthProviderId): Promise<OAuthProviderId | null> {
    if (provider) {
      return provider;
    }

    return this.repo.getActiveProvider();
  }

  private async runWithAdapterError<T>(
    adapter: OAuthProviderAdapter,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw adapter.normalizeError(error);
    }
  }

  private isUnauthorizedError(error: Error): boolean {
    const lowerMessage = error.message.toLowerCase();
    return (
      /\b401\b|\b403\b/.test(lowerMessage) ||
      lowerMessage.includes("unauthorized") ||
      lowerMessage.includes("forbidden")
    );
  }
}

/**
 * 工厂函数：创建 OAuthService 实例
 */
export function createOAuthService(
  credentialService: ICredentialService,
  dependencies: Omit<OAuthServiceDependencies, "adapters"> = {},
): OAuthService {
  return new OAuthService(credentialService, {
    ...dependencies,
    adapters: createOAuthProviderAdapters(createOAuthRuntimeConfig(dependencies.env), {
      apiClient: dependencies.apiClient,
    }),
  });
}
