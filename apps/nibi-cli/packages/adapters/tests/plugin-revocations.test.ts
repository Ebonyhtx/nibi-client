import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPluginRevocation,
  evaluatePluginRevocation,
  parsePluginRevocations,
  PLUGIN_REVOCATIONS_FILE,
  PLUGIN_REVOCATIONS_SIGNATURE_FILE,
  PLUGIN_REVOCATIONS_URL,
  readPluginRevocations,
  refreshPluginRevocations,
  type PluginRevocationDocument,
} from "../src/plugins/plugin-revocations.js";

const KEY_PAIR = generateKeyPairSync("ed25519");
const PUBLIC_SPKI_BASE64 = KEY_PAIR.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const PRIVATE_KEY = createPrivateKey(KEY_PAIR.privateKey.export({ format: "pem", type: "pkcs8" }));
const VERIFY = { defaultKid: "t1", publicKeys: { t1: PUBLIC_SPKI_BASE64 } } as const;

function signBytes(body: string): string {
  return sign(null, Buffer.from(body, "utf8"), PRIVATE_KEY).toString("hex");
}

function jsonResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "application/json" }, status: 200 });
}

function installFetcher(document: unknown): { calls: string[]; fetchImpl: typeof fetch } {
  const body = typeof document === "string" ? document : JSON.stringify(document);
  const signature = signBytes(body);
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return jsonResponse(url.endsWith(".sig") ? signature : body);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const DOCUMENT = {
  entries: [
    {
      action: "block",
      pluginId: "bad-plugin@nibi-official",
      reason: "security",
      versions: ["<2.0.0"],
    },
  ],
  issuedAt: "2026-11-24T00:00:00.000Z",
  revision: 3,
} satisfies PluginRevocationDocument;

let storageRoot: string;

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "nibi-revocations-"));
});

afterEach(() => {
  rmSync(storageRoot, { force: true, recursive: true });
});

describe("parsePluginRevocations", () => {
  it("接受合法文档并归一化 action/sha256", () => {
    const parsed = parsePluginRevocations({
      entries: [{ pluginId: "a@b", sha256: "A".repeat(64) }],
      issuedAt: "2026-11-24T00:00:00.000Z",
      revision: 1,
    });
    expect(parsed?.entries[0]).toEqual({
      action: "block",
      pluginId: "a@b",
      sha256: "a".repeat(64),
    });
  });

  it("任一条目结构不合法就整份文档作废", () => {
    const base = { issuedAt: "2026-11-24T00:00:00.000Z", revision: 1 };
    expect(parsePluginRevocations({ ...base, entries: [{ pluginId: "a@b", action: "ignore" }] })).toBeNull();
    expect(parsePluginRevocations({ ...base, entries: [{ pluginId: "a@b", sha256: "xyz" }] })).toBeNull();
    expect(parsePluginRevocations({ ...base, entries: [{ pluginId: "a@b", versions: [] }] })).toBeNull();
    expect(parsePluginRevocations({ ...base, entries: [{ pluginId: "no-marketplace" }] })).toBeNull();
    expect(parsePluginRevocations({ ...base, entries: [], revision: -1 })).toBeNull();
    expect(parsePluginRevocations({ ...base, entries: [], issuedAt: "not-a-date" })).toBeNull();
  });
});

describe("refreshPluginRevocations", () => {
  it("验签后把原始字节与签名一起落盘，读取可复现", async () => {
    const { calls, fetchImpl } = installFetcher(DOCUMENT);
    const result = await refreshPluginRevocations({ fetchImpl, storageRoot, verify: VERIFY });
    expect(result.status).toBe("updated");
    expect(calls).toEqual([PLUGIN_REVOCATIONS_URL, `${PLUGIN_REVOCATIONS_URL}.sig`]);
    expect(readPluginRevocations(storageRoot, VERIFY)?.revision).toBe(3);
    // 落盘的是原始字节，重新序列化会让下一次验签失败。
    expect(readFileSync(join(storageRoot, PLUGIN_REVOCATIONS_FILE), "utf8")).toBe(
      JSON.stringify(DOCUMENT),
    );
    expect(readFileSync(join(storageRoot, PLUGIN_REVOCATIONS_SIGNATURE_FILE), "utf8")).toMatch(
      /^[0-9a-f]{128}$/,
    );
  });

  it("签名不匹配时拒绝，不落盘", async () => {
    const tampered = { ...DOCUMENT, revision: 9 };
    const fetchImpl = (async (input: RequestInfo | URL) =>
      jsonResponse(String(input).endsWith(".sig") ? signBytes("other") : JSON.stringify(tampered))) as typeof fetch;
    await expect(
      refreshPluginRevocations({ fetchImpl, storageRoot, verify: VERIFY }),
    ).rejects.toThrow(/signature verification failed/u);
    expect(readPluginRevocations(storageRoot, VERIFY)).toBeNull();
  });

  it("revision 倒退按失败处理并保留旧快照", async () => {
    await refreshPluginRevocations({
      fetchImpl: installFetcher(DOCUMENT).fetchImpl,
      storageRoot,
      verify: VERIFY,
    });
    const older = { ...DOCUMENT, revision: 2 };
    await expect(
      refreshPluginRevocations({
        fetchImpl: installFetcher(older).fetchImpl,
        storageRoot,
        verify: VERIFY,
      }),
    ).rejects.toThrow(/revision went backwards/u);
    expect(readPluginRevocations(storageRoot, VERIFY)?.revision).toBe(3);
  });

  it("相同 revision 与相同字节按 unchanged 处理", async () => {
    const { fetchImpl } = installFetcher(DOCUMENT);
    await refreshPluginRevocations({ fetchImpl, storageRoot, verify: VERIFY });
    const second = await refreshPluginRevocations({ fetchImpl, storageRoot, verify: VERIFY });
    expect(second.status).toBe("unchanged");
  });

  it("issuedAt 超前本机一天以上拒绝", async () => {
    const future = { ...DOCUMENT, issuedAt: "2030-01-01T00:00:00.000Z" };
    await expect(
      refreshPluginRevocations({
        fetchImpl: installFetcher(future).fetchImpl,
        now: new Date("2026-11-24T00:00:00.000Z"),
        storageRoot,
        verify: VERIFY,
      }),
    ).rejects.toThrow(/issuedAt is in the future/u);
  });
});

describe("readPluginRevocations", () => {
  it("快照缺失按无撤销处理", () => {
    expect(readPluginRevocations(storageRoot, VERIFY)).toBeNull();
  });

  it("磁盘内容被改动后验签失败，按无撤销处理", async () => {
    await refreshPluginRevocations({
      fetchImpl: installFetcher(DOCUMENT).fetchImpl,
      storageRoot,
      verify: VERIFY,
    });
    writeFileSync(
      join(storageRoot, PLUGIN_REVOCATIONS_FILE),
      JSON.stringify({ ...DOCUMENT, revision: 4 }),
      "utf8",
    );
    expect(readPluginRevocations(storageRoot, VERIFY)).toBeNull();
  });
});

describe("evaluatePluginRevocation", () => {
  const document = parsePluginRevocations(DOCUMENT);

  it("命中版本区间返回 block", () => {
    expect(
      evaluatePluginRevocation({
        document,
        pluginId: "bad-plugin@nibi-official",
        version: "1.9.0",
      })?.action,
    ).toBe("block");
  });

  it("区间外不命中", () => {
    expect(
      evaluatePluginRevocation({
        document,
        pluginId: "bad-plugin@nibi-official",
        version: "2.1.0",
      }),
    ).toBeNull();
  });

  it("条目限定版本但调用方给不出版本时不命中", () => {
    expect(
      evaluatePluginRevocation({ document, pluginId: "bad-plugin@nibi-official" }),
    ).toBeNull();
  });

  it("sha256 条目必须内容一致才命中", () => {
    const byHash = parsePluginRevocations({
      entries: [{ pluginId: "x@m", sha256: "b".repeat(64) }],
      issuedAt: "2026-11-24T00:00:00.000Z",
      revision: 1,
    });
    expect(
      evaluatePluginRevocation({ document: byHash, pluginId: "x@m", sha256: "B".repeat(64) })?.action,
    ).toBe("block");
    expect(evaluatePluginRevocation({ document: byHash, pluginId: "x@m" })).toBeNull();
  });

  it("block 优先于同插件的 warn", () => {
    const mixed = parsePluginRevocations({
      entries: [
        { action: "warn", pluginId: "x@m" },
        { action: "block", pluginId: "x@m", versions: "<2.0.0" },
      ],
      issuedAt: "2026-11-24T00:00:00.000Z",
      revision: 2,
    });
    expect(
      evaluatePluginRevocation({ document: mixed, pluginId: "x@m", version: "1.0.0" })?.action,
    ).toBe("block");
    expect(
      evaluatePluginRevocation({ document: mixed, pluginId: "x@m", version: "3.0.0" })?.action,
    ).toBe("warn");
  });

  it("checkPluginRevocation 直接从存储根读快照", async () => {
    await refreshPluginRevocations({
      fetchImpl: installFetcher(DOCUMENT).fetchImpl,
      storageRoot,
      verify: VERIFY,
    });
    expect(
      checkPluginRevocation({
        pluginId: "bad-plugin@nibi-official",
        storageRoot,
        verify: VERIFY,
        version: "1.0.0",
      })?.action,
    ).toBe("block");
  });
});
