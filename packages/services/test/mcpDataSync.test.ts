import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathExists } from "../src/fs/atomicFileUtils.js";
import type { IMcpSyncService } from "../src/mcp-sync/mcpSync.js";
import { createMcpSyncService } from "../src/mcp-sync/mcpSyncService.js";

type McpPayload = Awaited<ReturnType<IMcpSyncService["exportSyncItems"]>>;
type McpImportItem = Parameters<IMcpSyncService["importSyncItems"]>[0]["items"][number];

const FILESYSTEM_COMMAND = "@modelcontextprotocol/server-filesystem";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "nibi-mcp-data-sync-"));
}

function service(): IMcpSyncService {
  return createMcpSyncService();
}

async function writeNibiConfig(
  home: string,
  config: Record<string, unknown>,
): Promise<string> {
  const configPath = join(home, ".nibi", "cli", "config.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

async function writeNibiServers(
  home: string,
  servers: Record<string, Record<string, unknown>>,
): Promise<string> {
  return await writeNibiConfig(home, { mcp: { servers } });
}

async function writeAgentsServers(
  home: string,
  servers: Record<string, Record<string, unknown>>,
): Promise<string> {
  const configPath = join(home, ".agents", "mcp.json");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);
  return configPath;
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>;
}

async function readNibiServers(
  home: string,
): Promise<Record<string, Record<string, unknown>>> {
  const config = await readJsonObject(join(home, ".nibi", "cli", "config.json"));
  const mcp = config.mcp;
  if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) return {};
  const servers = (mcp as Record<string, unknown>).servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return {};
  return servers as Record<string, Record<string, unknown>>;
}

async function readAgentsServers(
  home: string,
): Promise<Record<string, Record<string, unknown>>> {
  const config = await readJsonObject(join(home, ".agents", "mcp.json"));
  return config.mcpServers as Record<string, Record<string, unknown>>;
}

async function list(home: string, target = service()) {
  return await withHome(home, () => target.listSyncItems());
}

async function hashes(
  home: string,
  keys: string[],
  options: { targetHomeDir?: string; workspace?: WorkspaceMapping } = {},
  target = service(),
) {
  return await withHome(home, () =>
    target.getSyncContentHashes({ keys, ...options }),
  );
}

async function exportItems(
  home: string,
  keys: string[],
  workspace?: WorkspaceMapping,
  target = service(),
): Promise<McpPayload> {
  return await withHome(home, () => target.exportSyncItems({ keys, workspace }));
}

async function importItems(
  home: string,
  payload: McpPayload,
  items: McpImportItem[],
  target = service(),
) {
  return await withHome(home, () => target.importSyncItems({ payload, items }));
}

interface WorkspaceMapping {
  sourceWorkspacePath: string;
  targetWorkspacePath: string;
}

describe("mcp data sync service", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it("aligns servers by lowercase name across ends", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    // 来源端停用、目标端启用：启用状态不参与内容比较。
    await writeNibiServers(sourceHome, {
      Shared: { command: "npx", args: ["shared"], enabled: false },
      OnlySource: { command: "npx", args: ["source"] },
    });
    await writeNibiServers(targetHome, {
      shared: { command: "npx", args: ["shared"] },
      "only-target": { command: "npx", args: ["target"] },
    });

    const sourceList = await list(sourceHome);
    const targetList = await list(targetHome);
    expect(sourceList.homeDir).toBe(sourceHome);
    expect(targetList.homeDir).toBe(targetHome);
    expect(sourceList.importBlockedReason).toBeUndefined();
    expect(targetList.importBlockedReason).toBeUndefined();
    expect(sourceList.items.map((item) => item.key).sort()).toEqual([
      "onlysource",
      "shared",
    ]);
    expect(targetList.items.map((item) => item.key).sort()).toEqual([
      "only-target",
      "shared",
    ]);
    expect(sourceList.items.find((item) => item.key === "shared")).toMatchObject({
      name: "Shared",
      enabled: false,
    });
    expect(targetList.items.find((item) => item.key === "shared")).toMatchObject({
      name: "shared",
      enabled: true,
    });

    const sourceHashes = await hashes(sourceHome, ["shared", "onlysource"]);
    const targetHashes = await hashes(targetHome, ["shared", "only-target"]);
    expect(sourceHashes.hashes.shared).toBe(targetHashes.hashes.shared);
    expect(sourceHashes.hashes.onlysource).toMatch(/^[0-9a-f]{64}$/u);
    expect(targetHashes.hashes["only-target"]).toMatch(/^[0-9a-f]{64}$/u);
    // 只在一端存在的 key 不会出现在另一端的哈希结果里。
    expect(sourceHashes.hashes["only-target"]).toBeUndefined();
    expect(targetHashes.hashes.onlysource).toBeUndefined();
  });

  it("blocks the category when the target uses the agents compatibility config", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeNibiServers(sourceHome, { shared: { command: "npx" } });
    await writeAgentsServers(targetHome, { shared: { command: "npx" } });

    const targetList = await list(targetHome);
    expect(targetList.importBlockedReason).toBe("target-compat-config");
    expect(targetList.items.map((item) => item.key)).toEqual(["shared"]);

    const payload = await exportItems(sourceHome, ["shared"]);
    const result = await importItems(targetHome, payload, [
      { key: "shared", mode: "createOnly" },
    ]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ key: "shared", status: "failed" });
    expect(result.results[0]?.error).toContain("~/.agents/mcp.json");
    expect(await pathExists(join(targetHome, ".nibi", "cli", "config.json"))).toBe(false);
    expect(await readAgentsServers(targetHome)).toEqual({ shared: { command: "npx" } });
  });

  it("rewrites filesystem home paths when hashing and importing", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourcePaths = [join(sourceHome, "work"), join(sourceHome, "scratch", "a")];
    const targetPaths = [join(targetHome, "work"), join(targetHome, "scratch", "a")];
    await writeNibiServers(sourceHome, {
      filesystem: {
        type: "stdio",
        command: "npx",
        args: ["-y", FILESYSTEM_COMMAND, ...sourcePaths],
      },
      plain: { command: "node", args: [join(sourceHome, "server.js")] },
    });
    await writeNibiServers(targetHome, {
      filesystem: {
        type: "stdio",
        command: "npx",
        args: ["-y", FILESYSTEM_COMMAND, ...targetPaths],
      },
      plain: { command: "node", args: [join(targetHome, "server.js")] },
    });

    const sourceHashes = await hashes(sourceHome, ["filesystem", "plain"], {
      targetHomeDir: targetHome,
    });
    const targetHashes = await hashes(targetHome, ["filesystem", "plain"]);
    // filesystem 类按目标端 home 改写后与目标端一致；其他 MCP 的路径不改写。
    expect(sourceHashes.hashes.filesystem).toBe(targetHashes.hashes.filesystem);
    expect(sourceHashes.hashes.plain).not.toBe(targetHashes.hashes.plain);

    const payload = await exportItems(sourceHome, ["filesystem", "plain"]);
    expect(payload.sourceHomeDir).toBe(sourceHome);
    expect(payload.items[0]?.config.args).toEqual(["-y", FILESYSTEM_COMMAND, ...sourcePaths]);
    const result = await importItems(targetHome, payload, [
      {
        key: "filesystem",
        mode: "overwrite",
        expectedTargetHash: targetHashes.hashes.filesystem,
      },
      {
        key: "plain",
        mode: "overwrite",
        expectedTargetHash: targetHashes.hashes.plain,
      },
    ]);
    expect(result.results).toEqual([
      { key: "filesystem", status: "updated" },
      { key: "plain", status: "updated" },
    ]);
    const servers = await readNibiServers(targetHome);
    expect(servers.filesystem?.args).toEqual(["-y", FILESYSTEM_COMMAND, ...targetPaths]);
    expect(servers.plain?.args).toEqual([join(sourceHome, "server.js")]);
  });

  it("rewrites workspace paths before home paths", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourceWorkspace = join(sourceHome, "repo");
    const targetWorkspace = join(targetHome, "repo");
    const workspace: WorkspaceMapping = {
      sourceWorkspacePath: sourceWorkspace,
      targetWorkspacePath: targetWorkspace,
    };
    const sourceArgs = [
      FILESYSTEM_COMMAND,
      join(sourceWorkspace, "src"),
      join(sourceHome, "docs"),
    ];
    const targetArgs = [
      FILESYSTEM_COMMAND,
      join(targetWorkspace, "src"),
      join(targetHome, "docs"),
    ];
    await writeNibiServers(sourceHome, {
      filesystem: { command: "npx", args: sourceArgs },
    });
    await writeNibiServers(targetHome, {
      filesystem: { command: "npx", args: targetArgs },
    });

    const sourceHashes = await hashes(sourceHome, ["filesystem"], {
      targetHomeDir: targetHome,
      workspace,
    });
    const targetHashes = await hashes(targetHome, ["filesystem"]);
    expect(sourceHashes.hashes.filesystem).toBe(targetHashes.hashes.filesystem);

    const payload = await exportItems(sourceHome, ["filesystem"], workspace);
    expect(payload.sourceWorkspacePath).toBe(sourceWorkspace);
    expect(payload.targetWorkspacePath).toBe(targetWorkspace);
    const result = await importItems(targetHome, payload, [
      {
        key: "filesystem",
        mode: "overwrite",
        expectedTargetHash: targetHashes.hashes.filesystem,
      },
    ]);
    expect(result.results).toEqual([{ key: "filesystem", status: "updated" }]);
    expect((await readNibiServers(targetHome)).filesystem?.args).toEqual(targetArgs);
  });

  it("applies source enabled state to new servers and keeps target state on overwrite", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeNibiServers(sourceHome, {
      "stay-disabled": { command: "npx", args: ["v2"], enabled: true },
      "stay-enabled": { command: "npx", args: ["v2"], enabled: false },
      "new-disabled": { command: "npx", args: ["new"], enabled: false },
      "New-Enabled": { command: "npx", args: ["new"] },
    });
    await writeNibiServers(targetHome, {
      "stay-disabled": { command: "npx", args: ["v1"], enabled: false },
      "stay-enabled": { command: "npx", args: ["v1"] },
    });

    const payload = await exportItems(sourceHome, [
      "stay-disabled",
      "stay-enabled",
      "new-disabled",
      "new-enabled",
    ]);
    const targetHashes = await hashes(targetHome, ["stay-disabled", "stay-enabled"]);
    const result = await importItems(targetHome, payload, [
      {
        key: "stay-disabled",
        mode: "overwrite",
        expectedTargetHash: targetHashes.hashes["stay-disabled"],
      },
      {
        key: "stay-enabled",
        mode: "overwrite",
        expectedTargetHash: targetHashes.hashes["stay-enabled"],
      },
      { key: "new-disabled", mode: "createOnly" },
      { key: "new-enabled", mode: "createOnly" },
    ]);
    expect(result.results).toEqual([
      { key: "stay-disabled", status: "updated" },
      { key: "stay-enabled", status: "updated" },
      { key: "new-disabled", status: "created" },
      { key: "new-enabled", status: "created" },
    ]);

    const servers = await readNibiServers(targetHome);
    expect(servers["stay-disabled"]).toMatchObject({
      args: ["v2"],
      enabled: false,
    });
    expect(servers["stay-enabled"]?.args).toEqual(["v2"]);
    expect(servers["stay-enabled"]?.enabled).toBeUndefined();
    expect(servers["new-disabled"]).toMatchObject({ enabled: false });
    // 新建按来源端原大小写写入，key 只是对齐用的规范化名称。
    expect(servers["New-Enabled"]?.enabled).toBeUndefined();
    expect(servers["new-enabled"]).toBeUndefined();
  });

  it("imports only selected servers and keeps the rest of the target config", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeNibiServers(sourceHome, {
      shared: { command: "npx", args: ["source"] },
      added: { command: "npx", args: ["added"] },
    });
    await writeNibiConfig(targetHome, {
      theme: "dark",
      mcp: {
        other: true,
        servers: {
          shared: { command: "npx", args: ["target"] },
          "target-only": { command: "npx", args: ["keep"] },
        },
      },
    });

    const payload = await exportItems(sourceHome, ["shared", "added"]);
    const targetHashes = await hashes(targetHome, ["shared"]);
    const result = await importItems(targetHome, payload, [
      {
        key: "shared",
        mode: "overwrite",
        expectedTargetHash: targetHashes.hashes.shared,
      },
      { key: "added", mode: "createOnly" },
    ]);
    expect(result.results).toEqual([
      { key: "shared", status: "updated" },
      { key: "added", status: "created" },
    ]);

    const config = await readJsonObject(join(targetHome, ".nibi", "cli", "config.json"));
    expect(config.theme).toBe("dark");
    expect(config.mcp).toMatchObject({ other: true });
    expect(await readNibiServers(targetHome)).toEqual({
      shared: { command: "npx", args: ["source"] },
      "target-only": { command: "npx", args: ["keep"] },
      added: { command: "npx", args: ["added"] },
    });
  });

  it("reports conflict for createOnly when the same server already exists", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeNibiServers(sourceHome, { shared: { command: "npx", args: ["source"] } });
    await writeNibiServers(targetHome, { Shared: { command: "npx", args: ["target"] } });

    const payload = await exportItems(sourceHome, ["shared"]);
    const result = await importItems(targetHome, payload, [
      { key: "shared", mode: "createOnly" },
    ]);
    expect(result.results).toEqual([{ key: "shared", status: "conflict" }]);
    expect((await readNibiServers(targetHome)).Shared).toEqual({
      command: "npx",
      args: ["target"],
    });
  });

  it("reports conflict when the target content no longer matches the list hash", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeNibiServers(sourceHome, { shared: { command: "npx", args: ["source"] } });
    await writeNibiServers(targetHome, { shared: { command: "npx", args: ["before"] } });

    const payload = await exportItems(sourceHome, ["shared"]);
    const stale = await hashes(targetHome, ["shared"]);
    await writeNibiServers(targetHome, { shared: { command: "npx", args: ["after"] } });

    const result = await importItems(targetHome, payload, [
      {
        key: "shared",
        mode: "overwrite",
        expectedTargetHash: stale.hashes.shared,
      },
      // 没有 expectedTargetHash 的覆盖同样不能写入。
      { key: "shared", mode: "overwrite" },
    ]);
    expect(result.results).toEqual([
      { key: "shared", status: "conflict" },
      { key: "shared", status: "conflict" },
    ]);
    expect((await readNibiServers(targetHome)).shared).toEqual({
      command: "npx",
      args: ["after"],
    });
  });

  it("fails without touching an unreadable target config", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeNibiServers(sourceHome, { shared: { command: "npx" } });
    const configPath = join(targetHome, ".nibi", "cli", "config.json");
    await mkdir(dirname(configPath), { recursive: true });
    const broken = "{ this is not json";
    await writeFile(configPath, broken);

    const payload = await exportItems(sourceHome, ["shared"]);
    const result = await importItems(targetHome, payload, [
      { key: "shared", mode: "createOnly" },
    ]);
    expect(result.results[0]).toMatchObject({ key: "shared", status: "failed" });
    expect(result.results[0]?.error).toBeTruthy();
    expect(await readFile(configPath, "utf-8")).toBe(broken);
  });
});

async function withHome<T>(home: string, task: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await task();
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}
