import type { GitManagedWorktreeRemovalReason } from "@nibi/shared";
import type { IGitService } from "@nibi/services";

export interface ManagedWorktreeTaskGit {
  removeManagedWorktree: IGitService["removeManagedWorktree"];
}

/** 已创建、尚未物化成任务的受管 worktree 草稿。 */
export interface ManagedWorktreeDraft {
  workspacePath: string;
  workspaceIdentity?: string;
  worktreePath: string;
  sourceWorkspacePath: string;
  projectId: string;
  /** 首发 send 已发出；关闭 tab 时不得按草稿清理。 */
  promotionPending?: boolean;
}

export interface ManagedWorktreeDraftDiscardResult {
  action: "skipped" | "removed" | "kept";
  reason: GitManagedWorktreeRemovalReason | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const MANAGED_WORKTREE_DRAFTS_STORAGE_KEY = "nibi-managed-worktree-drafts:v1";
/**
 * 与 `pendingCommandRegistry` 的持久化键保持一致；这里只读扫描，
 * 用于在 send 已发出、activeTaskId 尚未落地时把草稿标记为 promotionPending。
 */
export const MANAGED_WORKTREE_PENDING_COMMANDS_STORAGE_KEY = "nibi-v4-pending-commands:v1";
const STORAGE_VERSION = 1;

function browserSessionStorage(): StorageLike | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function browserLocalStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function managedWorktreeDraftKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

function isValidStoredDraft(value: unknown): value is ManagedWorktreeDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.workspacePath === "string" &&
    draft.workspacePath.length > 0 &&
    typeof draft.worktreePath === "string" &&
    draft.worktreePath.length > 0 &&
    typeof draft.sourceWorkspacePath === "string" &&
    draft.sourceWorkspacePath.length > 0 &&
    typeof draft.projectId === "string" &&
    draft.projectId.length > 0 &&
    (draft.workspaceIdentity === undefined || typeof draft.workspaceIdentity === "string") &&
    (draft.promotionPending === undefined || typeof draft.promotionPending === "boolean")
  );
}

function isStoredDraftEnvelope(value: unknown): value is { version: number; drafts: unknown[] } {
  if (!value || typeof value !== "object") return false;
  const envelope = value as { version?: unknown; drafts?: unknown };
  return envelope.version === STORAGE_VERSION && Array.isArray(envelope.drafts);
}

function normalizeDraft(draft: ManagedWorktreeDraft): ManagedWorktreeDraft {
  return {
    workspacePath: draft.workspacePath,
    ...(draft.workspaceIdentity !== undefined
      ? { workspaceIdentity: draft.workspaceIdentity }
      : {}),
    worktreePath: draft.worktreePath,
    sourceWorkspacePath: draft.sourceWorkspacePath,
    projectId: draft.projectId,
    ...(draft.promotionPending ? { promotionPending: true } : {}),
  };
}

function isPendingInputCommand(value: unknown): value is {
  replay: { kind: "input"; type: string };
  clientContext?: {
    workspace?: { workspacePath?: unknown; workspaceIdentity?: unknown };
  };
} {
  if (!value || typeof value !== "object") return false;
  const entry = value as { replay?: { kind?: unknown; type?: unknown } };
  if (!entry.replay || entry.replay.kind !== "input") return false;
  return (
    entry.replay.type === "sendText" ||
    entry.replay.type === "sendGoalCommand" ||
    entry.replay.type === "compact" ||
    entry.replay.type === "createSession"
  );
}

export interface ManagedWorktreeDraftRegistry {
  readonly size: number;
  remember(draft: ManagedWorktreeDraft): void;
  read(workspacePath: string, workspaceIdentity?: string): ManagedWorktreeDraft | undefined;
  list(): ManagedWorktreeDraft[];
  forget(workspacePath: string, workspaceIdentity?: string): ManagedWorktreeDraft | undefined;
  prune(hasMaterializedTask: (draft: ManagedWorktreeDraft) => boolean): void;
  markPromotionPending(workspacePath: string, workspaceIdentity?: string): void;
  markPromotionPendingForPendingCommands(pendingCommands: readonly unknown[]): void;
  takeForDiscard(
    workspacePath: string,
    workspaceIdentity: string | undefined,
    hasMaterializedTask: boolean,
  ): { action: "cleanup"; draft: ManagedWorktreeDraft } | { action: "skipped" };
}

/**
 * per-window 草稿登记表：默认落在 sessionStorage（刷新存活、窗口关闭即清），
 * 不使用 localStorage 跨窗口共享。每次登记/注销都把完整快照写成一条记录。
 */
export function createManagedWorktreeDraftRegistry(options?: {
  storage?: StorageLike;
  storageKey?: string;
}): ManagedWorktreeDraftRegistry {
  const storage = options?.storage ?? browserSessionStorage();
  const storageKey = options?.storageKey ?? MANAGED_WORKTREE_DRAFTS_STORAGE_KEY;
  const drafts = new Map<string, ManagedWorktreeDraft>();

  const clearStorage = () => {
    if (!storage) return;
    try {
      storage.removeItem(storageKey);
    } catch {
      // 存储不可用时退化为内存表。
    }
  };

  const persist = () => {
    if (!storage) return;
    try {
      if (drafts.size === 0) {
        storage.removeItem(storageKey);
        return;
      }
      storage.setItem(
        storageKey,
        JSON.stringify({ version: STORAGE_VERSION, drafts: [...drafts.values()] }),
      );
    } catch {
      // 序列化/配额失败不能中断任务创建或删除；内存态仍保持完整。
    }
  };

  const load = () => {
    if (!storage) return;
    let raw: string | null;
    try {
      raw = storage.getItem(storageKey);
    } catch {
      return;
    }
    if (raw === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      clearStorage();
      return;
    }
    if (!isStoredDraftEnvelope(parsed)) {
      clearStorage();
      return;
    }
    let droppedInvalid = false;
    for (const value of parsed.drafts) {
      if (!isValidStoredDraft(value)) {
        droppedInvalid = true;
        continue;
      }
      drafts.set(
        managedWorktreeDraftKey(value.workspacePath, value.workspaceIdentity),
        normalizeDraft(value),
      );
    }
    if (droppedInvalid) persist();
  };

  load();

  return {
    get size() {
      return drafts.size;
    },

    remember(draft) {
      const key = managedWorktreeDraftKey(draft.workspacePath, draft.workspaceIdentity);
      const existing = drafts.get(key);
      const promotionPending = draft.promotionPending ?? existing?.promotionPending;
      drafts.set(
        key,
        normalizeDraft({
          ...draft,
          ...(promotionPending ? { promotionPending: true } : {}),
        }),
      );
      persist();
    },

    read(workspacePath, workspaceIdentity) {
      return drafts.get(managedWorktreeDraftKey(workspacePath, workspaceIdentity));
    },

    list() {
      return [...drafts.values()];
    },

    forget(workspacePath, workspaceIdentity) {
      const key = managedWorktreeDraftKey(workspacePath, workspaceIdentity);
      const draft = drafts.get(key);
      if (!draft) return undefined;
      drafts.delete(key);
      persist();
      return draft;
    },

    prune(hasMaterializedTask) {
      let changed = false;
      for (const [key, draft] of drafts) {
        if (!hasMaterializedTask(draft)) continue;
        drafts.delete(key);
        changed = true;
      }
      if (changed) persist();
    },

    markPromotionPending(workspacePath, workspaceIdentity) {
      const key = managedWorktreeDraftKey(workspacePath, workspaceIdentity);
      const draft = drafts.get(key);
      if (!draft || draft.promotionPending) return;
      drafts.set(key, { ...draft, promotionPending: true });
      persist();
    },

    markPromotionPendingForPendingCommands(pendingCommands) {
      if (drafts.size === 0) return;
      const pendingWorkspaceKeys = new Set<string>();
      for (const value of pendingCommands) {
        if (!isPendingInputCommand(value)) continue;
        const workspace = value.clientContext?.workspace;
        if (
          !workspace ||
          typeof workspace.workspacePath !== "string" ||
          workspace.workspacePath.length === 0
        ) {
          continue;
        }
        const workspaceIdentity =
          typeof workspace.workspaceIdentity === "string" ? workspace.workspaceIdentity : undefined;
        pendingWorkspaceKeys.add(
          managedWorktreeDraftKey(workspace.workspacePath, workspaceIdentity),
        );
      }
      if (pendingWorkspaceKeys.size === 0) return;

      let changed = false;
      for (const [key, draft] of drafts) {
        if (draft.promotionPending || !pendingWorkspaceKeys.has(key)) continue;
        drafts.set(key, { ...draft, promotionPending: true });
        changed = true;
      }
      if (changed) persist();
    },

    takeForDiscard(workspacePath, workspaceIdentity, hasMaterializedTask) {
      const key = managedWorktreeDraftKey(workspacePath, workspaceIdentity);
      const draft = drafts.get(key);
      if (!draft) return { action: "skipped" };
      if (hasMaterializedTask) {
        // 已物化成任务：注销登记，清理责任交给任务删除链。
        drafts.delete(key);
        persist();
        return { action: "skipped" };
      }
      if (draft.promotionPending) {
        // send 已发出，activeTaskId 可能还没落地；保留登记，等物化后由 prune 注销。
        return { action: "skipped" };
      }
      drafts.delete(key);
      persist();
      return { action: "cleanup", draft };
    },
  };
}

const defaultRegistry = createManagedWorktreeDraftRegistry();

export function rememberManagedWorktreeDraft(draft: ManagedWorktreeDraft): void {
  defaultRegistry.remember(draft);
}

export function readManagedWorktreeDraft(
  workspacePath: string,
  workspaceIdentity?: string,
): ManagedWorktreeDraft | undefined {
  return defaultRegistry.read(workspacePath, workspaceIdentity);
}

export function forgetManagedWorktreeDraft(
  workspacePath: string,
  workspaceIdentity?: string,
): ManagedWorktreeDraft | undefined {
  return defaultRegistry.forget(workspacePath, workspaceIdentity);
}

export function forgetMaterializedManagedWorktreeDrafts(
  hasMaterializedTask: (draft: ManagedWorktreeDraft) => boolean,
): void {
  defaultRegistry.prune(hasMaterializedTask);
}

export function markManagedWorktreeDraftPromotionPending(
  workspacePath: string,
  workspaceIdentity?: string,
): void {
  defaultRegistry.markPromotionPending(workspacePath, workspaceIdentity);
}

/**
 * 从 pending command 账本识别已经发出的首发 send。调用点在
 * pendingCommandRegistry 变更和 tab 关闭前，因此 send 后立即关 tab 也能拦住清理。
 */
export function syncManagedWorktreeDraftPromotionState(
  storage: StorageLike | undefined = browserLocalStorage(),
): void {
  if (!storage || defaultRegistry.size === 0) return;
  let raw: string | null;
  try {
    raw = storage.getItem(MANAGED_WORKTREE_PENDING_COMMANDS_STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // pending command 账本损坏不是本表的错误，保持现状即可。
    return;
  }
  if (!Array.isArray(parsed)) return;
  defaultRegistry.markPromotionPendingForPendingCommands(parsed);
}

/**
 * 丢弃 worktree 草稿：先取走登记，再走 `removeManagedWorktree` 的 dirty /
 * 新提交 / base commit 检查。失败时 worktree 原样保留并通过 `onError` 上报。
 * `not-managed` 视为已清理（例如 backend 的 deleteSession 清理已先一步完成）。
 */
export async function discardManagedWorktreeDraft(params: {
  gitService: Pick<ManagedWorktreeTaskGit, "removeManagedWorktree">;
  workspacePath: string;
  workspaceIdentity?: string;
  hasMaterializedTask: boolean;
  onError?: (error: unknown) => void;
}): Promise<ManagedWorktreeDraftDiscardResult> {
  if (!defaultRegistry.read(params.workspacePath, params.workspaceIdentity)) {
    return { action: "skipped", reason: null };
  }
  syncManagedWorktreeDraftPromotionState();
  const taken = defaultRegistry.takeForDiscard(
    params.workspacePath,
    params.workspaceIdentity,
    params.hasMaterializedTask,
  );
  if (taken.action === "skipped") return { action: "skipped", reason: null };

  try {
    const result = await params.gitService.removeManagedWorktree({
      worktreePath: taken.draft.worktreePath,
    });
    if (result.ok || result.reason === "not-managed") {
      return { action: "removed", reason: null };
    }
    params.onError?.(
      new Error(result.message ?? `managed-worktree.remove-failed: ${result.reason ?? "unknown"}`),
    );
    return { action: "kept", reason: result.reason };
  } catch (error) {
    params.onError?.(error);
    return { action: "kept", reason: "remove-failed" };
  }
}

export interface ManagedWorktreeTabCloseEvent {
  sequence: number;
  workspacePath: string;
  workspaceIdentity?: string;
  origin: "user-close" | "restore" | "rekey";
}

export interface ManagedWorktreeTabStoreLike {
  getState(): { lastClosedWorkspaceTabEvent: ManagedWorktreeTabCloseEvent | null };
  subscribe(
    listener: (state: { lastClosedWorkspaceTabEvent: ManagedWorktreeTabCloseEvent | null }) => void,
  ): () => void;
}

/**
 * 监听 workspace tab 关闭：只有用户显式关闭且没有物化任务、也没有首发 send
 * 时才清理草稿 worktree。恢复/重键（restore/rekey）不是用户放弃草稿，必须忽略。
 */
export function observeManagedWorktreeDraftAbandonment(params: {
  tabStoreApi: ManagedWorktreeTabStoreLike;
  getActiveTaskId: (workspacePath: string, workspaceIdentity?: string) => string | null;
  gitService: Pick<ManagedWorktreeTaskGit, "removeManagedWorktree">;
  onError?: (error: unknown) => void;
}): () => void {
  let lastSequence = params.tabStoreApi.getState().lastClosedWorkspaceTabEvent?.sequence ?? 0;
  return params.tabStoreApi.subscribe((state) => {
    const event = state.lastClosedWorkspaceTabEvent;
    if (!event || event.sequence <= lastSequence) return;
    lastSequence = event.sequence;
    if (event.origin !== "user-close") return;
    void discardManagedWorktreeDraft({
      gitService: params.gitService,
      workspacePath: event.workspacePath,
      ...(event.workspaceIdentity ? { workspaceIdentity: event.workspaceIdentity } : {}),
      hasMaterializedTask:
        params.getActiveTaskId(event.workspacePath, event.workspaceIdentity) !== null,
      onError: params.onError,
    });
  });
}
