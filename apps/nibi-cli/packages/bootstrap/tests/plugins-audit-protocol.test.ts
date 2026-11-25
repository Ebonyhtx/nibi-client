import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCliStorageRoot, getPluginStorageRoot } from "../src/app/storage-paths.js";
import { listPluginAudit } from "../src/nibi-protocol/plugins.js";
import type { NibiProtocolAgentServerContext } from "../src/nibi-protocol/server-types.js";

let root: string;
let previousStorageDir: string | undefined;

async function writeTestFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function pluginStorageRoot(): string {
  return getPluginStorageRoot(getCliStorageRoot(process.env.NIBI_STORAGE_DIR));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "nibi-plugin-audit-restore-"));
  previousStorageDir = process.env.NIBI_STORAGE_DIR;
  process.env.NIBI_STORAGE_DIR = join(root, "storage");
});

afterEach(async () => {
  if (previousStorageDir === undefined) delete process.env.NIBI_STORAGE_DIR;
  else process.env.NIBI_STORAGE_DIR = previousStorageDir;
  await rm(root, { force: true, recursive: true });
});

describe("plugins/audit", () => {
  it("只返回摘要字段，并按 pluginId 过滤 + limit 截断", async () => {
    await writeTestFile(
      join(pluginStorageRoot(), "plugin-audit.ndjson"),
      [
        {
          at: "2026-11-24T00:00:00.000Z",
          type: "capability_invoked",
          pluginId: "a@m",
          capability: "nibi.sessions.read",
        },
        {
          at: "2026-11-24T00:01:00.000Z",
          type: "capability_denied",
          pluginId: "b@m",
          capability: "nibi.workspace.files.read",
        },
        {
          at: "2026-11-24T00:02:00.000Z",
          type: "consent_granted",
          pluginId: "a@m",
          permissions: ["network"],
          version: "1.0.0",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n"),
    );

    const result = await listPluginAudit({} as NibiProtocolAgentServerContext, {
      pluginId: "a@m",
      workspace: { workspaceKey: root, workspacePath: root },
    });
    // 倒序（最新在前），只保留 a@m。
    expect(result.events.map((event) => event.type)).toEqual([
      "consent_granted",
      "capability_invoked",
    ]);
    expect(result.events[1]?.capability).toBe("nibi.sessions.read");
    // 不泄露路径/参数值：载荷里只有协议声明过的字段。
    expect(Object.keys(result.events[0] ?? {}).sort()).toEqual([
      "at",
      "permissions",
      "pluginId",
      "type",
      "version",
    ]);
  });

  it("审计文件缺失时返回空数组而不是报错", async () => {
    const result = await listPluginAudit({} as NibiProtocolAgentServerContext, {
      workspace: { workspaceKey: root, workspacePath: root },
    });
    expect(result.events).toEqual([]);
  });

  it("limit 默认 10", async () => {
    await writeTestFile(
      join(pluginStorageRoot(), "plugin-audit.ndjson"),
      Array.from({ length: 15 }, (_, index) =>
        JSON.stringify({
          at: new Date(Date.UTC(2026, 10, 24, 0, index)).toISOString(),
          pluginId: "a@m",
          type: "capability_invoked",
        }),
      ).join("\n"),
    );
    const result = await listPluginAudit({} as NibiProtocolAgentServerContext, {
      workspace: { workspaceKey: root, workspacePath: root },
    });
    expect(result.events).toHaveLength(10);
  });
});
