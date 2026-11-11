import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentStateId } from "@nibi/shared";
import { pathExists } from "../src/fs/atomicFileUtils.js";
import { createSubagentDataSyncMethods } from "../src/data-sync/subagentDataSync.js";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

const tempRoots: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "nibi-subagent-data-sync-"));
  tempRoots.push(home);
  return home;
}

function service() {
  return createSubagentDataSyncMethods();
}

function userAgentStateId(name: string): string {
  return createAgentStateId({ name, scope: "user", source: "user" });
}

interface AgentFixture {
  name: string;
  description?: string;
  skills?: string[];
  mcpServers?: string[];
  /** 追加到 frontmatter 的原始行（未知字段、对象形式的 mcpServers 等）。 */
  extraFrontmatter?: string[];
  body?: string;
}

/** 写入一个用户级 agent 文件，返回原文件内容（用于字节级断言）。 */
async function writeAgent(home: string, fileName: string, fixture: AgentFixture): Promise<string> {
  const lines = [
    "---",
    `name: "${fixture.name}"`,
    `description: "${fixture.description ?? `${fixture.name} description`}"`,
    ...(fixture.skills && fixture.skills.length > 0
      ? [`skills: [${fixture.skills.join(", ")}]`]
      : []),
    ...(fixture.mcpServers && fixture.mcpServers.length > 0
      ? [`mcpServers: [${fixture.mcpServers.join(", ")}]`]
      : []),
    ...(fixture.extraFrontmatter ?? []),
    "---",
    fixture.body ?? `${fixture.name} body`,
    "",
  ];
  const content = lines.join("\n");
  const root = join(home, ".nibi", "agents");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, fileName), content, "utf-8");
  return content;
}

async function writeAgentsState(home: string, disabledAgentIds: string[]): Promise<void> {
  const directory = join(home, ".nibi", "v2");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "agents-state.json"),
    `${JSON.stringify({ disabledAgentIds }, null, 2)}\n`,
    "utf-8",
  );
}

async function readAgentsState(home: string): Promise<{ disabledAgentIds?: string[] }> {
  return JSON.parse(await readFile(join(home, ".nibi", "v2", "agents-state.json"), "utf-8")) as {
    disabledAgentIds?: string[];
  };
}

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

async function list(home: string, target = service()) {
  return await withHome(home, () => target.listSyncItems());
}

async function hashes(home: string, keys: string[], target = service()) {
  return await withHome(home, () => target.getSyncContentHashes({ keys }));
}

async function exportItems(home: string, keys: string[], target = service()) {
  return await withHome(home, () => target.exportSyncItems({ keys }));
}

async function importItems(
  home: string,
  payload: Awaited<ReturnType<ReturnType<typeof service>["exportSyncItems"]>>,
  items: Parameters<ReturnType<typeof service>["importSyncItems"]>[0]["items"],
  target = service(),
) {
  return await withHome(home, () => target.importSyncItems({ payload, items }));
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("subagent data sync service", () => {
  let originalHome: string | undefined;
  let originalStorageDir: string | undefined;
  let originalNibiHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalStorageDir = process.env.NIBI_STORAGE_DIR;
    originalNibiHome = process.env.NIBI_HOME;
    delete process.env.NIBI_STORAGE_DIR;
    delete process.env.NIBI_HOME;
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStorageDir === undefined) delete process.env.NIBI_STORAGE_DIR;
    else process.env.NIBI_STORAGE_DIR = originalStorageDir;
    if (originalNibiHome === undefined) delete process.env.NIBI_HOME;
    else process.env.NIBI_HOME = originalNibiHome;
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  it("aligns agents by trimmed lowercase name and keeps the first file", async () => {
    const home = makeHome();
    const firstContent = await writeAgent(home, "a-first.md", {
      name: "  Review-Bot  ",
      description: "Reviews changes",
    });
    await writeAgent(home, "z-duplicate.md", {
      name: "review-bot",
      description: "Duplicate name",
    });

    const result = await list(home);

    expect(result.homeDir).toBe(home);
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.key).toBe("review-bot");
    expect(item.name).toBe("Review-Bot");
    expect(item.path).toBe(join(home, ".nibi", "agents", "a-first.md"));
    expect(item.signature).toEqual({
      fileCount: 1,
      totalBytes: Buffer.byteLength(firstContent),
    });
    expect(item.contentHash).toBe(sha256(firstContent));
  });

  it("reports identical and different content through signatures and hashes", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sameContent = await writeAgent(sourceHome, "same.md", { name: "Same" });
    const differentContent = await writeAgent(sourceHome, "different.md", {
      name: "Different",
      body: "source body",
    });
    await writeAgent(sourceHome, "only-local.md", { name: "Only-Local" });

    await writeAgent(targetHome, "same.md", { name: "Same" });
    await writeAgent(targetHome, "different.md", { name: "Different", body: "target body" });
    await writeAgent(targetHome, "only-remote.md", { name: "Only-Remote" });

    const sourceItems = (await list(sourceHome)).items;
    const targetItems = (await list(targetHome)).items;
    const sourceByKey = new Map(sourceItems.map((item) => [item.key, item]));
    const targetByKey = new Map(targetItems.map((item) => [item.key, item]));

    expect(sourceByKey.has("only-remote")).toBe(false);
    expect(targetByKey.has("only-local")).toBe(false);
    expect(sourceByKey.get("same")?.signature).toEqual(targetByKey.get("same")?.signature);
    expect(sourceByKey.get("different")?.signature).toEqual(
      targetByKey.get("different")?.signature,
    );

    const sourceHashes = (await hashes(sourceHome, ["same", "different"])).hashes;
    const targetHashes = (await hashes(targetHome, ["same", "different"])).hashes;
    expect(sourceHashes.same).toBe(sha256(sameContent));
    expect(sourceHashes.same).toBe(targetHashes.same);
    expect(sourceHashes.different).toBe(sha256(differentContent));
    expect(sourceHashes.different).not.toBe(targetHashes.different);
  });

  it("reads disabled state, writes it for new items and preserves it on overwrite", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const disabledContent = await writeAgent(sourceHome, "disabled.md", {
      name: "Disabled-Agent",
    });
    await writeAgentsState(sourceHome, [userAgentStateId("Disabled-Agent")]);

    const sourceItems = (await list(sourceHome)).items;
    expect(sourceItems.find((item) => item.key === "disabled-agent")?.enabled).toBe(false);
    const payload = await exportItems(sourceHome, ["disabled-agent"]);
    expect(payload.items[0]?.enabled).toBe(false);
    expect(Buffer.from(payload.items[0]!.content).toString("utf-8")).toBe(disabledContent);

    const created = await importItems(targetHome, payload, [
      { key: "disabled-agent", mode: "createOnly" },
    ]);
    expect(created.results).toEqual([{ key: "disabled-agent", status: "created" }]);
    expect((await readAgentsState(targetHome)).disabledAgentIds).toContain(
      userAgentStateId("Disabled-Agent"),
    );
    expect((await list(targetHome)).items[0]?.enabled).toBe(false);

    // 来源启用的新建项清除目标端残留的同名禁用 ID（例如以前删除的子智能体留下的）。
    await writeAgent(sourceHome, "enabled.md", { name: "Enabled-Agent" });
    await writeAgentsState(targetHome, [userAgentStateId("Enabled-Agent")]);
    const enabledPayload = await exportItems(sourceHome, ["enabled-agent"]);
    await importItems(targetHome, enabledPayload, [{ key: "enabled-agent", mode: "createOnly" }]);
    expect((await readAgentsState(targetHome)).disabledAgentIds).not.toContain(
      userAgentStateId("Enabled-Agent"),
    );
    expect(
      (await list(targetHome)).items.find((item) => item.key === "enabled-agent")?.enabled,
    ).toBe(true);

    // 覆盖不动目标端启用状态。
    await writeAgent(targetHome, "disabled.md", { name: "Disabled-Agent", body: "old body" });
    await writeAgentsState(targetHome, [userAgentStateId("Disabled-Agent")]);
    const newContent = await writeAgent(sourceHome, "disabled.md", {
      name: "Disabled-Agent",
      body: "new body",
    });
    const targetHash = (await list(targetHome)).items.find(
      (item) => item.key === "disabled-agent",
    )?.contentHash;
    const updated = await importItems(
      targetHome,
      await exportItems(sourceHome, ["disabled-agent"]),
      [{ key: "disabled-agent", mode: "overwrite", expectedTargetHash: targetHash }],
    );
    expect(updated.results).toEqual([{ key: "disabled-agent", status: "updated" }]);
    expect(
      (await list(targetHome)).items.find((item) => item.key === "disabled-agent")?.enabled,
    ).toBe(false);
    expect(await readFile(join(targetHome, ".nibi", "agents", "disabled.md"), "utf-8")).toBe(
      newContent,
    );
  });

  it("returns conflict for createOnly when the target already has the same name", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeAgent(sourceHome, "source-only.md", { name: "Only" });
    const targetContent = await writeAgent(targetHome, "existing.md", {
      name: "Only",
      body: "target body",
    });

    const payload = await exportItems(sourceHome, ["only"]);
    const result = await importItems(targetHome, payload, [{ key: "only", mode: "createOnly" }]);

    expect(result.results).toEqual([{ key: "only", status: "conflict" }]);
    expect(await readFile(join(targetHome, ".nibi", "agents", "existing.md"), "utf-8")).toBe(
      targetContent,
    );
    expect(await pathExists(join(targetHome, ".nibi", "agents", "source-only.md"))).toBe(false);
  });

  it("checks expectedTargetHash on overwrite and keeps the target file name and bytes", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourceContent = await writeAgent(sourceHome, "source-name.md", {
      name: "Reviewer",
      extraFrontmatter: ["memory: user", "x-custom: keep me"],
      body: "new body",
    });
    const targetContent = await writeAgent(targetHome, "target-name.md", {
      name: "Reviewer",
      body: "old body",
    });
    const targetPath = join(targetHome, ".nibi", "agents", "target-name.md");

    const stale = await importItems(targetHome, await exportItems(sourceHome, ["reviewer"]), [
      { key: "reviewer", mode: "overwrite", expectedTargetHash: "stale-hash" },
    ]);
    expect(stale.results).toEqual([{ key: "reviewer", status: "conflict" }]);
    expect(await readFile(targetPath, "utf-8")).toBe(targetContent);

    const expectedTargetHash = (await list(targetHome)).items[0]?.contentHash;
    const updated = await importItems(targetHome, await exportItems(sourceHome, ["reviewer"]), [
      { key: "reviewer", mode: "overwrite", expectedTargetHash },
    ]);
    expect(updated.results).toEqual([{ key: "reviewer", status: "updated" }]);
    // 原文件字节原样写入，未知 frontmatter 字段保留；文件名沿用目标端。
    expect(await readFile(targetPath, "utf-8")).toBe(sourceContent);
    expect(await pathExists(join(targetHome, ".nibi", "agents", "source-name.md"))).toBe(false);
    expect((await list(targetHome)).items[0]?.path).toBe(targetPath);
  });

  it("reports string MCP servers and skills as dependencies and ignores inline MCP objects", async () => {
    const home = makeHome();
    await writeAgent(home, "with-deps.md", {
      name: "With-Deps",
      skills: ["alpha", "beta"],
      extraFrontmatter: [
        "mcpServers:",
        "  - server-a",
        "  - command: node",
        '    args: ["-e", "0"]',
      ],
    });
    await writeAgent(home, "without-deps.md", { name: "Without-Deps" });

    const items = (await list(home)).items;
    expect(items.find((item) => item.key === "with-deps")?.dependencies).toEqual({
      mcpServers: ["server-a"],
      skills: ["alpha", "beta"],
    });
    expect(items.find((item) => item.key === "without-deps")?.dependencies).toBeUndefined();
  });

  it("never deletes target-only agents", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeAgent(sourceHome, "local-only.md", { name: "Local-Only" });
    const targetOnlyContent = await writeAgent(targetHome, "remote-only.md", {
      name: "Remote-Only",
    });

    const payload = await exportItems(sourceHome, ["local-only"]);
    const result = await importItems(targetHome, payload, [
      { key: "local-only", mode: "createOnly" },
    ]);

    expect(result.results).toEqual([{ key: "local-only", status: "created" }]);
    expect(await readFile(join(targetHome, ".nibi", "agents", "remote-only.md"), "utf-8")).toBe(
      targetOnlyContent,
    );
    expect((await list(targetHome)).items.map((item) => item.key).sort()).toEqual([
      "local-only",
      "remote-only",
    ]);
  });

  it("rolls back a new agent when the state file cannot be written", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeAgent(sourceHome, "broken-state.md", { name: "Broken-State" });
    await writeAgentsState(sourceHome, [userAgentStateId("Broken-State")]);
    const stateDirectory = join(targetHome, ".nibi", "v2");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(join(stateDirectory, "agents-state.json"), "{broken", "utf-8");

    const payload = await exportItems(sourceHome, ["broken-state"]);
    const result = await importItems(targetHome, payload, [
      { key: "broken-state", mode: "createOnly" },
    ]);

    expect(result.results[0]).toMatchObject({ key: "broken-state", status: "failed" });
    expect(await pathExists(join(targetHome, ".nibi", "agents", "broken-state.md"))).toBe(false);
    expect(await readFile(join(stateDirectory, "agents-state.json"), "utf-8")).toBe("{broken");
  });

  it("checks write access on the user agents root", async () => {
    const home = makeHome();
    const result = await withHome(home, () => service().checkSyncWriteAccess());
    expect(result).toMatchObject({ ok: true, path: join(home, ".nibi", "agents") });
  });

  it("is attached to the subagents service and honors its storage options", async () => {
    const home = makeHome();
    await writeAgent(home, "attached.md", { name: "Attached" });
    const subagents = createSubagentsService({ homeDir: home, isDesktopRuntime: true });

    const result = await subagents.listSyncItems();

    expect(result.items.map((item) => item.key)).toEqual(["attached"]);
  });
});
