import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NIBI_PLUGIN_HOST_COMMAND } from "@nibi/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { writeOfficialPluginRuntimeManifest } from "../src/app/official-plugin-runtime.js";

// 不用 `process.argv[1]` 造假入口：`officialPluginHostPrefixArgs()` 在 vitest 下恒为
// undefined（isTestProcess 的测试闸门），伪造 argv 只会让重写静默跳过、用例空转。
const hostPrefixArgs = [NIBI_PLUGIN_HOST_COMMAND] as const;

describe("official plugin runtime manifest", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("does not rewrite an unchanged runtime manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-runtime-manifest-"));
    cleanups.push(root);
    const manifestPath = join(root, ".zcode-plugin", "plugin.json");
    await writeJson(manifestPath, {
      mcpServers: {
        "browser-use": {
          args: [],
          command: "old-node",
        },
      },
      name: "browser-use",
    });

    const input = {
      hostPrefixArgs,
      pluginName: "browser-use",
      rootPath: root,
    };
    writeOfficialPluginRuntimeManifest(input);
    expect(
      JSON.parse(await readFile(manifestPath, "utf8")).mcpServers["browser-use"].command,
    ).toBe(process.execPath);
    const expectedContents = await readFile(manifestPath, "utf8");
    const firstStat = await stat(manifestPath);
    await delay(30);

    writeOfficialPluginRuntimeManifest(input);
    const secondStat = await stat(manifestPath);

    expect(await readFile(manifestPath, "utf8")).toBe(expectedContents);
    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });

  it("repairs cached entries from the seed and leaves HTTP servers untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-entry-"));
    cleanups.push(root);
    const manifestPath = join(root, ".zcode-plugin", "plugin.json");
    await writeJson(manifestPath, { mcpServers: { pdf: { command: "node", args: ["wrong.js"] } } });
    const remote = { type: "http", url: "https://example.com/mcp" };
    const sourceManifestContents = JSON.stringify({
      mcpServers: {
        pdf: { command: "node", args: ["${NIBI_PLUGIN_ROOT}/dist/server.mjs", "--flag"] },
        search: remote,
      },
    });
    const input = {
      hostPrefixArgs,
      pluginName: "pdf",
      rootPath: root,
      sourceManifestContents,
    };
    writeOfficialPluginRuntimeManifest(input);
    const contents = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(contents);
    expect(manifest.mcpServers.pdf.args.slice(-2)).toEqual([
      join(root, "dist/server.mjs"),
      "--flag",
    ]);
    expect(manifest.mcpServers.pdf.args[0]).toBe(NIBI_PLUGIN_HOST_COMMAND);
    expect(manifest.mcpServers.pdf.env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(manifest.mcpServers.search).toEqual(remote);
    writeOfficialPluginRuntimeManifest(input);
    expect(await readFile(manifestPath, "utf8")).toBe(contents);
  });

  it("keeps invalid mcpServers structural errors fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-runtime-invalid-"));
    cleanups.push(root);
    await writeJson(join(root, ".zcode-plugin", "plugin.json"), {
      mcpServers: "invalid",
      name: "browser-use",
    });

    expect(() =>
      writeOfficialPluginRuntimeManifest({
        hostPrefixArgs,
        pluginName: "browser-use",
        rootPath: root,
      }),
    ).toThrow("Official plugin manifest has invalid mcpServers.");
  });

  // ios-simulator / android-emulator 把 MCP 声明在插件根的 `.mcp.json` 而不是 plugin.json；
  // 只重写 plugin.json 会让它们以 `command: "node"`、没有 ELECTRON_RUN_AS_NODE 的形态
  // 进入缓存，桌面机上没装 Node 时 MCP server 直接起不来。
  it("rewrites Claude-compatible .mcp.json entries in place, idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-plugin-mcp-json-"));
    cleanups.push(root);
    await writeJson(join(root, ".nibi-plugin", "plugin.json"), {
      name: "ios-simulator",
      skills: "skills",
      version: "0.1.0",
    });
    const mcpPath = join(root, ".mcp.json");
    await writeJson(mcpPath, {
      mcpServers: {
        "ios-simulator": {
          args: ["${CLAUDE_PLUGIN_ROOT}/dist/mcp/server.js"],
          command: "node",
          cwd: "${CLAUDE_PROJECT_DIR}",
          env: {
            IOS_SIM_DEFAULT_DEVICE: "${user_config.default_device}",
            IOS_SIM_PACKAGE_ROOT: "${CLAUDE_PLUGIN_ROOT}",
          },
        },
        remote: { type: "http", url: "https://example.com/mcp" },
      },
    });
    const input = {
      hostPrefixArgs,
      pluginName: "ios-simulator",
      rootPath: root,
    };

    writeOfficialPluginRuntimeManifest(input);
    const contents = await readFile(mcpPath, "utf8");
    const parsed = JSON.parse(contents);
    expect(parsed.mcpServers["ios-simulator"]).toMatchObject({
      args: [NIBI_PLUGIN_HOST_COMMAND, join(root, "dist", "mcp", "server.js")],
      command: process.execPath,
      // 原 env 占位符保留（由 discovery 再展开），只追加 Node 模式。
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        IOS_SIM_DEFAULT_DEVICE: "${user_config.default_device}",
        IOS_SIM_PACKAGE_ROOT: "${CLAUDE_PLUGIN_ROOT}",
      },
    });
    expect(parsed.mcpServers.remote).toEqual({ type: "http", url: "https://example.com/mcp" });
    const firstStat = await stat(mcpPath);
    await delay(30);

    // 幂等：已重写过的条目直接跳过，不会把宿主前缀再叠一层。
    writeOfficialPluginRuntimeManifest(input);
    expect(await readFile(mcpPath, "utf8")).toBe(contents);
    expect((await stat(mcpPath)).mtimeMs).toBe(firstStat.mtimeMs);
  });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(path), { recursive: true }));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
