import { describe, expect, it } from "vitest";
import type { ProjectTask } from "@/project-sidebar/contract.js";
import {
  buildProjectDataCleanupRows,
  mergeProjectDataPurgeResults,
  projectDataCleanupAvailable,
  projectDataCleanupFreedBytes,
  projectDataCleanupRetrySelection,
  projectDataCleanupSelection,
} from "@/project-sidebar/project-data-cleanup.js";

function task(taskId: string, title: string, status?: "running" | "completed" | "error") {
  return { taskId, title, status } as unknown as ProjectTask;
}

const measured = {
  sessions: [
    { sessionId: "safe", bytes: 100 },
    { sessionId: "running", bytes: 200 },
    { sessionId: "zero", bytes: 0 },
  ],
  directories: [
    { path: "/work", memoryBytes: 10, checkpointBytes: 20 },
    { path: "/empty", memoryBytes: 0, checkpointBytes: 0 },
  ],
};

describe("项目数据清理纯函数", () => {
  it("默认只勾选非运行中且有字节的会话/目录，运行中显示原因", () => {
    const rows = buildProjectDataCleanupRows({
      measured,
      tasks: [task("safe", "Safe title"), task("running", "Running title", "running")],
      runningSessionIds: new Set(["running"]),
    });
    expect(rows.sessions).toEqual([
      { sessionId: "running", title: "Running title", bytes: 200, running: true, selected: false },
      { sessionId: "safe", title: "Safe title", bytes: 100, running: false, selected: true },
      { sessionId: "zero", title: "zero", bytes: 0, running: false, selected: false },
    ]);
    expect(rows.directories).toEqual([
      { path: "/work", memoryBytes: 10, checkpointBytes: 20, selected: true },
      { path: "/empty", memoryBytes: 0, checkpointBytes: 0, selected: false },
    ]);
    expect(projectDataCleanupSelection(rows)).toEqual({
      sessionIds: ["safe"],
      directories: ["/work"],
      totalBytes: 130,
    });
  });

  it("运行态优先取实时运行集合，其次取任务持久化状态", () => {
    const rows = buildProjectDataCleanupRows({
      measured: { sessions: [{ sessionId: "persisted", bytes: 1 }], directories: [] },
      tasks: [task("persisted", "Persisted", "running")],
      runningSessionIds: new Set(),
    });
    expect(rows.sessions[0]?.running).toBe(true);
    expect(rows.sessions[0]?.selected).toBe(false);
  });

  it("旧内核、只读旧 Server 与远端项目隐藏入口", () => {
    expect(
      projectDataCleanupAvailable({
        project: { hostId: "local" },
        supported: false,
      }),
    ).toBe(false);
    expect(
      projectDataCleanupAvailable({
        project: { hostId: "local", legacySingleRoot: true },
        supported: true,
      }),
    ).toBe(false);
    expect(
      projectDataCleanupAvailable({
        project: { hostId: "remote:ssh:a" },
        supported: true,
      }),
    ).toBe(false);
    expect(
      projectDataCleanupAvailable({
        project: { hostId: "local" },
        supported: true,
      }),
    ).toBe(true);
    // 未知能力保留入口，由首次测量收敛。
    expect(
      projectDataCleanupAvailable({
        project: { hostId: "local" },
        supported: undefined,
      }),
    ).toBe(true);
  });

  it("重试只重发失败项，并合并已释放字节", () => {
    const first = {
      deleted: [{ sessionId: "deleted", bytes: 10 }],
      kept: [{ sessionId: "running", reason: "running" as const }],
      failed: [
        { sessionId: "failed", code: "io" },
        { workspacePath: "/dir", code: "io" },
      ],
      memory: [{ workspacePath: "/dir", bytes: 5 }],
      checkpoints: [{ workspacePath: "/dir", bytes: 3 }],
    };
    expect(projectDataCleanupRetrySelection(first)).toEqual({
      sessionIds: ["failed"],
      directories: ["/dir"],
    });
    const merged = mergeProjectDataPurgeResults(first, {
      deleted: [{ sessionId: "failed", bytes: 0 }],
      kept: [],
      failed: [],
      memory: [{ workspacePath: "/dir", bytes: 2 }],
      checkpoints: [{ workspacePath: "/dir", bytes: 1 }],
    });
    expect(merged.deleted).toEqual([
      { sessionId: "deleted", bytes: 10 },
      { sessionId: "failed", bytes: 0 },
    ]);
    expect(merged.kept).toEqual([{ sessionId: "running", reason: "running" }]);
    expect(merged.failed).toEqual([]);
    expect(merged.memory).toEqual([{ workspacePath: "/dir", bytes: 7 }]);
    expect(merged.checkpoints).toEqual([{ workspacePath: "/dir", bytes: 4 }]);
    expect(projectDataCleanupFreedBytes(merged)).toBe(21);
  });

  it("重试成功删除后不再把同一会话标为 kept", () => {
    const merged = mergeProjectDataPurgeResults(
      {
        deleted: [],
        kept: [{ sessionId: "s", reason: "referenced" }],
        failed: [{ sessionId: "s", code: "io" }],
        memory: [],
        checkpoints: [],
      },
      {
        deleted: [{ sessionId: "s", bytes: 0 }],
        kept: [],
        failed: [],
        memory: [],
        checkpoints: [],
      },
    );
    expect(merged.kept).toEqual([]);
  });
});
