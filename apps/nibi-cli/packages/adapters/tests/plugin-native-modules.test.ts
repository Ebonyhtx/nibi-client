import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPluginNativeModules,
  scanPluginNativeModules,
} from "../src/plugins/native-modules.js";

let rootPath: string;

function writeFile(relativePath: string, contents = "binary"): void {
  const target = join(rootPath, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

beforeEach(() => {
  rootPath = mkdtempSync(join(tmpdir(), "nibi-native-modules-"));
});

afterEach(() => {
  rmSync(rootPath, { force: true, recursive: true });
});

describe("scanPluginNativeModules", () => {
  it("找出 node_modules 下的 .node 文件", () => {
    writeFile("plugin.json", "{}");
    writeFile("node_modules/better-sqlite3/build/Release/better_sqlite3.node");
    expect(scanPluginNativeModules(rootPath)).toEqual({
      files: ["node_modules/better-sqlite3/build/Release/better_sqlite3.node"],
      truncated: false,
    });
  });

  it("跳过 .git 与测试目录", () => {
    writeFile(".git/objects/thing.node");
    writeFile("tests/fixture.node");
    expect(scanPluginNativeModules(rootPath).files).toEqual([]);
  });

  it("没有原生模块时返回空", () => {
    writeFile("plugin.json", "{}");
    writeFile("skills/example/SKILL.md", "hi");
    expect(scanPluginNativeModules(rootPath)).toEqual({ files: [], truncated: false });
  });
});

describe("checkPluginNativeModules", () => {
  const declared = {
    apiVersion: "1" as const,
    entry: "index.js",
    native: true,
    napi: 9,
    platforms: ["win32-x64", "darwin-arm64"],
  };

  it("纯声明式插件放行", () => {
    writeFile("plugin.json", "{}");
    expect(checkPluginNativeModules({ rootPath, runtime: undefined })).toEqual({ status: "none" });
  });

  it("有 .node 但未声明 native 时拒绝", () => {
    writeFile("node_modules/x/build/x.node");
    const verdict = checkPluginNativeModules({
      platform: "win32-x64",
      rootPath,
      runtime: { apiVersion: "1", entry: "index.js" },
    });
    expect(verdict.status).toBe("undeclared");
  });

  it("平台不在声明列表内时拒绝", () => {
    writeFile("node_modules/x/build/x.node");
    const verdict = checkPluginNativeModules({ platform: "linux-x64", rootPath, runtime: declared });
    expect(verdict.status).toBe("platform_unsupported");
  });

  it("声明了 napi 并在支持平台上放行", () => {
    writeFile("node_modules/x/build/x.node");
    expect(checkPluginNativeModules({ platform: "win32-x64", rootPath, runtime: declared })).toEqual({
      files: ["node_modules/x/build/x.node"],
      status: "declared",
    });
  });

  it("Electron 宿主里没有 napi 声明的原生模块按 ABI 不匹配拒绝", () => {
    writeFile("node_modules/x/build/x.node");
    const verdict = checkPluginNativeModules({
      hostKind: "electron",
      platform: "win32-x64",
      rootPath,
      runtime: { apiVersion: "1", entry: "index.js", native: true, platforms: ["win32-x64"] },
    });
    expect(verdict.status).toBe("abi_unsupported");
  });

  it("官方 Node 宿主里没有 napi 声明也放行（由加载探针决定）", () => {
    writeFile("node_modules/x/build/x.node");
    const verdict = checkPluginNativeModules({
      hostKind: "node",
      platform: "win32-x64",
      rootPath,
      runtime: { apiVersion: "1", entry: "index.js", native: true, platforms: ["win32-x64"] },
    });
    expect(verdict.status).toBe("declared");
  });
});
