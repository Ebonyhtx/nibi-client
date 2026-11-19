import { memo, useCallback } from "react";
import { TID_V4_SESSION_SOURCE_HINT } from "@nibi/shared/test-ids";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import {
  readConversationRowSessionSource,
  resolveConversationSessionSourceHint,
  type ConversationSessionSource,
} from "@/lib/conversationSessionSource.js";
import { requestTaskNavigation } from "@/lib/taskNavigationRequest.js";
import { useOptionalProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";

/**
 * 跨会话来源提示（「来自会话 X」）。
 *
 * 标题按 project directory 的当前标题解析；来源已删除/不可达时保持可读但不可点击，
 * 并用 title 给轻提示。跳转只发导航意图，由 App 的 handleSelectTask 执行。
 */
export const ConversationSessionSourceHint = memo(function ConversationSessionSourceHint({
  source,
}: {
  source: ConversationSessionSource;
}) {
  const { intl } = useNibiIntl();
  const directory = useOptionalProjectDirectory();
  const task = directory?.tree.tasks.find((item) => item.taskId === source.sessionId);
  const model = resolveConversationSessionSourceHint(
    source,
    task,
    intl.formatMessage({ id: "conversation.fromSession.unknown" }),
  );
  const label = intl.formatMessage({ id: "conversation.fromSession" }, { name: model.name });
  const handleOpen = useCallback(() => {
    if (!model.workspacePath) return;
    requestTaskNavigation({
      taskId: source.sessionId,
      workspacePath: model.workspacePath,
      ...(model.workspaceIdentity ? { workspaceIdentity: model.workspaceIdentity } : {}),
    });
  }, [model.workspaceIdentity, model.workspacePath, source.sessionId]);

  return (
    <div
      data-testid={TID_V4_SESSION_SOURCE_HINT}
      data-v4-user-input-source="session"
      data-source-session-navigable={model.navigable ? "true" : "false"}
      className="mt-1 text-right text-ui-sm text-foreground-subtlest"
    >
      {model.navigable ? (
        <button
          type="button"
          onClick={handleOpen}
          title={intl.formatMessage({ id: "conversation.fromSession.open" })}
          className="rounded-sm underline-offset-2 hover:text-foreground-subtle hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {label}
        </button>
      ) : (
        <span title={intl.formatMessage({ id: "conversation.fromSession.unavailable" })}>
          {label}
        </span>
      )}
    </div>
  );
});

/** 行上有来源会话时渲染提示；没有来源返回 null（调用方无需再做分支）。 */
export function ConversationRowSessionSource({
  row,
}: {
  row: Parameters<typeof readConversationRowSessionSource>[0];
}) {
  const source = readConversationRowSessionSource(row);
  return source ? <ConversationSessionSourceHint source={source} /> : null;
}