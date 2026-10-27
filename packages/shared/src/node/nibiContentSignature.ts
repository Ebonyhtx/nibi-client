/**
 * NIBI content signature verification.
 *
 * Published manifests and configuration releases carry a detached `.sig`
 * sidecar: the Ed25519 signature of the object's raw bytes, encoded as hex.
 * The public key below is baked into the client so that content hosts can be
 * verified without a network round trip; rotation requires a client release.
 *
 * Only NIBI content hosts are required to be signed. User-added marketplaces
 * and third-party sources are not affected. A failed verification is treated
 * as a failed fetch: callers keep their last successful snapshot instead of
 * accepting partially trusted content.
 *
 * Signatures provide integrity only. Rollback protection is the caller's
 * monotonic revision check.
 */
import { createPublicKey, verify } from "node:crypto";
import { isNibiMirrorContentUrl } from "../nibiContentMirror.js";

/** DER/SPKI base64 of the NIBI content-signing public key. */
export const NIBI_CONTENT_SIGNING_PUBLIC_KEY_SPKI_BASE64 =
  "MCowBQYDK2VwAyEAfjUkJYlbWMyNQOR1E7m+/a0USdAUZYp7GHFoSsQlQ7k=";

/** NIBI content hosts that must be signed (https only). */
const SIGNED_HOSTS = new Set(["api.nibistudio.top", "dl.nibistudio.top"]);

let cachedPublicKey: ReturnType<typeof createPublicKey> | undefined;

/** Whether the URL is a NIBI content host that must carry a signature. */
export function isNibiSignedContentUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    return SIGNED_HOSTS.has(url.hostname) || isNibiMirrorContentUrl(raw);
  } catch {
    return false;
  }
}

/**
 * Verify with an explicit public key. The production path uses the baked key
 * below; this entry point exists so tests can inject a key pair.
 */
export function verifyContentSignatureWithKey(
  payload: Uint8Array,
  signatureHex: string,
  publicKeySpkiBase64: string,
): boolean {
  const hex = signatureHex.trim();
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(publicKeySpkiBase64, "base64"),
      format: "der",
      type: "spki",
    });
    return verify(null, payload, publicKey, Buffer.from(hex, "hex"));
  } catch {
    return false;
  }
}

/** Verify payload bytes against a hex signature. Any error returns false. */
export function verifyNibiContentSignature(payload: Uint8Array, signatureHex: string): boolean {
  const hex = signatureHex.trim();
  if (!/^[0-9a-fA-F]{128}$/.test(hex)) return false;
  cachedPublicKey ??= createPublicKey({
    key: Buffer.from(NIBI_CONTENT_SIGNING_PUBLIC_KEY_SPKI_BASE64, "base64"),
    format: "der",
    type: "spki",
  });
  try {
    return verify(null, payload, cachedPublicKey, Buffer.from(hex, "hex"));
  } catch {
    return false;
  }
}
