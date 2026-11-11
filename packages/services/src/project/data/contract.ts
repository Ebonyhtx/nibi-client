// 项目数据彻底删除的端口与结果类型；IProjectService 的数据命令使用这些类型。
// 上游对照：packages/services/src/project/data/contract.ts（3.17.2）。
import type {
  V4SessionDataMeasureResult,
  V4SessionDataPurgeResult,
} from "@nibi/shared/nibi-protocol-v4";

/** 彻底删除数据的一个会话：sessionId 即任务 ID，cwd 决定由哪个 Agent 进程执行。 */
export interface ProjectDataSession {
  sessionId: string;
  cwd: string;
}

/** 项目数据清理的副作用端口（node.ts 装配：CLI 会话数据 + Host git checkpoint 目录）。 */
export interface ProjectDataPort {
  /** 旧内核没有 sessionData 方法时 false；没有可询问的本地运行时为 undefined。 */
  supported(): Promise<boolean | undefined>;
  /** 大小只统计真正从磁盘删除的文件；数据库行删除不计入（库文件不收缩）。 */
  measure(input: { sessions: ProjectDataSession[]; directories: string[] }): Promise<{
    sessions: V4SessionDataMeasureResult["sessions"];
    directories: Array<{ path: string; memoryBytes: number; checkpointBytes: number }>;
  }>;
  /** 运行中、或附件仍被别的会话引用的会话保留在 kept；文件删除失败的会话保留行并计入 failed。 */
  purgeSessions(sessions: ProjectDataSession[]): Promise<{
    deleted: Array<{ sessionId: string; bytes: number }>;
    kept: Array<{ sessionId: string; reason: "running" | "referenced" }>;
    failed: Array<{ sessionId: string; code: string }>;
  }>;
  /** 删除这些目录的记忆与文件检查点；already-gone 目录按 0 字节处理。 */
  purgeDirectories(directories: string[]): Promise<{
    memory: Array<{ workspacePath: string; bytes: number }>;
    checkpoints: Array<{ workspacePath: string; bytes: number }>;
    failed: Array<{ workspacePath: string; code: string }>;
  }>;
}

export interface ProjectDataMeasureDetail {
  sessions: V4SessionDataMeasureResult["sessions"];
  directories: Array<{ path: string; memoryBytes: number; checkpointBytes: number }>;
}

/**
 * 清理能力：false = 旧内核明确不支持；true = 已验证支持；"unknown" = 当前没有
 * 已运行的本地 Agent 可询问，入口先保留，首次测量失败时再收敛为 false。
 */
export interface ProjectDataSupport {
  supported: boolean | "unknown";
}

/** purge 结果逐项保留，供 UI 展示 deleted / kept（原因）/ failed（可重试）。 */
export interface ProjectDataPurgeDetail {
  deleted: V4SessionDataPurgeResult["deleted"];
  kept: V4SessionDataPurgeResult["kept"];
  failed: V4SessionDataPurgeResult["failed"];
  memory: V4SessionDataPurgeResult["memory"];
  checkpoints: Array<{ workspacePath: string; bytes: number }>;
}
