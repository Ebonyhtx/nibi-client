import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverNodePluginsSync } from "../src/plugins/index.js";
import { writePluginConsent } from "../src/plugins/helpers.js";
import { getPluginViewRoot, PLUGIN_VIEWS_DIR } from "../src/plugins/view-root.js";

let storageRoot: string;
let installRoot: string;

/** 已安装插件：带 mcp.json、默认 skills、清单自定义路径与 runtime 入口。 */
function seedInstalledPlugin(pluginName = "wired"): void {
  installRoot = join(storageRoot, "cache", "test-mp", pluginName, "1.0.0");
  mkdirSync(join(installRoot, "skills", "demo"), { recursive: true });
  writeFileSync(
    join(installRoot, "plugin.json"),
    JSON.stringify({
      name: pluginName,
      skills: ["./custom-lessons", "./skills"],
      version: "1.0.0",
    }),
    "utf8",
  );
  writeFileSync(
    join(installRoot, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: demo\n---\n",
    "utf8",
  );
  mkdirSync(join(installRoot, "custom-lessons", "lesson"), { recursive: true });
  writeFileSync(
    join(installRoot, "custom-lessons", "lesson", "SKILL.md"),
    "---\nname: lesson\ndescription: lesson\n---\n",
    "utf8",
  );
  writeFileSync(
    join(installRoot, "mcp.json"),
    JSON.stringify({
      mcpServers: { main: { command: "node", args: ["server.js"], type: "stdio" } },
    }),
    "utf8",
  );
  writeFileSync(join(installRoot, "server.js"), "module.exports = {};\n", "utf8");
  writeFileSync(
    join(storageRoot, "installed_plugins.json"),
    JSON.stringify({
      plugins: [
        {
          id: `${pluginName}@test-mp`,
          installPath: installRoot,
          installedAt: "2026-11-01T00:00:00.000Z",
          marketplace: "test-mp",
          name: pluginName,
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

function discover(pluginName = "wired") {
  writePluginConsent({
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
  const dir = mkdtempSync(join(tmpdir(), "nibi-view-root-wiring-"));
  storageRoot = join(dir, "storage");
  mkdirSync(storageRoot, { recursive: true });
});

afterEach(() => {
  rmSync(join(storageRoot, ".."), { force: true, recursive: true });
});

describe("已安装插件读视图根", () => {
  it("运行时根指向视图根，且 MCP / 默认与自定义 skills 一个都不少", () => {
    seedInstalledPlugin();
    const outcome = discover();
    const plugin = outcome.plugins.find((item) => item.id === "wired@test-mp");
    const expectedViewRoot = getPluginViewRoot(storageRoot, "wired@test-mp");

    expect(plugin?.rootPath).toBe(expectedViewRoot);
    // 这是接线前最危险的回归点：视图漏 mcp.json 时 MCP server 会静默消失。
    expect(Object.keys(outcome.mcpServers)).toHaveLength(1);
    // 默认目录与清单自定义路径都要在。
    const skillPaths = outcome.skillRoots.map((root) => root.path);
    expect(skillPaths).toContain(join(expectedViewRoot, "skills"));
    expect(skillPaths).toContain(join(expectedViewRoot, "custom-lessons"));
    // 视图清单是规范化的那份（带来源元数据）。
    const manifest = JSON.parse(
      readFileSync(join(expectedViewRoot, "plugin.json"), "utf8"),
    ) as { nibiViewRoot?: { origin?: string } };
    expect(manifest.nibiViewRoot?.origin).toBe("community");
  });

  it("再次发现复用同一视图根且不重建", () => {
    seedInstalledPlugin();
    discover();
    const viewRoot = getPluginViewRoot(storageRoot, "wired@test-mp");
    const before = readFileSync(join(viewRoot, "plugin.json"), "utf8");
    discover();
    expect(readFileSync(join(viewRoot, "plugin.json"), "utf8")).toBe(before);
  });

  it("视图根建不出来时回退源目录并留下诊断（功能不丢）", () => {
    seedInstalledPlugin("fallback");
    // 把 views 占成一个文件：mkdir 必然失败，模拟「无法建立等价视图」。
    writeFileSync(join(storageRoot, PLUGIN_VIEWS_DIR), "occupied", "utf8");

    const outcome = discover("fallback");
    const plugin = outcome.plugins.find((item) => item.id === "fallback@test-mp");
    expect(plugin?.rootPath).toBe(installRoot);
    // 回退后仍可用：这正是「宁可少隔离，也不能少功能」的判据。
    expect(Object.keys(outcome.mcpServers)).toHaveLength(1);
    expect(
      outcome.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "plugin_view_root_unavailable" &&
          diagnostic.pluginId === "fallback@test-mp" &&
          diagnostic.severity === "warning",
      ),
    ).toBe(true);
  });
});
