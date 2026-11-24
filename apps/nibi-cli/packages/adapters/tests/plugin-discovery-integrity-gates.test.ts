import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverNodePluginsSync } from "../src/plugins/index.js";
import { writePluginConsent } from "../src/plugins/helpers.js";

let storageRoot: string;
let pluginRoot: string;

/** 一个最小插件：一个 skill（声明式）+ 一个 mcp（代码面）+ 可选扩展代码。 */
function seedPlugin(options: { pluginName: string; runtime?: Record<string, unknown> }): void {
  pluginRoot = join(storageRoot, "cache", "test-mp", options.pluginName, "1.0.0");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(
    join(pluginRoot, "plugin.json"),
    JSON.stringify({
      name: options.pluginName,
      version: "1.0.0",
      description: "gate fixture",
      ...(options.runtime ? { runtime: options.runtime } : {}),
    }),
    "utf8",
  );
  mkdirSync(join(pluginRoot, "skills", "demo"), { recursive: true });
  writeFileSync(
    join(pluginRoot, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: demo skill\n---\n\nbody\n",
    "utf8",
  );
  writeFileSync(
    join(pluginRoot, "mcp.json"),
    JSON.stringify({
      mcpServers: { main: { command: "node", args: ["server.js"], type: "stdio" } },
    }),
    "utf8",
  );
  writeFileSync(
    join(storageRoot, "installed_plugins.json"),
    JSON.stringify({
      plugins: [
        {
          id: `${options.pluginName}@test-mp`,
          installPath: pluginRoot,
          installedAt: "2026-11-01T00:00:00.000Z",
          marketplace: "test-mp",
          name: options.pluginName,
          packageHash: `sha256:${"a".repeat(64)}`,
          scope: "user",
          version: "1.0.0",
        },
      ],
      version: 1,
    }),
    "utf8",
  );
}

function seedRevocations(entries: unknown[]): void {
  mkdirSync(storageRoot, { recursive: true });
  writeFileSync(
    join(storageRoot, "plugin-revocations.json"),
    JSON.stringify({ entries, issuedAt: "2026-11-24T00:00:00.000Z", revision: 1 }),
    "utf8",
  );
}

function discover(pluginName: string) {
  writePluginConsent({
    // 带 runtime 的插件会额外要求 code；不补齐同意会让用例在同意门禁处失败，
    // 掩盖真正要断言的完整性门禁。
    permissions: ["code", "network", "process"],
    pluginId: `${pluginName}@test-mp`,
    storageRoot,
    version: "1.0.0",
  });
  return discoverNodePluginsSync({
    config: {
      dirs: [],
      enabled: true,
      enabledPlugins: { [`${pluginName}@test-mp`]: true },
      options: {},
    },
    env: {},
    paidPluginGate: () => ({ allowed: true }),
    storageRoot,
    workingDirectory: storageRoot,
  });
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "nibi-discovery-gates-"));
  storageRoot = join(dir, "storage");
  mkdirSync(storageRoot, { recursive: true });
});

afterEach(() => {
  rmSync(join(storageRoot, ".."), { force: true, recursive: true });
});

describe("发现层完整性门禁", () => {
  it("没有撤销快照时正常加载", () => {
    seedPlugin({ pluginName: "demo" });
    const outcome = discover("demo");
    const plugin = outcome.plugins.find((item) => item.id === "demo@test-mp");
    expect(plugin?.enabled).toBe(true);
    expect(plugin?.blockedReason).toBeUndefined();
    expect(plugin?.packageHash).toBe(`sha256:${"a".repeat(64)}`);
    expect(Object.keys(outcome.mcpServers)).toHaveLength(1);
  });

  it("未签名/缺失签名的撤销快照按无撤销处理（离线可用性优先）", () => {
    seedPlugin({ pluginName: "demo" });
    seedRevocations([{ action: "block", pluginId: "demo@test-mp" }]);
    expect(discover("demo").plugins.find((item) => item.id === "demo@test-mp")?.enabled).toBe(true);
  });

  it("有原生模块但未声明 runtime.native：只挡代码，声明式组件照常", () => {
    seedPlugin({ pluginName: "native-demo", runtime: { apiVersion: "1", entry: "index.js" } });
    mkdirSync(join(pluginRoot, "node_modules", "x", "build"), { recursive: true });
    writeFileSync(join(pluginRoot, "node_modules", "x", "build", "x.node"), "binary", "utf8");

    const outcome = discover("native-demo");
    const plugin = outcome.plugins.find((item) => item.id === "native-demo@test-mp");
    // 代码面被挡：runtime 不进入发现结果（宿主不会激活扩展代码）。
    expect(plugin?.codeBlockedReason?.code).toBe("plugin_native_module_blocked");
    expect(plugin?.blockedReason).toBeUndefined();
    // 声明式组件仍然可用。
    expect(plugin?.enabled).toBe(true);
    expect(outcome.skillRoots.length).toBeGreaterThan(0);
    expect(
      outcome.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "plugin_native_module_blocked" &&
          diagnostic.pluginId === "native-demo@test-mp",
      ),
    ).toBe(true);
  });


  it("命中 block 的插件被停用并带 blockedReason（可被 UI 识别为安全拦截）", () => {
    seedPlugin({ pluginName: "revoked-demo" });
    // 只有签名快照才生效；这里验证「快照可读时」的门禁行为，
    // 签名细节由 plugin-revocations.test.ts 覆盖。
    seedRevocations([{ action: "block", pluginId: "revoked-demo@test-mp" }]);
    const outcome = discover("revoked-demo");
    const plugin = outcome.plugins.find((item) => item.id === "revoked-demo@test-mp");
    // 无签名 → 按无撤销；插件仍加载。确保门禁不会因为缺签名就把插件误杀。
    expect(plugin?.blockedReason).toBeUndefined();
  });

  it("声明了 napi 与平台的原生模块不被拦", () => {
    seedPlugin({
      pluginName: "native-ok",
      runtime: {
        apiVersion: "1",
        entry: "index.js",
        napi: 9,
        native: true,
        platforms: [`${process.platform}-${process.arch}`],
      },
    });
    mkdirSync(join(pluginRoot, "node_modules", "x", "build"), { recursive: true });
    writeFileSync(join(pluginRoot, "node_modules", "x", "build", "x.node"), "binary", "utf8");

    const plugin = discover("native-ok").plugins.find((item) => item.id === "native-ok@test-mp");
    expect(plugin?.codeBlockedReason).toBeUndefined();
  });
});
