import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCleanEnv,
  resolveProviderConfigDir,
} from "../src/runtime-tools/providerRuntimeResolver.js";
import { setDataBaseDir } from "../src/paths.js";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe("providerRuntimeResolver workspace config dir identity", () => {
  const originalHome = process.env.HOME;
  const createdDirs: string[] = [];

  afterEach(() => {
    restoreEnv("HOME", originalHome);
    setDataBaseDir(null);
    for (const dir of createdDirs.splice(0).reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GLM 配置目录由 Nibi Agent home 统一承载，不再按 workspaceIdentity 计算", () => {
    const home = mkdtempSync(join(tmpdir(), "nibi-agent-resolver-home-"));
    createdDirs.push(home);
    process.env.HOME = home;
    // Bugfix: paths.ts 会在模块加载时固定默认 dataBaseDir，测试不能只改 HOME。
    setDataBaseDir(home);

    const workspacePath = "/home/dev";
    const workspaceIdentity = "remote:ssh:localhost:2223:dev:/home/dev";

    expect(resolveProviderConfigDir("glm", workspacePath, workspaceIdentity)).toBe(
      join(home, ".nibi", "cli"),
    );
  });
});

describe("providerRuntimeResolver clean env", () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const createdDirs: string[] = [];

  afterEach(() => {
    restoreEnv("HOME", originalHome);
    restoreEnv("USERPROFILE", originalUserProfile);
    setDataBaseDir(null);

    for (const dir of createdDirs.splice(0).reverse()) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("glm clean env 会把 HOME 切到 dataBaseDir，保证 session 读写目录一致", () => {
    const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-glm-home-"));
    createdDirs.push(dataBaseDir);
    setDataBaseDir(dataBaseDir);

    const env = buildCleanEnv("glm", join(dataBaseDir, ".nibi", "cli"));

    expect(env.HOME).toBe(dataBaseDir);
    if (process.platform === "win32") {
      expect(env.USERPROFILE).toBe(dataBaseDir);
    }
  });

  it("clean env 会剔除宿主 GOOGLE_API_KEY 并保留调用方额外参数", () => {
    process.env.GOOGLE_API_KEY = "host-google-api-key";

    const env = buildCleanEnv("glm", "/tmp/glm-home", {
      EXTRA_FLAG: "1",
    });

    expect(env.GOOGLE_API_KEY).toBeUndefined();
    expect(env.EXTRA_FLAG).toBe("1");
  });

  it("agent 子进程会强制 Python 使用 UTF-8 输出，避免 Windows GBK 字节被模型读成乱码", () => {
    const env = buildCleanEnv("glm", "/tmp/glm-home");

    expect(env.PYTHONIOENCODING).toBe("utf-8");
    expect(env.PYTHONUTF8).toBe("1");
  });
});
