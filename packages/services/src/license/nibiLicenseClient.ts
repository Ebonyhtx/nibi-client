// NIBI 会员 license 的**取用侧**（P1 收费通道 · 第 5 环）：缓存、按需在线检查、激活。
// 判定逻辑在 nibiLicense.ts（纯函数）；这里只负责"跟服务端说什么、说完缓存什么、失败怎么归类"。
//
// 失败分类是老实话的分界线：
// - **网络错**（连不上、超时、5xx）→ 不动缓存，判定层走 grace（离线用户不该被误伤）
// - **明确拒绝**（401/403 + reason）→ 写 lastRefusal，判定层立刻 deny（撤销要立刻生效）
import { NIBI_PROVIDER_ID } from "@nibi/shared";
import {
  NIBI_LICENSE_OFFLINE_GRACE_MS,
  NIBI_LICENSE_STATE_KEY,
  NIBI_LICENSE_TOKEN_KEY,
  evaluateNibiLicense,
  parseLicenseSnapshot,
  snapshotFromResponse,
  type NibiLicenseDecision,
  type NibiLicenseSnapshot,
} from "./nibiLicense.js";

/** 登录令牌的存储键（OAuth 服务写，license 检查读；两条链在这里交汇）。 */
export const NIBI_ACCESS_TOKEN_KEY = `oauth:${NIBI_PROVIDER_ID}:access_token`;

export interface LicenseCredentialStore {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface LicenseHttpResponse {
  status: number;
  body: unknown;
}

export interface NibiLicenseClientOptions {
  credentials: LicenseCredentialStore;
  deviceId: string;
  /** API 基址，例如 https://api.nibistudio.top/api/v1 */
  apiBaseUrl: string;
  request: (
    init: { method: "GET" | "POST"; url: string; headers?: Record<string, string>; body?: unknown },
  ) => Promise<LicenseHttpResponse>;
  now?: () => number;
  deviceName?: string;
  platform?: string;
  /** 登录令牌来源；默认读 credentials 里的 oauth:nibi:access_token。 */
  accessToken?: () => Promise<string | null>;
  /** 验签公钥表（默认用内置的那把；测试与轮换时传入覆盖） */
  publicKeys?: Record<string, string>;
}

export interface CachedLicense {
  token: string | null;
  snapshot: NibiLicenseSnapshot | null;
}

function decide(
  opts: NibiLicenseClientOptions,
  token: string | null,
  snapshot: NibiLicenseSnapshot | null,
  now: number,
): NibiLicenseDecision {
  return evaluateNibiLicense({ token, snapshot, now, publicKeys: opts.publicKeys });
}

async function loadCached(opts: NibiLicenseClientOptions): Promise<CachedLicense> {
  const [token, rawState] = await Promise.all([
    opts.credentials.load(NIBI_LICENSE_TOKEN_KEY),
    opts.credentials.load(NIBI_LICENSE_STATE_KEY),
  ]);
  return { token: token?.trim() || null, snapshot: parseLicenseSnapshot(rawState) };
}

async function loadAccessToken(opts: NibiLicenseClientOptions): Promise<string | null> {
  if (opts.accessToken) {
    const value = await opts.accessToken();
    return value?.trim() || null;
  }
  const raw = await opts.credentials.load(NIBI_ACCESS_TOKEN_KEY);
  return raw?.trim() || null;
}

async function saveState(
  opts: NibiLicenseClientOptions,
  token: string | null,
  snapshot: NibiLicenseSnapshot,
): Promise<void> {
  if (token) await opts.credentials.save(NIBI_LICENSE_TOKEN_KEY, token);
  await opts.credentials.save(NIBI_LICENSE_STATE_KEY, JSON.stringify(snapshot));
}

/** 只判不定：读缓存 → 判定（不联网）。UI 打开价格/门禁判定用它。 */
export async function readLicenseDecision(opts: NibiLicenseClientOptions): Promise<NibiLicenseDecision> {
  const cached = await loadCached(opts);
  return decide(opts, cached.token, cached.snapshot, opts.now?.() ?? Date.now());
}

function unauthorized(status: number): boolean {
  return status === 401 || status === 403;
}

/**
 * 需要时做一次在线检查（72h 一次；`force` 用于"用户点了重试"）。
 * 返回判定结果；网络失败**不改写**缓存（交给 grace）。
 */
export async function refreshLicense(
  opts: NibiLicenseClientOptions & { force?: boolean; plugins?: string[] },
): Promise<NibiLicenseDecision> {
  const now = opts.now?.() ?? Date.now();
  const cached = await loadCached(opts);
  const before = decide(opts, cached.token, cached.snapshot, now);
  const due = opts.force === true || before.status !== "active" && before.nextCheckInMs <= 0;
  if (!due) return before;

  // 两条身份的分工：
  // - license 头是设备绑定的离线凭证，日常检查走它（登录令牌过期也不影响）；
  // - 但 license 已过期/验不过时，用登录令牌换一份新的（续费后正是这条路）。
  const licenseUsable = Boolean(
    cached.token && before.claims && before.claims.exp * 1000 > now,
  );
  let headers: Record<string, string> | null = null;
  if (licenseUsable) {
    headers = { "X-Nibi-License": cached.token as string };
  } else {
    const accessToken = await loadAccessToken(opts);
    if (accessToken) {
      headers = { Authorization: `Bearer ${accessToken}` };
    }
  }
  if (!headers) return before;

  let res: LicenseHttpResponse;
  try {
    res = await opts.request({
      method: "POST",
      url: `${opts.apiBaseUrl}/licenses/check`,
      headers: { ...headers, "Content-Type": "application/json" },
      body: {
        deviceId: opts.deviceId,
        deviceName: opts.deviceName,
        platform: opts.platform,
        plugins: opts.plugins,
      },
    });
  } catch {
    // 网络失败：保持原判定（grace 里照用），什么都不写
    return decide(opts, cached.token, cached.snapshot, now);
  }

  if (res.status === 401 && !licenseUsable) {
    // 登录令牌可能只是过期了；这不代表会员被撤销，不能写拒绝把离线会员一棒打死。
    return before;
  }

  const body = (res.body ?? {}) as {
    authorized?: boolean;
    reason?: string | null;
    license?: { token?: string; expiresAt?: string | null; plan?: string | null } | null;
    membership?: { status?: string; expiresAt?: string | null; plan?: string | null } | null;
  };

  if (res.status === 200 && body.authorized === true && body.license?.token) {
    const snapshot = snapshotFromResponse({
      deviceId: opts.deviceId,
      now,
      plan: body.license.plan ?? body.membership?.plan ?? null,
      expiresAt: body.license.expiresAt ?? body.membership?.expiresAt ?? null,
    });
    await saveState(opts, body.license.token, snapshot);
    return decide(opts, body.license.token, snapshot, now);
  }

  if (unauthorized(res.status) || body.authorized === false) {
    // 明确被拒：写 refusal（判定层立刻 deny），token 留着——续费后同一设备可以直接再检查
    const snapshot = snapshotFromResponse({
      deviceId: opts.deviceId,
      now,
      refusal: body.reason ?? `http_${res.status}`,
      plan: null,
      expiresAt: body.membership?.expiresAt ?? null,
    });
    await saveState(opts, cached.token, snapshot);
    return decide(opts, cached.token, snapshot, now);
  }

  // 其他（5xx/解析异常）：不写缓存
  return decide(opts, cached.token, cached.snapshot, now);
}

/** 激活码激活（免登录路）：成功即落地 token 与快照；返回判定结果。 */
export async function activateLicenseWithCode(
  opts: NibiLicenseClientOptions,
  code: string,
): Promise<{ ok: boolean; decision: NibiLicenseDecision; error?: string }> {
  const now = opts.now?.() ?? Date.now();
  let res: LicenseHttpResponse;
  try {
    res = await opts.request({
      method: "POST",
      url: `${opts.apiBaseUrl}/licenses/activate`,
      headers: { "Content-Type": "application/json" },
      body: {
        code: code.trim(),
        deviceId: opts.deviceId,
        deviceName: opts.deviceName,
        platform: opts.platform,
      },
    });
  } catch (e) {
    return {
      ok: false,
      decision: decide(opts, null, null, now),
      error: `网络不可用：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const body = (res.body ?? {}) as {
    authorized?: boolean;
    error?: string;
    reason?: string;
    license?: { token?: string; expiresAt?: string | null; plan?: string | null } | null;
  };
  if (res.status === 200 && body.authorized === true && body.license?.token) {
    const snapshot = snapshotFromResponse({
      deviceId: opts.deviceId,
      now,
      plan: body.license.plan ?? null,
      expiresAt: body.license.expiresAt ?? null,
    });
    await saveState(opts, body.license.token, snapshot);
    return { ok: true, decision: decide(opts, body.license.token, snapshot, now) };
  }
  return {
    ok: false,
    decision: decide(opts, null, null, now),
    error: body.error ?? body.reason ?? `激活失败（HTTP ${res.status}）`,
  };
}

/** 退出登录/换账号时的清理（激活路没有账号，只有"取消激活"用得上） */
export async function clearLicenseCache(opts: NibiLicenseClientOptions): Promise<void> {
  await Promise.all([
    opts.credentials.delete(NIBI_LICENSE_TOKEN_KEY),
    opts.credentials.delete(NIBI_LICENSE_STATE_KEY),
  ]);
}

/** 给 UI/门禁用的一句话摘要（不联网） */
export function describeLicenseDecision(d: NibiLicenseDecision): string {
  switch (d.status) {
    case "active":
      return `NIBI 会员有效${d.claims?.plan ? `（${d.claims.plan}）` : ""}`;
    case "grace":
      return `NIBI 会员（离线宽限中，最迟 ${new Date((d.claims?.exp ?? 0) * 1000).toLocaleDateString()} 到期）`;
    case "expired":
      return "NIBI 会员已到期";
    case "not_activated":
      return "未激活 NIBI 会员";
    case "denied":
    default:
      return "NIBI 会员不可用";
  }
}

export { NIBI_LICENSE_OFFLINE_GRACE_MS };
