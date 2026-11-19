/** 跨会话来源的展示事实：sessionId 是身份，title 只来自旧快照。 */
export interface ConversationSessionSource {
  sessionId: string;
  title?: string;
}

export interface ConversationSessionSourceTask {
  title?: string;
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface ConversationSessionSourceHintModel {
  /** 已本地化的展示名；解析不到时由调用方传入兜底文案。 */
  name: string;
  navigable: boolean;
  workspacePath?: string;
  workspaceIdentity?: string;
}

/**
 * 行 → 来源会话的纯函数。
 *
 * 新数据写在 `source.kind=session`；`originMeta.senderSessionId` 是 mailbox/后台回复
 * 已持久化的同一事实（旧 `mailboxMessage.fromSessionId` 的投影形态）。两者都没有时返回 null。
 */
export function readConversationRowSessionSource(row: {
  source?: { kind: string; sessionId?: string; title?: string };
  originMeta?: { senderSessionId?: string; senderLabel?: string };
}): ConversationSessionSource | null {
  if (row.source?.kind === "session" && row.source.sessionId) {
    return {
      sessionId: row.source.sessionId,
      ...(row.source.title ? { title: row.source.title } : {}),
    };
  }
  const senderSessionId = row.originMeta?.senderSessionId;
  if (senderSessionId) {
    return {
      sessionId: senderSessionId,
      ...(row.originMeta?.senderLabel ? { title: row.originMeta.senderLabel } : {}),
    };
  }
  return null;
}

/**
 * 来源会话 → 横幅模型：标题按「当前目录事实 → 旧快照 → 兜底」回落；只有目录里确实
 * 存在来源会话（拿到 workspacePath）才可点击，避免猜路径把「打不开」变成「打开别的会话」。
 * 不返回 sessionId，展示层不会把内部 id 写进可见文案或 DOM。
 */
export function resolveConversationSessionSourceHint(
  source: ConversationSessionSource,
  task: ConversationSessionSourceTask | undefined,
  unknownLabel: string,
): ConversationSessionSourceHintModel {
  const workspacePath = task?.workspacePath?.trim();
  return {
    name: task?.title?.trim() || source.title?.trim() || unknownLabel,
    navigable: Boolean(workspacePath),
    ...(workspacePath ? { workspacePath } : {}),
    ...(task?.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
  };
}