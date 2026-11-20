import { afterEach, expect, it, vi } from "vitest";
import type { GitManagedWorktree, GitManagedWorktreeRemovalResult } from "@nibi/shared";
import {
  createManagedWorktreeDraftRegistry,
  discardManagedWorktreeDraft,
  forgetManagedWorktreeDraft,
  forgetMaterializedManagedWorktreeDrafts,
  MANAGED_WORKTREE_DRAFTS_STORAGE_KEY,
  MANAGED_WORKTREE_PENDING_COMMANDS_STORAGE_KEY,
  markManagedWorktreeDraftPromotionPending,
  observeManagedWorktreeDraftAbandonment,
  readManagedWorktreeDraft,
  rememberManagedWorktreeDraft,
  syncManagedWorktreeDraftPromotionState,
  type ManagedWorktreeDraft,
  type ManagedWorktreeTabCloseEvent,
} from "@/root/managedWorktreeTask.js";

const worktree: GitManagedWorktree = {
  name: "feature",
  path: "/repo/.nibi/worktrees/feature",
  workspacePath: "/repo/.nibi/worktrees/feature/packages/app",
  branchName: "worktree-feature",
  sourceWorkspacePath: "/repo/packages/app",
  baseRef: "origin/main",
  baseCommit: "0123456789012345678901234567890123456789",
};

const removed: GitManagedWorktreeRemovalResult = {
  ok: true,
  reason: null,
  message: null,
  worktreePath: worktree.path,
  branchName: worktree.branchName,
  dirtyEntryCount: 0,
  commitCount: 0,
};

function createMemoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

const draftRecord: ManagedWorktreeDraft = {
  workspacePath: worktree.workspacePath,
  worktreePath: worktree.path,
  sourceWorkspacePath: worktree.sourceWorkspacePath,
  projectId: "project-1",
};

afterEach(() => {
  forgetManagedWorktreeDraft(worktree.workspacePath);
});

function rememberDraft(): void {
  rememberManagedWorktreeDraft(draftRecord);
}

it("removes an abandoned worktree draft even when no placeholder session ever existed", async () => {
  rememberDraft();
  const removeManagedWorktree = vi.fn(async () => removed);
  const onError = vi.fn();

  await expect(
    discardManagedWorktreeDraft({
      gitService: { removeManagedWorktree },
      workspacePath: worktree.workspacePath,
      hasMaterializedTask: false,
      onError,
    }),
  ).resolves.toEqual({ action: "removed", reason: null });

  expect(removeManagedWorktree).toHaveBeenCalledWith({ worktreePath: worktree.path });
  expect(readManagedWorktreeDraft(worktree.workspacePath)).toBeUndefined();
  expect(onError).not.toHaveBeenCalled();
});

it("keeps a dirty worktree draft and reports why cleanup failed", async () => {
  rememberDraft();
  const removeManagedWorktree = vi.fn(async () => ({
    ...removed,
    ok: false,
    reason: "dirty" as const,
    message: "Managed worktree has uncommitted changes (1 entries).",
  }));
  const onError = vi.fn();

  await expect(
    discardManagedWorktreeDraft({
      gitService: { removeManagedWorktree },
      workspacePath: worktree.workspacePath,
      hasMaterializedTask: false,
      onError,
    }),
  ).resolves.toEqual({ action: "kept", reason: "dirty" });

  expect(removeManagedWorktree).toHaveBeenCalledWith({ worktreePath: worktree.path });
  expect(onError).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Managed worktree has uncommitted changes (1 entries)." }),
  );
});

it("treats an already removed worktree as cleaned", async () => {
  rememberDraft();
  const removeManagedWorktree = vi.fn(async () => ({
    ...removed,
    ok: false,
    reason: "not-managed" as const,
    message: "Workspace is not a registered managed worktree.",
    worktreePath: null,
  }));
  const onError = vi.fn();

  await expect(
    discardManagedWorktreeDraft({
      gitService: { removeManagedWorktree },
      workspacePath: worktree.workspacePath,
      hasMaterializedTask: false,
      onError,
    }),
  ).resolves.toEqual({ action: "removed", reason: null });
  expect(onError).not.toHaveBeenCalled();
});

it("never removes a worktree that already materialized into a task", async () => {
  rememberDraft();
  const removeManagedWorktree = vi.fn(async () => removed);

  await expect(
    discardManagedWorktreeDraft({
      gitService: { removeManagedWorktree },
      workspacePath: worktree.workspacePath,
      hasMaterializedTask: true,
    }),
  ).resolves.toEqual({ action: "skipped", reason: null });

  expect(removeManagedWorktree).not.toHaveBeenCalled();
  expect(readManagedWorktreeDraft(worktree.workspacePath)).toBeUndefined();
});

it("prunes draft registrations as soon as their workspace has an active task", () => {
  rememberDraft();
  rememberManagedWorktreeDraft({
    workspacePath: "/repo/.nibi/worktrees/other/packages/app",
    worktreePath: "/repo/.nibi/worktrees/other",
    sourceWorkspacePath: "/repo/packages/app",
    projectId: "project-2",
  });

  forgetMaterializedManagedWorktreeDrafts(
    (draft) => draft.workspacePath === worktree.workspacePath,
  );

  expect(readManagedWorktreeDraft(worktree.workspacePath)).toBeUndefined();
  expect(readManagedWorktreeDraft("/repo/.nibi/worktrees/other/packages/app")).toMatchObject({
    projectId: "project-2",
  });
  forgetManagedWorktreeDraft("/repo/.nibi/worktrees/other/packages/app");
});

it("persists drafts to per-window storage and restores them in a fresh registry", () => {
  const storage = createMemoryStorage();
  const first = createManagedWorktreeDraftRegistry({ storage });
  first.remember({ ...draftRecord, promotionPending: true });

  const raw = storage.getItem(MANAGED_WORKTREE_DRAFTS_STORAGE_KEY);
  expect(raw).not.toBeNull();
  expect(JSON.parse(raw!)).toMatchObject({
    version: 1,
    drafts: [expect.objectContaining({ ...draftRecord, promotionPending: true })],
  });

  const restored = createManagedWorktreeDraftRegistry({ storage });
  expect(restored.read(worktree.workspacePath)).toMatchObject({
    ...draftRecord,
    promotionPending: true,
  });

  restored.forget(worktree.workspacePath);
  expect(storage.getItem(MANAGED_WORKTREE_DRAFTS_STORAGE_KEY)).toBeNull();
});

it("keeps window registries isolated by their own storage", () => {
  const storageA = createMemoryStorage();
  const storageB = createMemoryStorage();
  const windowA = createManagedWorktreeDraftRegistry({ storage: storageA });
  const windowB = createManagedWorktreeDraftRegistry({ storage: storageB });

  windowA.remember(draftRecord);

  expect(windowA.read(worktree.workspacePath)).toMatchObject(draftRecord);
  expect(windowB.read(worktree.workspacePath)).toBeUndefined();
  expect(
    createManagedWorktreeDraftRegistry({ storage: storageB }).read(worktree.workspacePath),
  ).toBeUndefined();
});

it("ignores and clears corrupted or old-format draft storage", () => {
  const corruptedValues = [
    "{not-json",
    JSON.stringify({ version: 0, drafts: [draftRecord] }),
    JSON.stringify({ version: 1, drafts: "invalid" }),
    JSON.stringify({ drafts: [draftRecord] }),
  ];
  for (const raw of corruptedValues) {
    const storage = createMemoryStorage({ [MANAGED_WORKTREE_DRAFTS_STORAGE_KEY]: raw });
    const registry = createManagedWorktreeDraftRegistry({ storage });
    expect(registry.size).toBe(0);
    expect(storage.getItem(MANAGED_WORKTREE_DRAFTS_STORAGE_KEY)).toBeNull();
  }
});

it("drops invalid entries but still restores valid drafts", () => {
  const storage = createMemoryStorage({
    [MANAGED_WORKTREE_DRAFTS_STORAGE_KEY]: JSON.stringify({
      version: 1,
      drafts: [draftRecord, { workspacePath: 1 }],
    }),
  });
  const registry = createManagedWorktreeDraftRegistry({ storage });

  expect(registry.list()).toEqual([draftRecord]);
  expect(JSON.parse(storage.getItem(MANAGED_WORKTREE_DRAFTS_STORAGE_KEY)!).drafts).toHaveLength(1);
});

it("uses promotionPending to keep the worktree when its tab closes after send", async () => {
  rememberDraft();
  markManagedWorktreeDraftPromotionPending(worktree.workspacePath);
  const removeManagedWorktree = vi.fn(async () => removed);
  const onError = vi.fn();

  await expect(
    discardManagedWorktreeDraft({
      gitService: { removeManagedWorktree },
      workspacePath: worktree.workspacePath,
      hasMaterializedTask: false,
      onError,
    }),
  ).resolves.toEqual({ action: "skipped", reason: null });

  expect(removeManagedWorktree).not.toHaveBeenCalled();
  expect(readManagedWorktreeDraft(worktree.workspacePath)).toMatchObject({
    promotionPending: true,
  });
  expect(onError).not.toHaveBeenCalled();
});

it("marks promotionPending as soon as the pending command ledger records a send", () => {
  rememberDraft();
  const pendingStorage = createMemoryStorage({
    [MANAGED_WORKTREE_PENDING_COMMANDS_STORAGE_KEY]: JSON.stringify([
      {
        replay: { kind: "input", type: "sendText" },
        clientContext: { workspace: { workspacePath: worktree.workspacePath } },
      },
    ]),
  });

  syncManagedWorktreeDraftPromotionState(pendingStorage);

  expect(readManagedWorktreeDraft(worktree.workspacePath)).toMatchObject({
    promotionPending: true,
  });
});

it("does not clean a worktree when the tab closes immediately after send", async () => {
  rememberDraft();
  syncManagedWorktreeDraftPromotionState(
    createMemoryStorage({
      [MANAGED_WORKTREE_PENDING_COMMANDS_STORAGE_KEY]: JSON.stringify([
        {
          replay: { kind: "input", type: "sendText" },
          clientContext: { workspace: { workspacePath: worktree.workspacePath } },
        },
      ]),
    }),
  );
  const removeManagedWorktree = vi.fn(async () => removed);
  const tabEvents = createTabEventStore();
  const unsubscribe = observeManagedWorktreeDraftAbandonment({
    tabStoreApi: tabEvents.tabStoreApi,
    getActiveTaskId: () => null,
    gitService: { removeManagedWorktree },
  });

  tabEvents.emit({ sequence: 1, workspacePath: worktree.workspacePath, origin: "user-close" });
  await Promise.resolve();

  expect(removeManagedWorktree).not.toHaveBeenCalled();
  expect(readManagedWorktreeDraft(worktree.workspacePath)).toMatchObject({
    promotionPending: true,
  });
  unsubscribe();
});

it("unregisters a promotionPending draft once the task materializes", () => {
  rememberDraft();
  markManagedWorktreeDraftPromotionPending(worktree.workspacePath);

  forgetMaterializedManagedWorktreeDrafts(() => true);

  expect(readManagedWorktreeDraft(worktree.workspacePath)).toBeUndefined();
});

function createTabEventStore() {
  let listener:
    | ((state: { lastClosedWorkspaceTabEvent: ManagedWorktreeTabCloseEvent | null }) => void)
    | undefined;
  let state: { lastClosedWorkspaceTabEvent: ManagedWorktreeTabCloseEvent | null } = {
    lastClosedWorkspaceTabEvent: null,
  };
  return {
    tabStoreApi: {
      getState: () => state,
      subscribe: (
        next: (state: { lastClosedWorkspaceTabEvent: ManagedWorktreeTabCloseEvent | null }) => void,
      ) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    },
    emit(event: ManagedWorktreeTabCloseEvent): void {
      state = { lastClosedWorkspaceTabEvent: event };
      listener?.(state);
    },
  };
}

it("cleans an abandoned worktree draft when its tab is explicitly closed", async () => {
  rememberDraft();
  const removeManagedWorktree = vi.fn(async () => removed);
  const tabEvents = createTabEventStore();
  const unsubscribe = observeManagedWorktreeDraftAbandonment({
    tabStoreApi: tabEvents.tabStoreApi,
    getActiveTaskId: () => null,
    gitService: { removeManagedWorktree },
  });

  tabEvents.emit({ sequence: 1, workspacePath: worktree.workspacePath, origin: "user-close" });

  await vi.waitFor(() => {
    expect(removeManagedWorktree).toHaveBeenCalledWith({ worktreePath: worktree.path });
  });
  expect(readManagedWorktreeDraft(worktree.workspacePath)).toBeUndefined();
  unsubscribe();
});

it("ignores restore closes but forgets a worktree tab whose workspace has a task", () => {
  rememberDraft();
  const removeManagedWorktree = vi.fn(async () => removed);
  const restoreEvents = createTabEventStore();
  const unsubscribeRestore = observeManagedWorktreeDraftAbandonment({
    tabStoreApi: restoreEvents.tabStoreApi,
    getActiveTaskId: () => null,
    gitService: { removeManagedWorktree },
  });

  restoreEvents.emit({ sequence: 1, workspacePath: worktree.workspacePath, origin: "restore" });
  expect(removeManagedWorktree).not.toHaveBeenCalled();
  expect(readManagedWorktreeDraft(worktree.workspacePath)).toBeDefined();
  unsubscribeRestore();

  const materializedEvents = createTabEventStore();
  const unsubscribeMaterialized = observeManagedWorktreeDraftAbandonment({
    tabStoreApi: materializedEvents.tabStoreApi,
    getActiveTaskId: () => "task-1",
    gitService: { removeManagedWorktree },
  });
  materializedEvents.emit({
    sequence: 1,
    workspacePath: worktree.workspacePath,
    origin: "user-close",
  });

  expect(removeManagedWorktree).not.toHaveBeenCalled();
  expect(readManagedWorktreeDraft(worktree.workspacePath)).toBeUndefined();
  unsubscribeMaterialized();
});
