import type { NibiAgentWorkspaceTarget } from "#src/nibi-agent/nibiAgent.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  isManagedWorktreePathCandidate,
  type ManagedWorktreeInspection,
  type ManagedWorktreeManager,
} from "./managedWorktree.js";

const log = createServiceLogger("managed-worktree-cleanup");

export interface ManagedWorktreeCleanupTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface ManagedWorktreeCleanup {
  /**
   * 仅在路径形似受管 worktree 时才访问 Git；普通任务路径不会增加删除链路的
   * `git rev-parse` / `worktree list` 开销。
   */
  inspect(target: ManagedWorktreeCleanupTarget): Promise<ManagedWorktreeInspection | null>;
  /** 脏工作区或新提交会抛错，调用方必须在删除任务前中止。 */
  assertNoUncommittedWork(
    target: ManagedWorktreeCleanupTarget,
  ): Promise<ManagedWorktreeInspection | null>;
  stopRuntime(target: ManagedWorktreeCleanupTarget): Promise<void>;
  /** 移除失败必须抛错；不能静默留下 worktree。 */
  remove(target: ManagedWorktreeCleanupTarget): Promise<void>;
  /**
   * 草稿占位行回收：失败只记录，不阻塞占位行清理。返回是否真正移除了 worktree。
   * 脏工作区会保留并记录 error，避免静默丢用户改动。
   */
  discardDraft(target: ManagedWorktreeCleanupTarget): Promise<boolean>;
}

export function createManagedWorktreeCleanup(options: {
  manager: ManagedWorktreeManager;
  disposeWorkspace?: (target: NibiAgentWorkspaceTarget) => Promise<void>;
}): ManagedWorktreeCleanup {
  async function inspect(
    target: ManagedWorktreeCleanupTarget,
  ): Promise<ManagedWorktreeInspection | null> {
    if (target.workspaceIdentity?.trim()) return null;
    if (!isManagedWorktreePathCandidate(target.workspacePath)) return null;
    const inspection = await options.manager.inspect({ workspacePath: target.workspacePath });
    return inspection.isManaged ? inspection : null;
  }

  async function assertNoUncommittedWork(
    target: ManagedWorktreeCleanupTarget,
  ): Promise<ManagedWorktreeInspection | null> {
    const inspection = await inspect(target);
    if (!inspection?.worktreeRoot) return null;
    const check = await options.manager.checkRemoval({
      worktreePath: inspection.worktreeRoot,
    });
    if (!check.ok) {
      throw new Error(check.message ?? "Managed worktree is not removable.");
    }
    return inspection;
  }

  async function stopRuntime(target: ManagedWorktreeCleanupTarget): Promise<void> {
    if (!options.disposeWorkspace) return;
    await options.disposeWorkspace({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
    });
  }

  async function remove(target: ManagedWorktreeCleanupTarget): Promise<void> {
    const inspection = await inspect(target);
    if (!inspection?.worktreeRoot) return;
    const result = await options.manager.remove({ worktreePath: inspection.worktreeRoot });
    if (!result.ok) {
      throw new Error(result.message ?? "Managed worktree removal failed.");
    }
    log.info(undefined, "managed worktree removed", {
      workspacePath: target.workspacePath,
      worktreePath: inspection.worktreeRoot,
    });
  }

  async function discardDraft(target: ManagedWorktreeCleanupTarget): Promise<boolean> {
    try {
      const inspection = await inspect(target);
      if (!inspection?.worktreeRoot) return false;
      const check = await options.manager.checkRemoval({
        worktreePath: inspection.worktreeRoot,
      });
      if (!check.ok) {
        log.error(undefined, "保留草稿 worktree：仍有未提交内容", {
          workspacePath: target.workspacePath,
          worktreePath: inspection.worktreeRoot,
          reason: check.reason,
          message: check.message,
        });
        return false;
      }
      await stopRuntime(target);
      const result = await options.manager.remove({ worktreePath: inspection.worktreeRoot });
      if (!result.ok) {
        // renderer 侧关闭 tab 的清理可能已先一步移除；这不是失败，也不再留 worktree。
        if (result.reason === "not-managed") return false;
        log.error(undefined, "草稿 worktree 清理失败", {
          workspacePath: target.workspacePath,
          worktreePath: inspection.worktreeRoot,
          reason: result.reason,
          message: result.message,
        });
        return false;
      }
      return true;
    } catch (error) {
      log.error(undefined, "草稿 worktree 清理异常", {
        workspacePath: target.workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  return { inspect, assertNoUncommittedWork, stopRuntime, remove, discardDraft };
}
