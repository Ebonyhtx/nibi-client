import type {
  ComposerEditDraft,
  ComposerEditInvalidReason,
  ComposerEditState,
  ComposerEditTarget,
  ComposerEditWorkspaceMode,
} from "./contract.js";
import { composerEditTargetKey } from "./contract.js";
import { isSameComposerEditTarget } from "./editorIdentity.js";

const IDLE_STATE: ComposerEditState = {
  status: "idle",
  target: null,
  originalDraft: null,
  draft: null,
  invalidReason: null,
  focusRequest: null,
  submitRequest: null,
};

export interface ComposerEditStore {
  getSnapshot(): ComposerEditState;
  subscribe(listener: () => void): () => void;
  /** 同步进入编辑态（user query 等无需等待锁的入口）。 */
  begin(target: ComposerEditTarget, draft: ComposerEditDraft): void;
  /** 加锁等待期间先占住目标，阻止第二个入口并发进入。 */
  open(target: ComposerEditTarget): void;
  /** 锁/校验通过后把原始草稿交给编辑器，并请求一次聚焦。 */
  confirmOpen(draft: ComposerEditDraft): void;
  update(text: string): void;
  updateText(text: string): void;
  replaceDraft(draft: ComposerEditDraft): void;
  requestFocus(): void;
  requestSubmit(workspaceMode?: ComposerEditWorkspaceMode): void;
  setSubmitting(submitting: boolean): void;
  invalidate(reason: ComposerEditInvalidReason): void;
  end(): void;
  isDirty(): boolean;
  /** 测试与调试：读取当前焦点请求序号（不改变状态）。 */
  getFocusRequestId(): number;
}

function cloneDraft(draft: ComposerEditDraft): ComposerEditDraft {
  return {
    text: draft.text,
    ...(draft.attachments ? { attachments: [...draft.attachments] } : {}),
    ...(draft.conversationQuotes ? { conversationQuotes: [...draft.conversationQuotes] } : {}),
    ...(draft.config ? { config: { ...draft.config } } : {}),
  };
}

/**
 * 编辑态 store：只存在 renderer 内存，不持久化、不写协议。
 *
 * 不变量：
 * - originalDraft 在编辑期间不可变；dirty 只由当前正文与原始正文比较得出。
 * - idle 之外任何状态都必须有 target；opening 阶段没有 draft（锁还没到手）。
 * - 请求（focus/submit）用单调 requestId 表达，消费者按 id 去重，避免重复回放。
 */
export function createComposerEditStore(): ComposerEditStore {
  let state = IDLE_STATE;
  let focusRequestId = 0;
  let submitRequestId = 0;
  const listeners = new Set<() => void>();

  const publish = (next: ComposerEditState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const activeTarget = (): ComposerEditTarget | null =>
    state.status === "idle" ? null : state.target;

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    begin: (target, draft) => {
      focusRequestId += 1;
      publish({
        status: "editing",
        target,
        originalDraft: cloneDraft(draft),
        draft: cloneDraft(draft),
        invalidReason: null,
        focusRequest: { requestId: focusRequestId, targetKey: composerEditTargetKey(target) },
        submitRequest: null,
      });
    },
    open: (target) => {
      if (state.status !== "idle" && isSameComposerEditTarget(state.target, target)) return;
      publish({
        status: "opening",
        target,
        originalDraft: null,
        draft: null,
        invalidReason: null,
        focusRequest: null,
        submitRequest: null,
      });
    },
    confirmOpen: (draft) => {
      const target = activeTarget();
      if (!target || state.status !== "opening") return;
      focusRequestId += 1;
      publish({
        status: "editing",
        target,
        originalDraft: cloneDraft(draft),
        draft: cloneDraft(draft),
        invalidReason: null,
        focusRequest: { requestId: focusRequestId, targetKey: composerEditTargetKey(target) },
        submitRequest: null,
      });
    },
    update: (text) => {
      if ((state.status !== "editing" && state.status !== "invalid") || !state.draft) return;
      if (state.draft.text === text) return;
      publish({ ...state, draft: { ...state.draft, text } });
    },
    updateText: (text) => {
      if ((state.status !== "editing" && state.status !== "invalid") || !state.draft) return;
      if (state.draft.text === text) return;
      publish({ ...state, draft: { ...state.draft, text } });
    },
    replaceDraft: (draft) => {
      if (state.status !== "editing") return;
      publish({ ...state, draft: cloneDraft(draft) });
    },
    requestFocus: () => {
      const target = activeTarget();
      if (!target || state.status === "invalid" || state.status === "submitting") return;
      focusRequestId += 1;
      publish({
        ...state,
        focusRequest: { requestId: focusRequestId, targetKey: composerEditTargetKey(target) },
      });
    },
    requestSubmit: (workspaceMode = "preserve") => {
      const target = activeTarget();
      if (!target || state.status !== "editing") return;
      submitRequestId += 1;
      publish({
        ...state,
        submitRequest: {
          requestId: submitRequestId,
          targetKey: composerEditTargetKey(target),
          workspaceMode,
        },
      });
    },
    setSubmitting: (submitting) => {
      if (submitting) {
        if (state.status !== "editing") return;
        publish({ ...state, status: "submitting" });
        return;
      }
      if (state.status !== "submitting") return;
      publish({ ...state, status: "editing" });
    },
    invalidate: (reason) => {
      if (state.status === "idle" || !state.target) return;
      publish({ ...state, status: "invalid", invalidReason: reason });
    },
    end: () => {
      if (state === IDLE_STATE) return;
      publish(IDLE_STATE);
    },
    isDirty: () => {
      if (!state.originalDraft || !state.draft) return false;
      return state.originalDraft.text !== state.draft.text;
    },
    getFocusRequestId: () => focusRequestId,
  };
}
