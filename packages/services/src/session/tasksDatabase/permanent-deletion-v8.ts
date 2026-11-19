// 冻结 0008 的只增 SQL；后续结构调整必须追加迁移，不能跟随运行 Repo 修改 checksum。
//
// task_purge 是 Host 侧删除凭据：reserved 表示已向 CLI 发出删除意图，purged 表示 CLI 已确认
// 会话数据删除完成。tasks 行在 purged 时被硬删除；触发器阻止任何路径把同一 task 重新插入
// 或把 tombstone 恢复成可见行，避免 CLI 对账、远端同步或重试把已永久删除的会话复活。
export const TASK_PERMANENT_DELETION_SQL = `
CREATE TABLE IF NOT EXISTS task_purge (
  workspace_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'purged')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_key, task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_purge_state
ON task_purge (state);

CREATE TRIGGER IF NOT EXISTS task_purge_insert_guard
BEFORE INSERT ON tasks
WHEN EXISTS (
  SELECT 1 FROM task_purge
  WHERE workspace_key = NEW.workspace_key AND task_id = NEW.task_id AND state = 'purged'
)
BEGIN
  SELECT RAISE(ABORT, 'task-data.purged');
END;

CREATE TRIGGER IF NOT EXISTS task_purge_update_guard
BEFORE UPDATE ON tasks
WHEN EXISTS (
  SELECT 1 FROM task_purge
  WHERE workspace_key = NEW.workspace_key AND task_id = NEW.task_id AND state = 'purged'
)
AND (OLD.task_id <> NEW.task_id OR OLD.workspace_key <> NEW.workspace_key OR NEW.deleted = 0)
BEGIN
  SELECT RAISE(ABORT, 'task-data.purged');
END;
`;

export const TASK_PERMANENT_DELETION_CHECKSUM_INPUT = [
  TASK_PERMANENT_DELETION_SQL,
  "task-purge-reserved-purged-v1",
] as const;
