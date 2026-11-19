import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ConversationSelectionText } from "@nibi/shared";
import type { AttachmentRef, ConversationSnapshot } from "@nibi/shared/nibi-protocol-v4";

import type {
  ComposerEditDraft,
  ComposerEditInvalidReason,
  ComposerEditQueueLockPort,
  ComposerEditState,
  ComposerEditSubmitInput,
  ComposerEditSubmitPort,
  ComposerEditSubmitResult,
  ComposerEditTarget,
  ComposerEditWorkspaceMode,
} from "./contract.js";
import { composerEditScopeId, composerEditTargetKey, isComposerEditScopeId } from "./contract.js";
import {
  composerEditRowId,
  isQueueItemEditTarget,
  isSameComposerEditTarget,
  isUserQueryEditTarget,
} from "./editorIdentity.js";
import { createComposerEditStore, type ComposerEditStore } from "./store.js";

export type ComposerEditBeginResult =
  | "started"
  | "same"
  | "busy"
  | "cancelled"
  | "stale"
  | "disabled"
  | "lockedByOther"
  | "missing"
  | "failed";

export type ComposerEditSubmissionSettlement =
  | "sent"
  | "blocked"
  | "confirmationRequired"
  | "failed";

export interface ComposerEditComposerSubmitInput {
  text: string;
  attachments: readonly AttachmentRef[];
  conversationQuotes?: readonly ConversationSelectionText[];
  workspaceMode?: ComposerEditWorkspaceMode;
}

export interface UseComposerEditModeOptions {
  enabled: boolean;
  sessionId: string | null;
  workspaceKey: string;
  snapshot: ConversationSnapshot | null;
  editorId: string;
  queueLock: ComposerEditQueueLockPort;
  submit: ComposerEditSubmitPort;
  /** 切换目标且编辑正文已改：返回 false 保持当前编辑态。生产入口接 window.confirm。 */
  confirmDiscard?: (target: ComposerEditTarget) => boolean;
  onInvalid?: (reason: ComposerEditInvalidReason) => void;
}

export interface ComposerEditModeController {
  state: ComposerEditState;
  /** 只包含已经拿到锁/草稿的编辑态；opening 期间底部 Composer 仍保持原 scope。 */
  isActive: boolean;
  isEditing: boolean;
  isInvalid: boolean;
  draftScopeId: string | null;
  focusRequest: ComposerEditState["focusRequest"];
  submitRequest: ComposerEditState["submitRequest"];
  editingUserQueryRowId: number | null;
  beginUserQuery(
    target: Extract<ComposerEditTarget, { kind: "userQuery" }>,
    draft: ComposerEditDraft,
  ): Promise<ComposerEditBeginResult>;
  beginQueueItem(
    target: Extract<ComposerEditTarget, { kind: "queueItem" }>,
    draft: ComposerEditDraft,
  ): Promise<ComposerEditBeginResult>;
  cancel(): void;
  requestFocus(): void;
  requestRewind(): void;
  updateText(text: string): void;
  replaceDraft(draft: ComposerEditDraft): void;
  submitComposer(input: ComposerEditComposerSubmitInput): Promise<ComposerEditSubmitResult>;
  onComposerSubmissionSettled(result: ComposerEditSubmissionSettlement): void;
}

/**
 * 投影裁决：编辑态是否仍然合法。
 *
 * 只看权威 projection，不在 UI 记第二份事实：
 * - user query：仍在窗口且 canEdit 才合法；窗口滚出目标时无法裁决，保持现状。
 * - queue item：项消失即 queueItemRemoved；曾经观察到本端锁、之后锁消失/换主即 editLockLost。
 */
export function resolveComposerEditInvalidReason(
  snapshot: ConversationSnapshot | null,
  target: ComposerEditTarget,
  editorId: string,
  options: { queueLockObserved?: boolean } = {},
): ComposerEditInvalidReason | null {
  if (!snapshot || snapshot.sessionId !== target.sessionId) return null;
  if (isUserQueryEditTarget(target)) {
    const row = snapshot.rows.window.find((candidate) => candidate.rowId === target.rowId);
    if (!row) return null;
    if (row.kind !== "userInput") return "notLatest";
    return row.actions?.canEdit === true ? null : "notLatest";
  }
  const item = snapshot.queue.items.find(
    (candidate) => candidate.queueItemId === target.queueItemId,
  );
  if (!item) return "queueItemRemoved";
  if (item.editLock?.editorId === editorId) return null;
  // 锁已被别的编辑器持有是确定事实；锁缺席只在曾观察到本端锁后才算丢失，
  // 避免 lock ACK 与投影回流之间的乐观窗口被误判。
  if (item.editLock) return "editLockLost";
  return options.queueLockObserved ? "editLockLost" : null;
}

/**
 * bottom-composer 编辑态控制器。
 *
 * 时序：
 * - user query：直接进入编辑 scope；提交由 SessionPane 路由到 editUserQuery。
 * - queue item：先 await lockQueueItemEdit，拿到锁才切 scope；提交/取消都负责释放。
 * - 切换目标：正文改过先确认，再释放旧队列锁，最后进入新目标。
 * - 投影失效不自动清正文：用户能看见原因并取消，避免把输入静默丢掉。
 */
export function useComposerEditMode(
  options: UseComposerEditModeOptions,
): ComposerEditModeController {
  const storeRef = useRef<ComposerEditStore | null>(null);
  if (storeRef.current === null) storeRef.current = createComposerEditStore();
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const generationRef = useRef(0);
  const queueLockObservedRef = useRef(false);

  const {
    confirmDiscard,
    editorId,
    enabled,
    onInvalid,
    queueLock,
    sessionId,
    snapshot,
    submit,
    workspaceKey,
  } = options;

  const endCurrent = useCallback(async () => {
    const current = store.getSnapshot();
    const target = current.target;
    generationRef.current += 1;
    queueLockObservedRef.current = false;
    store.end();
    if (target && isQueueItemEditTarget(target)) {
      try {
        await queueLock.release(target);
      } catch {
        // release 是幂等清理；失败不能让编辑态无法退出。
      }
    }
  }, [queueLock, store]);

  const beginTarget = useCallback(
    async (
      target: ComposerEditTarget,
      draft: ComposerEditDraft,
    ): Promise<ComposerEditBeginResult> => {
      if (!enabled) return "disabled";
      if (!sessionId || target.sessionId !== sessionId || target.workspaceKey !== workspaceKey) {
        return "stale";
      }
      const current = store.getSnapshot();
      if (current.status !== "idle") {
        if (isSameComposerEditTarget(current.target, target)) {
          store.requestFocus();
          return "same";
        }
        if (current.status === "opening" || current.status === "submitting") return "busy";
        if (store.isDirty() && !(confirmDiscard?.(current.target!) ?? false)) {
          return "cancelled";
        }
        await endCurrent();
      }
      const generation = ++generationRef.current;
      queueLockObservedRef.current = false;
      store.open(target);
      if (isQueueItemEditTarget(target)) {
        const locked = await queueLock.lock(target);
        // 等待锁期间用户可能已切到别的目标/取消；迟到的锁必须自己释放。
        if (generation !== generationRef.current) {
          if (locked === "locked") await queueLock.release(target);
          return "cancelled";
        }
        if (locked !== "locked") {
          store.end();
          return locked;
        }
      }
      if (generation !== generationRef.current) return "cancelled";
      store.confirmOpen(draft);
      return "started";
    },
    [confirmDiscard, enabled, endCurrent, queueLock, sessionId, store, workspaceKey],
  );

  const beginUserQuery = useCallback(
    (target: Extract<ComposerEditTarget, { kind: "userQuery" }>, draft: ComposerEditDraft) =>
      beginTarget(target, draft),
    [beginTarget],
  );
  const beginQueueItem = useCallback(
    (target: Extract<ComposerEditTarget, { kind: "queueItem" }>, draft: ComposerEditDraft) =>
      beginTarget(target, draft),
    [beginTarget],
  );

  const cancel = useCallback(() => {
    void endCurrent();
  }, [endCurrent]);

  const requestFocus = useCallback(() => {
    store.requestFocus();
  }, [store]);

  const requestRewind = useCallback(() => {
    const current = store.getSnapshot();
    if (!current.target || !isUserQueryEditTarget(current.target)) return;
    store.requestSubmit("rewind");
  }, [store]);

  const updateText = useCallback(
    (text: string) => {
      store.updateText(text);
    },
    [store],
  );

  const replaceDraft = useCallback(
    (draft: ComposerEditDraft) => {
      store.replaceDraft(draft);
    },
    [store],
  );

  const submitComposer = useCallback(
    async (input: ComposerEditComposerSubmitInput): Promise<ComposerEditSubmitResult> => {
      const current = store.getSnapshot();
      if (current.status !== "editing" || !current.target) {
        return { status: "rejected", reason: "failed" };
      }
      if (!input.text.trim() && input.attachments.length === 0) {
        return { status: "rejected", reason: "failed" };
      }
      store.setSubmitting(true);
      const request: ComposerEditSubmitInput = {
        target: current.target,
        text: input.text,
        attachments: input.attachments,
        ...(input.conversationQuotes?.length
          ? { conversationQuotes: input.conversationQuotes }
          : {}),
        workspaceMode: input.workspaceMode ?? "preserve",
        editorId,
      };
      try {
        const result = await submit.submit(request);
        if (result.status === "accepted") return result;
        if (result.reason === "failed") {
          store.setSubmitting(false);
          return result;
        }
        // 不自动清正文：失效原因交给编辑条展示，用户决定取消还是重试。
        store.invalidate(result.reason);
        onInvalid?.(result.reason);
        return result;
      } catch (error) {
        store.setSubmitting(false);
        return {
          status: "rejected",
          reason: "failed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
    [editorId, onInvalid, store, submit],
  );

  const onComposerSubmissionSettled = useCallback(
    (result: ComposerEditSubmissionSettlement) => {
      if (result === "sent") {
        void endCurrent();
        return;
      }
      if (store.getSnapshot().status === "submitting") store.setSubmitting(false);
    },
    [endCurrent, store],
  );

  useEffect(() => {
    const current = store.getSnapshot();
    if (!current.target || current.status === "idle" || current.status === "opening") return;
    if (current.target.sessionId !== sessionId || current.target.workspaceKey !== workspaceKey) {
      void endCurrent();
      return;
    }
    if (current.status === "submitting") return;
    if (isQueueItemEditTarget(current.target) && snapshot) {
      const queueItemId = current.target.queueItemId;
      const item = snapshot.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
      if (item?.editLock?.editorId === editorId) queueLockObservedRef.current = true;
    }
    const reason = resolveComposerEditInvalidReason(snapshot, current.target, editorId, {
      queueLockObserved: queueLockObservedRef.current,
    });
    if (reason && current.status !== "invalid") {
      store.invalidate(reason);
      onInvalid?.(reason);
    }
  }, [editorId, endCurrent, onInvalid, sessionId, snapshot, store, workspaceKey]);

  const isActive =
    state.status === "editing" || state.status === "submitting" || state.status === "invalid";
  return {
    state,
    isActive,
    isEditing: state.status !== "idle",
    isInvalid: state.status === "invalid",
    draftScopeId: isActive && state.target ? composerEditScopeId(state.target) : null,
    focusRequest: isActive ? state.focusRequest : null,
    submitRequest: isActive ? state.submitRequest : null,
    editingUserQueryRowId: isActive && state.target ? composerEditRowId(state.target) : null,
    beginUserQuery,
    beginQueueItem,
    cancel,
    requestFocus,
    requestRewind,
    updateText,
    replaceDraft,
    submitComposer,
    onComposerSubmissionSettled,
  };
}

export { isComposerEditScopeId, composerEditTargetKey };
