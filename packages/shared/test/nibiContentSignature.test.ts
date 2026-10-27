import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  NIBI_CONTENT_SIGNING_PUBLIC_KEY_SPKI_BASE64,
  isNibiSignedContentUrl,
  verifyContentSignatureWithKey,
  verifyNibiContentSignature,
} from "../src/node.js";
import { setNibiMirrorOrigin } from "../src/nibiContentMirror.js";

// The production private key is held by the release pipeline and is not in the
// repository. Positive cases use an ephemeral key pair; negative cases exercise
// the baked public key.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeySpkiBase64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

function signPayload(payload: Uint8Array): string {
  return sign(null, payload, privateKey).toString("hex");
}

afterEach(() => setNibiMirrorOrigin(""));

describe("NIBI 内容签名（清单/配置 .sig sidecar）", () => {
  it("接受同一密钥对签出的 128 位 hex 签名", () => {
    const payload = Buffer.from('{"name":"nibi-official","revision":7}', "utf8");
    expect(verifyContentSignatureWithKey(payload, signPayload(payload), publicKeySpkiBase64)).toBe(
      true,
    );
  });

  it("内容改一个字节即失败", () => {
    const payload = Buffer.from('{"name":"nibi-official","revision":7}', "utf8");
    const signature = signPayload(payload);
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 2] ^= 0x01;
    expect(verifyContentSignatureWithKey(tampered, signature, publicKeySpkiBase64)).toBe(false);
  });

  it("签名改一位即失败", () => {
    const payload = Buffer.from("payload", "utf8");
    const signature = signPayload(payload);
    const flipped = (signature[0] === "0" ? "1" : "0") + signature.slice(1);
    expect(verifyContentSignatureWithKey(payload, flipped, publicKeySpkiBase64)).toBe(false);
  });

  it("签名形状不合法时 fail-closed（不抛异常）", () => {
    const payload = Buffer.from("payload", "utf8");
    for (const bad of ["", "zz", "abc", "0".repeat(126), "0".repeat(130), "g".repeat(128)]) {
      expect(verifyContentSignatureWithKey(payload, bad, publicKeySpkiBase64)).toBe(false);
      expect(verifyNibiContentSignature(payload, bad)).toBe(false);
    }
  });

  it("公钥不合法时 fail-closed", () => {
    const payload = Buffer.from("payload", "utf8");
    expect(verifyContentSignatureWithKey(payload, signPayload(payload), "not-base64-der")).toBe(
      false,
    );
  });

  it("烘焙公钥与发布链公钥一致（防漂移）", () => {
    // 该值必须与发布链公钥逐字节相同；轮换公钥 = 发新版客户端。
    expect(NIBI_CONTENT_SIGNING_PUBLIC_KEY_SPKI_BASE64).toBe(
      "MCowBQYDK2VwAyEAfjUkJYlbWMyNQOR1E7m+/a0USdAUZYp7GHFoSsQlQ7k=",
    );
  });

  it("烘焙公钥不接受其它密钥签出的签名", () => {
    const payload = Buffer.from('{"name":"nibi-official"}', "utf8");
    expect(verifyNibiContentSignature(payload, signPayload(payload))).toBe(false);
  });

  it("只有我们的内容主机且 https 才强制验签", () => {
    expect(isNibiSignedContentUrl("https://api.nibistudio.top/plugins/marketplace.json")).toBe(
      true,
    );
    expect(isNibiSignedContentUrl("https://dl.nibistudio.top/plugins/marketplace.json")).toBe(true);
    setNibiMirrorOrigin("https://mirror.example.test:8443");
    expect(isNibiSignedContentUrl("https://mirror.example.test:8443/plugins/marketplace.json")).toBe(
      true,
    );
    // 明文降级不认：签名文件本身走同一通道，http 下无法防中间人。
    expect(isNibiSignedContentUrl("http://api.nibistudio.top/plugins/marketplace.json")).toBe(
      false,
    );
    // 用户自加市场不受影响（不强制签名）。
    expect(isNibiSignedContentUrl("https://example.com/marketplace.json")).toBe(false);
    expect(isNibiSignedContentUrl("not a url")).toBe(false);
  });

  it("签名覆盖原始字节（不是规范化 JSON）", () => {
    // 发布链对文件原始字节签名：空白差异会让签名失效，这正是防止「重新序列化」绕过的手段。
    const compact = Buffer.from('{"a":1}', "utf8");
    const pretty = Buffer.from('{\n  "a": 1\n}\n', "utf8");
    const signature = signPayload(compact);
    expect(verifyContentSignatureWithKey(compact, signature, publicKeySpkiBase64)).toBe(true);
    expect(verifyContentSignatureWithKey(pretty, signature, publicKeySpkiBase64)).toBe(false);
    expect(createHash("sha256").update(compact).digest("hex")).not.toBe(
      createHash("sha256").update(pretty).digest("hex"),
    );
  });
});
