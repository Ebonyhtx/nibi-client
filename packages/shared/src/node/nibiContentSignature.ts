/**
 * NIBI content signature verification.
 *
 * Published manifests and configuration releases carry a detached `.sig`
 * sidecar: the Ed25519 signature of the object's raw bytes, encoded as hex.
 * The public keys below are baked into the client so that content hosts can be
 * verified without a network round trip; rotation requires a client release.
 *
 * Only NIBI content hosts are required to be signed. User-added marketplaces
 * and third-party sources are not affected. A failed verification is treated
 * as a failed fetch: callers keep their last successful snapshot instead of
 * accepting partially trusted content.
 *
 * Signatures provide integrity only. Rollback protection is the caller's
 * monotonic revision check.
 *
 * Key rotation: the `.sig` sidecar may carry an optional `<kid>:<hex>` prefix.
 * A bare 128-hex signature is verified with the default kid, so old signatures
 * keep working. The key table keeps every kid the client trusts; rotating the
 * signing key appends a new kid here and releases a client that knows both, so
 * a rotation never requires reinstalling plugins or changing plugin ids.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { NIBI_PRIMARY_CONTENT_HOSTS } from "../nibiContentHosts.js";

/** DER/SPKI base64 of the NIBI content-signing public key. */
export const NIBI_CONTENT_SIGNING_PUBLIC_KEY_SPKI_BASE64 =
  "MCowBQYDK2VwAyEAfjUkJYlbWMyNQOR1E7m+/a0USdAUZYp7GHFoSsQlQ7k=";

/**
 * kid → DER/SPKI base64 公钥表。
 *
 * 为什么要 kid：`.sig` 允许 `<kid>:<hex>` 前缀，发布链轮换密钥时只需把新 kid
 * 追加进这张表；旧客户端仍按默认 kid 验证旧签名，新客户端同时认旧/新 kid，
 * 轮换窗口内不会出现「客户端升级后反而验不过旧清单」或「旧客户端拒绝新签名」。
 * 未知 kid 一律 fail-closed（false），不能静默退回默认公钥——否则伪造者只要
 * 换个 kid 就能让验签落到一把已知公钥上。
 */
export const NIBI_CONTENT_SIGNING_PUBLIC_KEYS: Readonly<Record<string, string>> = {
  k1: NIBI_CONTENT_SIGNING_PUBLIC_KEY_SPKI_BASE64,
};

/** 裸 128-hex 签名（无 kid 前缀）使用的默认 kid。 */
export const NIBI_CONTENT_SIGNING_DEFAULT_KID = "k1";

/** NIBI content hosts that must be signed (https only). */
const SIGNED_HOSTS = NIBI_PRIMARY_CONTENT_HOSTS;

const SIGNATURE_HEX_PATTERN = /^[0-9a-fA-F]{128}$/u;
// kid 只允许可打印、无分隔符的短标识：`<kid>:<hex>` 里出现空白/冒号都视为坏格式，
// 避免把畸形签名误当成「kid 为空」再回落到默认公钥。
const KID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;

/**
 * createPublicKey 有固定开销，而验签在每次市场刷新/撤销列表刷新都会跑；
 * 按 SPKI 字符串缓存解析结果（同一 kid 的多份内容共享同一把 KeyObject）。
 */
const publicKeyCache = new Map<string, KeyObject>();

function loadPublicKey(spkiBase64: string): KeyObject {
  const cached = publicKeyCache.get(spkiBase64);
  if (cached) return cached;
  const publicKey = createPublicKey({
    key: Buffer.from(spkiBase64, "base64"),
    format: "der",
    type: "spki",
  });
  publicKeyCache.set(spkiBase64, publicKey);
  return publicKey;
}

/** Whether the URL is a NIBI content host that must carry a signature. */
export function isNibiSignedContentUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    return SIGNED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Verify with an explicit public key. The production path uses the baked key
 * below; this entry point exists so tests can inject a key pair.
 *
 * 保持原有语义：只接受裸 128 hex，不接受 `<kid>:<hex>`（调用方显式给了公钥，
 * 再做 kid 查找只会引入歧义）。
 */
export function verifyContentSignatureWithKey(
  payload: Uint8Array,
  signatureHex: string,
  publicKeySpkiBase64: string,
): boolean {
  const hex = signatureHex.trim();
  if (!SIGNATURE_HEX_PATTERN.test(hex)) return false;
  try {
    return verify(null, payload, loadPublicKey(publicKeySpkiBase64), Buffer.from(hex, "hex"));
  } catch {
    return false;
  }
}

export interface NibiContentSignatureVerifyOptions {
  /**
   * 公钥表覆盖（测试/轮换验证用）。缺省用内置表；显式传入时不会与内置表合并，
   * 这样测试可以完整控制可信集合。
   */
  publicKeys?: Readonly<Record<string, string>>;
  /** 裸 hex 使用的 kid；缺省 "k1"。 */
  defaultKid?: string;
}

/**
 * 解析 `<kid>:<hex>` 或裸 `<hex>`。冒号前的 kid 必须形如 `[A-Za-z0-9._-]{1,64}`，
 * 否则返回 null（坏格式 fail-closed）。hex 的格式校验交给验签入口，避免两处规则漂移。
 */
function parseContentSignature(
  raw: string,
  defaultKid: string,
): { kid: string; hex: string } | null {
  const trimmed = raw.trim();
  const separator = trimmed.indexOf(":");
  if (separator < 0) return { kid: defaultKid, hex: trimmed };
  const kid = trimmed.slice(0, separator).trim();
  const hex = trimmed.slice(separator + 1).trim();
  if (!KID_PATTERN.test(kid)) return null;
  return { kid, hex };
}

/**
 * Verify payload bytes against a hex or `<kid>:<hex>` signature.
 *
 * - 裸 128 hex：用默认 kid（k1）验证，兼容所有已发布内容。
 * - `<kid>:<hex>`：按 kid 查表；未知 kid / 坏格式一律 false。
 * 任何错误都返回 false，调用方据此保留上一份成功快照。
 */
export function verifyNibiContentSignature(
  payload: Uint8Array,
  signatureHex: string,
  options: NibiContentSignatureVerifyOptions = {},
): boolean {
  const publicKeys = options.publicKeys ?? NIBI_CONTENT_SIGNING_PUBLIC_KEYS;
  const defaultKid = options.defaultKid ?? NIBI_CONTENT_SIGNING_DEFAULT_KID;
  const parsed = parseContentSignature(signatureHex, defaultKid);
  if (!parsed) return false;
  const publicKeySpkiBase64 = publicKeys[parsed.kid];
  if (!publicKeySpkiBase64) return false;
  return verifyContentSignatureWithKey(payload, parsed.hex, publicKeySpkiBase64);
}
