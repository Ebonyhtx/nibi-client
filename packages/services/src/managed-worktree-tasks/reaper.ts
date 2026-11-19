// Host 启动期的受管 worktree 孤儿回收。
// 崩溃可能留下两类残留：
// 1. git 仍登记、但目录已被手动删除 —— 交给 `git worktree prune`。
// 2. bucket 目录里存在 git 未登记、也没有任务引用的 worktree —— 只能由 Host 删除。
// 回收必须保守：只处理受管根目录内、源仓库属于已知本地项目、且没有任何任务行/创建记录引用的目录；
// 无法确认来源的目录保留给管理弹窗，绝不删除用户自建 worktree。
import { readdir, readFile, realpath, rm, rmdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ProjectTaskRepositoryContract } from "#src/project-storage/contract.js";
import {
  isManagedWorktreeBucket,
  isSamePath,
  parseManagedWorktreePath,
  resolveManagedWorktreeRoot,
} from "@nibi/shared/managed-worktree";
import type { GitWorktreeRepo } from "#src/git/managed-worktree/contract.js";

export interface OrphanWorktreeReaperDeps {
  git: GitWorktreeRepo;
  repository(): Promise<
    Pick<ProjectTaskRepositoryContract, "readTree" | "listTasksByWorktree">
  >;
  dataBaseDir(): string;
  /** 本进程内正在创建的 worktree 根目录；回收必须跳过它们。 */
  isCreatingAt?(worktreeRoot: string): boolean;
}

export interface OrphanWorktreeReaperResult {
  /** 已删除的未登记残留目录。 */
  removed: string[];
  /** 已执行 `git worktree prune` 的源仓库。 */
  pruned: string[];
  /** 无法确认来源、保留现场的目录。 */
  skipped: string[];
}

const GIT_POINTER_PREFIX = "gitdir:";

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function realpathOr(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** 从 worktree 的 `.git` 指针解析源仓库 toplevel；失败返回 null。 */
async function resolveSourceRootFromCheckout(worktreeRoot: string): Promise<string | null> {
  try {
    const content = await readFile(join(worktreeRoot, ".git"), "utf8");
    const line = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (!line.startsWith(GIT_POINTER_PREFIX)) return null;
    const value = line.slice(GIT_POINTER_PREFIX.length).trim();
    if (!value) return null;
    const adminDir = await realpath(isAbsolute(value) ? value : resolve(worktreeRoot, value));
    const common = dirname(dirname(adminDir));
    // <common>/worktrees/<id> → common 必须是 <sourceRoot>/.git。
    const sourceRoot = dirname(common);
    const sourceDotGit = join(sourceRoot, ".git");
    if (!(await pathExists(sourceDotGit))) return null;
    return sourceRoot;
  } catch {
    return null;
  }
}

export async function reapOrphanedWorktrees(
  deps: OrphanWorktreeReaperDeps,
): Promise<OrphanWorktreeReaperResult> {
  const result: OrphanWorktreeReaperResult = { removed: [], pruned: [], skipped: [] };
  const managedRoot = resolveManagedWorktreeRoot(deps.dataBaseDir());
  if (!(await pathExists(managedRoot))) return result;

  const tree = (await deps.repository()).readTree({ includeTasks: false });
  const sourceRoots = [
    ...new Set(tree.projects.filter((project) => !project.deleted).flatMap((project) => project.roots.map((root) => root.rootPath))),
  ];
  const knownSourceRoots: string[] = [];
  const registered = new Map<string, string>();
  for (const rootPath of sourceRoots) {
    const listed = await deps.git.list({ sourcePath: rootPath }).catch(() => null);
    const listedSourceRoot = listed?.sourceRoot;
    if (!listedSourceRoot) continue;
    knownSourceRoots.push(await realpathOr(listedSourceRoot));
    for (const worktree of listed.worktrees) {
      if (worktree.state === "missing") {
        if (!result.pruned.some((root) => isSamePath(root, listedSourceRoot))) {
          await deps.git.prune({ sourcePath: listedSourceRoot }).catch(() => undefined);
          result.pruned.push(listedSourceRoot);
        }
        continue;
      }
      registered.set(worktree.path, listedSourceRoot);
    }
  }
  if (registered.size === 0 && knownSourceRoots.length === 0) return result;

  const realManagedRoot = await realpathOr(managedRoot);
  const buckets = await readdir(managedRoot, { withFileTypes: true }).catch(() => []);
  for (const bucketEntry of buckets) {
    if (!bucketEntry.isDirectory() || !isManagedWorktreeBucket(bucketEntry.name)) continue;
    const bucketDir = join(managedRoot, bucketEntry.name);
    const entries = await readdir(bucketDir, { withFileTypes: true }).catch(() => []);
    if (entries.length === 0) {
      // bucket 只在检出前被原子占用；启动时仍为空说明上次进程在 add 前崩溃。
      await rmdir(bucketDir).catch(() => undefined);
      continue;
    }
    let removedInBucket = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(bucketDir, entry.name);
      if ([...registered.keys()].some((path) => isSamePath(path, candidate))) continue;
      if (deps.isCreatingAt?.(candidate)) continue;
      const parts = parseManagedWorktreePath(realManagedRoot, await realpathOr(candidate));
      if (!parts || parts.relativePath !== "") continue;
      const repository = await deps.repository();
      if (repository.listTasksByWorktree({ worktreeRoot: parts.worktreeRoot }).length > 0) continue;
      const sourceRoot = await resolveSourceRootFromCheckout(parts.worktreeRoot);
      if (!sourceRoot) {
        // 无法确认来源：保留现场，交给管理弹窗。
        result.skipped.push(parts.worktreeRoot);
        continue;
      }
      const knownSource = sourceRoot;
      if (!knownSourceRoots.some((root) => isSamePath(root, knownSource))) {
        result.skipped.push(parts.worktreeRoot);
        continue;
      }
      await rm(parts.worktreeRoot, { recursive: true, force: true });
      result.removed.push(parts.worktreeRoot);
      removedInBucket = true;
    }
    if (removedInBucket) {
      await rmdir(bucketDir).catch(() => undefined);
    }
  }
  return result;
}