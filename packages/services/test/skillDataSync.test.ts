import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathExists } from "../src/fs/atomicFileUtils.js";
import { createSkillSyncService } from "../src/skill-sync/skillSyncService.js";
import type { ISkillSyncService } from "../src/skill-sync/skillSync.js";

const MAX_BYTES = 1024 * 1024;

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "nibi-data-sync-"));
}

async function writeSkill(
  home: string,
  directoryName: string,
  name = directoryName,
  body = `${name} body`,
  root: ".nibi" | ".agents" = ".nibi",
): Promise<string> {
  const directory = join(home, root, "skills", directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}`,
  );
  return directory;
}

async function writeBareSkill(home: string, directoryName: string): Promise<string> {
  const directory = join(home, ".nibi", "skills", directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), "Body without frontmatter");
  return directory;
}

async function writeConfig(home: string, value: unknown): Promise<void> {
  const directory = join(home, ".nibi", "cli");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "config.json"), JSON.stringify(value));
}

function service(): ISkillSyncService {
  return createSkillSyncService({ maxArchiveBytes: MAX_BYTES });
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
  payload: Awaited<ReturnType<ISkillSyncService["exportSyncItems"]>>,
  items: Parameters<ISkillSyncService["importSyncItems"]>[0]["items"],
  target = service(),
) {
  return await withHome(home, () => target.importSyncItems({ payload, items }));
}

describe("skill data sync service", () => {
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

  it("lists user skills with parentKey for nested skills", async () => {
    const home = makeHome();
    await writeSkill(home, "review");
    await writeBareSkill(home, "group/plain");
    await writeSkill(home, "parent");
    await writeSkill(home, "parent/child", "nested-child");

    const result = await list(home);
    const byKey = new Map(result.items.map((item) => [item.key, item]));

    expect(result.homeDir).toBe(home);
    expect([...byKey.keys()].sort()).toEqual(["nested-child", "parent", "plain", "review"]);
    expect(byKey.get("nested-child")?.parentKey).toBe("parent");
    expect(byKey.get("parent")?.parentKey).toBeUndefined();
    expect(byKey.get("plain")?.directoryName).toBe("group/plain");
    expect(byKey.get("plain")?.path).toBe(
      join(home, ".nibi", "skills", "group", "plain", "SKILL.md"),
    );
  });

  it("reports identical and different content through signatures and hashes", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeSkill(sourceHome, "same");
    await writeSkill(sourceHome, "different", "different", "source body");
    await writeSkill(sourceHome, "only-local");

    await writeSkill(targetHome, "same");
    await writeSkill(targetHome, "different", "different", "target body");
    await writeSkill(targetHome, "only-remote");

    const sourceItems = (await list(sourceHome)).items;
    const targetItems = (await list(targetHome)).items;
    const sourceKeys = new Set(sourceItems.map((item) => item.key));
    const targetByKey = new Map(targetItems.map((item) => [item.key, item]));

    expect(sourceKeys.has("only-remote")).toBe(false);
    expect(targetByKey.has("only-local")).toBe(false);
    expect(sourceItems.find((item) => item.key === "same")?.signature).toEqual(
      targetByKey.get("same")?.signature,
    );
    expect(sourceItems.find((item) => item.key === "different")?.signature).toEqual(
      targetByKey.get("different")?.signature,
    );

    const sourceHashes = (await hashes(sourceHome, ["same", "different"])).hashes;
    const targetHashes = (await hashes(targetHome, ["same", "different"])).hashes;
    expect(sourceHashes.same).toBe(targetHashes.same);
    expect(sourceHashes.different).not.toBe(targetHashes.different);
  });

  it("never deletes target-only skills and writes only requested keys", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeSkill(sourceHome, "only-local", "only-local", "local body");
    const targetOnlyDirectory = await writeSkill(targetHome, "only-remote");

    const payload = await exportItems(sourceHome, ["only-local"]);
    const result = await importItems(targetHome, payload, [
      { key: "only-local", mode: "createOnly" },
    ]);

    expect(result.results).toEqual([{ key: "only-local", status: "created" }]);
    expect(await pathExists(join(targetHome, ".nibi", "skills", "only-local", "SKILL.md"))).toBe(
      true,
    );
    expect(await readFile(join(targetOnlyDirectory, "SKILL.md"), "utf-8")).toContain("only-remote");
    expect((await readdir(join(targetHome, ".nibi", "skills"))).sort()).toEqual([
      "only-local",
      "only-remote",
    ]);
  });

  it("keeps per-item failures isolated and preserves the target on conflict", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeSkill(sourceHome, "updated", "updated", "new content");
    await writeSkill(sourceHome, "created");

    const existingDirectory = await writeSkill(targetHome, "updated", "updated", "old content");
    const payload = await exportItems(sourceHome, ["updated", "created"]);
    const result = await importItems(targetHome, payload, [
      { key: "updated", mode: "overwrite", expectedTargetHash: "stale-hash" },
      { key: "created", mode: "createOnly" },
    ]);

    expect(result.results).toEqual(
      expect.arrayContaining([
        { key: "updated", status: "conflict" },
        { key: "created", status: "created" },
      ]),
    );
    expect(await readFile(join(existingDirectory, "SKILL.md"), "utf-8")).toContain("old content");
    expect((await readdir(existingDirectory)).sort()).toEqual(["SKILL.md"]);
    expect(await pathExists(join(targetHome, ".nibi", "skills", "created", "SKILL.md"))).toBe(true);
  });

  it("replaces the whole skill directory on overwrite after the hash check", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourceDirectory = await writeSkill(sourceHome, "replace", "replace", "new content");
    await writeFile(join(sourceDirectory, "new.txt"), "new file");
    const targetDirectory = await writeSkill(targetHome, "replace", "replace", "old content");
    await writeFile(join(targetDirectory, "old.txt"), "old file");
    const expectedTargetHash = (await hashes(targetHome, ["replace"])).hashes.replace;

    const payload = await exportItems(sourceHome, ["replace"]);
    const result = await importItems(targetHome, payload, [
      { key: "replace", mode: "overwrite", expectedTargetHash },
    ]);

    expect(result.results).toEqual([{ key: "replace", status: "updated" }]);
    expect(await readFile(join(targetDirectory, "SKILL.md"), "utf-8")).toContain("new content");
    expect(await pathExists(join(targetDirectory, "new.txt"))).toBe(true);
    expect(await pathExists(join(targetDirectory, "old.txt"))).toBe(false);
  });

  it("writes parent and child skills together regardless of item order", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeSkill(sourceHome, "parent", "parent", "parent body");
    await writeSkill(sourceHome, "parent/child", "child");

    const payload = await exportItems(sourceHome, ["parent", "child"]);
    expect(payload.items.map((item) => item.directoryName).sort()).toEqual([
      "parent",
      "parent/child",
    ]);
    const result = await importItems(targetHome, payload, [
      { key: "child", mode: "createOnly" },
      { key: "parent", mode: "createOnly" },
    ]);

    expect(result.results).toEqual(
      expect.arrayContaining([
        { key: "parent", status: "created" },
        { key: "child", status: "created" },
      ]),
    );
    expect(
      await readFile(join(targetHome, ".nibi", "skills", "parent", "SKILL.md"), "utf-8"),
    ).toContain("parent body");
    expect(
      await readFile(join(targetHome, ".nibi", "skills", "parent", "child", "SKILL.md"), "utf-8"),
    ).toContain("child");
  });

  it("marks compat-directory and symlinked targets as not overwritable", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    await writeSkill(sourceHome, "compat", "compat", "compat body", ".agents");
    const realDirectory = await writeSkill(targetHome, "real");
    const linkDirectory = join(targetHome, ".nibi", "skills", "linked");
    await symlink(realDirectory, linkDirectory, process.platform === "win32" ? "junction" : "dir");

    const sourceItems = (await list(sourceHome)).items;
    expect(sourceItems.find((item) => item.key === "compat")?.overwriteBlockedReason).toBe(
      "compat-directory",
    );
    const targetItems = (await list(targetHome)).items;
    expect(targetItems.find((item) => item.key === "real")?.overwriteBlockedReason).toBe(
      "target-symlink",
    );
  });

  it("rejects a new disabled skill when config.json is corrupt and removes the partial directory", async () => {
    const sourceHome = makeHome();
    const targetHome = makeHome();
    const sourceDirectory = await writeSkill(sourceHome, "disabled", "disabled");
    const configPath = join(sourceHome, ".nibi", "cli", "config.json");
    await writeConfig(sourceHome, {
      skills: { [join(sourceDirectory, "SKILL.md").replaceAll("\\", "/")]: { enable: false } },
    });
    const targetConfigDirectory = join(targetHome, ".nibi", "cli");
    await mkdir(targetConfigDirectory, { recursive: true });
    await writeFile(join(targetConfigDirectory, "config.json"), "{broken");

    const payload = await exportItems(sourceHome, ["disabled"]);
    expect(payload.items[0]?.enabled).toBe(false);
    const result = await importItems(targetHome, payload, [
      { key: "disabled", mode: "createOnly" },
    ]);

    expect(result.results[0]).toMatchObject({ key: "disabled", status: "failed" });
    expect(await pathExists(join(targetHome, ".nibi", "skills", "disabled"))).toBe(false);
    expect(await readFile(configPath, "utf-8")).toContain("enable");
  });

  it("checks write access before pushing", async () => {
    const home = makeHome();
    const result = await withHome(home, () => service().checkSyncWriteAccess());
    expect(result).toMatchObject({ ok: true });
  });
});

async function withHome<T>(home: string, task: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await task();
  } finally {
    process.env.HOME = previous;
  }
}
