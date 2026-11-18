import { randomBytes } from "node:crypto";
import { mkdir, readFile, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  GitManagedWorktree,
  GitManagedWorktreeRemovalReason,
  GitManagedWorktreeRemovalResult,
} from "@nibi/shared";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_OUTPUT_BYTES,
  normalizeGitPath,
  normalizeWorkspaceInRepoPath,
} from "./config.js";
import {
  createGitCommandProvider,
  type GitCommandExecutionResult,
  type GitCommandProvider,
} from "./providers/gitCommandProvider.js";

const MANAGED_WORKTREE_DIRNAME = ".nibi";
const MANAGED_WORKTREE_SUBDIR = "worktrees";
const MANAGED_WORKTREE_EXCLUDE_ENTRY = ".nibi/worktrees/";
const MAX_MANAGED_WORKTREE_NAME_LENGTH = 64;
const MANAGED_WORKTREE_BRANCH_PREFIX = "worktree-";
const MANAGED_WORKTREE_BASE_COMMIT_CONFIG_KEY = "nibiBaseCommit";
const GIT_COMMIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
const MANAGED_NAME_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export interface ManagedWorktreeResolution {
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  gitDir: string;
  gitCommonDir: string;
}

export interface ManagedWorktreeInspection {
  isManaged: boolean;
  worktreeRoot: string | null;
  repoRoot: string | null;
  branchName: string | null;
}

export interface ManagedWorktreeRemovalCheck {
  ok: boolean;
  reason: GitManagedWorktreeRemovalReason | null;
  message: string | null;
  dirtyEntryCount: number;
  commitCount: number;
}

export interface ManagedWorktreeManager {
  create(params: { workspacePath: string; name?: string }): Promise<GitManagedWorktree>;
  list(params: { workspacePath: string }): Promise<GitManagedWorktree[]>;
  inspect(params: { workspacePath: string }): Promise<ManagedWorktreeInspection>;
  checkRemoval(params: { worktreePath: string }): Promise<ManagedWorktreeRemovalCheck>;
  remove(params: { worktreePath: string }): Promise<GitManagedWorktreeRemovalResult>;
  /** 当前正在创建（含失败回滚）的受管 worktree 数量；创建结束或失败都会归零。 */
  getCreatingCount(): number;
  /** 订阅「正在创建」数量变化，返回取消订阅函数。 */
  onCreatingCountChanged(listener: (count: number) => void): () => void;
}

interface ParsedWorktreeRecord {
  path: string;
  branchName: string | null;
}

function ensureCommandSucceeded(operation: string, result: GitCommandExecutionResult): void {
  if (result.exitCode === 0 && !result.timedOut && !result.outputTruncated) {
    return;
  }

  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(`${operation} failed${detail ? `: ${detail}` : ""}`);
}

function normalizeCommandOutput(result: GitCommandExecutionResult): string {
  return result.stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function normalizeManagedWorktreePathKey(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const absolute = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isPathWithin(parent: string, child: string): boolean {
  const relativePath = relative(resolve(parent), resolve(child));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function managedWorktreeRoot(repoRoot: string): string {
  return join(repoRoot, MANAGED_WORKTREE_DIRNAME, MANAGED_WORKTREE_SUBDIR);
}

export function isManagedWorktreePathCandidate(
  workspacePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizeManagedWorktreePathKey(workspacePath, platform);
  return normalized.includes(`/${MANAGED_WORKTREE_DIRNAME}/${MANAGED_WORKTREE_SUBDIR}/`);
}

export function validateManagedWorktreeName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error("managed-worktree.invalid-name: name is empty");
  }
  if (trimmed !== name) {
    throw new Error("managed-worktree.invalid-name: name must not have leading/trailing spaces");
  }
  if (trimmed.length > MAX_MANAGED_WORKTREE_NAME_LENGTH) {
    throw new Error(
      `managed-worktree.invalid-name: name exceeds ${MAX_MANAGED_WORKTREE_NAME_LENGTH} characters`,
    );
  }
  if (trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("managed-worktree.invalid-name: name contains an unsupported separator");
  }

  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment.length === 0 || !MANAGED_NAME_SEGMENT_PATTERN.test(segment)) {
      throw new Error("managed-worktree.invalid-name: each segment must match [A-Za-z0-9._-]+");
    }
    if (segment === "." || segment === ".." || segment.toLowerCase() === ".git") {
      throw new Error("managed-worktree.invalid-name: reserved path segment");
    }
    // 段内 `..` / `.lock` 能通过字符集，却不是合法 Git ref；必须在创建分支前拒绝。
    if (segment.includes("..")) {
      throw new Error("managed-worktree.invalid-name: segment must not contain '..'");
    }
    if (segment.toLowerCase().endsWith(".lock")) {
      throw new Error("managed-worktree.invalid-name: segment must not end with '.lock'");
    }
    if (WINDOWS_RESERVED_NAME_PATTERN.test(segment)) {
      throw new Error("managed-worktree.invalid-name: Windows reserved device name");
    }
    if (segment.endsWith(".") || segment.endsWith(" ")) {
      throw new Error("managed-worktree.invalid-name: segment must not end with a dot or space");
    }
  }

  return segments.join("/");
}

function createDefaultManagedWorktreeName(now: Date = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "")
    .replace("T", "-");
  return `wt-${timestamp}-${randomBytes(3).toString("hex")}`;
}

export function managedWorktreeBranchName(name: string): string {
  return `${MANAGED_WORKTREE_BRANCH_PREFIX}${name.replace(/\//g, "-")}`;
}

function managedWorktreeBaseCommitConfigKey(branchName: string): string {
  return `branch.${branchName}.${MANAGED_WORKTREE_BASE_COMMIT_CONFIG_KEY}`;
}

function toWorktreeWorkspacePath(worktreeRoot: string, workspaceInRepoPath: string): string {
  const relativeWorkspace = normalizeWorkspaceInRepoPath(workspaceInRepoPath);
  return relativeWorkspace === "."
    ? worktreeRoot
    : join(worktreeRoot, ...relativeWorkspace.split("/"));
}

export function parseManagedWorktreeListPorcelain(
  stdout: string,
  managedRoot: string,
  platform: NodeJS.Platform = process.platform,
): ParsedWorktreeRecord[] {
  const records: ParsedWorktreeRecord[] = [];
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  const flush = () => {
    if (currentPath) {
      records.push({ path: currentPath, branchName: currentBranch });
    }
    currentPath = null;
    currentBranch = null;
  };

  for (const rawLine of stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")) {
    if (rawLine.length === 0) {
      flush();
      continue;
    }
    if (rawLine.startsWith("worktree ")) {
      flush();
      currentPath = rawLine.slice("worktree ".length).trim();
      continue;
    }
    if (rawLine.startsWith("branch ")) {
      const ref = rawLine.slice("branch ".length).trim();
      currentBranch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  flush();

  const managedRootKey = normalizeManagedWorktreePathKey(managedRoot, platform);
  return records.filter((record) => {
    const recordKey = normalizeManagedWorktreePathKey(record.path, platform);
    return recordKey !== managedRootKey && recordKey.startsWith(`${managedRootKey}/`);
  });
}

export function createManagedWorktreeManager(options?: {
  commandProvider?: GitCommandProvider;
}): ManagedWorktreeManager {
  const commandProvider = options?.commandProvider ?? createGitCommandProvider();
  let creatingCount = 0;
  const creatingCountListeners = new Set<(count: number) => void>();

  function notifyCreatingCountChanged(): void {
    for (const listener of creatingCountListeners) {
      try {
        listener(creatingCount);
      } catch {
        // 订阅者异常不能改变 create/回滚语义。
      }
    }
  }

  function onCreatingCountChanged(listener: (count: number) => void): () => void {
    creatingCountListeners.add(listener);
    return () => {
      creatingCountListeners.delete(listener);
    };
  }

  /** 只包一层计数；创建、回滚与返回值的语义完全沿用原实现。 */
  async function create(params: {
    workspacePath: string;
    name?: string;
  }): Promise<GitManagedWorktree> {
    creatingCount += 1;
    notifyCreatingCountChanged();
    try {
      return await createWorktree(params);
    } finally {
      creatingCount -= 1;
      notifyCreatingCountChanged();
    }
  }

  async function runGit(
    cwd: string,
    args: string[],
    runOptions?: { maxOutputBytes?: number },
  ): Promise<GitCommandExecutionResult> {
    return await commandProvider.run({
      cwd,
      args,
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: runOptions?.maxOutputBytes ?? DEFAULT_GIT_OUTPUT_BYTES,
    });
  }

  async function resolveRepository(workspacePath: string): Promise<ManagedWorktreeResolution> {
    const result = await runGit(workspacePath, [
      "rev-parse",
      "--show-toplevel",
      "--show-prefix",
      "--absolute-git-dir",
      "--git-common-dir",
    ]);
    if (result.exitCode !== 0) {
      throw new Error("managed-worktree.not-a-repository");
    }

    const lines = normalizeCommandOutput(result).split("\n");
    const repoRoot = lines[0]?.trim();
    if (!repoRoot) {
      throw new Error("managed-worktree.not-a-repository");
    }

    return {
      workspacePath,
      repoRoot,
      workspaceInRepoPath: normalizeWorkspaceInRepoPath(lines[1] ?? ""),
      gitDir: lines[2]?.trim() ?? "",
      gitCommonDir: lines[3]?.trim() ?? "",
    };
  }

  function resolveCommonDir(resolution: ManagedWorktreeResolution): string {
    const commonDir = resolution.gitCommonDir.trim();
    return commonDir
      ? isAbsolute(commonDir)
        ? commonDir
        : // `--git-common-dir` 的相对结果以命令 cwd 为基准，不是 repoRoot；
          // monorepo 子目录 workspace 必须按 workspacePath 解析。
          resolve(resolution.workspacePath, commonDir)
      : resolution.gitDir;
  }

  async function branchExists(repoRoot: string, branchName: string): Promise<boolean> {
    const result = await runGit(repoRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ]);
    if (result.exitCode === 0) {
      return true;
    }
    if (result.exitCode === 1) {
      return false;
    }
    ensureCommandSucceeded("git show-ref --verify", result);
    return false;
  }

  async function refExists(repoRoot: string, ref: string): Promise<boolean> {
    const result = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return result.exitCode === 0;
  }

  /**
   * 仅用于选择新 worktree 的起点。删除检查不再调用它：
   * 起点必须固化成 base commit，否则 detached HEAD / 默认分支被删时会误判。
   */
  async function resolveBaseRef(repoRoot: string): Promise<string> {
    const originHead = await runGit(repoRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const originDefault = originHead.exitCode === 0 ? originHead.stdout.trim() : "";
    if (originDefault && (await refExists(repoRoot, originDefault))) {
      return originDefault;
    }

    for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
      if (await refExists(repoRoot, candidate)) {
        return candidate;
      }
    }

    const headBranch = await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const headBranchName = headBranch.exitCode === 0 ? headBranch.stdout.trim() : "";
    if (headBranchName && (await refExists(repoRoot, headBranchName))) {
      return headBranchName;
    }

    return "HEAD";
  }

  async function readBaseCommit(repoRoot: string, branchName: string): Promise<string | null> {
    const result = await runGit(repoRoot, [
      "config",
      "--local",
      "--get",
      managedWorktreeBaseCommitConfigKey(branchName),
    ]);
    if (result.exitCode !== 0) return null;
    const value = result.stdout.trim();
    return GIT_COMMIT_SHA_PATTERN.test(value) ? value : null;
  }

  async function writeBaseCommit(
    repoRoot: string,
    branchName: string,
    baseCommit: string,
  ): Promise<void> {
    const result = await runGit(repoRoot, [
      "config",
      "--local",
      managedWorktreeBaseCommitConfigKey(branchName),
      baseCommit,
    ]);
    ensureCommandSucceeded("git config managed worktree base commit", result);
  }

  async function ensureExcludeEntry(commonDir: string): Promise<void> {
    const excludePath = join(commonDir, "info", "exclude");
    await mkdir(dirname(excludePath), { recursive: true });
    let existing = "";
    try {
      existing = await readFile(excludePath, "utf-8");
    } catch {
      existing = "";
    }

    const lines = existing.replace(/\r\n/g, "\n").split("\n");
    if (lines.some((line) => line.trim() === MANAGED_WORKTREE_EXCLUDE_ENTRY.replace(/\/$/, ""))) {
      return;
    }
    if (lines.some((line) => line.trim() === MANAGED_WORKTREE_EXCLUDE_ENTRY)) {
      return;
    }

    const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
    await writeFile(
      excludePath,
      `${existing}${separator}${MANAGED_WORKTREE_EXCLUDE_ENTRY}\n`,
      "utf-8",
    );
  }

  async function listParsedWorktrees(repoRoot: string): Promise<ParsedWorktreeRecord[]> {
    const result = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
    ensureCommandSucceeded("git worktree list", result);
    return parseManagedWorktreeListPorcelain(
      result.stdout,
      managedWorktreeRoot(repoRoot),
      process.platform,
    );
  }

  async function pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** 创建后续步骤失败时的尽力回滚；回滚错误不能覆盖原始错误。 */
  async function rollbackCreatedWorktree(
    repoRoot: string,
    worktreeRoot: string,
    branchName: string,
  ): Promise<void> {
    try {
      await runGit(repoRoot, ["worktree", "remove", worktreeRoot]);
    } catch {
      // 尽力回滚；原始错误仍必须抛给调用方。
    }
    try {
      await runGit(repoRoot, ["branch", "-D", branchName]);
    } catch {
      // 同上。
    }
    // 只删除空目录：仍有其它受管 worktree 时 rmdir 会失败，不能递归清理。
    try {
      await rmdir(managedWorktreeRoot(repoRoot));
    } catch {
      // 非空或无目录都无需处理。
    }
    try {
      await rmdir(join(repoRoot, MANAGED_WORKTREE_DIRNAME));
    } catch {
      // 同上。
    }
  }

  async function inspect(params: { workspacePath: string }): Promise<ManagedWorktreeInspection> {
    if (!isManagedWorktreePathCandidate(params.workspacePath)) {
      return { isManaged: false, worktreeRoot: null, repoRoot: null, branchName: null };
    }

    try {
      const resolution = await resolveRepository(params.workspacePath);
      const worktreeRoot = resolution.repoRoot;
      const commonDir = resolveCommonDir(resolution);
      if (basename(commonDir).toLowerCase() !== ".git") {
        return { isManaged: false, worktreeRoot: null, repoRoot: null, branchName: null };
      }

      const repoRoot = dirname(commonDir);
      const managedRoot = managedWorktreeRoot(repoRoot);
      if (
        normalizeManagedWorktreePathKey(worktreeRoot) ===
          normalizeManagedWorktreePathKey(managedRoot) ||
        !isPathWithin(managedRoot, worktreeRoot)
      ) {
        return { isManaged: false, worktreeRoot: null, repoRoot: null, branchName: null };
      }

      const records = await listParsedWorktrees(repoRoot);
      const record = records.find(
        (candidate) =>
          normalizeManagedWorktreePathKey(candidate.path) ===
          normalizeManagedWorktreePathKey(worktreeRoot),
      );
      if (!record) {
        return { isManaged: false, worktreeRoot: null, repoRoot: null, branchName: null };
      }

      return {
        isManaged: true,
        worktreeRoot: record.path,
        repoRoot,
        branchName: record.branchName,
      };
    } catch {
      return { isManaged: false, worktreeRoot: null, repoRoot: null, branchName: null };
    }
  }

  async function checkRemoval(params: {
    worktreePath: string;
  }): Promise<ManagedWorktreeRemovalCheck> {
    const inspection = await inspect({ workspacePath: params.worktreePath });
    if (!inspection.isManaged || !inspection.worktreeRoot || !inspection.repoRoot) {
      return {
        ok: false,
        reason: "not-managed",
        message: "Workspace is not a registered managed worktree.",
        dirtyEntryCount: 0,
        commitCount: 0,
      };
    }

    const statusResult = await runGit(inspection.worktreeRoot, ["status", "--porcelain"]);
    ensureCommandSucceeded("git status --porcelain", statusResult);
    const dirtyEntryCount = normalizeCommandOutput(statusResult)
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
    if (dirtyEntryCount > 0) {
      return {
        ok: false,
        reason: "dirty",
        message: `Managed worktree has uncommitted changes (${dirtyEntryCount} entries).`,
        dirtyEntryCount,
        commitCount: 0,
      };
    }

    const branchName = inspection.branchName;
    if (!branchName) {
      return {
        ok: false,
        reason: "base-commit-missing",
        message:
          "Managed worktree has no branch; its recorded base commit is unavailable, refusing to remove.",
        dirtyEntryCount: 0,
        commitCount: 0,
      };
    }
    const baseCommit = await readBaseCommit(inspection.repoRoot, branchName);
    if (!baseCommit) {
      return {
        ok: false,
        reason: "base-commit-missing",
        message: `Managed worktree is missing its recorded base commit (${branchName}); refusing to remove.`,
        dirtyEntryCount: 0,
        commitCount: 0,
      };
    }

    const commitCountResult = await runGit(inspection.worktreeRoot, [
      "rev-list",
      "--count",
      `${baseCommit}..HEAD`,
    ]);
    if (commitCountResult.exitCode !== 0) {
      return {
        ok: false,
        reason: "base-commit-missing",
        message: `Unable to verify commits against recorded base ${baseCommit}; refusing to remove.`,
        dirtyEntryCount: 0,
        commitCount: 0,
      };
    }
    const commitCount = Number.parseInt(commitCountResult.stdout.trim(), 10);
    if (!Number.isFinite(commitCount)) {
      return {
        ok: false,
        reason: "base-commit-missing",
        message: `Unable to read commit count against recorded base ${baseCommit}; refusing to remove.`,
        dirtyEntryCount: 0,
        commitCount: 0,
      };
    }
    if (commitCount > 0) {
      return {
        ok: false,
        reason: "uncommitted-commits",
        message: `Managed worktree has ${commitCount} commits not in base ${baseCommit}.`,
        dirtyEntryCount: 0,
        commitCount,
      };
    }

    return {
      ok: true,
      reason: null,
      message: null,
      dirtyEntryCount: 0,
      commitCount: 0,
    };
  }

  async function createWorktree(params: {
    workspacePath: string;
    name?: string;
  }): Promise<GitManagedWorktree> {
    const resolution = await resolveRepository(params.workspacePath);
    const commonDir = resolveCommonDir(resolution);
    if (
      normalizeManagedWorktreePathKey(commonDir) !==
      normalizeManagedWorktreePathKey(resolution.gitDir)
    ) {
      throw new Error("managed-worktree.source-is-worktree");
    }

    const repoRoot = resolution.repoRoot;
    const managedRoot = managedWorktreeRoot(repoRoot);
    const requestedName = params.name?.trim();
    const baseRef = await resolveBaseRef(repoRoot);
    let lastCollision: Error | null = null;

    for (let attempt = 0; attempt < (requestedName ? 1 : 5); attempt += 1) {
      const name = validateManagedWorktreeName(requestedName ?? createDefaultManagedWorktreeName());
      const worktreeRoot = join(managedRoot, ...name.split("/"));
      const branchName = managedWorktreeBranchName(name);

      if (await branchExists(repoRoot, branchName)) {
        const error = new Error(`managed-worktree.branch-exists: ${branchName}`);
        if (requestedName) throw error;
        lastCollision = error;
        continue;
      }
      if (await pathExists(worktreeRoot)) {
        const error = new Error(`managed-worktree.workspace-exists: ${worktreeRoot}`);
        if (requestedName) throw error;
        lastCollision = error;
        continue;
      }

      await mkdir(managedRoot, { recursive: true });
      const addResult = await runGit(repoRoot, [
        "worktree",
        "add",
        "--no-track",
        "-b",
        branchName,
        worktreeRoot,
        baseRef,
      ]);
      ensureCommandSucceeded("git worktree add", addResult);

      const baseCommitResult = await runGit(worktreeRoot, ["rev-parse", "HEAD"]);
      const baseCommit = baseCommitResult.stdout.trim();
      if (baseCommitResult.exitCode !== 0 || !GIT_COMMIT_SHA_PATTERN.test(baseCommit)) {
        await rollbackCreatedWorktree(repoRoot, worktreeRoot, branchName);
        throw new Error(`managed-worktree.base-commit-failed: ${baseRef}`);
      }

      const workspacePath = toWorktreeWorkspacePath(worktreeRoot, resolution.workspaceInRepoPath);
      try {
        const workspaceStat = await stat(workspacePath);
        if (!workspaceStat.isDirectory()) throw new Error("not a directory");
      } catch {
        // 子目录在当前 base ref 中不存在（未提交/未推送）时，任务 cwd 无法执行；
        // 提前回滚并给出明确原因，避免留下一个无法运行任务的 worktree。
        await rollbackCreatedWorktree(repoRoot, worktreeRoot, branchName);
        throw new Error(`managed-worktree.workspace-missing: ${workspacePath}`);
      }

      try {
        await ensureExcludeEntry(commonDir);
        // 把创建起点固化到受管分支配置；删除只认这里的 commit，避免默认分支
        // 解析失败（detached HEAD / 分支改名）时把已提交内容当成干净工作区。
        await writeBaseCommit(repoRoot, branchName, baseCommit);
      } catch (error) {
        await rollbackCreatedWorktree(repoRoot, worktreeRoot, branchName);
        throw error;
      }

      return {
        name,
        path: worktreeRoot,
        workspacePath,
        branchName,
        sourceWorkspacePath: params.workspacePath,
        baseRef,
        baseCommit,
      };
    }

    throw lastCollision ?? new Error("managed-worktree.create-failed");
  }

  async function list(params: { workspacePath: string }): Promise<GitManagedWorktree[]> {
    const resolution = await resolveRepository(params.workspacePath);
    const repoRoot = resolution.repoRoot;
    const records = await listParsedWorktrees(repoRoot);
    const baseCommits = await Promise.all(
      records.map((record) =>
        record.branchName ? readBaseCommit(repoRoot, record.branchName) : Promise.resolve(null),
      ),
    );
    return records
      .map((record, index) => ({
        name: normalizeGitPath(relative(managedWorktreeRoot(repoRoot), record.path)),
        path: record.path,
        workspacePath: toWorktreeWorkspacePath(record.path, resolution.workspaceInRepoPath),
        branchName: record.branchName,
        sourceWorkspacePath: params.workspacePath,
        baseRef: null,
        baseCommit: baseCommits[index] ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async function remove(params: {
    worktreePath: string;
  }): Promise<GitManagedWorktreeRemovalResult> {
    const inspection = await inspect({ workspacePath: params.worktreePath });
    if (!inspection.isManaged || !inspection.worktreeRoot || !inspection.repoRoot) {
      return {
        ok: false,
        reason: "not-managed",
        message: "Workspace is not a registered managed worktree.",
        worktreePath: null,
        branchName: null,
        dirtyEntryCount: 0,
        commitCount: 0,
      };
    }

    const check = await checkRemoval({ worktreePath: inspection.worktreeRoot });
    if (!check.ok) {
      return {
        ok: false,
        reason: check.reason,
        message: check.message,
        worktreePath: inspection.worktreeRoot,
        branchName: inspection.branchName,
        dirtyEntryCount: check.dirtyEntryCount,
        commitCount: check.commitCount,
      };
    }

    const removeResult = await runGit(inspection.repoRoot, [
      "worktree",
      "remove",
      inspection.worktreeRoot,
    ]);
    if (removeResult.exitCode !== 0) {
      return {
        ok: false,
        reason: "remove-failed",
        message:
          removeResult.stderr.trim() || removeResult.stdout.trim() || "git worktree remove failed.",
        worktreePath: inspection.worktreeRoot,
        branchName: inspection.branchName,
        dirtyEntryCount: 0,
        commitCount: 0,
      };
    }

    if (inspection.branchName && inspection.branchName.startsWith(MANAGED_WORKTREE_BRANCH_PREFIX)) {
      const branchResult = await runGit(inspection.repoRoot, [
        "branch",
        "-D",
        inspection.branchName,
      ]);
      if (branchResult.exitCode !== 0) {
        return {
          ok: false,
          reason: "branch-delete-failed",
          message:
            branchResult.stderr.trim() ||
            branchResult.stdout.trim() ||
            `Failed to delete managed branch ${inspection.branchName}.`,
          worktreePath: inspection.worktreeRoot,
          branchName: inspection.branchName,
          dirtyEntryCount: 0,
          commitCount: 0,
        };
      }
    }

    return {
      ok: true,
      reason: null,
      message: null,
      worktreePath: inspection.worktreeRoot,
      branchName: inspection.branchName,
      dirtyEntryCount: 0,
      commitCount: 0,
    };
  }

  return {
    create,
    list,
    inspect,
    checkRemoval,
    remove,
    getCreatingCount: () => creatingCount,
    onCreatingCountChanged,
  };
}
