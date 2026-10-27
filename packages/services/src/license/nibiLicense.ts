// NIBI 会员 license 的客户端侧（P1 收费通道 · 第 5 环的一半：状态与判定）。
//
// 设计要点：
// - **两个时钟**：license 的 `exp`（= 会员到期，硬边界）与在线检查的鲜度（软边界，72h + 7 天宽限）。
//   会员没到期但一直联不上网 → 宽限期内照用；服务端**明确拒绝**（401/403）→ 立即失效，不等宽限。
// - **验签是本地的事**：Ed25519 + 公钥（内置一份，未知 kid 时才去 /pubkey 取），断网也能判。
// - 本模块只做「状态与判定」，不碰 UI、不写死路径；设备号、凭据存取、HTTP 都由调用方注入——
//   这样才能在没有 Electron、没有 Zitadel 的单测里把判定表跑全。
import { createPublicKey, verify as edVerify } from "node:crypto";
import { NIBI_LICENSE_ISSUER, NIBI_LICENSE_PUBLIC_KEYS } from "@nibi/shared";

// 公钥表在 shared（agent 的收费插件门禁也要用同一份），这里保留同名导出兼容既有调用点。
export { NIBI_LICENSE_PUBLIC_KEYS };

export const NIBI_LICENSE_CHECK_INTERVAL_MS = 72 * 3600_000;
export const NIBI_LICENSE_OFFLINE_GRACE_MS = 7 * 86400_000;
/**
 * 启动时的撤销检查间隔。
 *
 * 72h 是"离线还能用多久"的软边界，不能用它决定"多久确认一次撤销"：后台撤销后用户
 * 重启客户端，旧快照仍然是 active，界面会继续显示"即将到期"，直到 72h 窗口到期。
 * 启动时若上次检查超过这个间隔（或有 lastRefusal），无论 license 是否 active 都强制
 * 走一次 /licenses/check；服务端明确拒绝会立刻写 refusal，判定层立即 deny。
 * 10 分钟：撤销后只要重启（或十分钟后再启动）就会生效，同时反复开关客户端不会打爆接口。
 */
export const NIBI_LICENSE_STARTUP_REFRESH_MS = 10 * 60_000;

/** 凭据键（都走 ICredentialService，加密落盘） */
export const NIBI_LICENSE_TOKEN_KEY = "nibi:license:token";
export const NIBI_LICENSE_STATE_KEY = "nibi:license:state";

export interface NibiLicenseClaims {
  iss: string;
  sub: string;
  uid: string;
  plan: string;
  plugins: string[];
  dev?: string;
  iat: number;
  exp: number;
  jti: string;
}

/** 缓存快照：判定只需要它 + 现在的时刻（快照是"上次在线时服务端说了什么"） */
export interface NibiLicenseSnapshot {
  deviceId: string;
  /** 上次成功在线检查的时刻（ISO） */
  lastCheckAt: string | null;
  /** 上次在线检查是否被明确拒绝（no_membership / membership_expired / device_mismatch） */
  lastRefusal: string | null;
  /** 上次在线检查拿到的会员状态里带的 plan（展示用） */
  plan?: string | null;
  expiresAt?: string | null;
}

export type NibiLicenseStatus = "active" | "grace" | "expired" | "not_activated" | "denied";

export interface NibiLicenseDecision {
  status: NibiLicenseStatus;
  /** 是否放行付费件 */
  allowed: boolean;
  /** 给用户看的原因（中文，UI 可直接展示；需要 i18n 时按 status 自己映射） */
  reason: string;
  claims: NibiLicenseClaims | null;
  /** 距离下次该在线检查还有多久（毫秒；<=0 表示该查了） */
  nextCheckInMs: number;
  /** 服务端该被调用的时刻（ISO）——调用方据此决定是否发 /check */
  nextCheckAt: string | null;
}

function b64urlDecode(segment: string): Buffer {
  return Buffer.from(segment, "base64url");
}

/**
 * 离线验签：只回答「这串字节确实由对应私钥签发、没被改过」。
 * 返回 null = 签名/结构不对（不是"会员无效"——那是判定层的事）。
 */
export function verifyLicenseToken(
  token: string,
  publicKeys: Record<string, string> = NIBI_LICENSE_PUBLIC_KEYS,
): { claims: NibiLicenseClaims; kid: string } | null {
  const parts = token.split(".");
  const [headerB64, payloadB64, sigB64] = parts;
  if (parts.length !== 3 || !headerB64 || !payloadB64 || !sigB64) return null;
  try {
    const header = JSON.parse(b64urlDecode(headerB64).toString("utf8")) as { kid?: string; alg?: string };
    const kid = header.kid ?? "";
    const pem = publicKeys[kid];
    if (!pem) return null;
    if (header.alg && header.alg !== "Ed25519") return null;
    const ok = edVerify(
      null,
      Buffer.from(`${headerB64}.${payloadB64}`, "utf8"),
      createPublicKey(pem),
      b64urlDecode(sigB64),
    );
    if (!ok) return null;
    const claims = JSON.parse(b64urlDecode(payloadB64).toString("utf8")) as NibiLicenseClaims;
    if (claims.iss !== NIBI_LICENSE_ISSUER) return null;
    return { claims, kid };
  } catch {
    return null;
  }
}

/** 授权范围判定（与服务端同一口径：["*"] 全放） */
export function licenseCoversPlugin(claims: NibiLicenseClaims | null, pluginName: string): boolean {
  if (!claims) return false;
  const list = claims.plugins ?? [];
  return list.includes("*") || list.includes(pluginName);
}

/**
 * 判定表（纯函数，单测覆盖全部行）：
 *
 * | 情形 | 结果 |
 * | --- | --- |
 * | 没有 token | not_activated（引导：输入激活码 / 开通会员） |
 * | 验签失败 | denied（token 坏了或被改过；清缓存重来） |
 * | 服务端明确拒绝过 | denied（不等宽限） |
 * | exp > now 且检查新鲜 | active |
 * | exp > now 但检查过期 | grace（宽限 ≤7 天）/ 否则 expired（该联网续期） |
 * | exp <= now | expired（会员到期，硬边界） |
 */
export function evaluateNibiLicense(params: {
  token: string | null;
  snapshot: NibiLicenseSnapshot | null;
  now?: number;
  publicKeys?: Record<string, string>;
}): NibiLicenseDecision {
  const now = params.now ?? Date.now();
  const snapshot = params.snapshot;
  const nextCheckFrom = (snapshot?.lastCheckAt ? Date.parse(snapshot.lastCheckAt) : 0) + NIBI_LICENSE_CHECK_INTERVAL_MS;
  const base = {
    claims: null as NibiLicenseClaims | null,
    nextCheckInMs: Math.max(0, nextCheckFrom - now),
    nextCheckAt: nextCheckFrom > 0 ? new Date(nextCheckFrom).toISOString() : null,
  };
  if (!params.token) {
    return { ...base, status: "not_activated", allowed: false, reason: "这台设备还没有激活会员（可用激活码激活）" };
  }
  const verified = verifyLicenseToken(params.token, params.publicKeys ?? NIBI_LICENSE_PUBLIC_KEYS);
  if (!verified) {
    return { ...base, status: "denied", allowed: false, reason: "会员凭证无法验证（请重新激活）" };
  }
  const { claims } = verified;
  const withClaims = { ...base, claims };
  const expMs = claims.exp * 1000;
  // 到期是硬边界，优先于任何服务端拒绝：会员过期后 /check 会返回 401/403 并写 refusal，
  // 若先看 refusal 就会把“到期”误报成“状态异常”（用户看到的正是这个）。
  if (expMs <= now) {
    return {
      ...withClaims,
      status: "expired",
      allowed: false,
      reason: "会员已到期，续费后继续使用",
      nextCheckInMs: 0,
      nextCheckAt: new Date(now).toISOString(),
    };
  }
  if (snapshot?.lastRefusal) {
    if (snapshot.lastRefusal === "membership_expired") {
      return {
        ...withClaims,
        status: "expired",
        allowed: false,
        reason: "会员已到期，续费后继续使用",
        nextCheckInMs: 0,
        nextCheckAt: new Date(now).toISOString(),
      };
    }
    if (snapshot.lastRefusal === "no_membership") {
      return { ...withClaims, status: "not_activated", allowed: false, reason: "该账号尚未开通会员" };
    }
    return { ...withClaims, status: "denied", allowed: false, reason: "会员已失效（服务端已拒绝）" };
  }
  if (nextCheckFrom <= now && now - nextCheckFrom > NIBI_LICENSE_OFFLINE_GRACE_MS) {
    // 超过 72h 就没能联上网，且宽限 7 天也过了 —— 该联网确认了
    return { ...withClaims, status: "expired", allowed: false, reason: "太久没有联网确认会员状态，请联网后重试", nextCheckInMs: 0 };
  }
  if (nextCheckFrom <= now) {
    return { ...withClaims, status: "grace", allowed: true, reason: "离线宽限中（联网后将自动确认）", nextCheckInMs: 0 };
  }
  return {
    ...withClaims,
    status: "active",
    allowed: true,
    reason: "会员有效",
    expiresAt: undefined,
  } as NibiLicenseDecision;
}

/** 快照解析（存的是 JSON 字符串；坏了当没有） */
export function parseLicenseSnapshot(raw: string | null): NibiLicenseSnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as NibiLicenseSnapshot;
    return parsed && typeof parsed.deviceId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** 把 /licenses 或 /check 的成功响应归一成"该缓存什么" */
export function snapshotFromResponse(params: {
  deviceId: string;
  now?: number;
  plan?: string | null;
  expiresAt?: string | null;
  refusal?: string | null;
}): NibiLicenseSnapshot {
  return {
    deviceId: params.deviceId,
    lastCheckAt: new Date(params.now ?? Date.now()).toISOString(),
    lastRefusal: params.refusal ?? null,
    plan: params.plan ?? null,
    expiresAt: params.expiresAt ?? null,
  };
}
