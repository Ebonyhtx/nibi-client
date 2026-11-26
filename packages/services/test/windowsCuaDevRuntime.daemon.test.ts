/**
 * 产品运行时清单里的可选 `daemon`（原生 agent cursor 的可执行文件）。
 *
 * 为什么要在宿主侧验：daemon 是新增的外部进程入口，属于"能被启动的代码"。
 * 只验 entry/addon 会让它成为清单外的可执行文件；而把 daemon 当必需键又会
 * 立刻打断老清单（没有 daemon 的运行时必须继续可用，只是没有 ghost）。
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveWindowsCuaRuntime,
  WindowsCuaDevRuntimeResolutionError,
} from "#src/cua-permission-broker/windowsCuaDevRuntime.js";
import type { WindowsCuaRuntimeFileSystem } from "#src/cua-permission-broker/windowsCuaDevRuntime.js";

const HASH_ENTRY = "a".repeat(64);
const HASH_ADDON = "b".repeat(64);
const HASH_DAEMON = "c".repeat(64);

function createFileSystem(files: Map<string, string>): WindowsCuaRuntimeFileSystem {
  // Stats 的 isFile/isDirectory 在接口里是**方法**（Node 的 Stats 形状），不是布尔字段。
  const statsFor = (path: string) => {
    const directory = files.has(`${path}/`);
    const file = files.has(path);
    return {
      isDirectory: () => directory,
      isFile: () => file,
      isSymbolicLink: () => false,
    };
  };
  return {
    async stat(path) {
      return statsFor(path);
    },
    async lstat(path) {
      return statsFor(path);
    },
    async realpath(path) {
      return path;
    },
    async readFile(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`ENOENT ${path}`);
      return value;
    },
  };
}

function buildRuntime(manifest: Record<string, unknown>) {
  const resourcesPath = join(process.cwd(), "fake-resources");
  const root = join(resourcesPath, "tools", "cua-helper");
  const files = new Map<string, string>();
  files.set(`${root}/`, "");
  files.set(join(root, "package.json"), JSON.stringify({ type: "module" }));
  files.set(join(root, "helper", "main.js"), "export {};");
  files.set(join(root, "node_modules", "@trycua", "pkg", "addon.node"), "addon");
  files.set(join(root, "runtime-manifest.json"), JSON.stringify(manifest));
  return { resourcesPath, root, files };
}

const baseManifest = {
  schemaVersion: 1,
  packageName: "@nibi/cua",
  packageVersion: "0.7.0",
  platform: "win32",
  arch: "x64",
  electronVersion: "44.10.1",
  entry: "helper/main.js",
  addon: "node_modules/@trycua/pkg/addon.node",
  sha256: { entry: HASH_ENTRY, addon: HASH_ADDON },
};

function resolveWith(files: Map<string, string>, resourcesPath: string) {
  return resolveWindowsCuaRuntime({
    platform: "win32",
    resourcesPath,
    arch: "x64",
    electronVersion: "44.10.1",
    fileSystem: createFileSystem(files),
    hashBytes: async (bytes) => {
      const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
      if (text === "export {};") return HASH_ENTRY;
      if (text === "addon") return HASH_ADDON;
      return HASH_DAEMON;
    },
  });
}

describe("Windows CUA runtime manifest daemon artifact", () => {
  it("accepts a manifest without daemon (old runtimes keep working)", async () => {
    const { resourcesPath, files } = buildRuntime(baseManifest);
    await expect(resolveWith(files, resourcesPath)).resolves.toMatchObject({
      root: expect.stringContaining("cua-helper"),
    });
  });

  it("verifies the declared daemon file", async () => {
    const { resourcesPath, root, files } = buildRuntime({
      ...baseManifest,
      daemon: "bin/cua-driver.exe",
      sha256: { ...baseManifest.sha256, daemon: HASH_DAEMON },
    });
    files.set(join(root, "bin", "cua-driver.exe"), "MZ fake pe");
    await expect(resolveWith(files, resourcesPath)).resolves.toBeTruthy();
  });

  it("reports missing-daemon when the declared file is absent", async () => {
    const { resourcesPath, files } = buildRuntime({
      ...baseManifest,
      daemon: "bin/cua-driver.exe",
      sha256: { ...baseManifest.sha256, daemon: HASH_DAEMON },
    });
    await expect(resolveWith(files, resourcesPath)).rejects.toMatchObject({
      name: WindowsCuaDevRuntimeResolutionError.name,
      reason: "missing-daemon",
      artifact: "bin/cua-driver.exe",
    });
  });

  it("rejects a daemon whose hash does not match", async () => {
    const { resourcesPath, root, files } = buildRuntime({
      ...baseManifest,
      daemon: "bin/cua-driver.exe",
      sha256: { ...baseManifest.sha256, daemon: HASH_DAEMON },
    });
    files.set(join(root, "bin", "cua-driver.exe"), "tampered");
    await expect(
      resolveWindowsCuaRuntime({
        platform: "win32",
        resourcesPath,
        arch: "x64",
        electronVersion: "44.10.1",
        fileSystem: createFileSystem(files),
        hashBytes: async (bytes) => {
          const text = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
          if (text === "export {};") return HASH_ENTRY;
          if (text === "addon") return HASH_ADDON;
          return "d".repeat(64);
        },
      }),
    ).rejects.toMatchObject({ reason: "artifact-integrity-mismatch", artifact: "daemon" });
  });

  it("rejects a daemon without its own sha256 entry", async () => {
    const { resourcesPath, root, files } = buildRuntime({
      ...baseManifest,
      daemon: "bin/cua-driver.exe",
    });
    files.set(join(root, "bin", "cua-driver.exe"), "MZ fake pe");
    await expect(resolveWith(files, resourcesPath)).rejects.toMatchObject({
      reason: "incompatible-runtime-manifest",
    });
  });

  it("rejects a daemon that escapes the runtime root", async () => {
    const { resourcesPath, files } = buildRuntime({
      ...baseManifest,
      daemon: "../cua-driver.exe",
      sha256: { ...baseManifest.sha256, daemon: HASH_DAEMON },
    });
    await expect(resolveWith(files, resourcesPath)).rejects.toMatchObject({
      reason: "invalid-artifact-path",
      artifact: "daemon",
    });
  });
});
