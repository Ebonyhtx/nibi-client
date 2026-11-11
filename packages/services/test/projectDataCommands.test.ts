import { describe, expect, it, vi } from "vitest";
import type { ProjectDataPort } from "../src/project/data/contract.js";
import { createProjectDataCommands } from "../src/project/data/project-data.js";
import type {
  ProjectDataRepositoryContract,
  ProjectRepositoryContract,
  ProjectTaskRef,
  VirtualProject,
} from "../src/project-storage/contract.js";

interface FakeTask {
  taskId: string;
  workspacePath: string;
  projectId: string | null;
}

function project(id: string, roots: string[], deleted = false): VirtualProject {
  return {
    id,
    hostId: "local",
    name: id,
    nameOverridden: false,
    roots: roots.map((rootPath, position) => ({
      rootPath,
      position,
      isPrimary: position === 0,
    })),
    pinned: false,
    deleted,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function repository(projects: VirtualProject[], tasks: FakeTask[]) {
  const repository = {
    deleted: [] as string[],
    readTree: vi.fn(() => ({ projects, tasks: [] })),
    readProjectTaskRefs: vi.fn((id: string): ProjectTaskRef[] =>
      tasks
        .filter((task) => task.projectId === id)
        .map((task) => ({ taskId: task.taskId, workspacePath: task.workspacePath })),
    ),
    readTaskScopes: vi.fn(() =>
      tasks.map((task) => ({ projectId: task.projectId, cwd: task.workspacePath })),
    ),
    purgeTasks: vi.fn((refs: readonly ProjectTaskRef[]) => {
      for (const ref of refs) {
        repository.deleted.push(ref.taskId);
        const index = tasks.findIndex(
          (task) => task.taskId === ref.taskId && task.workspacePath === ref.workspacePath,
        );
        if (index >= 0) tasks.splice(index, 1);
      }
    }),
  };
  return repository as typeof repository & ProjectRepositoryContract;
}

function port(overrides: Partial<ProjectDataPort> = {}): ProjectDataPort {
  return {
    supported: vi.fn(async () => true),
    measure: vi.fn(async ({ sessions, directories }) => ({
      sessions: sessions.map((session) => ({ sessionId: session.sessionId, bytes: 10 })),
      directories: directories.map((path) => ({
        path,
        memoryBytes: 20,
        checkpointBytes: 30,
      })),
    })),
    purgeSessions: vi.fn(async (sessions) => ({
      deleted: sessions.map((session) => ({ sessionId: session.sessionId, bytes: 10 })),
      kept: [],
      failed: [],
    })),
    purgeDirectories: vi.fn(async (directories) => ({
      memory: directories.map((workspacePath) => ({ workspacePath, bytes: 20 })),
      checkpoints: directories.map((workspacePath) => ({ workspacePath, bytes: 30 })),
      failed: [],
    })),
    ...overrides,
  };
}

describe("项目数据清理命令", () => {
  it("measure 覆盖项目全部任务，并排除仍被别的项目 root 或任务使用的目录", async () => {
    const repo = repository(
      [project("p1", ["/work"]), project("p2", ["/shared"]), project("gone", ["/old"], true)],
      [
        { taskId: "t1", workspacePath: "/work", projectId: "p1" },
        { taskId: "t2", workspacePath: "/draft", projectId: "p1" },
        { taskId: "t3", workspacePath: "/shared", projectId: "p1" },
        { taskId: "t4", workspacePath: "/other", projectId: "p2" },
        { taskId: "t5", workspacePath: "/global", projectId: null },
        { taskId: "t6", workspacePath: "/old", projectId: "gone" },
      ],
    );
    const dataPort = port();
    const commands = createProjectDataCommands({
      repository: async () => repo,
      data: {
        port: dataPort,
        repository: async () => repo as unknown as ProjectDataRepositoryContract,
      },
      changed: vi.fn(async () => {}),
    });

    const measured = await commands.measureProjectData("p1");
    expect(dataPort.measure).toHaveBeenCalledWith({
      sessions: [
        { sessionId: "t1", cwd: "/work" },
        { sessionId: "t2", cwd: "/draft" },
        { sessionId: "t3", cwd: "/shared" },
      ],
      directories: ["/work", "/draft"],
    });
    expect(measured.directories).toEqual([
      { path: "/work", memoryBytes: 20, checkpointBytes: 30 },
      { path: "/draft", memoryBytes: 20, checkpointBytes: 30 },
    ]);
    expect(measured.sessions.map((session) => session.bytes)).toEqual([10, 10, 10]);
  });

  it("purge 保留运行中/被引用会话，只删已删会话的 Host 行，并排除保留下来的 cwd", async () => {
    const repo = repository(
      [project("p1", ["/work"]), project("p2", ["/shared"]), project("gone", ["/old"], true)],
      [
        { taskId: "done", workspacePath: "/work", projectId: "p1" },
        { taskId: "running", workspacePath: "/draft", projectId: "p1" },
        { taskId: "referenced", workspacePath: "/ref", projectId: "p1" },
        { taskId: "other", workspacePath: "/other", projectId: "p2" },
        { taskId: "old", workspacePath: "/old", projectId: "gone" },
      ],
    );
    const dataPort = port({
      purgeSessions: vi.fn(async () => ({
        deleted: [{ sessionId: "done", bytes: 100 }],
        kept: [
          { sessionId: "running", reason: "running" as const },
          { sessionId: "referenced", reason: "referenced" as const },
        ],
        failed: [],
      })),
    });
    const changed = vi.fn(async () => {});
    const commands = createProjectDataCommands({
      repository: async () => repo,
      data: {
        port: dataPort,
        repository: async () => repo as unknown as ProjectDataRepositoryContract,
      },
      changed,
    });

    const result = await commands.purgeProjectData({ projectId: "p1" });
    expect(result).toEqual({
      deleted: [{ sessionId: "done", bytes: 100 }],
      kept: [
        { sessionId: "running", reason: "running" },
        { sessionId: "referenced", reason: "referenced" },
      ],
      failed: [],
      memory: [{ workspacePath: "/work", bytes: 20 }],
      checkpoints: [{ workspacePath: "/work", bytes: 30 }],
    });
    // 保留下来的会话仍在用自己的 cwd，记忆与检查点不能删。
    expect(dataPort.purgeDirectories).toHaveBeenCalledWith(["/work"]);
    expect(repo.purgeTasks).toHaveBeenCalledWith([{ taskId: "done", workspacePath: "/work" }]);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("目录删除失败时保留任务行，重试按 0 字节成功并清掉行", async () => {
    const tasks: FakeTask[] = [{ taskId: "s1", workspacePath: "/draft", projectId: "p1" }];
    const repo = repository([project("p1", [])], tasks);
    const purgeDirectories = vi
      .fn()
      .mockResolvedValueOnce({
        memory: [],
        checkpoints: [],
        failed: [{ workspacePath: "/draft", code: "project.data-memory-purge-failed" }],
      })
      .mockResolvedValueOnce({
        memory: [{ workspacePath: "/draft", bytes: 0 }],
        checkpoints: [{ workspacePath: "/draft", bytes: 0 }],
        failed: [],
      });
    let purged = false;
    const dataPort = port({
      purgeSessions: vi.fn(async (sessions) => {
        const deleted = purged
          ? sessions.map((session) => ({ sessionId: session.sessionId, bytes: 0 }))
          : sessions.map((session) => ({ sessionId: session.sessionId, bytes: 7 }));
        purged = true;
        return { deleted, kept: [], failed: [] };
      }),
      purgeDirectories,
    });
    const commands = createProjectDataCommands({
      repository: async () => repo,
      data: {
        port: dataPort,
        repository: async () => repo as unknown as ProjectDataRepositoryContract,
      },
      changed: vi.fn(async () => {}),
    });

    const first = await commands.purgeProjectData({
      projectId: "p1",
      sessionIds: ["s1"],
      directories: ["/draft"],
    });
    expect(first.failed).toEqual([
      { workspacePath: "/draft", code: "project.data-memory-purge-failed" },
    ]);
    expect(repo.purgeTasks).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(1);

    const second = await commands.purgeProjectData({
      projectId: "p1",
      sessionIds: ["s1"],
      directories: ["/draft"],
    });
    expect(second.deleted).toEqual([{ sessionId: "s1", bytes: 0 }]);
    expect(second.failed).toEqual([]);
    expect(repo.purgeTasks).toHaveBeenCalledWith([{ taskId: "s1", workspacePath: "/draft" }]);
    expect(tasks).toHaveLength(0);

    // 第三次是纯幂等：任务行已不在，什么都不删。
    const third = await commands.purgeProjectData({
      projectId: "p1",
      sessionIds: ["s1"],
      directories: ["/draft"],
    });
    expect(third.deleted).toEqual([]);
    expect(third.memory).toEqual([]);
    expect(third.failed).toEqual([]);
  });

  it("容量探测：旧内核 false，缺端口或非本机不可用", async () => {
    const repo = repository([project("p1", ["/work"])], []);
    const unsupported = createProjectDataCommands({
      repository: async () => repo,
      data: {
        port: port({ supported: vi.fn(async () => false) }),
        repository: async () => repo as unknown as ProjectDataRepositoryContract,
      },
      changed: vi.fn(async () => {}),
    });
    expect(await unsupported.readProjectDataSupport()).toEqual({ supported: false });

    const unknown = createProjectDataCommands({
      repository: async () => repo,
      data: {
        port: port({ supported: vi.fn(async () => undefined) }),
        repository: async () => repo as unknown as ProjectDataRepositoryContract,
      },
      changed: vi.fn(async () => {}),
    });
    expect(await unknown.readProjectDataSupport()).toEqual({ supported: "unknown" });

    const unavailable = createProjectDataCommands({
      repository: async () => repo,
      changed: vi.fn(async () => {}),
    });
    expect(await unavailable.readProjectDataSupport()).toEqual({ supported: false });
    await expect(unavailable.measureProjectData("p1")).rejects.toThrow("project.data-unavailable");

    const remote = createProjectDataCommands({
      repository: async () => repo,
      ownerHostId: "remote-host",
      data: {
        port: port(),
        repository: async () => repo as unknown as ProjectDataRepositoryContract,
      },
      changed: vi.fn(async () => {}),
    });
    expect(await remote.readProjectDataSupport()).toEqual({ supported: false });
    await expect(remote.measureProjectData("p1")).rejects.toThrow("project.data-local-only");
  });

  it("旧内核的 unsupported 错误从端口原样上抛，Host 不伪造 0 字节成功", async () => {
    const repo = repository([project("p1", ["/work"])], []);
    const commands = createProjectDataCommands({
      repository: async () => repo,
      data: {
        port: port({
          measure: vi.fn(async () => {
            throw new Error("project.data-unsupported");
          }),
        }),
        repository: async () => repo as unknown as ProjectDataRepositoryContract,
      },
      changed: vi.fn(async () => {}),
    });
    await expect(commands.measureProjectData("p1")).rejects.toThrow("project.data-unsupported");
  });
});
