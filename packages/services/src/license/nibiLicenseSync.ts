// license 的**宿主侧同步**：启动时与每次 NIBI 登录令牌写入后，跑一次
// `GET /licenses` 语义的在线检查（`refreshLicense`），把设备令牌写进共享凭据文件。
//
// 为什么需要这一层：agent 的收费插件门禁读的是 `nibi:license:token`，
// 而它只在"有人做过在线检查"之后才存在。只接登录不接同步 → 会员登录后仍被门禁拦。
import { randomUUID } from "node:crypto";
import type { ApiClient } from "@nibi/shared";
import type { ICredentialService } from "../credential/credential.js";
import {
  NIBI_ACCESS_TOKEN_KEY,
  refreshLicense,
  type LicenseCredentialStore,
  type NibiLicenseClientOptions,
} from "./nibiLicenseClient.js";
import {
  NIBI_LICENSE_STARTUP_REFRESH_MS,
  NIBI_LICENSE_STATE_KEY,
  NIBI_LICENSE_TOKEN_KEY,
  evaluateNibiLicense,
  parseLicenseSnapshot,
  type NibiLicenseDecision,
} from "./nibiLicense.js";

/** 设备标识：一次生成、长期复用；服务端 /licenses/check 要求 8–128 字符。 */
export const NIBI_DEVICE_ID_KEY = "nibi:device:id";

/** 当前登录账号的凭据键（OAuth 服务写；license 缓存与它绑定，换号即失效）。 */
export const NIBI_USER_INFO_KEY = "oauth:nibi:user_info";

/** user_info 是 JSON：`{ id, name?, email?, avatarUrl? }`；解析失败按"未知账号"处理。 */
export async function loadNibiAccountIdentity(
  credentialService: Pick<ICredentialService, "load">,
): Promise<string | null> {
  try {
    const raw = await credentialService.load(NIBI_USER_INFO_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { id?: unknown };
    return typeof parsed?.id === "string" && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}

export interface NibiLicenseSyncOptions {
  credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
  apiClient: ApiClient;
  /** 返回站点 origin（如 https://api.nibistudio.top）；内部拼 `/api/v1`。 */
  resolveEndpointOrigin: () => Promise<string> | string;
  now?: () => number;
  /** 验签公钥覆盖（测试与轮换用）。 */
  publicKeys?: Record<string, string>;
}

export interface NibiLicenseSync {
  /** 去重的在线检查；`force` 用于"刚登录/刚续费"。 */
  sync(force?: boolean): Promise<NibiLicenseDecision>;
  /**
   * 启动时检查：距上次在线检查超过 `NIBI_LICENSE_STARTUP_REFRESH_MS`，或上次被明确拒绝，
   * 就强制走一次 /licenses/check（撤销在一次重启内生效）；否则只读缓存。
   */
  syncOnStartup(): Promise<NibiLicenseDecision>;
  /** 退出登录/换账号时清掉本地凭证与快照。 */
  clear(): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 15_000;

/** 清除代际变化时：删除可能已写回的凭证，并把本次结果按"无凭证"处理。 */
function emptyDecision(options: NibiLicenseSyncOptions): NibiLicenseDecision {
  return evaluateNibiLicense({
    token: null,
    snapshot: parseLicenseSnapshot(null),
    now: options.now?.() ?? Date.now(),
    ...(options.publicKeys ? { publicKeys: options.publicKeys } : {}),
  });
}

export function createNibiLicenseSync(options: NibiLicenseSyncOptions): NibiLicenseSync {
  let inFlight: Promise<NibiLicenseDecision> | null = null;
  let inFlightForce = false;
  // clear() 的代际：代际变化后返回的旧 sync 结果必须作废，
  // 否则退出登录瞬间返回的旧响应会把 license 写回来（复活 bug）。
  let generation = 0;

  const credentials: LicenseCredentialStore = {
    load: (key) => options.credentialService.load(key),
    save: (key, value) => options.credentialService.save(key, value),
    delete: (key) => options.credentialService.delete(key),
  };

  async function ensureDeviceId(): Promise<string> {
    const existing = (await options.credentialService.load(NIBI_DEVICE_ID_KEY))?.trim() ?? "";
    if (existing.length >= 8 && existing.length <= 128) return existing;
    const created = randomUUID();
    await options.credentialService.save(NIBI_DEVICE_ID_KEY, created);
    return created;
  }

  async function buildOptions(
    force: boolean,
  ): Promise<NibiLicenseClientOptions & { force: boolean }> {
    const origin = (await options.resolveEndpointOrigin()).replace(/\/+$/, "");
    const accountIdentity = await loadNibiAccountIdentity(options.credentialService);
    return {
      apiBaseUrl: `${origin}/api/v1`,
      credentials,
      deviceId: await ensureDeviceId(),
      deviceName: "NIBI Desktop",
      platform: process.platform,
      now: options.now ?? Date.now,
      ...(options.publicKeys ? { publicKeys: options.publicKeys } : {}),
      ...(accountIdentity ? { accountIdentity } : {}),
      force,
      request: async ({ method, url, headers, body }) => {
        const response = await options.apiClient.request(url, {
          method,
          headers,
          // license 是 NIBI 自家端点，不能被 NIBI_BASE_URL 改写到上游。
          skipEndpointRewrite: true,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
        let parsed: unknown = {};
        try {
          parsed = await response.json();
        } catch {
          // 非 JSON（网关错误页等）按空体处理，交给上层按 status 归类。
        }
        return { status: response.status, body: parsed };
      },
      };
  }

  /** 清除代际变化时：删除可能已写回的凭证，并把本次结果按"无凭证"处理。 */
  const discardDecisionIfCleared = async (
    requestedGeneration: number,
    decision: NibiLicenseDecision,
  ): Promise<NibiLicenseDecision> => {
    if (requestedGeneration === generation) return decision;
    await Promise.all([
      options.credentialService.delete(NIBI_LICENSE_TOKEN_KEY),
      options.credentialService.delete(NIBI_LICENSE_STATE_KEY),
    ]);
    return emptyDecision(options);
  };

  return {
    sync(force = false) {
      // force 调用不能被"去重"吞掉：正在跑的是非 force 检查时，等它结束后必须真跑一次。
      if (inFlight) {
        if (!force || inFlightForce) return inFlight;
        const previous = inFlight;
        const requestedGeneration = generation;
        const run = (async () => {
          await previous.catch(() => undefined);
          const decision = await refreshLicense(await buildOptions(true));
          return await discardDecisionIfCleared(requestedGeneration, decision);
        })().finally(() => {
          if (inFlight === run) inFlight = null;
        });
        inFlight = run;
        inFlightForce = true;
        return run;
      }
      const requestedGeneration = generation;
      const run = (async () => {
        // 没有登录令牌也没有 license 时，连设备号都不生成：匿名用户的每次启动不该留下写盘痕迹。
        const [accessToken, licenseToken] = await Promise.all([
          credentials.load(NIBI_ACCESS_TOKEN_KEY),
          credentials.load(NIBI_LICENSE_TOKEN_KEY),
        ]);
        if (!accessToken?.trim() && !licenseToken?.trim()) {
          return evaluateNibiLicense({
            token: null,
            snapshot: parseLicenseSnapshot(await credentials.load(NIBI_LICENSE_STATE_KEY)),
            now: options.now?.() ?? Date.now(),
            ...(options.publicKeys ? { publicKeys: options.publicKeys } : {}),
          });
        }
        const decision = await refreshLicense(await buildOptions(force));
        // 清除发生在请求途中：把可能已写回的 license 再删一次，返回值按无凭证处理。
        return await discardDecisionIfCleared(requestedGeneration, decision);
      })().finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      inFlightForce = force;
      return run;
    },
    syncOnStartup() {
      if (inFlight) return inFlight;
      const requestedGeneration = generation;
      const run = (async () => {
        const [accessToken, licenseToken, rawState] = await Promise.all([
          credentials.load(NIBI_ACCESS_TOKEN_KEY),
          credentials.load(NIBI_LICENSE_TOKEN_KEY),
          credentials.load(NIBI_LICENSE_STATE_KEY),
        ]);
        const snapshot = parseLicenseSnapshot(rawState);
        if (!accessToken?.trim() && !licenseToken?.trim()) {
          // 匿名：保持"不生成设备号、不发请求"的边界。
          return evaluateNibiLicense({
            token: null,
            snapshot,
            now: options.now?.() ?? Date.now(),
            ...(options.publicKeys ? { publicKeys: options.publicKeys } : {}),
          });
        }
        const now = options.now?.() ?? Date.now();
        const lastCheckAt = snapshot?.lastCheckAt ? Date.parse(snapshot.lastCheckAt) : Number.NaN;
        const stale =
          !Number.isFinite(lastCheckAt) || now - lastCheckAt >= NIBI_LICENSE_STARTUP_REFRESH_MS;
        // 有 lastRefusal 时也要查：用户可能刚续费，启动正是清除拒绝状态的机会。
        const shouldRefresh = stale || snapshot?.lastRefusal != null;
        const decision = await refreshLicense(await buildOptions(shouldRefresh));
        return await discardDecisionIfCleared(requestedGeneration, decision);
      })().finally(() => {
        if (inFlight === run) inFlight = null;
      });
      inFlight = run;
      return run;
    },
    async clear() {
      // 先升代际再删：任何还在飞的 sync 完成后会把凭证再删一次，
      // 旧请求的 saveState 不能在退出登录后复活 license。
      generation += 1;
      await Promise.all([
        options.credentialService.delete(NIBI_LICENSE_TOKEN_KEY),
        options.credentialService.delete(NIBI_LICENSE_STATE_KEY),
      ]);
    },
  };
}
