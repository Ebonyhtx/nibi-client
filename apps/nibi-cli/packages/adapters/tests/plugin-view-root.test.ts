import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getPluginViewRoot,
  isPluginViewRootCurrentSync,
  listPluginViewRoots,
  materializePluginViewRoot,
  materializePluginViewRootSync,
  PLUGIN_VIEWS_DIR,
  pluginViewRootExists,
  removePluginViewRoot,
} from "../src/plugins/view-root.js";

let storageRoot: string;
let sourceRoot: string;

function write(relativePath: string, contents = "x"): void {
  const target = join(sourceRoot, relativePath);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, contents, "utf8");
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    manifest: { name: "demo", version: "1.0.0" },
    manifestRelativePath: "plugin.json",
    origin: "official",
    packageHash: `sha256:${"a".repeat(64)}`,
    pluginId: "demo@nibi-official",
    rootPath: sourceRoot,
    storageRoot,
    version: "1.0.0",
    ...overrides,
  };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "nibi-view-root-"));
  storageRoot = join(dir, "storage");
  sourceRoot = join(dir, "plugin");
  mkdirSync(storageRoot, { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
});

afterEach(() => {
  rmSync(join(storageRoot, ".."), { force: true, recursive: true });
});

describe("view root 构造等价", () => {
  it("顶层每个条目都在视图里，且内容可读", () => {
    write("plugin.json", JSON.stringify({ name: "demo", version: "1.0.0" }));
    write("skills/demo/SKILL.md", "---\nname: demo\n---\nbody\n");
    write("commands/run.md", "---\ndescription: run\n---\n");
    write("mcp.json", JSON.stringify({ mcpServers: { main: { command: "node" } } }));
    write("index.js", "module.exports = {};\n");

    const result = materializePluginViewRootSync(input());
    expect(result).not.toBeNull();
    const viewRoot = result?.viewRoot ?? "";
    expect(viewRoot).toBe(join(storageRoot, PLUGIN_VIEWS_DIR, "demo@nibi-official"));

    // 关键不变式：所有组件面都在，一个都不能少（这正是第一版漏 mcp.json 的地方）。
    expect(readFileSync(join(viewRoot, "mcp.json"), "utf8")).toContain("mcpServers");
    expect(readFileSync(join(viewRoot, "skills/demo/SKILL.md"), "utf8")).toContain("name: demo");
    expect(readFileSync(join(viewRoot, "commands/run.md"), "utf8")).toContain("description: run");
    expect(readFileSync(join(viewRoot, "index.js"), "utf8")).toContain("module.exports");
  });

  it("视图清单带 nibiViewRoot 元数据且保留原字段", () => {
    write("plugin.json", JSON.stringify({ name: "demo", version: "1.0.0" }));
    const result = materializePluginViewRootSync(input());
    const manifest = JSON.parse(readFileSync(join(result?.viewRoot ?? "", "plugin.json"), "utf8"));
    expect(manifest.name).toBe("demo");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.nibiViewRoot).toEqual({
      origin: "official",
      packageHash: `sha256:${"a".repeat(64)}`,
      version: "1.0.0",
    });
  });

  it("根清单被规范化清单替换，不复制原始清单", () => {
    write(
      "plugin.json",
      JSON.stringify({ name: "raw-name", extensions: { "com.nibistudio.nibi": {} } }),
    );
    const result = materializePluginViewRootSync(input());
    const manifest = JSON.parse(readFileSync(join(result?.viewRoot ?? "", "plugin.json"), "utf8"));
    // 视图清单来自调用方传入的归一化结果，不是源文件字节。
    expect(manifest.name).toBe("demo");
    expect(manifest.extensions).toBeUndefined();
  });

  it("嵌套清单的目录整体跳过，避免旧清单混入", () => {
    write(".claude-plugin/plugin.json", JSON.stringify({ name: "old" }));
    write(".claude-plugin/extra.json", "{}");
    write("skills/demo/SKILL.md", "x");
    const result = materializePluginViewRootSync(
      input({ manifestRelativePath: ".claude-plugin/plugin.json" }),
    );
    const viewRoot = result?.viewRoot ?? "";
    // 嵌套清单目录不进入视图：否则读取方会看到「根清单 + 旧目录清单」并存。
    expect(() => statSync(join(viewRoot, ".claude-plugin"))).toThrow();
    expect(readFileSync(join(viewRoot, "skills/demo/SKILL.md"), "utf8")).toBe("x");
  });

  it("跳过 .git", () => {
    write(".git/config", "x");
    write("plugin.json", "{}");
    const result = materializePluginViewRootSync(input());
    expect(() => statSync(join(result?.viewRoot ?? "", ".git"))).toThrow();
  });

  it("缺组件目录时不创建空目录", () => {
    write("plugin.json", "{}");
    const result = materializePluginViewRootSync(input());
    expect(() => statSync(join(result?.viewRoot ?? "", "skills"))).toThrow();
  });

  it("清单里自定义的组件路径（非 skills/ 默认目录）同样可用", () => {
    write("plugin.json", "{}");
    write("custom/lessons/a/SKILL.md", "---\nname: a\n---\n");
    const result = materializePluginViewRootSync(input());
    expect(
      readFileSync(join(result?.viewRoot ?? "", "custom/lessons/a/SKILL.md"), "utf8"),
    ).toContain("name: a");
  });
});

describe("幂等与更新", () => {
  it("相同输入第二次不写盘（mtime 不变）", () => {
    write("plugin.json", "{}");
    write("skills/demo/SKILL.md", "x");
    const first = materializePluginViewRootSync(input());
    expect(first?.wrote).toBe(true);
    const manifestPath = join(first?.viewRoot ?? "", "plugin.json");
    const before = statSync(manifestPath).mtimeMs;

    const second = materializePluginViewRootSync(input());
    expect(second?.wrote).toBe(false);
    expect(statSync(manifestPath).mtimeMs).toBe(before);
  });

  it("清单变化后重写并更新内容", () => {
    write("plugin.json", "{}");
    const first = materializePluginViewRootSync(input());
    const second = materializePluginViewRootSync(
      input({ manifest: { name: "demo", version: "2.0.0" }, version: "2.0.0" }),
    );
    expect(second?.wrote).toBe(true);
    const manifest = JSON.parse(readFileSync(join(first?.viewRoot ?? "", "plugin.json"), "utf8"));
    expect(manifest.version).toBe("2.0.0");
  });

  it("源目录新增条目后视图重建（不会陈旧）", () => {
    write("plugin.json", "{}");
    materializePluginViewRootSync(input());
    expect(isPluginViewRootCurrentSync(storageRoot, input())).toBe(true);
    write("agents/reviewer.md", "---\nname: reviewer\n---\n");
    // 顶层集合变了 → 不等价 → 下次物化必须重写。
    const rebuilt = materializePluginViewRootSync(input());
    expect(rebuilt?.wrote).toBe(true);
    expect(readFileSync(join(rebuilt?.viewRoot ?? "", "agents/reviewer.md"), "utf8")).toContain(
      "reviewer",
    );
  });

  it("包 hash 变化触发重写（同版本换内容）", () => {
    write("plugin.json", "{}");
    materializePluginViewRootSync(input());
    const rebuilt = materializePluginViewRootSync(
      input({ packageHash: `sha256:${"b".repeat(64)}` }),
    );
    expect(rebuilt?.wrote).toBe(true);
  });

  it("异步包装与同步实现结果一致", async () => {
    write("plugin.json", "{}");
    const asyncResult = await materializePluginViewRoot(input());
    expect(asyncResult?.wrote).toBe(true);
    expect(materializePluginViewRootSync(input())?.wrote).toBe(false);
  });
});

describe("路径与生命周期", () => {
  it("危险 pluginId 不逃出 views 目录", () => {
    for (const pluginId of ["..", ".", ""]) {
      const viewRoot = getPluginViewRoot(storageRoot, pluginId);
      expect(viewRoot.startsWith(join(storageRoot, PLUGIN_VIEWS_DIR))).toBe(true);
      expect(viewRoot).not.toBe(join(storageRoot, PLUGIN_VIEWS_DIR));
    }
  });

  it("列举与删除", () => {
    write("plugin.json", "{}");
    materializePluginViewRootSync(input());
    expect(listPluginViewRoots(storageRoot)).toEqual(["demo@nibi-official"]);
    expect(pluginViewRootExists(storageRoot, "demo@nibi-official")).toBe(true);
    expect(removePluginViewRoot(storageRoot, "demo@nibi-official")).toBe(true);
    expect(listPluginViewRoots(storageRoot)).toEqual([]);
    expect(pluginViewRootExists(storageRoot, "demo@nibi-official")).toBe(false);
  });

  it("删除视图根不会删掉源插件内容", () => {
    write("plugin.json", "{}");
    write("skills/demo/SKILL.md", "keep me");
    materializePluginViewRootSync(input());
    removePluginViewRoot(storageRoot, "demo@nibi-official");
    // 链接模式下这最容易出错：跟进去删会毁掉插件源目录。
    expect(readFileSync(join(sourceRoot, "skills/demo/SKILL.md"), "utf8")).toBe("keep me");
  });

  it("未物化过时列举返回空数组而不是报错", () => {
    expect(listPluginViewRoots(storageRoot)).toEqual([]);
  });

  it("删除不存在的视图根返回 false", () => {
    expect(removePluginViewRoot(storageRoot, "nope@nibi-official")).toBe(false);
  });
});
