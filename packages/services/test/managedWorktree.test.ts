import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  createManagedWorktreeManager,
  normalizeManagedWorktreePathKey,
  parseManagedWorktreeListPorcelain,
  validateManagedWorktreeName,
} from "../src/git/managedWorktree.js";
import type {
  GitCommandExecutionResult,
  GitCommandProvider,
} from "../src/git/providers/gitCommandProvider.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const describeIfGit = gitAvailable ? describe : describe.skip;
const gitLocalEnvVars = gitAvailable
  ? execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf-8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  : [];

function createDetachedGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const variableName of gitLocalEnvVars) {
    delete env[variableName];
  }
  return env;
}

function runGit(cwd: string | undefined, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: createDetachedGitEnv(),
  }).trim();
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function createRepo(options?: { withRemote?: boolean }) {
  const container = makeTempDir("nibi-managed-worktree-");
  const repoPath = join(container, "repo");
  const workspacePath = join(repoPath, "packages", "app");
  mkdirSync(workspacePath, { recursive: true });
  writeFileSync(join(workspacePath, "tracked.txt"), "line 1\n");

  runGit(container, ["init", "repo"]);
  runGit(repoPath, ["branch", "-M", "main"]);
  runGit(repoPath, ["config", "user.name", "Nibi Tester"]);
  runGit(repoPath, ["config", "user.email", "tester@example.com"]);
  runGit(repoPath, ["config", "commit.gpgsign", "false"]);
  runGit(repoPath, ["config", "core.autocrlf", "false"]);
  runGit(repoPath, ["add", "."]);
  runGit(repoPath, ["commit", "-m", "chore: initial"]);

  let remotePath: string | null = null;
  if (options?.withRemote) {
    remotePath = makeTempDir("nibi-managed-worktree-remote-");
    runGit(undefined, ["init", "--bare", remotePath]);
    runGit(repoPath, ["remote", "add", "origin", remotePath]);
    runGit(repoPath, ["push", "-u", "origin", "main"]);
  }

  return { container, repoPath, workspacePath, remotePath };
}

describeIfGit("managed worktree", () => {
  it("creates a managed worktree in a monorepo subdirectory and lists/removes it", async () => {
    const { repoPath, workspacePath } = createRepo();
    const manager = createManagedWorktreeManager();

    const created = await manager.create({ workspacePath, name: "feature-one" });

    expect(created).toMatchObject({
      name: "feature-one",
      branchName: "worktree-feature-one",
      baseRef: "main",
      baseCommit: runGit(repoPath, ["rev-parse", "main"]),
    });
    // Windows CI 的 tmpdir 是 8.3 短名（RUNNER~1），投影侧会 realpath 成长名；按真实路径比较。
    const expectedRoot = join(repoPath, ".nibi", "worktrees", "feature-one");
    await expect(realpath(created.path)).resolves.toBe(await realpath(expectedRoot));
    await expect(realpath(created.workspacePath)).resolves.toBe(
      await realpath(join(expectedRoot, "packages", "app")),
    );
    await expect(realpath(created.sourceWorkspacePath)).resolves.toBe(
      await realpath(workspacePath),
    );
    expect(
      runGit(repoPath, [
        "config",
        "--local",
        "--get",
        "branch.worktree-feature-one.nibiBaseCommit",
      ]),
    ).toBe(created.baseCommit);
    expect(existsSync(created.workspacePath)).toBe(true);
    expect(runGit(repoPath, ["branch", "--list", "worktree-feature-one"])).toContain(
      "worktree-feature-one",
    );

    const listed = await manager.list({ workspacePath });
    expect(listed.map((worktree) => worktree.name)).toEqual(["feature-one"]);
    expect(listed[0]?.workspacePath).toBe(created.workspacePath);
    expect(listed[0]?.baseCommit).toBe(created.baseCommit);

    const excluded = readFileSync(join(repoPath, ".git", "info", "exclude"), "utf-8");
    expect(
      excluded.split(/\r?\n/).filter((line) => line.trim() === ".nibi/worktrees/"),
    ).toHaveLength(1);

    const removal = await manager.remove({ worktreePath: created.workspacePath });

    expect(removal).toMatchObject({
      ok: true,
      reason: null,
      branchName: "worktree-feature-one",
    });
    expect(normalizeManagedWorktreePathKey(removal.worktreePath!)).toBe(
      normalizeManagedWorktreePathKey(created.path),
    );
    expect(existsSync(created.path)).toBe(false);
    expect(runGit(repoPath, ["branch", "--list", "worktree-feature-one"])).toBe("");
  });

  it("keeps .git/info/exclude idempotent across multiple creations", async () => {
    const { repoPath, workspacePath } = createRepo();
    const manager = createManagedWorktreeManager();

    await manager.create({ workspacePath, name: "one" });
    await manager.create({ workspacePath, name: "two" });

    const excluded = readFileSync(join(repoPath, ".git", "info", "exclude"), "utf-8");
    expect(
      excluded.split(/\r?\n/).filter((line) => line.trim() === ".nibi/worktrees/"),
    ).toHaveLength(1);
  });

  it("uses origin default as the base when local main is ahead", async () => {
    const { repoPath, workspacePath } = createRepo({ withRemote: true });
    writeFileSync(join(workspacePath, "local-only.txt"), "local only\n");
    runGit(repoPath, ["add", "."]);
    runGit(repoPath, ["commit", "-m", "local only"]);
    const originMain = runGit(repoPath, ["rev-parse", "origin/main"]);
    expect(runGit(repoPath, ["rev-parse", "HEAD"])).not.toBe(originMain);

    const created = await createManagedWorktreeManager().create({
      workspacePath,
      name: "from-origin",
    });

    expect(created.baseRef).toBe("origin/main");
    expect(runGit(created.path, ["rev-parse", "HEAD"])).toBe(originMain);
  });

  it("falls back to a non-main default branch so new commits are still detected", async () => {
    const { repoPath, workspacePath } = createRepo();
    runGit(repoPath, ["branch", "-M", "trunk"]);
    const manager = createManagedWorktreeManager();

    const created = await manager.create({ workspacePath, name: "trunk-based" });
    expect(created.baseRef).toBe("trunk");

    writeFileSync(join(created.workspacePath, "committed.txt"), "committed\n");
    runGit(created.path, ["add", "."]);
    runGit(created.path, ["commit", "-m", "feat: worktree commit"]);

    const removal = await manager.remove({ worktreePath: created.path });
    expect(removal).toMatchObject({
      ok: false,
      reason: "uncommitted-commits",
      commitCount: 1,
    });
    expect(existsSync(created.path)).toBe(true);
  });

  it("rolls back when the mapped monorepo directory is absent from the base checkout", async () => {
    const { repoPath } = createRepo();
    const untrackedWorkspace = join(repoPath, "packages", "new-app");
    mkdirSync(untrackedWorkspace, { recursive: true });
    writeFileSync(join(untrackedWorkspace, "scratch.txt"), "scratch\n");

    await expect(
      createManagedWorktreeManager().create({
        workspacePath: untrackedWorkspace,
        name: "missing-dir",
      }),
    ).rejects.toThrow("managed-worktree.workspace-missing");

    expect(existsSync(join(repoPath, ".nibi", "worktrees", "missing-dir"))).toBe(false);
    expect(existsSync(join(repoPath, ".nibi"))).toBe(false);
    expect(runGit(repoPath, ["branch", "--list", "worktree-missing-dir"])).toBe("");
  });

  it("uses the recorded commit in a detached-HEAD repo instead of the fallback HEAD ref", async () => {
    const { repoPath, workspacePath } = createRepo();
    const baseCommit = runGit(repoPath, ["rev-parse", "HEAD"]);
    runGit(repoPath, ["checkout", "--detach"]);
    runGit(repoPath, ["branch", "-D", "main"]);
    const manager = createManagedWorktreeManager();

    const clean = await manager.create({ workspacePath, name: "detached-clean" });
    expect(clean.baseRef).toBe("HEAD");
    expect(clean.baseCommit).toBe(baseCommit);
    expect(await manager.remove({ worktreePath: clean.path })).toMatchObject({
      ok: true,
      reason: null,
    });
    expect(existsSync(clean.path)).toBe(false);

    const committed = await manager.create({ workspacePath, name: "detached-committed" });
    writeFileSync(join(committed.workspacePath, "committed.txt"), "committed\n");
    runGit(committed.path, ["add", "."]);
    runGit(committed.path, ["commit", "-m", "feat: worktree commit"]);

    const removal = await manager.remove({ worktreePath: committed.path });
    expect(removal).toMatchObject({
      ok: false,
      reason: "uncommitted-commits",
      commitCount: 1,
    });
    expect(existsSync(committed.path)).toBe(true);
  });

  it("refuses removal when the recorded base commit is unavailable", async () => {
    const { repoPath, workspacePath } = createRepo();
    const manager = createManagedWorktreeManager();
    const created = await manager.create({ workspacePath, name: "no-base" });
    expect(created.baseCommit).toMatch(/^[0-9a-f]{40}$/);

    runGit(repoPath, ["config", "--local", "--unset", "branch.worktree-no-base.nibiBaseCommit"]);

    const removal = await manager.remove({ worktreePath: created.path });
    expect(removal).toMatchObject({
      ok: false,
      reason: "base-commit-missing",
      commitCount: 0,
    });
    expect(removal.message).toContain("base commit");
    expect(existsSync(created.path)).toBe(true);
  });

  it("rejects an existing managed branch instead of resetting it", async () => {
    const { repoPath, workspacePath } = createRepo();
    runGit(repoPath, ["branch", "worktree-taken"]);

    await expect(
      createManagedWorktreeManager().create({ workspacePath, name: "taken" }),
    ).rejects.toThrow("managed-worktree.branch-exists: worktree-taken");
    expect(existsSync(join(repoPath, ".nibi", "worktrees", "taken"))).toBe(false);
  });

  it("refuses removal when the worktree has uncommitted changes", async () => {
    const { workspacePath } = createRepo();
    const manager = createManagedWorktreeManager();
    const created = await manager.create({ workspacePath, name: "dirty" });
    writeFileSync(join(created.workspacePath, "dirty.txt"), "dirty\n");

    const removal = await manager.remove({ worktreePath: created.workspacePath });

    expect(removal).toMatchObject({
      ok: false,
      reason: "dirty",
      dirtyEntryCount: 1,
      commitCount: 0,
    });
    expect(existsSync(created.workspacePath)).toBe(true);
    expect(existsSync(join(created.workspacePath, "dirty.txt"))).toBe(true);
  });

  it("refuses removal when the worktree has commits beyond the base", async () => {
    const { workspacePath } = createRepo();
    const manager = createManagedWorktreeManager();
    const created = await manager.create({ workspacePath, name: "committed" });
    writeFileSync(join(created.workspacePath, "committed.txt"), "committed\n");
    runGit(created.path, ["add", "."]);
    runGit(created.path, ["commit", "-m", "feat: worktree commit"]);

    const removal = await manager.remove({ worktreePath: created.path });

    expect(removal).toMatchObject({
      ok: false,
      reason: "uncommitted-commits",
      dirtyEntryCount: 0,
      commitCount: 1,
    });
    expect(existsSync(created.path)).toBe(true);
  }, 90_000);

  it("rejects non-managed directories", async () => {
    const { workspacePath } = createRepo();

    const removal = await createManagedWorktreeManager().remove({
      worktreePath: workspacePath,
    });

    expect(removal).toMatchObject({ ok: false, reason: "not-managed" });
  });

  it("creates with --no-track -b and removes without force", async () => {
    const repoRoot = makeTempDir("nibi-managed-worktree-flags-");
    const gitDir = join(repoRoot, ".git");
    const sourceWorkspacePath = join(repoRoot, "packages", "app");
    const worktreeRoot = join(repoRoot, ".nibi", "worktrees", "feature");
    mkdirSync(sourceWorkspacePath, { recursive: true });
    const commands: { cwd: string; args: string[] }[] = [];
    const pseudoHead = "0123456789012345678901234567890123456789";

    const runCommand: GitCommandProvider["run"] = async (options) => {
      commands.push({ cwd: options.cwd, args: options.args });
      const args = options.args;
      const result: GitCommandExecutionResult = {
        binaryPath: "git",
        cwd: options.cwd,
        args,
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        durationMs: 0,
        timedOut: false,
        outputTruncated: false,
      };

      if (args[0] === "rev-parse" && args.includes("--show-toplevel")) {
        const insideWorktree = options.cwd.toLowerCase().startsWith(worktreeRoot.toLowerCase());
        return {
          ...result,
          stdout: [
            insideWorktree ? worktreeRoot : repoRoot,
            insideWorktree ? "packages/app/" : "",
            gitDir,
            gitDir,
            "",
          ].join("\n"),
        };
      }
      if (args[0] === "symbolic-ref" && args.includes("refs/remotes/origin/HEAD")) {
        return { ...result, exitCode: 1 };
      }
      if (args[0] === "symbolic-ref" && args.includes("--short")) {
        return { ...result, exitCode: 1 };
      }
      if (args[0] === "rev-parse" && args.includes("--verify")) {
        return { ...result, exitCode: args.includes("main^{commit}") ? 0 : 1 };
      }
      if (args[0] === "rev-parse") {
        return { ...result, stdout: `${pseudoHead}\n` };
      }
      if (args[0] === "show-ref") {
        return { ...result, exitCode: 1 };
      }
      if (args[0] === "config") {
        return args.includes("--get") ? { ...result, stdout: `${pseudoHead}\n` } : result;
      }
      if (args[0] === "worktree" && args[1] === "add") {
        mkdirSync(join(worktreeRoot, "packages", "app"), { recursive: true });
        return result;
      }
      if (args[0] === "worktree" && args[1] === "list") {
        return {
          ...result,
          stdout: [
            `worktree ${worktreeRoot}`,
            `HEAD ${pseudoHead}`,
            "branch refs/heads/worktree-feature",
            "",
            `worktree ${repoRoot}`,
            `HEAD ${pseudoHead}`,
            "branch refs/heads/main",
            "",
          ].join("\n"),
        };
      }
      if (args[0] === "status") return result;
      if (args[0] === "rev-list") return { ...result, stdout: "0\n" };
      if (args[0] === "worktree" && args[1] === "remove") return result;
      if (args[0] === "branch" && args[1] === "-D") return result;
      throw new Error(`Unscripted git call: ${args.join(" ")}`);
    };

    const manager = createManagedWorktreeManager({
      commandProvider: {
        resolveGitBinary: async () => "git",
        run: runCommand,
      },
    });
    const created = await manager.create({
      workspacePath: sourceWorkspacePath,
      name: "feature",
    });

    const addCommand = commands.find(
      (command) => command.args[0] === "worktree" && command.args[1] === "add",
    );
    expect(addCommand?.args).toEqual([
      "worktree",
      "add",
      "--no-track",
      "-b",
      "worktree-feature",
      worktreeRoot,
      "main",
    ]);
    expect(created.baseCommit).toBe(pseudoHead);
    expect(
      commands.find(
        (command) =>
          command.args[0] === "config" &&
          command.args.includes("branch.worktree-feature.nibiBaseCommit"),
      )?.args,
    ).toContain(pseudoHead);

    const removal = await manager.remove({ worktreePath: created.workspacePath });
    expect(removal.ok).toBe(true);

    const removeCommand = commands.find(
      (command) => command.args[0] === "worktree" && command.args[1] === "remove",
    );
    expect(removeCommand?.args).toEqual(["worktree", "remove", worktreeRoot]);
    const flatArgs = commands.flatMap((command) => command.args);
    expect(flatArgs).not.toContain("-B");
    expect(flatArgs).not.toContain("--force");
  });

  it("reports the creating count while a worktree is being created and returns to zero", async () => {
    const { workspacePath } = createRepo();
    const manager = createManagedWorktreeManager();
    const counts: number[] = [];

    const unsubscribe = manager.onCreatingCountChanged((count) => {
      counts.push(count);
    });

    await manager.create({ workspacePath, name: "counting" });

    expect(counts).toEqual([1, 0]);
    expect(manager.getCreatingCount()).toBe(0);
    unsubscribe();
  });

  it("returns the creating count to zero when creation fails", async () => {
    const { container } = createRepo();
    const manager = createManagedWorktreeManager();
    const counts: number[] = [];
    manager.onCreatingCountChanged((count) => counts.push(count));

    await expect(
      manager.create({ workspacePath: join(container, "missing-workspace") }),
    ).rejects.toThrow("managed-worktree.not-a-repository");

    expect(counts).toEqual([1, 0]);
    expect(manager.getCreatingCount()).toBe(0);
  });

  it("validates names against traversal, git, Windows device and length rules", () => {
    expect(validateManagedWorktreeName("feature/one-two_3")).toBe("feature/one-two_3");
    for (const invalid of [
      "",
      ".",
      "..",
      ".git",
      "a//b",
      "/absolute",
      "a b",
      "trailing.",
      "trailing ",
      "a..b",
      "branch.lock",
      "dir.lock/child",
      "CON",
      "nul.txt",
      "COM1",
      "a".repeat(65),
      "a\\b",
    ]) {
      expect(() => validateManagedWorktreeName(invalid)).toThrow("managed-worktree.invalid-name");
    }
  });

  it("normalizes CRLF, separators and Windows casing in porcelain records", () => {
    const stdout = [
      "worktree C:\\Repo\\.nibi\\worktrees\\Feature",
      "HEAD 0123456789012345678901234567890123456789",
      "branch refs/heads/worktree-Feature",
      "",
      "worktree C:\\Repo",
      "HEAD 0123456789012345678901234567890123456789",
      "branch refs/heads/main",
      "",
    ].join("\r\n");

    const records = parseManagedWorktreeListPorcelain(stdout, "c:/repo/.nibi/worktrees/", "win32");

    expect(records).toEqual([
      {
        path: "C:\\Repo\\.nibi\\worktrees\\Feature",
        branchName: "worktree-Feature",
      },
    ]);
    expect(normalizeManagedWorktreePathKey("C:\\Repo\\A\\", "win32")).toBe("c:/repo/a");
    expect(normalizeManagedWorktreePathKey("C:\\Repo\\A\\", "linux")).toBe("C:/Repo/A");
  });
});
