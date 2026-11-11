import type {
  ProjectDataMeasureDetail,
  ProjectDataPurgeDetail,
  ProjectTask,
} from "@/project-sidebar/contract.js";

export interface ProjectDataCleanupSessionRow {
  sessionId: string;
  title: string;
  bytes: number;
  /** 运行中的会话由内核保留，不能勾选；被引用只能在 purge 结果里得知。 */
  running: boolean;
  selected: boolean;
}

export interface ProjectDataCleanupDirectoryRow {
  path: string;
  memoryBytes: number;
  checkpointBytes: number;
  selected: boolean;
}

export interface ProjectDataCleanupRows {
  sessions: ProjectDataCleanupSessionRow[];
  directories: ProjectDataCleanupDirectoryRow[];
}

/** 默认勾选安全项：非运行中且确有字节可删；用户可再取消。 */
export function buildProjectDataCleanupRows(input: {
  measured: ProjectDataMeasureDetail;
  tasks: readonly ProjectTask[];
  runningSessionIds: ReadonlySet<string>;
}): ProjectDataCleanupRows {
  const titles = new Map(input.tasks.map((task) => [task.taskId, task.title]));
  const runningTaskIds = new Set(
    input.tasks.filter((task) => task.status === "running").map((task) => task.taskId),
  );
  const sessions = input.measured.sessions
    .map((session) => {
      const running =
        input.runningSessionIds.has(session.sessionId) || runningTaskIds.has(session.sessionId);
      return {
        sessionId: session.sessionId,
        title: titles.get(session.sessionId)?.trim() || session.sessionId,
        bytes: session.bytes,
        running,
        selected: !running && session.bytes > 0,
      };
    })
    .sort(
      (left, right) => right.bytes - left.bytes || left.sessionId.localeCompare(right.sessionId),
    );
  const directories = input.measured.directories
    .map((directory) => ({
      path: directory.path,
      memoryBytes: directory.memoryBytes,
      checkpointBytes: directory.checkpointBytes,
      selected: directory.memoryBytes + directory.checkpointBytes > 0,
    }))
    .sort(
      (left, right) =>
        right.memoryBytes + right.checkpointBytes - (left.memoryBytes + left.checkpointBytes),
    );
  return { sessions, directories };
}

export function projectDataCleanupSelection(rows: ProjectDataCleanupRows): {
  sessionIds: string[];
  directories: string[];
  totalBytes: number;
} {
  const sessions = rows.sessions.filter((row) => row.selected && !row.running);
  const directories = rows.directories.filter((row) => row.selected);
  return {
    sessionIds: sessions.map((row) => row.sessionId),
    directories: directories.map((row) => row.path),
    totalBytes:
      sessions.reduce((sum, row) => sum + row.bytes, 0) +
      directories.reduce((sum, row) => sum + row.memoryBytes + row.checkpointBytes, 0),
  };
}

export function projectDataCleanupFreedBytes(result: ProjectDataPurgeDetail): number {
  return (
    result.deleted.reduce((sum, entry) => sum + entry.bytes, 0) +
    result.memory.reduce((sum, entry) => sum + entry.bytes, 0) +
    result.checkpoints.reduce((sum, entry) => sum + entry.bytes, 0)
  );
}

/** 失败项的重试选择：只重发上次失败、且仍能定位的会话/目录。 */
export function projectDataCleanupRetrySelection(result: ProjectDataPurgeDetail): {
  sessionIds: string[];
  directories: string[];
} {
  return {
    sessionIds: [
      ...new Set(result.failed.flatMap((entry) => (entry.sessionId ? [entry.sessionId] : []))),
    ],
    directories: [
      ...new Set(
        result.failed.flatMap((entry) => (entry.workspacePath ? [entry.workspacePath] : [])),
      ),
    ],
  };
}

/**
 * 重试结果与上次结果合并：deleted 按会话累计字节，kept 以最新结果为准，
 * failed 只保留本次仍失败的项。目录失败可能与上次同名，按路径去重。
 */
export function mergeProjectDataPurgeResults(
  previous: ProjectDataPurgeDetail,
  next: ProjectDataPurgeDetail,
): ProjectDataPurgeDetail {
  const deleted = new Map<string, number>();
  for (const entry of [...previous.deleted, ...next.deleted])
    deleted.set(entry.sessionId, (deleted.get(entry.sessionId) ?? 0) + entry.bytes);
  const deletedIds = new Set(deleted.keys());
  const kept = new Map<string, "running" | "referenced">();
  for (const entry of [...previous.kept, ...next.kept]) {
    if (deletedIds.has(entry.sessionId)) continue;
    kept.set(entry.sessionId, entry.reason);
  }
  const memory = new Map<string, number>();
  for (const entry of [...previous.memory, ...next.memory])
    memory.set(entry.workspacePath, (memory.get(entry.workspacePath) ?? 0) + entry.bytes);
  const checkpoints = new Map<string, number>();
  for (const entry of [...previous.checkpoints, ...next.checkpoints])
    checkpoints.set(entry.workspacePath, (checkpoints.get(entry.workspacePath) ?? 0) + entry.bytes);
  return {
    deleted: [...deleted].map(([sessionId, bytes]) => ({ sessionId, bytes })),
    kept: [...kept].map(([sessionId, reason]) => ({ sessionId, reason })),
    failed: next.failed,
    memory: [...memory].map(([workspacePath, bytes]) => ({ workspacePath, bytes })),
    checkpoints: [...checkpoints].map(([workspacePath, bytes]) => ({ workspacePath, bytes })),
  };
}

/** 旧内核明确不支持、旧 Server 只读投影或远端项目都不显示清理入口。 */
export function projectDataCleanupAvailable(input: {
  project: { hostId: string; legacySingleRoot?: true };
  supported: boolean | "unknown" | undefined;
}): boolean {
  if (input.supported === false) return false;
  return input.project.hostId === "local" && input.project.legacySingleRoot !== true;
}

export function isProjectDataUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("project.data-unsupported");
}
