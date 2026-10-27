/**
 * 收费插件的本地门禁（agent 侧）。
 *
 * 为什么在 agent 里而不是 UI 里：安装/更新/描述都要走这条路径，CLI、桌面、远控共用；
 * 只挡 UI 的话，`zcode plugins install` 仍能把别人的付费 zip 装进来。
 *
 * 判定用的是**离线验签**（公钥在 @nibi/shared），网络只用于下载；下载时带上
 * `X-Nibi-License`，服务端还会再验一次（主防线在服务端）。
 */
import { createPublicKey, verify as edVerify } from "node:crypto";
import { NIBI_LICENSE_ISSUER, NIBI_LICENSE_PUBLIC_KEYS } from "@nibi/shared";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";

/** 与 services 侧同一个凭据键（OAuth/会员链写入，agent 读取）。 */
export const NIBI_LICENSE_TOKEN_KEY = "nibi:license:token";
export const NIBI_LICENSE_STATE_KEY = "nibi:license:state";

export type PaidPluginDenyReason =
  | "no_license"
  | "bad_license"
  | "expired"
  | "not_covered"
  | "denied";

export class PaidPluginMembershipError extends Error {
  readonly code = "plugin_membership_required" as const;

  constructor(
    readonly reason: PaidPluginDenyReason,
    message: string,
  ) {
    super(message);
    this.name = "PaidPluginMembershipError";
  }
}

export interface NibiLicenseClaims {
  iss: string;
  sub: string;
  uid?: string;
  plan?: string;
  plugins?: string[];
  dev?: string;
  iat?: number;
  exp: number;
}

function b64urlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

/** 验签 + 签发方校验；失败返回 null（与 services 侧的判定口径一致）。 */
export function verifyNibiLicenseToken(
  token: string,
  publicKeys: Record<string, string> = NIBI_LICENSE_PUBLIC_KEYS,
): NibiLicenseClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) return null;
  try {
    const header = JSON.parse(b64urlDecode(headerB64).toString("utf8")) as {
      alg?: string;
      kid?: string;
    };
    const pem = header.kid ? publicKeys[header.kid] : undefined;
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
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) return null;
    return claims;
  } catch {
    return null;
  }
}

export function licenseCoversPlugin(claims: NibiLicenseClaims | null, pluginName: string): boolean {
  if (!claims) return false;
  const list = claims.plugins ?? [];
  return list.includes("*") || list.includes(pluginName);
}

/** 同步读取 license 令牌（插件加载门禁是同步路径）。损坏/缺失都当没有。 */
export function readNibiLicenseTokenSync(
  env: Record<string, string | undefined> = process.env,
): string | null {
  try {
    return createSharedZCodeCredentialStore({ env }).loadSync(NIBI_LICENSE_TOKEN_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

/** 读上次在线检查的“服务端明确拒绝”状态（封禁/撤销/到期）；加载门禁是同步路径。 */
export function readNibiLicenseRefusalSync(
  env: Record<string, string | undefined> = process.env,
): string | null {
  try {
    const raw = createSharedZCodeCredentialStore({ env }).loadSync(NIBI_LICENSE_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lastRefusal?: unknown };
    return typeof parsed?.lastRefusal === "string" && parsed.lastRefusal ? parsed.lastRefusal : null;
  } catch {
    return null;
  }
}

/** 服务端 refusal 到用户可读原因的映射。所有拒绝都是"不能放行"，
 *  但把"从没开通过"说成"被暂停或撤销"会让新用户以为账号出了问题。 */
const PAID_PLUGIN_REFUSAL_MESSAGES: Record<string, string> = {
  no_membership:
    "该插件是会员专享插件：当前账号还没有开通 NIBI 会员，请先开通会员",
  membership_expired: "该插件需要有效的 NIBI 会员：当前会员已到期，续费后重试",
  device_mismatch:
    "会员凭证与这台设备不匹配，请在客户端账户菜单刷新会员状态后重试",
  not_entitled: "当前 NIBI 会员不包含该插件，请查看会员方案或联系支持",
};

/** 纯校验版（给定令牌）：加载门禁/启用前检查共用，避免重复读凭据。 */
export function resolvePaidPluginAccessFromToken(input: {
  token: string;
  pluginName: string;
  now?: number;
  publicKeys?: Record<string, string>;
  /** 上次在线检查的 refusal；有值 = 服务端已明确拒绝（含封禁），不能再放行。 */
  refusal?: string | null;
}): PaidPluginAccess {
  if (input.refusal) {
    throw new PaidPluginMembershipError(
      "denied",
      PAID_PLUGIN_REFUSAL_MESSAGES[input.refusal] ??
        "会员状态已被服务端暂停或撤销，请重新登录 NIBI 账号或联系支持",
    );
  }
  const token = input.token.trim();
  if (!token) {
    throw new PaidPluginMembershipError(
      "no_license",
      "该插件是会员专享插件：这台设备还没有 NIBI 会员凭证，请登录后开通会员",
    );
  }
  const claims = verifyNibiLicenseToken(token, input.publicKeys ?? NIBI_LICENSE_PUBLIC_KEYS);
  if (!claims) {
    throw new PaidPluginMembershipError(
      "bad_license",
      "会员凭证无法验证，请重新登录 NIBI 账号后重试",
    );
  }
  const now = input.now ?? Date.now();
  if (claims.exp * 1000 <= now) {
    throw new PaidPluginMembershipError(
      "expired",
      "该插件需要有效的 NIBI 会员：当前会员已到期，续费后重试",
    );
  }
  if (!licenseCoversPlugin(claims, input.pluginName)) {
    throw new PaidPluginMembershipError(
      "not_covered",
      "当前 NIBI 会员不包含该插件，请查看会员方案或联系支持",
    );
  }
  return { token, claims };
}

export interface PaidPluginAccess {
  token: string;
  claims: NibiLicenseClaims;
}

/**
 * 读取并校验收费插件的授权。任何一条不满足都抛 `PaidPluginMembershipError`，
 * 消息按“用户能照着做”的口径写（先登录并开通会员）。
 */
export async function resolvePaidPluginAccess(input: {
  credentialStore: Pick<SharedZCodeCredentialStore, "load">;
  pluginName: string;
  now?: number;
  /** 验签公钥覆盖（测试与轮换用；默认内置表）。 */
  publicKeys?: Record<string, string>;
}): Promise<PaidPluginAccess> {
  const [raw, stateRaw] = await Promise.all([
    input.credentialStore.load(NIBI_LICENSE_TOKEN_KEY),
    input.credentialStore.load(NIBI_LICENSE_STATE_KEY),
  ]);
  let refusal: string | null = null;
  try {
    const parsed = stateRaw ? (JSON.parse(stateRaw) as { lastRefusal?: unknown }) : null;
    refusal = typeof parsed?.lastRefusal === "string" && parsed.lastRefusal ? parsed.lastRefusal : null;
  } catch {
    refusal = null;
  }
  return resolvePaidPluginAccessFromToken({
    token: raw ?? "",
    pluginName: input.pluginName,
    refusal,
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.publicKeys ? { publicKeys: input.publicKeys } : {}),
  });
}
