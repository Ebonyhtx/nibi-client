// 会话历史中的"已创建 worktree"：由 CLI 写入历史，桌面、手机与重启后看到同一项；
// 默认收起，可展开查看 git 与拷贝输出。
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { TID_WORKTREE_CREATED_MARKER } from "./testIds.js";
import { WorktreeOutputBlock } from "./WorktreeOutputBlock.js";

export function WorktreeCreatedMarker({
  rowId,
  output,
}: {
  rowId: string | number;
  output: string;
}) {
  const { intl } = useNibiIntl();
  return (
    <div data-row-id={rowId} className="py-1">
      <WorktreeOutputBlock
        testId={TID_WORKTREE_CREATED_MARKER}
        title={intl.formatMessage({ id: "git.managedWorktree.created.title" })}
        status="done"
        output={output}
      />
    </div>
  );
}

/**
 * 旧结构兜底：共享 schema 尚未收录 worktreeCreated（旧服务端/旧快照）时按结构读取，
 * 缺字段不渲染。新投影走后端 typed marker（`marker.type === "worktreeCreated"`）直读。
 */
export function readWorktreeCreatedMarker(marker: unknown): { output: string } | null {
  if (!marker || typeof marker !== "object") return null;
  const candidate = marker as { type?: unknown; output?: unknown };
  if (candidate.type !== "worktreeCreated") return null;
  return { output: typeof candidate.output === "string" ? candidate.output : "" };
}