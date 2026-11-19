/**
 * composer-edit-mode 标准调用示例：宿主（SessionPane）接线该模仿这一段。
 *
 * 1) 行上的编辑按钮只发 begin 意图，由 hook 负责加锁/切 scope；
 * 2) Composer 的提交在编辑态被路由到 editUserQuery / editQueueItem；
 * 3) 提交结算后调用 onComposerSubmissionSettled，成功即退出编辑 scope。
 */
import type {
  ConversationRowTarget,
  ConversationSnapshot,
  QueueItem,
} from "@nibi/shared/nibi-protocol-v4";

import type {
  ComposerEditQueueLockPort,
  ComposerEditSubmitPort,
  ComposerQueueItemEditTarget,
  ComposerUserQueryEditTarget,
} from "./contract.js";
import { resolveQueueItemEditDraft } from "./queueConfigApply.js";
import {
  useComposerEditMode,
  type ComposerEditBeginResult,
  type ComposerEditModeController,
} from "./useComposerEditMode.js";

export function useExampleComposerEditMode({
  editorId,
  queueLock,
  sessionId,
  snapshot,
  submit,
  workspaceKey,
}: {
  editorId: string;
  queueLock: ComposerEditQueueLockPort;
  sessionId: string;
  snapshot: ConversationSnapshot | null;
  submit: ComposerEditSubmitPort;
  workspaceKey: string;
}): ComposerEditModeController {
  return useComposerEditMode({
    enabled: true,
    sessionId,
    workspaceKey,
    snapshot,
    editorId,
    queueLock,
    submit,
  });
}

export function beginExampleUserQueryEdit(
  editMode: ComposerEditModeController,
  rowTarget: ConversationRowTarget,
  sessionId: string,
  workspaceKey: string,
  text: string,
): Promise<ComposerEditBeginResult> {
  const target: ComposerUserQueryEditTarget = {
    kind: "userQuery",
    sessionId,
    workspaceKey,
    rowId: rowTarget.rowId,
    entityId: rowTarget.entityId,
  };
  return editMode.beginUserQuery(target, { text });
}

export function beginExampleQueueItemEdit(
  editMode: ComposerEditModeController,
  queueItem: QueueItem,
  sessionId: string,
  workspaceKey: string,
): Promise<ComposerEditBeginResult> | null {
  const draft = resolveQueueItemEditDraft(queueItem);
  if (!draft) return null;
  const target: ComposerQueueItemEditTarget = {
    kind: "queueItem",
    sessionId,
    workspaceKey,
    queueItemId: queueItem.queueItemId,
  };
  return editMode.beginQueueItem(target, draft);
}
