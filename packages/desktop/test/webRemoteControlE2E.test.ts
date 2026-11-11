// E2E 信封 v1 的桌面侧测试（规格：D:\NIBI-GO\docs\design\e2e-envelope-v1.md）。
// 覆盖：§7 已知密文向量、KDF 跨实现对拍（Node/OpenSSL）、握手确定性、
// 非法材料降级、enc 收发环路、旧对端明文不变、重连换钥后旧密文解不开。
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { EventEmitter, once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

import { x25519 } from "@noble/curves/ed25519.js";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WebRemoteControlAppPayload } from "@nibi/shared";
import { createFakeRelayV2 } from "@nibi/shared/testing/fake-relay-v2";

import {
  DesktopE2EChannel,
  E2E_NONCE_BYTES,
  buildKeyNegResponse,
  deriveSessionKey,
  isEncryptedPayload,
  openPayload,
  parseKeyNegInit,
  sealPayload,
  type KeyNegInitPayload,
  type KeyNegResponsePayload,
} from "#src/main/web-remote-relay/webRemoteControlE2E.js";
import {
  createWebRemoteControlV2Http,
  WebRemoteControlDeviceTransport,
} from "#src/main/web-remote-relay/index.js";

const CONTEXT = "d_fixture_device";
/** 规格 §7 的格式漂移守卫向量（手机侧 crypto.test.ts 断言同一串）。 */
const SPEC_CT = "rHtk/LRWx9bBzyM4Bk3sfmob1j8yDA4FxhIJY1gIk+T2WVzeHZ0WWtBj";

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function unb64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function fill(length: number, byte: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

function initPayload(secretKey: Uint8Array, nonce: Uint8Array): KeyNegInitPayload {
  return {
    nibi_type: "keyneg-init",
    v: 1,
    pub: b64(x25519.getPublicKey(secretKey)),
    nonce: b64(nonce),
  };
}

/** 手机侧同公式派生：X25519(phoneSecret, desktopPub) → HKDF，salt 顺序 client‖server。 */
function phoneSessionKey(params: {
  secretKey: Uint8Array;
  clientNonce: Uint8Array;
  response: KeyNegResponsePayload;
  context?: string;
}): Uint8Array {
  return deriveSessionKey({
    sharedSecret: x25519.getSharedSecret(params.secretKey, unb64(params.response.pub)),
    clientNonce: params.clientNonce,
    serverNonce: unb64(params.response.nonce),
    context: params.context ?? CONTEXT,
  });
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("E2E 信封（XChaCha20-Poly1305，P3c JSON 文本帧）", () => {
  it("§7 已知向量：同 key/nonce 解出同一明文（防格式漂移）", () => {
    const key = fill(32, 0x42);
    const nonce = fill(24, 0x17);
    const envelope = sealPayload({ nibi_type: "ping", v: 1 }, key, nonce);
    expect(envelope).toEqual({
      nibi_type: "enc",
      v: 1,
      // 24B 的 0x17；无 padding 的 32 字符
      n: "FxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcX",
      ct: SPEC_CT,
    });
    expect(openPayload(envelope, key)).toEqual({ nibi_type: "ping", v: 1 });
    // 反方向：拿规格里的 ct 直接解，必须还原同一明文
    expect(openPayload({ nibi_type: "enc", v: 1, n: envelope.n, ct: SPEC_CT }, key)).toEqual({
      nibi_type: "ping",
      v: 1,
    });
  });

  it("随机 nonce 往返：加密 → 解密还原 JSON，nonce 恒为 24B", () => {
    const key = new Uint8Array(randomBytes(32));
    const plain = { nibi_type: "data", hello: "world", nested: { n: 1 } };
    const envelope = sealPayload(plain, key);
    expect(envelope.v).toBe(1);
    expect(unb64(envelope.n)).toHaveLength(E2E_NONCE_BYTES);
    expect(unb64(envelope.ct).length).toBeGreaterThan(16);
    expect(openPayload(envelope, key)).toEqual(plain);
  });

  it("篡改/错钥/版本/非规范 base64 → null（调用方丢弃该帧）", () => {
    const key = new Uint8Array(randomBytes(32));
    const envelope = sealPayload({ x: 1 }, key);
    const tamperedBytes = unb64(envelope.ct);
    tamperedBytes[0] = tamperedBytes[0]! ^ 0xff;
    expect(openPayload({ ...envelope, ct: b64(tamperedBytes) }, key)).toBeNull();
    expect(openPayload(envelope, new Uint8Array(randomBytes(32)))).toBeNull();
    expect(openPayload({ ...envelope, v: 99 }, key)).toBeNull();
    expect(openPayload({ ...envelope, n: "short" }, key)).toBeNull();
    // 非法字符 / 错误 padding 都不能被 Node 的宽容解码吞掉
    expect(openPayload({ ...envelope, n: `${envelope.n.slice(0, -1)}!` }, key)).toBeNull();
    expect(openPayload({ ...envelope, ct: `${envelope.ct}===` }, key)).toBeNull();
    expect(openPayload({ ...envelope, ct: "" }, key)).toBeNull();
  });

  it("信封识别只认完整字段", () => {
    const envelope = sealPayload({ a: 1 }, new Uint8Array(randomBytes(32)));
    expect(isEncryptedPayload(envelope)).toBe(true);
    expect(isEncryptedPayload({ nibi_type: "enc", v: 1 })).toBe(false);
    expect(isEncryptedPayload({ nibi_type: "data" })).toBe(false);
    expect(isEncryptedPayload(null)).toBe(false);
  });
});

describe("握手（X25519 + HKDF-SHA256，规格 §3）", () => {
  it("KDF 与 Node/OpenSSL 独立实现对拍（salt 顺序 + info 前缀 + 32B 输出）", () => {
    const clientSecret = fill(32, 0x11);
    const serverSecret = fill(32, 0x22);
    const clientNonce = fill(24, 0x33);
    const serverNonce = fill(24, 0x44);
    const clientPublic = x25519.getPublicKey(clientSecret);
    const serverPublic = x25519.getPublicKey(serverSecret);

    // OpenSSL 侧的 X25519（PKCS#8/SPKI 前缀拼 raw key）+ HKDF，与 @noble 是两条实现路径
    const pkcs8 = Buffer.concat([
      Buffer.from("302e020100300506032b656e04220420", "hex"),
      Buffer.from(clientSecret),
    ]);
    const spki = Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"),
      Buffer.from(serverPublic),
    ]);
    const opensslShared = diffieHellman({
      privateKey: createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }),
      publicKey: createPublicKey({ key: spki, format: "der", type: "spki" }),
    });

    const expected = new Uint8Array(
      hkdfSync(
        "sha256",
        opensslShared,
        Buffer.concat([Buffer.from(clientNonce), Buffer.from(serverNonce)]),
        Buffer.from(`nibi-e2e-v1|${CONTEXT}`),
        32,
      ),
    );
    const desktop = deriveSessionKey({
      sharedSecret: x25519.getSharedSecret(serverSecret, clientPublic),
      clientNonce,
      serverNonce,
      context: CONTEXT,
    });
    const phone = deriveSessionKey({
      sharedSecret: x25519.getSharedSecret(clientSecret, serverPublic),
      clientNonce,
      serverNonce,
      context: CONTEXT,
    });
    expect(desktop).toHaveLength(32);
    expect(Array.from(desktop)).toEqual(Array.from(expected));
    expect(Array.from(phone)).toEqual(Array.from(desktop));
  });

  it("固定临时密钥：response 可确定性断言，双方派生出同一 K", () => {
    const clientSecret = fill(32, 0x11);
    const clientNonce = fill(24, 0x33);
    const serverSecret = fill(32, 0x22);
    const serverNonce = fill(24, 0x44);
    const init = initPayload(clientSecret, clientNonce);
    expect(parseKeyNegInit(init)).toEqual({
      publicKey: x25519.getPublicKey(clientSecret),
      nonce: clientNonce,
    });

    const negotiated = buildKeyNegResponse({
      clientPublicKey: x25519.getPublicKey(clientSecret),
      clientNonce,
      context: CONTEXT,
      secretKey: serverSecret,
      nonce: serverNonce,
    });
    expect(negotiated).not.toBeNull();
    expect(negotiated!.response).toEqual({
      nibi_type: "keyneg-response",
      v: 1,
      pub: b64(x25519.getPublicKey(serverSecret)),
      nonce: b64(serverNonce),
    });
    const phoneKey = phoneSessionKey({
      secretKey: clientSecret,
      clientNonce,
      response: negotiated!.response,
    });
    expect(Array.from(negotiated!.key)).toEqual(Array.from(phoneKey));

    // 同一 K：双向信封互解
    expect(openPayload(sealPayload({ from: "phone" }, phoneKey), negotiated!.key)).toEqual({
      from: "phone",
    });
    expect(openPayload(sealPayload({ from: "desktop" }, negotiated!.key), phoneKey)).toEqual({
      from: "desktop",
    });
  });

  it("channel 用固定临时密钥走完 init→response，出向立刻加密、入向解密", () => {
    const clientSecret = fill(32, 0x11);
    const clientNonce = fill(24, 0x33);
    const events: string[] = [];
    const channel = new DesktopE2EChannel({
      context: () => CONTEXT,
      createEphemeral: () => ({ secretKey: fill(32, 0x22), nonce: fill(24, 0x44) }),
      onStateChange: (state) => events.push(state),
    });
    expect(channel.state).toBe("plaintext");
    expect(channel.wrapOutgoing({ nibi_type: "data" })).toEqual({ nibi_type: "data" });

    const result = channel.handleIncoming(initPayload(clientSecret, clientNonce));
    expect(result.kind).toBe("keyneg-response");
    expect(channel.state).toBe("secure");
    expect(events).toEqual(["secure"]);

    const key = phoneSessionKey({
      secretKey: clientSecret,
      clientNonce,
      response: (result as { response: KeyNegResponsePayload }).response,
    });
    const outgoing = channel.wrapOutgoing({
      nibi_type: "workspace-list-response",
      requestId: "r1",
    });
    expect(isEncryptedPayload(outgoing)).toBe(true);
    expect(openPayload(outgoing as never, key)).toEqual({
      nibi_type: "workspace-list-response",
      requestId: "r1",
    });

    const fromPhone = channel.handleIncoming(
      sealPayload({ nibi_type: "bootstrap-request", requestId: "r2" }, key),
    );
    expect(fromPhone).toEqual({
      kind: "opened",
      payload: { nibi_type: "bootstrap-request", requestId: "r2" },
    });
    // keyneg 自身永远明文
    expect(
      channel.wrapOutgoing({ nibi_type: "keyneg-response", v: 1, pub: "a", nonce: "b" }),
    ).toEqual({
      nibi_type: "keyneg-response",
      v: 1,
      pub: "a",
      nonce: "b",
    });
  });

  it("非法材料一律不协商、不回包、状态保持明文（连接不断）", () => {
    const valid = initPayload(fill(32, 0x11), fill(24, 0x33));
    const channel = new DesktopE2EChannel({ context: () => CONTEXT });
    const invalidInits: unknown[] = [
      { ...valid, v: 2 },
      { ...valid, v: "1" },
      { ...valid, pub: 12 as unknown as string },
      { ...valid, nonce: 12 as unknown as string },
      { ...valid, pub: b64(fill(31, 1)) },
      { ...valid, pub: b64(fill(33, 1)) },
      { ...valid, nonce: b64(fill(32, 1)) },
      { ...valid, pub: "!!!!" },
      { ...valid, pub: `${valid.pub.slice(0, -1)}!` },
      // 低阶点：@noble 对非法公钥抛错，桌面按非法材料降级，不能让异常穿透 transport
      { ...valid, pub: b64(fill(32, 0)) },
      { nibi_type: "keyneg-init", v: 1, pub: valid.pub },
    ];
    for (const init of invalidInits) {
      expect(channel.handleIncoming(init).kind).toBe("dropped");
      expect(channel.state).toBe("plaintext");
    }
    // 非 keyneg 载荷（含 null/字符串）不在本模块的拒收范围：原样放行给业务 schema 判定
    expect(channel.handleIncoming(null).kind).toBe("pass");
    expect(channel.handleIncoming("keyneg-init").kind).toBe("pass");
    expect(channel.state).toBe("plaintext");
    // 之后收到合法 init 仍能建立会话（非法材料没有污染状态）
    expect(channel.handleIncoming(valid).kind).toBe("keyneg-response");
    expect(channel.state).toBe("secure");
  });

  it("重复 init 重新协商：新 K 生效，旧密文解不开（手机重配对可自愈）", () => {
    const serverSecret = fill(32, 0x22);
    const serverNonces = [fill(24, 0x44), fill(24, 0x45)];
    let index = 0;
    const channel = new DesktopE2EChannel({
      context: () => CONTEXT,
      createEphemeral: () => ({ secretKey: serverSecret, nonce: serverNonces[index++]! }),
    });
    const firstClientSecret = fill(32, 0x11);
    const firstClientNonce = fill(24, 0x33);
    const first = channel.handleIncoming(initPayload(firstClientSecret, firstClientNonce));
    const firstKey = phoneSessionKey({
      secretKey: firstClientSecret,
      clientNonce: firstClientNonce,
      response: (first as { response: KeyNegResponsePayload }).response,
    });
    const secondClientSecret = fill(32, 0x12);
    const secondClientNonce = fill(24, 0x34);
    const second = channel.handleIncoming(initPayload(secondClientSecret, secondClientNonce));
    expect((second as { response: KeyNegResponsePayload }).response.nonce).toBe(
      b64(serverNonces[1]!),
    );
    const secondKey = phoneSessionKey({
      secretKey: secondClientSecret,
      clientNonce: secondClientNonce,
      response: (second as { response: KeyNegResponsePayload }).response,
    });
    expect(Array.from(firstKey)).not.toEqual(Array.from(secondKey));

    // 旧 K 的密文在新会话上必须被丢弃（GCM 认证失败），新 K 正常
    expect(
      channel.handleIncoming(
        sealPayload({ nibi_type: "bootstrap-request", requestId: "old" }, firstKey),
      ),
    ).toEqual({
      kind: "dropped",
      reason: "enc-rejected",
    });
    expect(
      channel.handleIncoming(
        sealPayload({ nibi_type: "bootstrap-request", requestId: "new" }, secondKey),
      ),
    ).toEqual({
      kind: "opened",
      payload: { nibi_type: "bootstrap-request", requestId: "new" },
    });
    // 出向只用新 K
    expect(
      openPayload(
        channel.wrapOutgoing({ nibi_type: "workspace-list-request", requestId: "o" }) as never,
        secondKey,
      ),
    ).toEqual({
      nibi_type: "workspace-list-request",
      requestId: "o",
    });
  });

  it("握手前 enc 丢弃、response 不作为业务帧、reset 后旧密文解不开", () => {
    const channel = new DesktopE2EChannel({
      context: () => CONTEXT,
      createEphemeral: () => ({ secretKey: fill(32, 0x22), nonce: fill(24, 0x44) }),
    });
    const strayKey = fill(32, 0x55);
    expect(channel.handleIncoming(sealPayload({ a: 1 }, strayKey))).toEqual({
      kind: "dropped",
      reason: "enc-before-handshake",
    });
    expect(
      channel.handleIncoming({ nibi_type: "keyneg-response", v: 1, pub: "a", nonce: "b" }),
    ).toEqual({ kind: "dropped", reason: "keyneg-unexpected" });

    const clientSecret = fill(32, 0x11);
    const clientNonce = fill(24, 0x33);
    const result = channel.handleIncoming(initPayload(clientSecret, clientNonce));
    const key = phoneSessionKey({
      secretKey: clientSecret,
      clientNonce,
      response: (result as { response: KeyNegResponsePayload }).response,
    });
    channel.reset();
    expect(channel.state).toBe("plaintext");
    expect(
      channel.handleIncoming(
        sealPayload({ nibi_type: "bootstrap-request", requestId: "stale" }, key),
      ),
    ).toEqual({
      kind: "dropped",
      reason: "enc-before-handshake",
    });
    // 明文帧不受影响
    const plain = { nibi_type: "bootstrap-request", requestId: "plain" };
    expect(channel.handleIncoming(plain)).toEqual({ kind: "pass", payload: plain });
  });
});

describe("transport 镜像（真实 fake relay + 真 WS）", () => {
  async function fixture() {
    const relay = await createFakeRelayV2({ users: { jwt: "user" } });
    cleanups.push(() => relay.close());
    const http = createWebRemoteControlV2Http(relay.httpUrl);
    const request = async (path: string, body: unknown) => {
      const response = await fetch(`${relay.httpUrl}/api/v1/remote/${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return await response.json();
    };
    const { data: device } = await request("device", { device_mid: "mid-1" });
    const states: string[] = [];
    const stateEvents = new EventEmitter();
    const payloads: WebRemoteControlAppPayload[] = [];
    const transport = new WebRemoteControlDeviceTransport({
      relayWsUrl: relay.wsUrl,
      deviceMid: "mid-1",
      getToken: (signal) => http.token("jwt", signal),
      resolveDeviceSid: async () => device.device_sid,
      meta: { name: "My desktop", platform: "darwin", version: "3.13.0" },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onStateChange: (state) => {
        states.push(state);
        stateEvents.emit(`state:${state}`);
      },
      onError: (error) => console.error(error),
      onPayload: (payload) => payloads.push(payload),
    });
    cleanups.push(() => transport.dispose());
    const waitForState = async (state: string) => {
      if (states.at(-1) !== state) {
        await once(stateEvents, `state:${state}`, { signal: AbortSignal.timeout(8000) });
      }
    };
    const connectTerminal = async () => {
      const { data } = await request("token", { role: "terminal" });
      const terminal = new WebSocket(`${relay.wsUrl}?token=${data.token}&mid=mid-1`);
      const messages: Array<Record<string, unknown>> = [];
      terminal.on("message", (raw) =>
        messages.push(JSON.parse(raw.toString()) as Record<string, unknown>),
      );
      cleanups.push(() => terminal.close());
      await once(terminal, "open");
      terminal.send(JSON.stringify({ type: "auth_init", device_sid: device.device_sid }));
      return { terminal, messages };
    };
    return {
      relay,
      transport,
      device,
      request,
      payloads,
      states,
      waitForState,
      connectTerminal,
    };
  }

  function payloadOf(
    messages: Array<Record<string, unknown>>,
    type: string,
  ): Record<string, unknown> | undefined {
    return messages
      .map((message) => message.payload)
      .find(
        (payload): payload is Record<string, unknown> =>
          !!payload &&
          typeof payload === "object" &&
          (payload as { nibi_type?: unknown }).nibi_type === type,
      );
  }

  async function negotiate(
    terminal: WebSocket,
    messages: Array<Record<string, unknown>>,
    context: string,
  ) {
    const secretKey = x25519.utils.randomSecretKey();
    const clientNonce = new Uint8Array(randomBytes(E2E_NONCE_BYTES));
    terminal.send(JSON.stringify({ type: "data", payload: initPayload(secretKey, clientNonce) }));
    await vi.waitFor(() => expect(payloadOf(messages, "keyneg-response")).toBeDefined(), {
      timeout: 5000,
    });
    const response = payloadOf(messages, "keyneg-response") as unknown as KeyNegResponsePayload;
    return {
      secretKey,
      clientNonce,
      response,
      key: phoneSessionKey({ secretKey, clientNonce, response, context }),
    };
  }

  it("握手：桌面回 keyneg-response（明文），双向业务帧都包 enc 且可互解", async () => {
    const f = await fixture();
    f.transport.start();
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("waiting_terminal"));
    const { terminal, messages } = await f.connectTerminal();
    await f.waitForState("paired");

    const { key, response } = await negotiate(terminal, messages, f.device.device_sid);
    expect(response).toEqual({
      nibi_type: "keyneg-response",
      v: 1,
      // 每次握手新建临时密钥：发包必须是 32B base64，且不能是手机自己的公钥
      pub: expect.any(String),
      nonce: expect.any(String),
    });
    expect(unb64(response.pub)).toHaveLength(32);
    expect(unb64(response.nonce)).toHaveLength(24);

    // phone → desktop：enc 在业务管线之前被解开
    terminal.send(
      JSON.stringify({
        type: "data",
        payload: sealPayload({ nibi_type: "bootstrap-request", requestId: "enc-in" }, key),
      }),
    );
    await vi.waitFor(() =>
      expect(f.payloads).toContainEqual({ nibi_type: "bootstrap-request", requestId: "enc-in" }),
    );

    // desktop → phone：业务 payload 一律 enc
    const outbound: WebRemoteControlAppPayload = {
      nibi_type: "workspace-list-request",
      requestId: "enc-out",
    };
    expect(f.transport.sendPayload(outbound)).toBe(true);
    await vi.waitFor(() => expect(payloadOf(messages, "enc")).toBeDefined(), { timeout: 5000 });
    const sealed = payloadOf(messages, "enc") as Record<string, unknown>;
    expect(openPayload(sealed as never, key)).toEqual(outbound);

    // 计量的字节就是实际发出的帧字节（分片 sizing 依赖这一点）
    const deviceFrame = f.relay.messages
      .filter(
        ({ role, message }) => role === "device" && (message as { type?: string }).type === "data",
      )
      .at(-1)!;
    const wireBytes = Buffer.byteLength(JSON.stringify(deviceFrame.message), "utf8");
    expect(f.transport.measurePayloadBytes(outbound)).toBe(wireBytes);
  });

  it("非法握手材料：不回包、按明文继续、连接不断", async () => {
    const f = await fixture();
    f.transport.start();
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("waiting_terminal"));
    const { terminal, messages } = await f.connectTerminal();
    await f.waitForState("paired");

    terminal.send(
      JSON.stringify({
        type: "data",
        payload: { nibi_type: "keyneg-init", v: 1, pub: "not-base64!", nonce: "short" },
      }),
    );
    await delay(120);
    expect(payloadOf(messages, "keyneg-response")).toBeUndefined();
    expect(f.states.at(-1)).toBe("paired");

    terminal.send(
      JSON.stringify({
        type: "data",
        payload: { nibi_type: "bootstrap-request", requestId: "after-bad-init" },
      }),
    );
    await vi.waitFor(() =>
      expect(f.payloads).toContainEqual({
        nibi_type: "bootstrap-request",
        requestId: "after-bad-init",
      }),
    );

    // 降级明文：桌面出向也不会包 enc
    const outbound: WebRemoteControlAppPayload = {
      nibi_type: "workspace-list-request",
      requestId: "still-plain",
    };
    expect(f.transport.sendPayload(outbound)).toBe(true);
    await vi.waitFor(() =>
      expect(messages).toContainEqual(expect.objectContaining({ type: "data", payload: outbound })),
    );
  });

  it("旧手机不发 keyneg-init：明文照旧（不主动协商、不加密）", async () => {
    const f = await fixture();
    f.transport.start();
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("waiting_terminal"));
    const { terminal, messages } = await f.connectTerminal();
    await f.waitForState("paired");

    terminal.send(
      JSON.stringify({
        type: "data",
        payload: { nibi_type: "bootstrap-request", requestId: "legacy-in" },
      }),
    );
    await vi.waitFor(() =>
      expect(f.payloads).toContainEqual({ nibi_type: "bootstrap-request", requestId: "legacy-in" }),
    );

    const outbound: WebRemoteControlAppPayload = {
      nibi_type: "workspace-list-request",
      requestId: "legacy-out",
    };
    expect(f.transport.sendPayload(outbound)).toBe(true);
    await vi.waitFor(() =>
      expect(messages).toContainEqual(expect.objectContaining({ type: "data", payload: outbound })),
    );
    // 桌面从不主动发 keyneg-init
    expect(payloadOf(messages, "keyneg-init")).toBeUndefined();
  });

  it("重连换钥：新握手后旧密文被丢弃，新密文正常；桌面出向也换新 K", async () => {
    const f = await fixture();
    f.transport.start();
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("waiting_terminal"));
    const first = await f.connectTerminal();
    await f.waitForState("paired");
    const firstSession = await negotiate(first.terminal, first.messages, f.device.device_sid);

    first.terminal.send(
      JSON.stringify({
        type: "data",
        payload: sealPayload(
          { nibi_type: "bootstrap-request", requestId: "before-reconnect" },
          firstSession.key,
        ),
      }),
    );
    await vi.waitFor(() =>
      expect(f.payloads).toContainEqual({
        nibi_type: "bootstrap-request",
        requestId: "before-reconnect",
      }),
    );

    first.terminal.close();
    await f.waitForState("waiting_terminal");

    const second = await f.connectTerminal();
    await f.waitForState("paired");
    const secondSession = await negotiate(second.terminal, second.messages, f.device.device_sid);
    expect(secondSession.response.pub).not.toBe(firstSession.response.pub);
    expect(Array.from(secondSession.key)).not.toEqual(Array.from(firstSession.key));

    const before = f.payloads.length;
    second.terminal.send(
      JSON.stringify({
        type: "data",
        payload: sealPayload(
          { nibi_type: "bootstrap-request", requestId: "stale-key" },
          firstSession.key,
        ),
      }),
    );
    // 给 relay→desktop 一个真实的往返窗口：旧 K 的帧必须被丢弃且不打断连接
    await delay(120);
    expect(f.payloads).toHaveLength(before);
    expect(f.payloads).not.toContainEqual(expect.objectContaining({ requestId: "stale-key" }));

    second.terminal.send(
      JSON.stringify({
        type: "data",
        payload: sealPayload(
          { nibi_type: "bootstrap-request", requestId: "fresh-key" },
          secondSession.key,
        ),
      }),
    );
    await vi.waitFor(() =>
      expect(f.payloads).toContainEqual({ nibi_type: "bootstrap-request", requestId: "fresh-key" }),
    );

    const outbound: WebRemoteControlAppPayload = {
      nibi_type: "workspace-list-request",
      requestId: "out-after-reconnect",
    };
    expect(f.transport.sendPayload(outbound)).toBe(true);
    await vi.waitFor(() => expect(payloadOf(second.messages, "enc")).toBeDefined(), {
      timeout: 5000,
    });
    const sealed = payloadOf(second.messages, "enc") as Record<string, unknown>;
    expect(openPayload(sealed as never, secondSession.key)).toEqual(outbound);
    // 旧 K 解不开新连接的密文
    expect(openPayload(sealed as never, firstSession.key)).toBeNull();
  });
});
