import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadOrCreateInstallKeySync,
  readInstallKeySync,
  resolveInstallKeyPathForCredentialsFile,
} from "@nibi/shared/node";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import { createZCodeCredentialCipher } from "../src/auth/credential-cipher.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(homedir(), `nibi-cred-v2-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function makeStore(baseDir: string, env?: Record<string, string | undefined>) {
  return createSharedZCodeCredentialStore({ baseDir, ...(env ? { env } : {}) });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

describe("per-install credential encryption (v2)", () => {
  it("round-trips through the store and puts the key outside the v2 directory", async () => {
    const baseDir = await makeTempDir("base");
    const store = makeStore(baseDir);
    await store.saveMany({ "nibi:license:token": "license-token-1", "oauth:active_provider": "nibi" });

    const credentialsPath = join(baseDir, ".nibi", "v2", "credentials.json");
    const keyPath = resolveInstallKeyPathForCredentialsFile(credentialsPath);
    expect(keyPath).toBe(join(baseDir, ".nibi", "machine", "credential-v2.key"));
    expect(existsSync(keyPath)).toBe(true);
    // v2 密文前缀 + 不再有 v1 残留。
    const raw = readFileSync(credentialsPath, "utf8");
    expect(raw).toContain("enc:v2:");
    expect(raw).not.toContain("enc:v1:");

    const store2 = makeStore(baseDir);
    await expect(store2.load("nibi:license:token")).resolves.toBe("license-token-1");
    expect(store2.loadSync("oauth:active_provider")).toBe("nibi");
  });

  it("fails closed when only credentials.json is copied to another machine", async () => {
    const baseDir = await makeTempDir("source");
    const store = makeStore(baseDir);
    await store.save("nibi:license:token", "secret-license");

    // 攻击场景：只拷走 credentials.json（不带 .nibi/machine/ 下的钥匙）。
    const targetDir = await makeTempDir("target");
    await mkdir(join(targetDir, ".nibi", "v2"), { recursive: true });
    await copyFile(
      join(baseDir, ".nibi", "v2", "credentials.json"),
      join(targetDir, ".nibi", "v2", "credentials.json"),
    );

    const stolen = makeStore(targetDir);
    await expect(stolen.load("nibi:license:token")).rejects.toThrow(/密钥|key/iu);
    // agent 同步读路径同样失败（付费门禁按无凭证处理，fail-closed）。
    expect(() => stolen.loadSync("nibi:license:token")).toThrow(/密钥|key/iu);
  });

  it("migrates legacy v1 values to v2 on the next write", async () => {
    const baseDir = await makeTempDir("legacy");
    const credentialsPath = join(baseDir, ".nibi", "v2", "credentials.json");
    await mkdir(join(baseDir, ".nibi", "v2"), { recursive: true });
    // 用旧版（可推导 fallback 密钥、无 installKeyPath）cipher 预置 v1 密文。
    const legacyStore = createSharedZCodeCredentialStore({
      baseDir,
      cipher: createZCodeCredentialCipher({ env: {} }),
    });
    await legacyStore.save("oauth:active_provider", "nibi");
    expect(readFileSync(credentialsPath, "utf8")).toContain("enc:v1:");

    // 升级后的 host 写入任一键值 → 整个记录迁移为 v2。
    const upgraded = makeStore(baseDir);
    await upgraded.save("nibi:device:id", "device-1234");
    const raw = readFileSync(credentialsPath, "utf8");
    expect(raw).not.toContain("enc:v1:");
    expect(raw).toContain("enc:v2:");
    await expect(upgraded.load("oauth:active_provider")).resolves.toBe("nibi");
  });

  it("an explicit NIBI_CREDENTIAL_SECRET still works and creates no key file", async () => {
    const baseDir = await makeTempDir("env");
    const env = { NIBI_CREDENTIAL_SECRET: "deployment-secret-0123456789" };
    const store = makeStore(baseDir, env);
    await store.save("nibi:license:token", "tok");
    expect(existsSync(join(baseDir, ".nibi", "machine", "credential-v2.key"))).toBe(false);

    // 另一个进程（同 env secret）无钥可读：部署方自带高熵密钥时无需安装密钥文件。
    const other = makeStore(baseDir, env);
    await expect(other.load("nibi:license:token")).resolves.toBe("tok");
  });

  it("removing the install key file makes existing v2 values undecryptable (no silent re-mint)", async () => {
    const baseDir = await makeTempDir("lostkey");
    const store = makeStore(baseDir);
    await store.save("nibi:license:token", "tok");
    const keyPath = join(baseDir, ".nibi", "machine", "credential-v2.key");
    const { unlink } = await import("node:fs/promises");
    await unlink(keyPath);

    await expect(store.load("nibi:license:token")).rejects.toThrow();
    // 但钥匙文件不会被这次读取重新生成。
    expect(existsSync(keyPath)).toBe(false);
  });
});

describe("install key primitives", () => {
  it("loadOrCreate is idempotent and validates length", async () => {
    const dir = await makeTempDir("key");
    const keyPath = join(dir, "machine", "credential-v2.key");
    const first = loadOrCreateInstallKeySync(keyPath);
    const second = loadOrCreateInstallKeySync(keyPath);
    expect(first.equals(second)).toBe(true);
    expect(readInstallKeySync(keyPath)?.equals(first)).toBe(true);

    await writeFile(keyPath, "not-a-valid-key", "utf8");
    expect(() => loadOrCreateInstallKeySync(keyPath)).toThrow(/length|无效/u);
  });

  it("readInstallKeySync returns null when the key is absent", async () => {
    const dir = await makeTempDir("absent");
    expect(readInstallKeySync(join(dir, "missing.key"))).toBeNull();
  });
});
