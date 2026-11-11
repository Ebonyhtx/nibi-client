import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandDataSyncPayload } from "@nibi/shared";
import { createCommandsService } from "../src/commands/commandsService.js";
import { createCommandDataSyncMethods } from "../src/data-sync/commandDataSync.js";
import { pathExists } from "../src/fs/atomicFileUtils.js";

type CommandRoot = ".nibi" | ".agents";

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "nibi-command-sync-"));
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function commandBody(description: string, body: string): string {
  return `---\ndescription: ${description}\n---\n\n${body}`;
}

async function writeCommand(
  home: string,
  root: CommandRoot,
  relativePath: string,
  content: string,
): Promise<string> {
  const filePath = join(home, root, "commands", ...relativePath.split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  return filePath;
}

async function writeConfig(home: string, value: unknown): Promise<string> {
  const directory = join(home, ".nibi", "cli");
  await mkdir(directory, { recursive: true });
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(value));
  return configPath;
}

function service() {
  return createCommandDataSyncMethods();
}

async function list(home: string) {
  return await withHome(home, () => service().listSyncItems());
}

async function contentHashes(home: string, keys: string[]) {
  return await withHome(home, () => service().getSyncContentHashes({ keys }));
}

async function exportItems(home: string, keys: string[]) {
  return await withHome(home, () => service().exportSyncItems({ keys }));
}

async function importItems(
  home: string,
  payload: CommandDataSyncPayload,
  items: Parameters<
    ReturnType<typeof createCommandDataSyncMethods>["importSyncItems"]
  >[0]["items"],
) {
  return await withHome(home, () => service().importSyncItems({ payload, items }));
}

async function withHome<T>(home: string, task: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await task();
  } finally {
    process.env.HOME = previous;
  }
}

describe("command data sync service", () => {
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

  afterEach(() => {
    process.env.HOME = originalHome;
    if (originalStorageDir === undefined) delete process.env.NIBI_STORAGE_DIR;
    else process.env.NIBI_STORAGE_DIR = originalStorageDir;
    if (originalNibiHome === undefined) delete process.env.NIBI_HOME;
    else process.env.NIBI_HOME = originalNibiHome;
  });

  it("merges both command roots with .nibi priority and case-insensitive keys", async () => {
    const home = makeHome();
    const nibiContent = commandBody("Nibi commit", "nibi body");
    const nibiFile = await writeCommand(home, ".nibi", "Git/Commit.md", nibiContent);
    await writeCommand(home, ".agents", "git/commit.md", commandBody("Agents commit", "agents body"));
    const agentsOnlyFile = await writeCommand(
      home,
      ".agents",
      "Mixed/Name.md",
      commandBody("Agents only", "agents only body"),
    );
    await writeCommand(home, ".nibi", "Group/Sub/Cmd.md", commandBody("Sub command", "sub body"));
    // 点开头的文件与目录都不参与同步。
    await writeCommand(home, ".nibi", ".secret.md", "secret");
    await writeCommand(home, ".nibi", ".hidden/Hidden.md", "hidden");

    const result = await list(home);
    const byKey = new Map(result.items.map((item) => [item.key, item]));

    expect(result.homeDir).toBe(home);
    expect([...byKey.keys()].sort()).toEqual(["/git/commit", "/group/sub/cmd", "/mixed/name"]);
    expect(byKey.get("/git/commit")).toMatchObject({
      name: "/Git/Commit",
      description: "Nibi commit",
      path: nibiFile,
      enabled: true,
      signature: { fileCount: 1, totalBytes: Buffer.byteLength(nibiContent) },
      contentHash: sha256(nibiContent),
    });
    expect(byKey.get("/git/commit")?.overwriteBlockedReason).toBeUndefined();
    expect(byKey.get("/group/sub/cmd")?.name).toBe("/Group/Sub/Cmd");
    expect(byKey.get("/mixed/name")).toMatchObject({
      name: "/Mixed/Name",
      path: agentsOnlyFile,
      // 兼容目录里的同 key 命令不能再作为覆盖目标。
      overwriteBlockedReason: "compat-directory",
    });
  });

  it("hashes command file bytes with sha256", async () => {
    const home = makeHome();
    await writeCommand(home, ".nibi", "one.md", "one body");

    const result = await contentHashes(home, ["/one", "/missing"]);

    expect(result.hashes).toEqual({ "/one": sha256("one body") });
  });

  it("reads enabled overrides from the user config for list and export", async () => {
    const home = makeHome();
    const disabledFile = await writeCommand(
      home,
      ".nibi",
      "disabled.md",
      commandBody("Disabled", "body"),
    );
    await writeCommand(home, ".nibi", "enabled.md", commandBody("Enabled", "body"));
    await writeConfig(home, {
      command: { [disabledFile]: { enable: false } },
      plugins: { enabled: true },
    });

    const items = (await list(home)).items;
    expect(items.find((item) => item.key === "/disabled")?.enabled).toBe(false);
    expect(items.find((item) => item.key === "/enabled")?.enabled).toBe(true);

    const payload = await exportItems(home, ["/disabled", "/enabled"]);
    expect(payload.sourceHomeDir).toBe(home);
    expect(payload.items.find((item) => item.key === "/disabled")?.enabled).toBe(false);
    expect(payload.items.find((item) => item.key === "/enabled")?.enabled).toBe(true);
  });

  it("exports original file bytes and imports missing commands into the .nibi root", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourceContent = "---\ndescription: Run\r\n---\r\n\r\nrun body\r\n";
    const sourceFile = await writeCommand(sourceHome, ".agents", "Tool/Deep/Run.md", sourceContent);
    await writeConfig(sourceHome, { command: { [sourceFile]: { enable: false } } });

    const payload = await exportItems(sourceHome, ["/tool/deep/run"]);
    expect(payload.items).toEqual([
      {
        key: "/tool/deep/run",
        name: "/Tool/Deep/Run",
        relativePath: "Tool/Deep/Run.md",
        content: new Uint8Array(Buffer.from(sourceContent)),
        enabled: false,
      },
    ]);

    const result = await importItems(targetHome, payload, [
      { key: "/tool/deep/run", mode: "createOnly" },
    ]);

    expect(result.results).toEqual([{ key: "/tool/deep/run", status: "created" }]);
    const targetFile = join(targetHome, ".nibi", "commands", "Tool", "Deep", "Run.md");
    // 按原文件字节写入，不经过表单生成（CRLF 与 frontmatter 原样保留）。
    expect(await readFile(targetFile, "utf-8")).toBe(sourceContent);
    const config = JSON.parse(
      await readFile(join(targetHome, ".nibi", "cli", "config.json"), "utf-8"),
    ) as { command?: Record<string, unknown> };
    expect(config.command?.[targetFile]).toEqual({ enable: false });
  });

  it("returns conflict for createOnly when the key already exists in either root", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeCommand(sourceHome, ".nibi", "Git/Commit.md", commandBody("Source", "source body"));
    const targetFile = await writeCommand(
      targetHome,
      ".agents",
      "Git/Commit.md",
      commandBody("Target", "target body"),
    );

    const payload = await exportItems(sourceHome, ["/git/commit"]);
    const result = await importItems(targetHome, payload, [
      { key: "/git/commit", mode: "createOnly" },
    ]);

    expect(result.results).toEqual([{ key: "/git/commit", status: "conflict" }]);
    expect(await pathExists(join(targetHome, ".nibi", "commands", "Git", "Commit.md"))).toBe(false);
    expect(await readFile(targetFile, "utf-8")).toContain("target body");
  });

  it("returns conflict on overwrite when the target hash does not match", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeCommand(sourceHome, ".nibi", "git/commit.md", commandBody("New", "new body"));
    const targetFile = await writeCommand(
      targetHome,
      ".nibi",
      "git/commit.md",
      commandBody("Old", "old body"),
    );

    const payload = await exportItems(sourceHome, ["/git/commit"]);
    const result = await importItems(targetHome, payload, [
      { key: "/git/commit", mode: "overwrite", expectedTargetHash: "stale-hash" },
    ]);

    expect(result.results).toEqual([{ key: "/git/commit", status: "conflict" }]);
    expect(await readFile(targetFile, "utf-8")).toContain("old body");
  });

  it("overwrites matching commands and keeps the target enabled state", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeCommand(sourceHome, ".nibi", "git/commit.md", commandBody("New", "new body"));
    const targetFile = await writeCommand(
      targetHome,
      ".nibi",
      "git/commit.md",
      commandBody("Old", "old body"),
    );
    await writeConfig(targetHome, {
      command: { [targetFile]: { enable: false } },
      plugins: { enabled: true },
    });
    const expectedTargetHash = (await contentHashes(targetHome, ["/git/commit"])).hashes[
      "/git/commit"
    ];

    const payload = await exportItems(sourceHome, ["/git/commit"]);
    const result = await importItems(targetHome, payload, [
      { key: "/git/commit", mode: "overwrite", expectedTargetHash },
    ]);

    expect(result.results).toEqual([{ key: "/git/commit", status: "updated" }]);
    expect(await readFile(targetFile, "utf-8")).toContain("new body");
    // 覆盖保留目标端启用状态，config.json 里其他字段不动。
    expect((await list(targetHome)).items.find((item) => item.key === "/git/commit")?.enabled).toBe(
      false,
    );
    const config = JSON.parse(
      await readFile(join(targetHome, ".nibi", "cli", "config.json"), "utf-8"),
    ) as { command?: Record<string, unknown>; plugins?: unknown };
    expect(config.command?.[targetFile]).toEqual({ enable: false });
    expect(config.plugins).toEqual({ enabled: true });
  });

  it("rejects payload paths that are not plain .md paths under the command root", async () => {
    const home = makeHome();
    const payload: CommandDataSyncPayload = {
      sourceHomeDir: home,
      items: [
        {
          key: "/escape",
          name: "/escape",
          relativePath: "../escape.md",
          content: new Uint8Array(Buffer.from("escape")),
          enabled: true,
        },
        {
          key: "/note",
          name: "/note",
          relativePath: "note.txt",
          content: new Uint8Array(Buffer.from("note")),
          enabled: true,
        },
        {
          key: "/mismatch",
          name: "/mismatch",
          relativePath: "Other.md",
          content: new Uint8Array(Buffer.from("mismatch")),
          enabled: true,
        },
        {
          key: "/absolute",
          name: "/absolute",
          relativePath: "C:/tmp/absolute.md",
          content: new Uint8Array(Buffer.from("absolute")),
          enabled: true,
        },
      ],
    };

    const result = await importItems(
      home,
      payload,
      payload.items.map((item) => ({ key: item.key, mode: "createOnly" as const })),
    );

    expect(result.results).toHaveLength(4);
    for (const item of result.results) {
      expect(item).toMatchObject({ status: "failed" });
      expect(item.error).toContain("invalid command path");
    }
    expect(await pathExists(join(home, "escape.md"))).toBe(false);
    expect(await pathExists(join(home, ".nibi", "commands", "note.txt"))).toBe(false);
  });

  it("fails and removes the new command when the target config is corrupt", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourceFile = await writeCommand(
      sourceHome,
      ".nibi",
      "disabled.md",
      commandBody("Disabled", "body"),
    );
    await writeConfig(sourceHome, { command: { [sourceFile]: { enable: false } } });
    const configDirectory = join(targetHome, ".nibi", "cli");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "config.json");
    await writeFile(configPath, "{broken");

    const payload = await exportItems(sourceHome, ["/disabled"]);
    const result = await importItems(targetHome, payload, [
      { key: "/disabled", mode: "createOnly" },
    ]);

    expect(result.results[0]).toMatchObject({ key: "/disabled", status: "failed" });
    expect(await pathExists(join(targetHome, ".nibi", "commands", "disabled.md"))).toBe(false);
    expect(await readFile(configPath, "utf-8")).toBe("{broken");
    // 坏 config 不影响列表读取（按无覆盖处理）。
    expect((await list(targetHome)).items.some((item) => item.key === "/disabled")).toBe(false);
  });

  it("never deletes target-only commands", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeCommand(sourceHome, ".nibi", "local.md", commandBody("Local", "local body"));
    const remoteFile = await writeCommand(
      targetHome,
      ".nibi",
      "remote.md",
      commandBody("Remote", "remote body"),
    );

    const payload = await exportItems(sourceHome, ["/local"]);
    const result = await importItems(targetHome, payload, [{ key: "/local", mode: "createOnly" }]);

    expect(result.results).toEqual([{ key: "/local", status: "created" }]);
    expect(await readFile(remoteFile, "utf-8")).toContain("remote body");
    expect((await readdir(join(targetHome, ".nibi", "commands"))).sort()).toEqual([
      "local.md",
      "remote.md",
    ]);
  });

  it("blocks symlinked command files from export and overwrite", async (context) => {
    const home = makeHome();
    const externalHome = makeHome();
    const realContent = commandBody("Real", "real body");
    const realFile = join(externalHome, "Real.md");
    await writeFile(realFile, realContent);
    const linkPath = join(home, ".nibi", "commands", "Linked.md");
    await mkdir(dirname(linkPath), { recursive: true });
    try {
      await symlink(realFile, linkPath, process.platform === "win32" ? "file" : undefined);
    } catch (error) {
      context.skip(`cannot create file symlink: ${String(error)}`);
      return;
    }

    const items = (await list(home)).items;
    expect(items.find((item) => item.key === "/linked")).toMatchObject({
      exportBlockedReason: "contains-symlink",
      overwriteBlockedReason: "target-symlink",
    });

    const payload: CommandDataSyncPayload = {
      sourceHomeDir: home,
      items: [
        {
          key: "/linked",
          name: "/linked",
          relativePath: "Linked.md",
          content: new Uint8Array(Buffer.from(commandBody("New", "new body"))),
          enabled: true,
        },
      ],
    };
    const hash = (await contentHashes(home, ["/linked"])).hashes["/linked"];
    const result = await importItems(home, payload, [
      { key: "/linked", mode: "overwrite", expectedTargetHash: hash },
    ]);

    expect(result.results[0]).toMatchObject({ key: "/linked", status: "failed" });
    expect(await readFile(realFile, "utf-8")).toBe(realContent);
  });

  it("does not descend into symlinked command directories", async (context) => {
    const home = makeHome();
    const externalHome = makeHome();
    const externalDirectory = join(externalHome, "nested");
    await mkdir(externalDirectory, { recursive: true });
    await writeFile(join(externalDirectory, "Hidden.md"), commandBody("Hidden", "hidden"));
    const linkDirectory = join(home, ".nibi", "commands", "linked");
    await mkdir(dirname(linkDirectory), { recursive: true });
    try {
      await symlink(
        externalDirectory,
        linkDirectory,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      context.skip(`cannot create directory symlink: ${String(error)}`);
      return;
    }

    const items = (await list(home)).items;

    expect(items.some((item) => item.key === "/linked/hidden")).toBe(false);
  });

  it("exposes the data sync methods on the commands service", async () => {
    const home = makeHome();
    await writeCommand(home, ".nibi", "synced.md", commandBody("Synced", "body"));

    const result = await withHome(home, () => createCommandsService().listSyncItems());
    const access = await withHome(home, () => createCommandsService().checkSyncWriteAccess());

    expect(result.items.map((item) => item.key)).toContain("/synced");
    expect(access).toMatchObject({ ok: true });
  });
});
