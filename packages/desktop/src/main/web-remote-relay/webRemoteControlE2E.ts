// E2E 信封与握手 v1 的桌面侧镜像（规格：D:\NIBI-GO\docs\design\e2e-envelope-v1.md）。
//
// 载体是 relay data payload（服务端 `data.payload` 是 z.json() 不透明透传，零改动），
// 因此握手帧和密文帧都走 terminal 侧同一个 data 口；keyneg-* 必须保持明文，
// 手机在握手完成前只认明文 keyneg，`enc` 则必须在桌面业务管线之前被解开。
//
// 安全边界（写清根因，后续改动不要放宽）：
// 1) K 只存在于内存，且是会话级的（决议 P3b）：每次 socket 重建都调用 reset() 丢弃，
//    旧连接上的密文在新连接上 GCM 认证必然失败 → 整帧丢弃。桌面不持久化任何密钥材料。
// 2) 桌面是纯响应端：不发 keyneg-init、不计 3s 超时（降级判定在手机侧）。旧手机不发 init
//    就一直是明文；PWA 走 packages/web 的独立链路，与本模块无关，永远明文。
// 3) 握手是未认证的临时 ECDH：能主动改 data 帧的 relay 仍可在首次握手时做中间人，
//    这是 v1 的已知边界（device 级持久身份/轮换留待 C 立项）。本模块只保证"协商完成后"
//    帧的机密性、完整性与防重放，不把 relay 当成可信第三方来扩张信任面。
// 4) 解密失败/非法材料一律不抛给 transport：丢弃该帧、连接继续（与"旧对端"同一条 fail-safe
//    路径），避免一条坏帧把整条远控连接打断。
//
// 与规格文字的一处差异（按手机实现为准）：§2 把 keyneg nonce 写成 32B，但手机
// `packages/relay-client/src/handshake.ts` 用的是 E2E_NONCE_BYTES=24 并在 acceptResponse 里
// 硬校验 24B；桌面若按 32B 收发会直接被判非法，因此这里镜像 24B（KDF salt 实际 48B）。
import { randomBytes } from "node:crypto";

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const E2E_ENVELOPE_VERSION = 1;
export const E2E_KEY_BYTES = 32;
export const E2E_PUBLIC_KEY_BYTES = 32;
/** XChaCha20 信封 nonce（24B）；同时是 keyneg nonce 长度，见文件头的规格差异说明。 */
export const E2E_NONCE_BYTES = 24;
export const E2E_KEYNEG_VERSION = 1;
export const E2E_ENVELOPE_TYPE = "enc";
export const E2E_KEYNEG_INIT_TYPE = "keyneg-init";
export const E2E_KEYNEG_RESPONSE_TYPE = "keyneg-response";
/** RFC 4648 base64（带 padding）；与手机 shared-extract 的 topicWireBase64Schema 同一形状。 */
const WIRE_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const KDF_INFO_PREFIX = "nibi-e2e-v1|";

/** relay data payload 的密文信封（决议 P3c：JSON 文本帧，字段 base64）。 */
export interface EncryptedPayload {
  nibi_type: "enc";
  v: number;
  /** XChaCha20 nonce：24B base64。 */
  n: string;
  /** 密文 + 16B Poly1305 tag：base64。 */
  ct: string;
}

/** terminal → desktop 的协商首帧（桌面只消费、不回键）。 */
export type KeyNegInitPayload = {
  nibi_type: "keyneg-init";
  v: number;
  /** X25519 临时公钥 32B base64。 */
  pub: string;
  /** 24B 随机 base64（参与 KDF salt 与防重放）。 */
  nonce: string;
};

/** desktop → terminal 的协商回帧。 */
export type KeyNegResponsePayload = {
  nibi_type: "keyneg-response";
  v: number;
  pub: string;
  nonce: string;
};

/** D11：cipher 走接口抽象，Android/桌面可用 libsodium 替换 @noble，密文格式不变。 */
export interface Cipher {
  encrypt(plain: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array;
  decrypt(ciphertext: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array;
}

export const xchachaCipher: Cipher = {
  encrypt: (plain, key, nonce) => xchacha20poly1305(key, nonce).encrypt(plain),
  decrypt: (ciphertext, key, nonce) => xchacha20poly1305(key, nonce).decrypt(ciphertext),
};

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function decodeBase64(value: string): Uint8Array | null {
  // Buffer.from(..., "base64") 对非法字符和错误 padding 是宽容的；先按 schema 形状过滤，
  // 再要求 re-encode 完全一致，保证两端字节级同一串（手机侧同样校验 canonical base64）。
  if (value.length < 4 || !WIRE_BASE64_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, "base64");
  if (encodeBase64(decoded) !== value) return null;
  return new Uint8Array(decoded);
}

/**
 * K = HKDF-SHA256(shared, salt = clientNonce ‖ serverNonce, info = "nibi-e2e-v1|<context>", 32)。
 * context 用 deviceSid 做域分离（双方已知、非秘密），防跨设备串用。
 */
export function deriveSessionKey(params: {
  sharedSecret: Uint8Array;
  clientNonce: Uint8Array;
  serverNonce: Uint8Array;
  context: string;
}): Uint8Array {
  const salt = new Uint8Array(params.clientNonce.length + params.serverNonce.length);
  salt.set(params.clientNonce, 0);
  salt.set(params.serverNonce, params.clientNonce.length);
  const info = new TextEncoder().encode(`${KDF_INFO_PREFIX}${params.context}`);
  return hkdf(sha256, params.sharedSecret, salt, info, E2E_KEY_BYTES);
}

/** 业务 payload → 密文信封；nonce 默认每次随机 24B（XChaCha20 空间足够，碰撞可忽略）。 */
export function sealPayload(
  plain: unknown,
  key: Uint8Array,
  nonce: Uint8Array = new Uint8Array(randomBytes(E2E_NONCE_BYTES)),
  cipher: Cipher = xchachaCipher,
): EncryptedPayload {
  if (key.length !== E2E_KEY_BYTES) throw new Error("E2E key must be 32 bytes");
  if (nonce.length !== E2E_NONCE_BYTES) throw new Error("E2E nonce must be 24 bytes");
  const plaintext = new TextEncoder().encode(JSON.stringify(plain));
  return {
    nibi_type: E2E_ENVELOPE_TYPE,
    v: E2E_ENVELOPE_VERSION,
    n: encodeBase64(nonce),
    ct: encodeBase64(cipher.encrypt(plaintext, key, nonce)),
  };
}

/** 错钥/篡改/版本不符/非法 base64 → null（调用方丢弃该帧，不断连）。 */
export function openPayload(
  envelope: EncryptedPayload,
  key: Uint8Array,
  cipher: Cipher = xchachaCipher,
): unknown | null {
  if (envelope.v !== E2E_ENVELOPE_VERSION) return null;
  const nonce = decodeBase64(envelope.n);
  const ciphertext = decodeBase64(envelope.ct);
  if (!nonce || nonce.length !== E2E_NONCE_BYTES) return null;
  // 最短密文 = 空明文 + 16B tag。
  if (!ciphertext || ciphertext.length < 16) return null;
  try {
    return JSON.parse(new TextDecoder().decode(cipher.decrypt(ciphertext, key, nonce))) as unknown;
  } catch {
    return null;
  }
}

export function isEncryptedPayload(payload: unknown): payload is EncryptedPayload {
  if (!payload || typeof payload !== "object") return false;
  const record = payload as Record<string, unknown>;
  return (
    record.nibi_type === E2E_ENVELOPE_TYPE &&
    typeof record.v === "number" &&
    typeof record.n === "string" &&
    typeof record.ct === "string"
  );
}

export interface ParsedKeyNegInit {
  publicKey: Uint8Array;
  nonce: Uint8Array;
}

/**
 * 严格校验 keyneg-init：版本必须为 1、pub 必须 canonical base64 的 32B、nonce 必须 24B。
 * 任一不符返回 null（调用方按"非法材料"降级明文，不回包）。
 */
export function parseKeyNegInit(payload: unknown): ParsedKeyNegInit | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (record.nibi_type !== E2E_KEYNEG_INIT_TYPE || record.v !== E2E_KEYNEG_VERSION) return null;
  if (typeof record.pub !== "string" || typeof record.nonce !== "string") return null;
  const publicKey = decodeBase64(record.pub);
  const nonce = decodeBase64(record.nonce);
  if (!publicKey || publicKey.length !== E2E_PUBLIC_KEY_BYTES) return null;
  if (!nonce || nonce.length !== E2E_NONCE_BYTES) return null;
  return { publicKey, nonce };
}

/**
 * 桌面对一次 keyneg-init 的密钥协商（纯函数，便于用固定临时密钥做确定性断言）。
 * 临时私钥固定 32B；低阶点/非法公钥由 @noble 抛出或全零共享密钥识别 → null。
 */
export function buildKeyNegResponse(params: {
  clientPublicKey: Uint8Array;
  clientNonce: Uint8Array;
  context: string;
  secretKey: Uint8Array;
  nonce: Uint8Array;
}): { response: KeyNegResponsePayload; key: Uint8Array } | null {
  if (params.secretKey.length !== E2E_PUBLIC_KEY_BYTES) return null;
  if (params.nonce.length !== E2E_NONCE_BYTES) return null;
  let sharedSecret: Uint8Array;
  try {
    sharedSecret = x25519.getSharedSecret(params.secretKey, params.clientPublicKey);
  } catch {
    return null;
  }
  // 低阶点会得到全零共享密钥；@noble 部分版本已抛错，这里再兜一层，宁可降级也不协商出可预测的 K。
  if (sharedSecret.every((byte) => byte === 0)) return null;
  return {
    response: {
      nibi_type: E2E_KEYNEG_RESPONSE_TYPE,
      v: E2E_KEYNEG_VERSION,
      pub: encodeBase64(x25519.getPublicKey(params.secretKey)),
      nonce: encodeBase64(params.nonce),
    },
    key: deriveSessionKey({
      sharedSecret,
      clientNonce: params.clientNonce,
      serverNonce: params.nonce,
      context: params.context,
    }),
  };
}

export type DesktopE2EState = "plaintext" | "secure";

export type DesktopE2EDropReason =
  /** keyneg-init 版本/长度/base64/低阶点非法，或注入的临时密钥非法。 */
  | "keyneg-invalid"
  /** 桌面不该收到的 keyneg-response（协商没有桌面发起的一段）。 */
  | "keyneg-unexpected"
  /** 握手完成前收到的 enc：规格 §4 要求丢弃。 */
  | "enc-before-handshake"
  /** 版本不符/非法 base64/错钥/篡改。 */
  | "enc-rejected";

export type DesktopE2EIncomingResult =
  /** 明文帧，原样进入业务管线（旧对端/降级/控制帧）。 */
  | { kind: "pass"; payload: unknown }
  /** 解密后的业务帧（与明文帧走同一管线）。 */
  | { kind: "opened"; payload: unknown }
  /** 需要立刻回给 terminal 的明文协商帧；不进业务面。 */
  | { kind: "keyneg-response"; response: KeyNegResponsePayload }
  /** 丢弃该帧，连接与状态不变。 */
  | { kind: "dropped"; reason: DesktopE2EDropReason };

export interface DesktopE2EChannelOptions {
  /**
   * KDF 域分离上下文（deviceSid）。做成惰性取值：transport 的 deviceSid 先于 socket 就绪，
   * 且每次重注册可能更新，取值时机必须在处理 init 的那一刻。
   */
  context(): string;
  /** 测试注入固定临时密钥；生产缺省每次握手随机（每次建连新建，不复用）。 */
  createEphemeral?(): { secretKey: Uint8Array; nonce: Uint8Array };
  /** 仅观测 plaintext→secure 迁移；reset() 不回调（连接状态本身已有日志）。 */
  onStateChange?(state: DesktopE2EState): void;
}

/**
 * 桌面侧信封状态机：plaintext（默认，等价"未加密连接"）→ secure。
 * 桌面不发起协商、不计时；只有收到合法 keyneg-init 才进入 secure。
 */
export class DesktopE2EChannel {
  private current: DesktopE2EState = "plaintext";
  private key?: Uint8Array;

  constructor(private readonly options: DesktopE2EChannelOptions) {}

  get state(): DesktopE2EState {
    return this.current;
  }

  get secure(): boolean {
    return this.current === "secure";
  }

  /** 收到 data payload：分类为 明文 / 已解密 / 需回包 / 丢弃；永不抛出。 */
  handleIncoming(payload: unknown): DesktopE2EIncomingResult {
    const type =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).nibi_type
        : undefined;
    if (type === E2E_KEYNEG_INIT_TYPE) return this.negotiate(payload);
    if (type === E2E_KEYNEG_RESPONSE_TYPE) return { kind: "dropped", reason: "keyneg-unexpected" };
    if (type === E2E_ENVELOPE_TYPE) return this.open(payload);
    return { kind: "pass", payload };
  }

  /** 出向包装：secure 后业务 payload 一律 enc；keyneg 自身永远明文。 */
  wrapOutgoing(payload: unknown): unknown {
    if (this.current !== "secure" || !this.key) return payload;
    const type =
      payload && typeof payload === "object"
        ? (payload as Record<string, unknown>).nibi_type
        : undefined;
    if (type === E2E_KEYNEG_INIT_TYPE || type === E2E_KEYNEG_RESPONSE_TYPE) return payload;
    return sealPayload(payload, this.key);
  }

  /**
   * 每次 socket 重建/断开都调用：会话级 K（P3b），旧密文在新连接上必须解不开。
   * 只丢引用不清零——JS 无法保证内存擦除，这里的安全承诺是"不再可达、不再复用"，
   * 而不是"物理擦除"；K 也不落盘、不进日志。
   */
  reset(): void {
    this.key = undefined;
    this.current = "plaintext";
  }

  private negotiate(payload: unknown): DesktopE2EIncomingResult {
    const init = parseKeyNegInit(payload);
    if (!init) return { kind: "dropped", reason: "keyneg-invalid" };
    const material = this.options.createEphemeral?.() ?? {
      secretKey: new Uint8Array(randomBytes(E2E_PUBLIC_KEY_BYTES)),
      nonce: new Uint8Array(randomBytes(E2E_NONCE_BYTES)),
    };
    const negotiated = buildKeyNegResponse({
      clientPublicKey: init.publicKey,
      clientNonce: init.nonce,
      context: this.options.context(),
      secretKey: material.secretKey,
      nonce: material.nonce,
    });
    if (!negotiated) return { kind: "dropped", reason: "keyneg-invalid" };
    // 同一连接上再次收到 init 也按新材料重协商：手机重配对时 relay 未必给出 waiting 边沿，
    // 若把重复 init 当成"忽略"，手机会 3s 后降级明文而桌面继续加密，双向都解不开且无法自愈。
    // 这不扩大信任面：握手本就未认证，能注入 data 的 relay 已经可以中间人首次握手；
    // 最坏后果是被迫重协商导致掉线（DoS），既有密文不会因此泄漏。
    const firstSecure = this.current !== "secure";
    this.key = negotiated.key;
    this.current = "secure";
    if (firstSecure) this.options.onStateChange?.("secure");
    return { kind: "keyneg-response", response: negotiated.response };
  }

  private open(payload: unknown): DesktopE2EIncomingResult {
    if (!isEncryptedPayload(payload)) return { kind: "dropped", reason: "enc-rejected" };
    // 握手完成前的 enc 一律丢弃（规格 §4）：此时没有 K，也不可能来自同一会话。
    if (this.current !== "secure" || !this.key) {
      return { kind: "dropped", reason: "enc-before-handshake" };
    }
    const opened = openPayload(payload, this.key);
    if (opened === null) return { kind: "dropped", reason: "enc-rejected" };
    return { kind: "opened", payload: opened };
  }
}
