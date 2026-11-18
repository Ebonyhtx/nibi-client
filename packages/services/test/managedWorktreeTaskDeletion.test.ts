import type { NibiTaskMeta } from "@nibi/shared";
import { describe, expect, it, vi } from "vitest";
import { createNibiTaskServiceAdapter } from "#src/nibi-agent/nibiTaskServiceAdapter.js";
import type { INibiAgentService } from "#src/nibi-agent/nibiAgent.js";
import type { NibiTaskIndexSyncer } from "#src/nibi-agent/nibiTaskIndexSyncer.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { ManagedWorktreeCleanup } from "#src/git/managedWorktreeCleanup.js";

const cleanupTarget = {
  workspacePath: "/repo/.nibi/worktrees/feature/packages/app",
  taskId: "task-1",
};

const archivedMeta: NibiTaskMeta = {
  taskId: "task-1",
  traceId: "trace",
  title: "Task",
  workspacePath: cleanupTarget.workspacePath,
  createdAt: 1,
  updatedAt: 1,
  mode: "build",
};

function createAdapter(options?: {
  cleanup?: Partial<ManagedWorktreeCleanup>;
  archivedMeta?: NibiTaskMeta | null;
}) {
  const mutateSessionFacts = vi.fn(async () => archivedMeta);
  const emitWorkspaceTaskListChanged = vi.fn();
  const disposable = { dispose: vi.fn() };
  const taskIndexSyncer = {
    mutateSessionFacts,
    emitWorkspaceTaskListChanged,
    ensureSessionSubscription: vi.fn(),
    onSessionTerminalEvent: vi.fn(() => disposable),
    onSessionReadyEvent: vi.fn(() => disposable),
  } as unknown as NibiTaskIndexSyncer;
  const deleteArchivedTask = vi.fn(async () =>
    options?.archivedMeta === undefined ? archivedMeta : options.archivedMeta,
  );
  const taskIndexRepo = {
    deleteArchivedTask,
  } as unknown as TaskIndexRepo;
  const cleanup = {
    inspect: vi.fn(async () => null),
    assertNoUncommittedWork: vi.fn(async () => null),
    stopRuntime: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    discardDraft: vi.fn(async () => false),
    ...options?.cleanup,
  } satisfies ManagedWorktreeCleanup;
  const service = createNibiTaskServiceAdapter({
    nibiAgentService: {} as INibiAgentService,
    taskIndexRepo,
    taskIndexSyncer,
    managedWorktreeCleanup: cleanup,
  });

  return {
    service,
    cleanup,
    mutateSessionFacts,
    emitWorkspaceTaskListChanged,
    deleteArchivedTask,
  };
}

describe("managed worktree task deletion", () => {
  it("stops runtime before deleting and removes the worktree afterwards", async () => {
    const { service, cleanup, mutateSessionFacts } = createAdapter({
      cleanup: {
        assertNoUncommittedWork: vi.fn(async () => ({
          isManaged: true,
          worktreeRoot: "/repo/.nibi/worktrees/feature",
          repoRoot: "/repo",
          branchName: "worktree-feature",
        })),
      },
    });

    await service.deleteTask(cleanupTarget);

    expect(cleanup.assertNoUncommittedWork).toHaveBeenCalledWith(cleanupTarget);
    expect(cleanup.stopRuntime).toHaveBeenCalledWith(cleanupTarget);
    expect(cleanup.remove).toHaveBeenCalledWith(cleanupTarget);
    expect(mutateSessionFacts.mock.invocationCallOrder[0]).toBeGreaterThan(
      cleanup.stopRuntime.mock.invocationCallOrder[0]!,
    );
    expect(cleanup.remove.mock.invocationCallOrder[0]).toBeGreaterThan(
      mutateSessionFacts.mock.invocationCallOrder[0]!,
    );
  });

  it("aborts ordinary deletion when the worktree is dirty", async () => {
    const { service, cleanup, mutateSessionFacts } = createAdapter({
      cleanup: {
        assertNoUncommittedWork: vi.fn(async () => {
          throw new Error("Managed worktree has uncommitted changes (1 entries).");
        }),
      },
    });

    await expect(service.deleteTask(cleanupTarget)).rejects.toThrow(
      "Managed worktree has uncommitted changes",
    );
    expect(cleanup.stopRuntime).not.toHaveBeenCalled();
    expect(mutateSessionFacts).not.toHaveBeenCalled();
    expect(cleanup.remove).not.toHaveBeenCalled();
  });

  it("cleans archived deletions only after the archive guard and tombstone", async () => {
    const { service, cleanup, deleteArchivedTask, emitWorkspaceTaskListChanged } = createAdapter({
      cleanup: {
        assertNoUncommittedWork: vi.fn(async () => ({
          isManaged: true,
          worktreeRoot: "/repo/.nibi/worktrees/feature",
          repoRoot: "/repo",
          branchName: "worktree-feature",
        })),
      },
    });

    await expect(
      service.deleteArchivedTask({ workspacePath: cleanupTarget.workspacePath, taskId: "task-1" }),
    ).resolves.toBe(true);

    expect(deleteArchivedTask).toHaveBeenCalled();
    expect(cleanup.stopRuntime).toHaveBeenCalled();
    expect(cleanup.remove).toHaveBeenCalled();
    expect(emitWorkspaceTaskListChanged).toHaveBeenCalled();
  });

  it("marks dirty batch entries failed without tombstoning them", async () => {
    const { service, cleanup, deleteArchivedTask } = createAdapter({
      cleanup: {
        assertNoUncommittedWork: vi.fn(async ({ taskId }) => {
          if (taskId === "dirty") {
            throw new Error("Managed worktree has uncommitted changes (1 entries).");
          }
          return {
            isManaged: true,
            worktreeRoot: "/repo/.nibi/worktrees/clean",
            repoRoot: "/repo",
            branchName: "worktree-clean",
          };
        }),
      },
    });

    const result = await service.deleteArchivedTasks({
      workspacePath: cleanupTarget.workspacePath,
      taskIds: ["clean", "dirty"],
    });

    expect(result.deletedTaskIds).toEqual(["clean"]);
    expect(result.failedTaskIds).toEqual(["dirty"]);
    expect(deleteArchivedTask).toHaveBeenCalledTimes(1);
    expect(cleanup.remove).toHaveBeenCalledTimes(1);
  });
});
