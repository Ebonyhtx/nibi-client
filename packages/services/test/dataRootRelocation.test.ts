import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCredentialService } from "#src/credential/credentialService.js";
import { createCredentialCipherProvider } from "#src/credential/providers/credentialCipherProvider.js";
import {
  cleanupStaleRelocationStaging,
  DATA_ROOT_RELOCATION_ERROR_CODES,
  relocateDataRoot,
} from "#src/data-root/relocate.js";
import {
  createFsFaultInjector,
  resetProcessFsFaultInjectorForTests,
  setFsFaultInjectorForTests,
} from "#src/fs/fsFaultInjection.js";
import { setDataBaseDir } from "#src/paths.js";
import { createSettingServiceWithMigrations } from "#src/setting/settingService.js";

const tempDirs: string[] = [];
const originalSettingsDir = process.env.NIBI_SETTINGS_DIR;
const originalCredentialSecret = process.env.NIBI_CREDENTIAL_SECRET;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

beforeEach(() => {
  setDataBaseDir(null);
  // 强制走 per-install 密钥文件路径，避免外部环境把两代密文都指向 env secret。
  delete process.env.NIBI_CREDENTIAL_SECRET;
});

afterEach(() => {
  setDataBaseDir(null);
  resetProcessFsFaultInjectorForTests();
  restoreEnv("NIBI_SETTINGS_DIR", originalSettingsDir);
  restoreEnv("NIBI_CREDENTIAL_SECRET", originalCredentialSecret);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

/** 用源数据根写三条真实 v2 凭据：OAuth / JWT / license。 */
async function seedSourceCredentials(sourceBaseDir: string): Promise<Record<string, string>> {
  setDataBaseDir(sourceBaseDir);
  const credentialService = createCredentialService();
  const values: Record<string, string> = {
    "oauth:nibi:access_token": "oauth-access-token",
    "nibi-jwttoken": "jwt-token",
    "nibi:license:token": "license-token",
  };
  for (const [key, value] of Object.entries(values)) {
    await credentialService.save(key, value);
  }
  return values;
}

function writeSettingPointer(settingsDir: string, dataBaseDir: string): string {
  mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, "setting.json");
  const content = JSON.stringify({ dataBaseDir }, null, 2);
  writeFileSync(settingsPath, content, "utf-8");
  return content;
}

function createSettingsServiceWithDir(settingsDir: string) {
  process.env.NIBI_SETTINGS_DIR = settingsDir;
  return createSettingServiceWithMigrations().service;
}

function listRelocationStagingDirs(baseDir: string): string[] {
  const nibiRoot = join(baseDir, ".nibi");
  if (!existsSync(nibiRoot)) return [];
  return readdirSync(nibiRoot).filter((name) => name.startsWith(".migrating-"));
}

function createLegacyCipher() {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NIBI_CREDENTIAL_SECRET;
  return createCredentialCipherProvider({ env });
}

describe("relocateDataRoot", () => {
  it("切根后冷重启仍能解密旧的 OAuth/JWT/license v2 密文", async () => {
    const source = makeTempDir("nibi-relocate-src-");
    const target = makeTempDir("nibi-relocate-dst-");
    const values = await seedSourceCredentials(source);
    const sourceV2Dir = join(source, ".nibi", "v2");
    writeFileSync(join(sourceV2Dir, "app-canary.txt"), "app-data", "utf-8");
    writeFileSync(join(sourceV2Dir, "setting.json"), '{"dataBaseDir":"stale"}', "utf-8");
    expect(readFileSync(join(sourceV2Dir, "credentials.json"), "utf-8")).toContain("enc:v2:");

    const result = await relocateDataRoot(source, target);

    expect(result.copiedData).toBe(true);
    expect(result.copiedMachine).toBe(true);
    expect(result.verification.skipReason).toBeNull();
    expect(result.verification.v2ValueCount).toBeGreaterThanOrEqual(3);
    expect(result.verification.verifiedV2Key).toBe("oauth:nibi:access_token");

    const targetV2Dir = join(target, ".nibi", "v2");
    expect(readFileSync(join(targetV2Dir, "app-canary.txt"), "utf-8")).toBe("app-data");
    // setting.json 是 bootstrap 指针，必须留在默认 home，不随数据迁移。
    expect(existsSync(join(targetV2Dir, "setting.json"))).toBe(false);
    // 钥匙必须在 v2 之外；只拷 v2 的攻击面仍然解不开。
    expect(existsSync(join(target, ".nibi", "machine", "credential-v2.key"))).toBe(true);
    expect(existsSync(join(targetV2Dir, "credential-v2.key"))).toBe(false);
    // 迁移是复制不是移动。
    expect(existsSync(join(sourceV2Dir, "credentials.json"))).toBe(true);

    // 模拟冷重启：新进程只拿到目标根，重建凭据服务后旧密文仍可解。
    setDataBaseDir(target);
    const restarted = createCredentialService();
    for (const [key, expected] of Object.entries(values)) {
      await expect(restarted.load(key)).resolves.toBe(expected);
    }
  });

  it("目标已有不同的安装密钥时拒绝迁移，源与 setting 都不变", async () => {
    const source = makeTempDir("nibi-relocate-key-src-");
    const target = makeTempDir("nibi-relocate-key-dst-");
    const settingsDir = makeTempDir("nibi-relocate-key-settings-");
    const values = await seedSourceCredentials(source);
    const sourceCredentialsPath = join(source, ".nibi", "v2", "credentials.json");
    const sourceCredentialsBefore = readFileSync(sourceCredentialsPath);

    const targetKeyDir = join(target, ".nibi", "machine");
    mkdirSync(targetKeyDir, { recursive: true });
    const targetKeyPath = join(targetKeyDir, "credential-v2.key");
    const otherKey = `${Buffer.alloc(32, 7).toString("base64url")}\n`;
    writeFileSync(targetKeyPath, otherKey, "utf-8");

    const settingsContentBefore = writeSettingPointer(settingsDir, source);
    setDataBaseDir(source);
    const service = createSettingsServiceWithDir(settingsDir);

    await expect(service.updateDataBaseDir(target)).rejects.toMatchObject({
      code: DATA_ROOT_RELOCATION_ERROR_CODES.keyConflict,
    });

    expect(readFileSync(join(settingsDir, "setting.json"), "utf-8")).toBe(settingsContentBefore);
    expect(readFileSync(targetKeyPath, "utf-8")).toBe(otherKey);
    expect(existsSync(join(target, ".nibi", "v2"))).toBe(false);
    expect(readFileSync(sourceCredentialsPath)).toEqual(sourceCredentialsBefore);
    // 源凭据仍可解，说明失败路径没有动过源根。
    setDataBaseDir(source);
    const sourceService = createCredentialService();
    await expect(sourceService.load("oauth:nibi:access_token")).resolves.toBe(
      values["oauth:nibi:access_token"],
    );
  });

  it("目标已有同一把钥匙时迁移成功、续用目标钥匙且不覆盖它", async () => {
    const source = makeTempDir("nibi-relocate-samekey-src-");
    const target = makeTempDir("nibi-relocate-samekey-dst-");
    const settingsDir = makeTempDir("nibi-relocate-samekey-settings-");
    const values = await seedSourceCredentials(source);

    const sourceMachineDir = join(source, ".nibi", "machine");
    const sourceKey = readFileSync(join(sourceMachineDir, "credential-v2.key"));
    // machine 目录整体迁移：除钥匙外的机器级文件也要跟过去。
    writeFileSync(join(sourceMachineDir, "machine-extra.txt"), "machine-extra", "utf-8");

    const targetMachineDir = join(target, ".nibi", "machine");
    mkdirSync(targetMachineDir, { recursive: true });
    const targetKeyPath = join(targetMachineDir, "credential-v2.key");
    writeFileSync(targetKeyPath, sourceKey);
    const sentinelTime = new Date("2001-02-03T04:05:06.000Z");
    utimesSync(targetKeyPath, sentinelTime, sentinelTime);

    const settingsContentBefore = writeSettingPointer(settingsDir, source);
    setDataBaseDir(source);
    const service = createSettingsServiceWithDir(settingsDir);

    await service.updateDataBaseDir(target);

    // 同钥时续用目标钥匙文件（mtime 仍是哨兵值，说明没有被复制覆盖）。
    expect(readFileSync(targetKeyPath)).toEqual(sourceKey);
    expect(statSync(targetKeyPath).mtimeMs).toBeLessThan(Date.now() - 60_000);
    expect(readFileSync(join(targetMachineDir, "machine-extra.txt"), "utf-8")).toBe(
      "machine-extra",
    );
    expect(readFileSync(join(settingsDir, "setting.json"), "utf-8")).not.toBe(
      settingsContentBefore,
    );
    const settings = JSON.parse(readFileSync(join(settingsDir, "setting.json"), "utf-8"));
    expect(settings.dataBaseDir).toBe(target);

    setDataBaseDir(target);
    const restarted = createCredentialService();
    await expect(restarted.load("nibi-jwttoken")).resolves.toBe(values["nibi-jwttoken"]);
  });

  it("publish 成功但 setting 写失败后重试：同安装非空目标可合并且不覆盖", async () => {
    const source = makeTempDir("nibi-relocate-settingfail-src-");
    const target = makeTempDir("nibi-relocate-settingfail-dst-");
    const settingsDir = makeTempDir("nibi-relocate-settingfail-settings-");
    const values = await seedSourceCredentials(source);
    writeFileSync(join(source, ".nibi", "v2", "app-canary.txt"), "source-v1", "utf-8");
    const settingsContentBefore = writeSettingPointer(settingsDir, source);
    setDataBaseDir(source);
    const service = createSettingsServiceWithDir(settingsDir);

    setFsFaultInjectorForTests(
      createFsFaultInjector([
        {
          id: "setting-write-failure",
          code: "EIO",
          operations: ["writeFile"],
          pathEndsWith: "setting.json",
          maxMatches: 1,
          message: "injected setting write failure",
        },
      ]),
    );

    await expect(service.updateDataBaseDir(target)).rejects.toThrow(
      /injected setting write failure/,
    );

    // 数据已发布到目标，但 setting 仍指向旧根。
    expect(readFileSync(join(settingsDir, "setting.json"), "utf-8")).toBe(settingsContentBefore);
    expect(existsSync(join(target, ".nibi", "v2", "credentials.json"))).toBe(true);

    // 目标里已有内容被保留；源里 publish 之后新增的文件要在重试时补进去。
    writeFileSync(join(target, ".nibi", "v2", "app-canary.txt"), "target-edited", "utf-8");
    writeFileSync(join(source, ".nibi", "v2", "source-after-publish.txt"), "source-new", "utf-8");

    resetProcessFsFaultInjectorForTests();
    await service.updateDataBaseDir(target);

    expect(readFileSync(join(target, ".nibi", "v2", "app-canary.txt"), "utf-8")).toBe(
      "target-edited",
    );
    expect(readFileSync(join(target, ".nibi", "v2", "source-after-publish.txt"), "utf-8")).toBe(
      "source-new",
    );
    expect(JSON.parse(readFileSync(join(settingsDir, "setting.json"), "utf-8")).dataBaseDir).toBe(
      target,
    );

    setDataBaseDir(target);
    const restarted = createCredentialService();
    await expect(restarted.load("oauth:nibi:access_token")).resolves.toBe(
      values["oauth:nibi:access_token"],
    );
  });

  it("同一安装密钥时允许还原回非空旧根：已有文件不覆盖、源新增文件补入", async () => {
    const oldRoot = makeTempDir("nibi-relocate-restore-old-");
    const newRoot = makeTempDir("nibi-relocate-restore-new-");
    const values = await seedSourceCredentials(oldRoot);
    writeFileSync(join(oldRoot, ".nibi", "v2", "a-only.txt"), "a-version", "utf-8");

    await relocateDataRoot(oldRoot, newRoot);

    // 新根使用一段时间：改写同名文件，并新增只存在于新根的文件。
    writeFileSync(join(newRoot, ".nibi", "v2", "a-only.txt"), "b-version", "utf-8");
    writeFileSync(join(newRoot, ".nibi", "v2", "b-only.txt"), "b-new", "utf-8");

    const result = await relocateDataRoot(newRoot, oldRoot);

    expect(result.targetKeyState).toBe("same");
    // 旧根已有文件保留旧版本；新根新增文件补进来。
    expect(readFileSync(join(oldRoot, ".nibi", "v2", "a-only.txt"), "utf-8")).toBe("a-version");
    expect(readFileSync(join(oldRoot, ".nibi", "v2", "b-only.txt"), "utf-8")).toBe("b-new");

    setDataBaseDir(oldRoot);
    const restarted = createCredentialService();
    await expect(restarted.load("nibi:license:token")).resolves.toBe(values["nibi:license:token"]);
  });

  it("目标非空但安装密钥不同：拒绝且源与目标都不变", async () => {
    const source = makeTempDir("nibi-relocate-occupied-diffkey-src-");
    const target = makeTempDir("nibi-relocate-occupied-diffkey-dst-");
    await seedSourceCredentials(source);
    const sourceCredentialsPath = join(source, ".nibi", "v2", "credentials.json");
    const sourceCredentialsBefore = readFileSync(sourceCredentialsPath);

    const targetV2Dir = join(target, ".nibi", "v2");
    mkdirSync(targetV2Dir, { recursive: true });
    writeFileSync(join(targetV2Dir, "existing.txt"), "target-keep", "utf-8");
    const targetMachineDir = join(target, ".nibi", "machine");
    mkdirSync(targetMachineDir, { recursive: true });
    const targetKeyPath = join(targetMachineDir, "credential-v2.key");
    const otherKey = `${Buffer.alloc(32, 9).toString("base64url")}\n`;
    writeFileSync(targetKeyPath, otherKey, "utf-8");

    await expect(relocateDataRoot(source, target)).rejects.toMatchObject({
      code: DATA_ROOT_RELOCATION_ERROR_CODES.keyConflict,
    });

    expect(readFileSync(join(targetV2Dir, "existing.txt"), "utf-8")).toBe("target-keep");
    expect(readFileSync(targetKeyPath, "utf-8")).toBe(otherKey);
    expect(readFileSync(sourceCredentialsPath)).toEqual(sourceCredentialsBefore);
    expect(existsSync(join(targetV2Dir, "app-canary.txt"))).toBe(false);
  });

  it("目标非空但缺少安装密钥：拒绝且不创建 machine 或补入源文件", async () => {
    const source = makeTempDir("nibi-relocate-occupied-nokey-src-");
    const target = makeTempDir("nibi-relocate-occupied-nokey-dst-");
    await seedSourceCredentials(source);
    const sourceCredentialsPath = join(source, ".nibi", "v2", "credentials.json");
    const sourceCredentialsBefore = readFileSync(sourceCredentialsPath);
    const targetV2Dir = join(target, ".nibi", "v2");
    mkdirSync(targetV2Dir, { recursive: true });
    writeFileSync(join(targetV2Dir, "existing.txt"), "target-keep", "utf-8");

    await expect(relocateDataRoot(source, target)).rejects.toMatchObject({
      code: DATA_ROOT_RELOCATION_ERROR_CODES.targetNotEmpty,
    });

    expect(readFileSync(join(targetV2Dir, "existing.txt"), "utf-8")).toBe("target-keep");
    expect(existsSync(join(target, ".nibi", "machine"))).toBe(false);
    expect(existsSync(join(targetV2Dir, "credentials.json"))).toBe(false);
    expect(readFileSync(sourceCredentialsPath)).toEqual(sourceCredentialsBefore);
  });

  it("源缺少安装密钥而目标非空：拒绝（无法证明同一安装）", async () => {
    const source = makeTempDir("nibi-relocate-occupied-targetonly-src-");
    const target = makeTempDir("nibi-relocate-occupied-targetonly-dst-");
    const sourceV2Dir = join(source, ".nibi", "v2");
    mkdirSync(sourceV2Dir, { recursive: true });
    const sourceRecord = {
      "oauth:legacy:access_token": createLegacyCipher().encrypt("legacy-only-token"),
    };
    writeFileSync(
      join(sourceV2Dir, "credentials.json"),
      `${JSON.stringify(sourceRecord, null, 2)}\n`,
      "utf-8",
    );

    const targetV2Dir = join(target, ".nibi", "v2");
    mkdirSync(targetV2Dir, { recursive: true });
    writeFileSync(join(targetV2Dir, "existing.txt"), "target-keep", "utf-8");
    const targetMachineDir = join(target, ".nibi", "machine");
    mkdirSync(targetMachineDir, { recursive: true });
    const targetKeyPath = join(targetMachineDir, "credential-v2.key");
    const targetKey = `${Buffer.alloc(32, 5).toString("base64url")}\n`;
    writeFileSync(targetKeyPath, targetKey, "utf-8");

    await expect(relocateDataRoot(source, target)).rejects.toMatchObject({
      code: DATA_ROOT_RELOCATION_ERROR_CODES.targetNotEmpty,
    });

    expect(readFileSync(join(targetV2Dir, "existing.txt"), "utf-8")).toBe("target-keep");
    expect(readFileSync(targetKeyPath, "utf-8")).toBe(targetKey);
    expect(existsSync(join(targetV2Dir, "credentials.json"))).toBe(false);
  });

  it("注入复制失败时 setting 不变、目标无正式目录，重试幂等", async () => {
    const source = makeTempDir("nibi-relocate-copyfail-src-");
    const target = makeTempDir("nibi-relocate-copyfail-dst-");
    const settingsDir = makeTempDir("nibi-relocate-copyfail-settings-");
    const values = await seedSourceCredentials(source);
    const sourceCredentialsBefore = readFileSync(join(source, ".nibi", "v2", "credentials.json"));
    const settingsContentBefore = writeSettingPointer(settingsDir, source);
    setDataBaseDir(source);
    const service = createSettingsServiceWithDir(settingsDir);

    setFsFaultInjectorForTests(
      createFsFaultInjector([
        {
          id: "copy-failure",
          code: "EIO",
          operations: ["writeFile"],
          pathIncludes: ".migrating-",
          maxMatches: 1,
          message: "injected copy failure",
        },
      ]),
    );

    await expect(service.updateDataBaseDir(target)).rejects.toThrow(/injected copy failure/);

    expect(readFileSync(join(settingsDir, "setting.json"), "utf-8")).toBe(settingsContentBefore);
    expect(existsSync(join(target, ".nibi", "v2"))).toBe(false);
    expect(existsSync(join(target, ".nibi", "machine"))).toBe(false);
    expect(listRelocationStagingDirs(target)).toEqual([]);
    expect(readFileSync(join(source, ".nibi", "v2", "credentials.json"))).toEqual(
      sourceCredentialsBefore,
    );

    // 去掉故障后重试：同一目标可以完整迁移，没有半套目录残留干扰。
    resetProcessFsFaultInjectorForTests();
    await service.updateDataBaseDir(target);
    expect(JSON.parse(readFileSync(join(settingsDir, "setting.json"), "utf-8")).dataBaseDir).toBe(
      target,
    );
    setDataBaseDir(target);
    const restarted = createCredentialService();
    await expect(restarted.load("nibi:license:token")).resolves.toBe(values["nibi:license:token"]);
  });

  it("注入验证失败时 setting 不变、目标无正式目录，重试幂等", async () => {
    const source = makeTempDir("nibi-relocate-verifyfail-src-");
    const target = makeTempDir("nibi-relocate-verifyfail-dst-");
    const settingsDir = makeTempDir("nibi-relocate-verifyfail-settings-");
    const values = await seedSourceCredentials(source);
    const settingsContentBefore = writeSettingPointer(settingsDir, source);
    setDataBaseDir(source);
    const service = createSettingsServiceWithDir(settingsDir);

    setFsFaultInjectorForTests(
      createFsFaultInjector([
        {
          id: "verify-failure",
          code: "EIO",
          operations: ["readFile"],
          pathEndsWith: "credentials.json",
          maxMatches: 1,
          message: "injected verify read failure",
        },
      ]),
    );

    await expect(service.updateDataBaseDir(target)).rejects.toMatchObject({
      code: DATA_ROOT_RELOCATION_ERROR_CODES.credentialVerificationFailed,
    });

    expect(readFileSync(join(settingsDir, "setting.json"), "utf-8")).toBe(settingsContentBefore);
    expect(existsSync(join(target, ".nibi", "v2"))).toBe(false);
    expect(existsSync(join(target, ".nibi", "machine"))).toBe(false);
    expect(listRelocationStagingDirs(target)).toEqual([]);

    resetProcessFsFaultInjectorForTests();
    await service.updateDataBaseDir(target);
    expect(JSON.parse(readFileSync(join(settingsDir, "setting.json"), "utf-8")).dataBaseDir).toBe(
      target,
    );
    setDataBaseDir(target);
    const restarted = createCredentialService();
    await expect(restarted.load("oauth:nibi:access_token")).resolves.toBe(
      values["oauth:nibi:access_token"],
    );
  });

  it("源密钥缺失时 v2 凭据在暂存区无法验证，拒绝发布", async () => {
    const source = makeTempDir("nibi-relocate-nokey-src-");
    const target = makeTempDir("nibi-relocate-nokey-dst-");
    await seedSourceCredentials(source);
    rmSync(join(source, ".nibi", "machine", "credential-v2.key"));

    await expect(relocateDataRoot(source, target)).rejects.toMatchObject({
      code: DATA_ROOT_RELOCATION_ERROR_CODES.credentialVerificationFailed,
    });

    expect(existsSync(join(target, ".nibi", "v2"))).toBe(false);
    expect(existsSync(join(target, ".nibi", "machine"))).toBe(false);
    // 源数据原样保留，便于用户恢复密钥后重试。
    expect(existsSync(join(source, ".nibi", "v2", "credentials.json"))).toBe(true);
  });

  it("目标 v2 是空目录时先清理空目录再发布（Windows rename 语义）", async () => {
    const source = makeTempDir("nibi-relocate-emptydir-src-");
    const target = makeTempDir("nibi-relocate-emptydir-dst-");
    await seedSourceCredentials(source);
    mkdirSync(join(target, ".nibi", "v2"), { recursive: true });

    const result = await relocateDataRoot(source, target);

    expect(result.copiedData).toBe(true);
    expect(existsSync(join(target, ".nibi", "v2", "credentials.json"))).toBe(true);
    expect(existsSync(join(target, ".nibi", "machine", "credential-v2.key"))).toBe(true);
  });

  it("目标已有非空数据目录时拒绝，不覆盖目标文件", async () => {
    const source = makeTempDir("nibi-relocate-nonempty-src-");
    const target = makeTempDir("nibi-relocate-nonempty-dst-");
    await seedSourceCredentials(source);
    const targetV2Dir = join(target, ".nibi", "v2");
    mkdirSync(targetV2Dir, { recursive: true });
    writeFileSync(join(targetV2Dir, "existing.txt"), "keep-me", "utf-8");

    await expect(relocateDataRoot(source, target)).rejects.toMatchObject({
      code: DATA_ROOT_RELOCATION_ERROR_CODES.targetNotEmpty,
    });

    expect(readFileSync(join(targetV2Dir, "existing.txt"), "utf-8")).toBe("keep-me");
    expect(existsSync(join(target, ".nibi", "machine"))).toBe(false);
    expect(existsSync(join(source, ".nibi", "v2", "credentials.json"))).toBe(true);
  });

  it("v1+v2 混合凭据迁移后都能解出，且 v1/v2 各验证一条", async () => {
    const source = makeTempDir("nibi-relocate-mixed-src-");
    const target = makeTempDir("nibi-relocate-mixed-dst-");
    const values = await seedSourceCredentials(source);

    const credentialsPath = join(source, ".nibi", "v2", "credentials.json");
    const record = JSON.parse(readFileSync(credentialsPath, "utf-8")) as Record<string, string>;
    record["oauth:legacy:access_token"] = createLegacyCipher().encrypt("legacy-access-token");
    writeFileSync(credentialsPath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");

    const result = await relocateDataRoot(source, target);

    expect(result.verification.v1ValueCount).toBe(1);
    expect(result.verification.v2ValueCount).toBeGreaterThanOrEqual(3);
    expect(result.verification.verifiedV1Key).toBe("oauth:legacy:access_token");
    expect(result.verification.verifiedV2Key).toBe("oauth:nibi:access_token");
    expect(result.verification.skipReason).toBeNull();

    setDataBaseDir(target);
    const restarted = createCredentialService();
    await expect(restarted.load("oauth:legacy:access_token")).resolves.toBe("legacy-access-token");
    for (const [key, expected] of Object.entries(values)) {
      await expect(restarted.load(key)).resolves.toBe(expected);
    }
  });

  it("没有 v2 密文时跳过 v2 验证并报告原因", async () => {
    const source = makeTempDir("nibi-relocate-v1only-src-");
    const target = makeTempDir("nibi-relocate-v1only-dst-");
    const sourceV2Dir = join(source, ".nibi", "v2");
    mkdirSync(sourceV2Dir, { recursive: true });
    const legacyValue = createLegacyCipher().encrypt("legacy-only-token");
    writeFileSync(
      join(sourceV2Dir, "credentials.json"),
      `${JSON.stringify({ "oauth:legacy:access_token": legacyValue }, null, 2)}\n`,
      "utf-8",
    );

    const result = await relocateDataRoot(source, target);

    expect(result.copiedMachine).toBe(false);
    expect(result.verification.skipReason).toBe("no-v2-values");
    expect(result.verification.verifiedV2Key).toBeNull();
    expect(result.verification.verifiedV1Key).toBe("oauth:legacy:access_token");
    expect(result.verification.keySource).toBe("none");

    setDataBaseDir(target);
    const restarted = createCredentialService();
    await expect(restarted.load("oauth:legacy:access_token")).resolves.toBe("legacy-only-token");
  });

  it("清理残留的 .migrating-* 暂存目录", async () => {
    const target = makeTempDir("nibi-relocate-stale-dst-");
    const staleDir = join(target, ".nibi", ".migrating-123");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(join(staleDir, "half-copy.txt"), "partial", "utf-8");

    await expect(cleanupStaleRelocationStaging(target)).resolves.toBe(1);
    expect(existsSync(staleDir)).toBe(false);
  });
});
