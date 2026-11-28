import type { ConversationSelectionText, ModelSelection } from "@nibi/shared";
import type { AttachmentRef, CommandAck, SubmissionMode } from "@nibi/shared/nibi-protocol-v4";

/**
 * 编辑态草稿 scope 前缀。
 *
 * 编辑一个历史 user query 或一条队列消息时，Composer 不能复用会话草稿 scope：
 * 否则提交/取消会把编辑正文写回用户正在写的下一条消息。带这个前缀的 scope 只存在
 * renderer 内存里（见 composerDraftStore 的同名分支），永不写 localStorage。
 */
export const COMPOSER_EDIT_SCOPE_MARKER = "composer-edit:";

export type ComposerEditWorkspaceMode = "preserve" | "rewind";

export interface ComposerUserQueryEditTarget {
  kind: "userQuery";
  sessionId: string;
  workspaceKey: string;
  rowId: number;
  entityId: string;
}

export interface ComposerQueueItemEditTarget {
  kind: "queueItem";
  sessionId: string;
  workspaceKey: string;
  queueItemId: string;
}

export type ComposerEditTarget = ComposerUserQueryEditTarget | ComposerQueueItemEditTarget;

/**
 * 投影驱动的失效原因：
 * - notLatest：目标 user query 已不是当前投影允许编辑的最后一条真实用户输入；
 * - queueItemRemoved：队列项已被本端/其他端发送、删除或结束；
 * - editLockLost：队列项编辑锁被其他编辑器持有或已消失。
 */
export type ComposerEditInvalidReason = "notLatest" | "queueItemRemoved" | "editLockLost";

export interface ComposerEditConfig {
  mode?: SubmissionMode;
  planEnabled?: boolean;
  modelSelection?: ModelSelection;
}

/** 进入编辑态时冻结的原始输入；取消/切换只丢弃编辑态副本，不触碰会话草稿。 */
export interface ComposerEditDraft {
  text: string;
  attachments?: readonly AttachmentRef[];
  conversationQuotes?: readonly ConversationSelectionText[];
  config?: ComposerEditConfig;
}

export type ComposerEditStatus = "idle" | "opening" | "editing" | "submitting" | "invalid";

export interface ComposerEditFocusRequest {
  requestId: number;
  targetKey: string;
}

export interface ComposerEditSubmitRequest {
  requestId: number;
  targetKey: string;
  workspaceMode: ComposerEditWorkspaceMode;
}

export interface ComposerEditState {
  status: ComposerEditStatus;
  target: ComposerEditTarget | null;
  originalDraft: ComposerEditDraft | null;
  draft: ComposerEditDraft | null;
  invalidReason: ComposerEditInvalidReason | null;
  focusRequest: ComposerEditFocusRequest | null;
  submitRequest: ComposerEditSubmitRequest | null;
}

export type ComposerEditWorkspaceRewindReason =
  | "available"
  | "noFiles"
  | "reverted"
  | "running"
  | "unavailable";

export interface ComposerEditWorkspaceRewind {
  enabled: boolean;
  reason: ComposerEditWorkspaceRewindReason;
}

export interface ComposerEditBarProps {
  target: ComposerEditTarget;
  state: Exclude<ComposerEditStatus, "idle" | "opening">;
  invalidReason?: ComposerEditInvalidReason | null;
  canRewind?: boolean;
  rewindDisabled?: boolean;
  /** 目标轮的工作区文件重置可用性；缺省时沿用 rewindDisabled。 */
  workspaceRewind?: ComposerEditWorkspaceRewind;
  onRewind?: () => void;
  onCancel: () => void;
}

export interface ComposerEditSubmitInput {
  target: ComposerEditTarget;
  /** 已序列化 prompt context 的正文（Composer 提交边界给出的完整 newText）。 */
  text: string;
  attachments: readonly AttachmentRef[];
  conversationQuotes?: readonly ConversationSelectionText[];
  workspaceMode: ComposerEditWorkspaceMode;
  editorId: string;
}

export type ComposerEditSubmitResult =
  | { status: "accepted" }
  | { status: "rejected"; reason: ComposerEditInvalidReason | "failed"; message?: string };

/** 队列编辑锁端口：U36 命令的薄适配，不改协议，也不在模块内保存第二份锁状态。 */
export interface ComposerEditQueueLockPort {
  /** 等待 lockQueueItemEdit ACK；accepted/duplicate 才能进入编辑态。 */
  lock(
    target: ComposerQueueItemEditTarget,
  ): Promise<"locked" | "lockedByOther" | "missing" | "failed">;
  /** 幂等释放；取消、切换目标、编辑态结束都走这里。 */
  release(target: ComposerQueueItemEditTarget): Promise<void>;
}

export interface ComposerEditSubmitPort {
  /** 按 target.kind 路由到 editUserQuery / editQueueItem（队列项成功后释放锁）。 */
  submit(input: ComposerEditSubmitInput): Promise<ComposerEditSubmitResult>;
}

/** 会话级编辑身份：workspace + session 共同决定，pane 换绑时整个编辑态作废。 */
export function composerEditSessionKey(workspaceKey: string, sessionId: string): string {
  return `${workspaceKey}\u0000${sessionId}`;
}

/** 目标身份只用于比较/请求去重，不进入协议。 */
export function composerEditTargetKey(target: ComposerEditTarget): string {
  return `${target.workspaceKey}\u0000${target.sessionId}\u0000${target.kind}\u0000${
    target.kind === "userQuery" ? target.rowId : target.queueItemId
  }`;
}

export function composerEditScopeId(target: ComposerEditTarget): string {
  return `${COMPOSER_EDIT_SCOPE_MARKER}${encodeURIComponent(composerEditTargetKey(target))}`;
}

export function isComposerEditScopeId(scopeId: string): boolean {
  return scopeId.startsWith(COMPOSER_EDIT_SCOPE_MARKER);
}

/**
 * 网络/宿主侧命令的唯一构造点。路由测试与 SessionPane 共用这里，避免两边对
 * editUserQuery / editQueueItem 的字段集合产生分叉。
 */
export function buildComposerEditSubmitCommand(input: ComposerEditSubmitInput): {
  type: "editUserQuery" | "editQueueItem";
  payload: Record<string, unknown>;
} {
  if (input.target.kind === "userQuery") {
    return {
      type: "editUserQuery",
      payload: {
        target: { rowId: input.target.rowId, entityId: input.target.entityId },
        newText: input.text,
        workspaceMode: input.workspaceMode,
        // 缺省 attachments 表示保留 canonical 原附件；显式 [] 才表示删光。
        ...(input.attachments.length > 0 ? { attachments: [...input.attachments] } : {}),
        ...(input.conversationQuotes?.length
          ? { conversationQuotes: [...input.conversationQuotes] }
          : {}),
      },
    };
  }
  return {
    type: "editQueueItem",
    payload: {
      queueItemId: input.target.queueItemId,
      newText: input.text,
      editorId: input.editorId,
    },
  };
}

/** 只把可展示的拒绝码收敛成编辑态失效原因；其余失败留在编辑态供重试。 */
export function composerEditInvalidReasonForAck(
  target: ComposerEditTarget,
  ack: Pick<CommandAck, "status" | "reasonCode">,
): ComposerEditInvalidReason | null {
  if (ack.status === "accepted" || ack.status === "duplicate") return null;
  if (target.kind === "userQuery" && ack.reasonCode === "guard.latestQueryEditOnly") {
    return "notLatest";
  }
  if (target.kind === "queueItem") {
    if (ack.reasonCode === "queue.itemMissing") return "queueItemRemoved";
    if (ack.reasonCode === "queue.editLockMissing") return "editLockLost";
  }
  return null;
}
