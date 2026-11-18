import { describe, expect, it, vi } from "vitest";
import { createManagedWorktreeCleanup } from "../src/git/managedWorktreeCleanup.js";
import type { ManagedWorktreeManager } from "../src/git/managedWorktree.js";

const managedRoot = "/repo/.nibi/worktrees/feature";
const managedWorkspace = `${managedRoot}/packages/app`;

function createManager(overrides?: Partial<ManagedWorktreeManager>): ManagedWorktreeManager {
  const unexpected = (name: keyof ManagedWorktreeManager) =>
    vi.fn(async () => {
      throw new Error(`Unexpected managed worktree call: ${name}`);
    });
  return {
    create: unexpected("create"),
    list: unexpected("list"),
    inspect: vi.fn(async () => ({
      isManaged: false,
      worktreeRoot: null,
      repoRoot: null,
      branchName: null,
    })),
    checkRemoval: unexpected("checkRemoval"),
    remove: unexpected("remove"),
    ...overrides,
  };
}

describe("managed worktree cleanup", () => {
  it("skips remote identities and ordinary paths without calling Git", async () => {
    const manager = createManager();
    const cleanup = createManagedWorktreeCleanup({ manager });

    await expect(
      cleanup.inspect({
        workspacePath: managedWorkspace,
        workspaceIdentity: "remote:server:s:/repo",
      }),
    ).resolves.toBeNull();
    await expect(cleanup.inspect({ workspacePath: "/repo/packages/app" })).resolves.toBeNull();
    expect(manager.inspect).not.toHaveBeenCalled();
  });

  it("throws before stopping runtime when the worktree is dirty", async () => {
    const manager = createManager({
      inspect: vi.fn(async () => ({
        isManaged: true,
        worktreeRoot: managedRoot,
        repoRoot: "/repo",
        branchName: "worktree-feature",
      })),
      checkRemoval: vi.fn(async () => ({
        ok: false,
        reason: "dirty" as const,
        message: "Managed worktree has uncommitted changes (2 entries).",
        dirtyEntryCount: 2,
        commitCount: 0,
      })),
    });
    const disposeWorkspace = vi.fn(async () => {});
    const cleanup = createManagedWorktreeCleanup({ manager, disposeWorkspace });

    await expect(
      cleanup.assertNoUncommittedWork({ workspacePath: managedWorkspace }),
    ).rejects.toThrow("Managed worktree has uncommitted changes (2 entries).");
    expect(disposeWorkspace).not.toHaveBeenCalled();
  });

  it("stops runtime and removes only clean managed worktrees", async () => {
    const manager = createManager({
      inspect: vi.fn(async () => ({
        isManaged: true,
        worktreeRoot: managedRoot,
        repoRoot: "/repo",
        branchName: "worktree-feature",
      })),
      checkRemoval: vi.fn(async () => ({
        ok: true,
        reason: null,
        message: null,
        dirtyEntryCount: 0,
        commitCount: 0,
      })),
      remove: vi.fn(async () => ({
        ok: true,
        reason: null,
        message: null,
        worktreePath: managedRoot,
        branchName: "worktree-feature",
        dirtyEntryCount: 0,
        commitCount: 0,
      })),
    });
    const disposeWorkspace = vi.fn(async () => {});
    const cleanup = createManagedWorktreeCleanup({ manager, disposeWorkspace });

    const inspection = await cleanup.assertNoUncommittedWork({
      workspacePath: managedWorkspace,
    });
    expect(inspection?.isManaged).toBe(true);
    await cleanup.stopRuntime({ workspacePath: managedWorkspace });
    await cleanup.remove({ workspacePath: managedWorkspace });

    expect(disposeWorkspace).toHaveBeenCalledWith({ workspacePath: managedWorkspace });
    expect(manager.remove).toHaveBeenCalledWith({ worktreePath: managedRoot });
  });

  it("surfaces removal failures instead of silently leaving a worktree", async () => {
    const manager = createManager({
      inspect: vi.fn(async () => ({
        isManaged: true,
        worktreeRoot: managedRoot,
        repoRoot: "/repo",
        branchName: "worktree-feature",
      })),
      remove: vi.fn(async () => ({
        ok: false,
        reason: "remove-failed" as const,
        message: "locked by running process",
        worktreePath: managedRoot,
        branchName: "worktree-feature",
        dirtyEntryCount: 0,
        commitCount: 0,
      })),
    });
    const cleanup = createManagedWorktreeCleanup({ manager });

    await expect(cleanup.remove({ workspacePath: managedWorkspace })).rejects.toThrow(
      "locked by running process",
    );
  });

  it("draft discard keeps dirty worktrees and removes clean ones", async () => {
    const inspect = vi.fn(async () => ({
      isManaged: true,
      worktreeRoot: managedRoot,
      repoRoot: "/repo",
      branchName: "worktree-feature",
    }));
    const remove = vi.fn(async () => ({
      ok: true,
      reason: null,
      message: null,
      worktreePath: managedRoot,
      branchName: "worktree-feature",
      dirtyEntryCount: 0,
      commitCount: 0,
    }));
    const manager = createManager({
      inspect,
      checkRemoval: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          reason: "dirty",
          message: "dirty",
          dirtyEntryCount: 1,
          commitCount: 0,
        })
        .mockResolvedValueOnce({
          ok: true,
          reason: null,
          message: null,
          dirtyEntryCount: 0,
          commitCount: 0,
        }),
      remove,
    });
    const cleanup = createManagedWorktreeCleanup({ manager });

    await expect(cleanup.discardDraft({ workspacePath: managedWorkspace })).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
    await expect(cleanup.discardDraft({ workspacePath: managedWorkspace })).resolves.toBe(true);
    expect(remove).toHaveBeenCalledWith({ worktreePath: managedRoot });
  });
});
