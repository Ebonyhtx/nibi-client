import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createGitCommandProvider } from "../src/git/providers/gitCommandProvider.js";
import { createGitWorktreeRepo } from "../src/git/managed-worktree/index.js";
import { reapOrphanedWorktrees } from "../src/managed-worktree-tasks/index.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `nibi-wt-${label}-`));
  tempDirs.push(dir);
  return dir;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-c", "user.name=Nibi Test", "-c", "user.email=test@example.com", ...args],
    { cwd, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  return stdout.trim();
}

async function createRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, "init", "-q");
  await writeFile(join(root, "README.md"), "hello\n");
  await git(root, "add", "README.md");
  await git(root, "commit", "-qm", "init");
}

function repoAt(dataBaseDir: string) {
  return createGitWorktreeRepo({
    commandProvider: createGitCommandProvider(),
    dataBaseDir: () => dataBaseDir,
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("managed worktree git repo", () => {
  it("reports non-repository sources without creating anything", async () => {
    const root = await makeTempDir("nongit");
    const repo = repoAt(join(root, "data"));
    await expect(repo.create({ sourcePath: root })).resolves.toMatchObject({
      ok: false,
      error: { code: "not-repository" },
    });
    await expect(repo.list({ sourcePath: root })).resolves.toEqual({
      sourceRoot: null,
      worktrees: [],
    });
  });

  it("creates, lists and removes a worktree, mapping a repository subdirectory cwd", async () => {
    const root = await makeTempDir("basic");
    const source = join(root, "repo");
    await createRepo(source);
    await mkdir(join(source, "packages", "app"), { recursive: true });
    await writeFile(join(source, "packages", "app", "index.ts"), "export {}\n");
    await git(source, "add", ".");
    await git(source, "commit", "-qm", "app");

    const dataBaseDir = join(root, "data");
    const repo = repoAt(dataBaseDir);
    const created = await repo.create({ sourcePath: join(source, "packages", "app") });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.cwd).toBe(join(created.worktree.path, "packages", "app"));
    await expect(readFile(join(created.cwd, "index.ts"), "utf8")).resolves.toContain("export");
    await expect(readFile(join(created.worktree.path, ".git"), "utf8")).resolves.toContain(
      "gitdir:",
    );

    const listed = await repo.list({ sourcePath: source });
    expect(listed.sourceRoot).toBeTruthy();
    expect(listed.worktrees).toHaveLength(1);
    expect(listed.worktrees[0]).toMatchObject({
      path: created.worktree.path,
      bucket: created.worktree.bucket,
      state: "ok",
      dirty: false,
    });
    expect(listed.worktrees[0]?.bucket).toMatch(/^[0-9a-f]{4}$/);

    await expect(repo.remove({ path: created.worktree.path })).resolves.toEqual({ ok: true });
    await expect(repo.list({ sourcePath: source })).resolves.toMatchObject({ worktrees: [] });
  });

  it("rejects invalid start refs, missing subdirectories and non-managed removal paths", async () => {
    const root = await makeTempDir("invalid");
    const source = join(root, "repo");
    await createRepo(source);
    const dataBaseDir = join(root, "data");
    const repo = repoAt(dataBaseDir);

    await expect(
      repo.create({ sourcePath: source, startRef: "does-not-exist" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid-start-ref" } });

    const subdir = join(source, "untracked-app");
    await mkdir(subdir);
    await expect(repo.create({ sourcePath: subdir })).resolves.toMatchObject({
      ok: false,
      error: { code: "start-ref-missing-subdir" },
    });

    const outside = join(root, "outside");
    await mkdir(outside);
    await expect(repo.remove({ path: outside })).resolves.toMatchObject({
      ok: false,
      error: { code: "not-managed" },
    });
    await expect(repo.resolveManagedWorktree(outside)).resolves.toBeNull();
  });

  it("refuses dirty removal and allows an explicit force removal", async () => {
    const root = await makeTempDir("dirty");
    const source = join(root, "repo");
    await createRepo(source);
    const repo = repoAt(join(root, "data"));
    const created = await repo.create({ sourcePath: source });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await writeFile(join(created.worktree.path, "untracked.txt"), "dirty\n");
    await expect(repo.isDirty(created.worktree.path)).resolves.toBe(true);
    await expect(repo.remove({ path: created.worktree.path })).resolves.toMatchObject({
      ok: false,
      error: { code: "worktree-dirty" },
    });
    await expect(repo.remove({ path: created.worktree.path, force: true })).resolves.toEqual({
      ok: true,
    });
  });

  it("carries uncommitted and ignored-included files into the fork worktree", async () => {
    const root = await makeTempDir("carry");
    const source = join(root, "repo");
    await createRepo(source);
    await writeFile(join(source, ".gitignore"), ".env\n");
    await writeFile(join(source, ".worktreeinclude"), ".env\n");
    await git(source, "add", ".gitignore", ".worktreeinclude");
    await git(source, "commit", "-qm", "ignore");
    await writeFile(join(source, "README.md"), "hello changed\n");
    await writeFile(join(source, ".env"), "TOKEN=1\n");
    await writeFile(join(source, "untracked.txt"), "new\n");
    await git(source, "add", "README.md");

    const repo = repoAt(join(root, "data"));
    const created = await repo.create({ sourcePath: source, carryChanges: true });
    if (!created.ok) throw new Error(`${created.error.code}: ${created.error.detail}`);
    expect(created.ok).toBe(true);
    await expect(readFile(join(created.worktree.path, "README.md"), "utf8")).resolves.toBe(
      "hello changed\n",
    );
    await expect(readFile(join(created.worktree.path, "untracked.txt"), "utf8")).resolves.toBe(
      "new\n",
    );
    await expect(readFile(join(created.worktree.path, ".env"), "utf8")).resolves.toBe("TOKEN=1\n");
  });

  it("reaps unregistered buckets and prunes registered worktrees whose directory is gone", async () => {
    const root = await makeTempDir("reaper");
    const source = join(root, "repo");
    await createRepo(source);
    const dataBaseDir = join(root, "data");
    const repo = repoAt(dataBaseDir);

    // 未登记的残留：bucket 里有一份 checkout，但 git 从未登记过它。
    const managedRoot = join(dataBaseDir, ".nibi", "worktrees");
    const ghostRoot = join(managedRoot, "dead", "repo");
    const adminDir = join(source, ".git", "worktrees", "ghost");
    await mkdir(ghostRoot, { recursive: true });
    await mkdir(adminDir, { recursive: true });
    await writeFile(join(ghostRoot, ".git"), `gitdir: ${adminDir}\n`);
    await writeFile(join(adminDir, "gitdir"), `${join(ghostRoot, ".git")}\n`);
    await writeFile(join(adminDir, "commondir"), "../..\n");

    // 已登记但目录被手动删除：reaper 应执行 prune。
    const created = await repo.create({ sourcePath: source });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await rm(created.worktree.path, { recursive: true, force: true });

    const repository = {
      readTree: () => ({
        projects: [
          {
            id: "project",
            hostId: "local",
            name: "repo",
            nameOverridden: false,
            roots: [{ rootPath: source, position: 0, isPrimary: true }],
            position: 0,
            pinned: false,
            deleted: false,
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        tasks: [],
      }),
      listTasksByWorktree: () => [],
    };
    const result = await reapOrphanedWorktrees({
      git: repo,
      repository: async () => repository as never,
      dataBaseDir: () => dataBaseDir,
    });
    expect(result.removed).toContain(ghostRoot);
    expect(result.pruned.length).toBeGreaterThan(0);
    await expect(readFile(join(ghostRoot, ".git"), "utf8")).rejects.toBeTruthy();
    await expect(repo.list({ sourcePath: source })).resolves.toMatchObject({ worktrees: [] });
  });
});