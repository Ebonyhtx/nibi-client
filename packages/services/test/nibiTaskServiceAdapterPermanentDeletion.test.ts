import { describe, expect, it, vi } from "vitest";
import { createNibiTaskServiceAdapter } from "#src/nibi-agent/nibiTaskServiceAdapter.js";
import type { INibiAgentService } from "#src/nibi-agent/nibiAgent.js";
import type { NibiTaskIndexSyncer } from "#src/nibi-agent/nibiTaskIndexSyncer.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

const target = { workspacePath: "/repo", taskId: "task-1" };
const workspace = { workspacePath: "/repo" };

function createAdapter(options?: {
  archived?: boolean;
  deleted?: boolean;
  reserve?: boolean;
  execute?: unknown;
  preview?: unknown;
}) {
  const previewSessionDeletion = vi.fn(
    async () =>
      options?.preview ?? {
        sessionId: target.taskId,
        revision: "rev-1",
        sessionIds: [target.taskId, `${target.taskId}-child`],
        forks: [{ sessionId: "fork-1", title: "Fork" }],
        retainedArtifacts: [
          {
            sessionId: target.taskId,
            artifactId: "artifact-1",
            fileName: "report.md",
            referrers: [{ sessionId: "other", title: "Other" }],
          },
        ],
        deletedFiles: 3,
        incomplete: false,
        completed: false,
      },
  );
  const executeSessionDeletion = vi.fn(
    async () =>
      options?.execute ?? {
        sessionId: target.taskId,
        status: "deleted",
        sessionIds: [target.taskId],
        retainedArtifacts: 0,
      },
  );
  const getTaskMembershipState = vi.fn(async () => ({
    archived: options?.archived ?? true,
    deleted: options?.deleted ?? false,
  }));
  const reservePermanentDeletion = vi.fn(async () => options?.reserve ?? true);
  const releasePermanentDeletion = vi.fn(async () => true);
  const completePermanentDeletion = vi.fn(async () => null);
  const emitWorkspaceTaskListChanged = vi.fn();
  const disposable = { dispose: vi.fn() };
  const taskIndexSyncer = {
    mutateSessionFacts: vi.fn(),
    emitWorkspaceTaskListChanged,
    ensureSessionSubscription: vi.fn(),
    onSessionTerminalEvent: vi.fn(() => disposable),
    onSessionReadyEvent: vi.fn(() => disposable),
  } as unknown as NibiTaskIndexSyncer;
  const taskIndexRepo = {
    getTaskMembershipState,
    reservePermanentDeletion,
    releasePermanentDeletion,
    completePermanentDeletion,
  } as unknown as TaskIndexRepo;
  const nibiAgentService = {
    previewSessionDeletion,
    executeSessionDeletion,
  } as unknown as INibiAgentService;
  const service = createNibiTaskServiceAdapter({
    nibiAgentService,
    taskIndexRepo,
    taskIndexSyncer,
  });
  return {
    service,
    previewSessionDeletion,
    executeSessionDeletion,
    reservePermanentDeletion,
    releasePermanentDeletion,
    completePermanentDeletion,
    emitWorkspaceTaskListChanged,
  };
}

describe("permanent archived task deletion", () => {
  it("预览向本机 kernel 查询并映射 willDelete/willKeep", async () => {
    const { service, previewSessionDeletion } = createAdapter();
    await expect(service.previewArchivedTaskDeletion(target)).resolves.toEqual({
      taskId: "task-1",
      revision: "rev-1",
      sessionIds: ["task-1", "task-1-child"],
      forks: [{ sessionId: "fork-1", title: "Fork" }],
      retainedArtifacts: [
        {
          sessionId: "task-1",
          artifactId: "artifact-1",
          fileName: "report.md",
          referrers: [{ sessionId: "other", title: "Other" }],
        },
      ],
      deletedFiles: 3,
      incomplete: false,
      completed: false,
    });
    expect(previewSessionDeletion).toHaveBeenCalledWith({
      sessionId: "task-1",
      workspace,
    });
  });

  it("未归档和已删除拒绝进入永久删除；远程形态的 identity 由拥有者 Host 处理", async () => {
    await expect(
      createAdapter({ archived: false }).service.previewArchivedTaskDeletion(target),
    ).rejects.toThrow("task.not-archived");
    await expect(
      createAdapter({ deleted: true }).service.previewArchivedTaskDeletion(target),
    ).rejects.toThrow("task.not-archived");
    const remote = createAdapter();
    await expect(
      remote.service.previewArchivedTaskDeletion({
        ...target,
        workspaceIdentity: "remote:ssh:host:22:user:/repo",
      }),
    ).resolves.toMatchObject({ revision: "rev-1" });
    expect(remote.previewSessionDeletion).toHaveBeenCalledWith({
      sessionId: "task-1",
      workspace: {
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:host:22:user:/repo",
      },
    });
  });

  it("deleted：预留后执行，完成索引并广播一次删除", async () => {
    const {
      service,
      reservePermanentDeletion,
      executeSessionDeletion,
      completePermanentDeletion,
      releasePermanentDeletion,
      emitWorkspaceTaskListChanged,
    } = createAdapter();
    await expect(
      service.permanentlyDeleteArchivedTask({
        ...target,
        revision: "rev-1",
        operationId: "op-1",
      }),
    ).resolves.toEqual({
      taskId: "task-1",
      status: "deleted",
      sessionIds: ["task-1"],
      retainedArtifacts: 0,
    });
    expect(reservePermanentDeletion).toHaveBeenCalledWith({
      ...target,
      revision: "rev-1",
      operationId: "op-1",
    });
    expect(executeSessionDeletion).toHaveBeenCalledWith({
      sessionId: "task-1",
      workspace,
      revision: "rev-1",
      operationId: "op-1",
    });
    expect(completePermanentDeletion).toHaveBeenCalledWith({
      ...target,
      operationId: "op-1",
    });
    expect(releasePermanentDeletion).not.toHaveBeenCalled();
    expect(emitWorkspaceTaskListChanged).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1" }),
      undefined,
      "task_deleted",
    );
  });

  it("blocked：释放预留，不删索引、不广播", async () => {
    const {
      service,
      completePermanentDeletion,
      releasePermanentDeletion,
      emitWorkspaceTaskListChanged,
    } = createAdapter({
      execute: {
        sessionId: "task-1",
        status: "blocked",
        sessionIds: ["task-1"],
        retainedArtifacts: 0,
        reason: "running",
      },
    });
    await expect(
      service.permanentlyDeleteArchivedTask({
        ...target,
        revision: "rev-1",
        operationId: "op-1",
      }),
    ).resolves.toEqual({
      taskId: "task-1",
      status: "blocked",
      sessionIds: ["task-1"],
      retainedArtifacts: 0,
      reason: "running",
    });
    expect(releasePermanentDeletion).toHaveBeenCalledWith({ ...target, operationId: "op-1" });
    expect(completePermanentDeletion).not.toHaveBeenCalled();
    expect(emitWorkspaceTaskListChanged).not.toHaveBeenCalled();
  });

  it("incomplete：保留预留供续删，行不消失", async () => {
    const { service, completePermanentDeletion, releasePermanentDeletion } = createAdapter({
      execute: {
        sessionId: "task-1",
        status: "incomplete",
        sessionIds: ["task-1"],
        retainedArtifacts: 1,
        reason: "session-data.file-busy",
      },
    });
    await expect(
      service.permanentlyDeleteArchivedTask({
        ...target,
        revision: "rev-1",
        operationId: "op-1",
      }),
    ).resolves.toMatchObject({ status: "incomplete", retainedArtifacts: 1 });
    expect(completePermanentDeletion).not.toHaveBeenCalled();
    expect(releasePermanentDeletion).not.toHaveBeenCalled();
  });

  it("预留失败（确认期间被恢复/已永久删除）时不执行 kernel", async () => {
    const { service, executeSessionDeletion } = createAdapter({ reserve: false });
    await expect(
      service.permanentlyDeleteArchivedTask({
        ...target,
        revision: "rev-1",
        operationId: "op-1",
      }),
    ).rejects.toThrow("task.not-archived");
    expect(executeSessionDeletion).not.toHaveBeenCalled();
  });
});
