import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NibiTaskMeta } from "@nibi/shared";
import { setDataBaseDir } from "#src/paths.js";
import { shouldReserveCreatedTask } from "#src/project-storage/project-repository.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

const WORKSPACE = "/workspace/downloads";

function realTask(overrides: Partial<NibiTaskMeta> = {}): NibiTaskMeta {
  return {
    taskId: "session_real",
    traceId: "trace-session-real",
    title: "Real session",
    workspacePath: WORKSPACE,
    createdAt: 100,
    updatedAt: 200,
    mode: "default",
    provider: "glm",
    ...overrides,
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nibi-task-index-placeholder-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  // Windows 需要等待 SQLite 释放文件句柄，避免临时目录清理出现 EPERM。
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rm(tempDir, { recursive: true, force: true });
});

describe("task index unmaterialized creation rows", () => {
  it("keeps reservations out of task lists, project counts and cleanup candidates", async () => {
    const projectRepo = await repo.getProjectRepository();
    const project = projectRepo.saveProject({ roots: [WORKSPACE] });
    const ghost = { workspacePath: WORKSPACE, taskId: "session_ghost" };
    projectRepo.reserveCreatedTask({ task: ghost, projectId: project.id });

    // 列表查询只认 CLI 事实：占位行不进入 active 列表或全局列表。
    expect(
      await repo.queryTaskList({
        workspaceScopes: [{ workspacePath: WORKSPACE }],
        kind: "active",
      }),
    ).toEqual({ items: [], total: 0, hasMore: false });
    expect(await repo.listTaskMetas({ workspacePath: WORKSPACE })).toEqual([]);
    // 项目树的会话数同样只读 CLI 事实。
    expect(projectRepo.readTree().tasks).toEqual([]);
    // 清理候选只包含 CLI 已知会话，不能出现 0 B 幽灵行。
    expect(projectRepo.readProjectTaskRefs(project.id)).toEqual([]);
    // 显式按 ID 读取也不能把占位行当成会话返回。
    expect(
      await repo.getTaskMeta({ workspacePath: WORKSPACE, taskId: "session_ghost" }),
    ).toBeNull();

    // 对账仍能看到占位行，但必须带 unmaterialized 标记，供自愈逻辑判断。
    expect(await repo.listReconciliationRows({ workspacePath: WORKSPACE })).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({ taskId: "session_ghost" }),
        unmaterialized: true,
      }),
    ]);
  });

  it("skips malformed or empty meta rows even when CLI facts exist", async () => {
    const projectRepo = await repo.getProjectRepository();
    const project = projectRepo.saveProject({ roots: [WORKSPACE] });
    await repo.applyCliFacts({
      meta: realTask({ taskId: "session_corrupt" }),
      titleSource: "generated",
    });
    await repo.applyCliFacts({
      meta: realTask({ taskId: "session_valid", title: "Valid" }),
      titleSource: "generated",
    });
    const db = await repo.getOrganizationDatabase();
    db.prepare("UPDATE tasks SET meta_json='{}' WHERE task_id='session_corrupt'").run();

    expect(await repo.listTaskMetas({ workspacePath: WORKSPACE })).toEqual([
      expect.objectContaining({ taskId: "session_valid", title: "Valid" }),
    ]);
    expect(
      await repo.queryTaskList({
        workspaceScopes: [{ workspacePath: WORKSPACE }],
        kind: "active",
        limit: 10,
      }),
    ).toMatchObject({
      total: 1,
      hasMore: false,
      items: [expect.objectContaining({ taskId: "session_valid" })],
    });
    expect(projectRepo.readTree().tasks.map((task) => task.taskId)).toEqual(["session_valid"]);
    expect(projectRepo.readProjectTaskRefs(project.id).map((task) => task.taskId)).toEqual([
      "session_valid",
    ]);
    expect(
      await repo.getTaskMeta({ workspacePath: WORKSPACE, taskId: "session_corrupt" }),
    ).toBeNull();
  });

  it("only reserves index rows for project ownership or explicit execution directories", () => {
    // 草稿预热（v4 createSession 初始 persistence=deferred）没有项目、没有额外目录：
    // 不应写 meta_json='{}' 的占位行。
    expect(shouldReserveCreatedTask({ projectId: null })).toBe(false);
    expect(shouldReserveCreatedTask({ projectId: null, additionalDirectories: [] })).toBe(true);
    expect(shouldReserveCreatedTask({ projectId: "project-a" })).toBe(true);
  });

  it("does not let a placeholder hide a materialized session in the same project", async () => {
    const projectRepo = await repo.getProjectRepository();
    const project = projectRepo.saveProject({ roots: [WORKSPACE] });
    projectRepo.reserveCreatedTask({
      task: { workspacePath: WORKSPACE, taskId: "session_ghost" },
      projectId: project.id,
    });
    await repo.applyCliFacts({ meta: realTask(), titleSource: "generated" });

    expect(projectRepo.readTree().tasks.map((task) => task.taskId)).toEqual(["session_real"]);
    expect(projectRepo.readProjectTaskRefs(project.id)).toEqual([
      { taskId: "session_real", workspacePath: WORKSPACE },
    ]);
  });

  it("removes only unmaterialized rows through the explicit cleanup API", async () => {
    const projectRepo = await repo.getProjectRepository();
    projectRepo.reserveCreatedTask({
      task: { workspacePath: WORKSPACE, taskId: "session_ghost" },
      projectId: null,
    });
    await expect(
      repo.removeUnmaterializedTask({
        workspacePath: WORKSPACE,
        taskId: "session_ghost",
      }),
    ).resolves.toBe(true);
    expect(await repo.listReconciliationRows({ workspacePath: WORKSPACE })).toEqual([]);

    await repo.applyCliFacts({ meta: realTask(), titleSource: "generated" });
    await expect(
      repo.removeUnmaterializedTask({
        workspacePath: WORKSPACE,
        taskId: "session_real",
      }),
    ).resolves.toBe(false);
    expect(
      await repo.getTaskMeta({
        workspacePath: WORKSPACE,
        taskId: "session_real",
      }),
    ).toMatchObject({ taskId: "session_real", title: "Real session" });
  });

  it("prunes orphan-confirmed placeholders on startup but keeps fresh reservations", async () => {
    const projectRepo = await repo.getProjectRepository();
    projectRepo.reserveCreatedTask({
      task: { workspacePath: WORKSPACE, taskId: "session_orphan" },
      projectId: null,
    });
    await repo.markCliOrphan({
      workspacePath: WORKSPACE,
      taskId: "session_orphan",
    });
    projectRepo.reserveCreatedTask({
      task: { workspacePath: WORKSPACE, taskId: "session_fresh" },
      projectId: null,
    });
    await repo.applyCliFacts({
      meta: realTask({ updatedAt: 300 }),
      titleSource: "generated",
    });
    await repo.applyCliDeletion({
      workspacePath: WORKSPACE,
      taskId: "session_real",
    });
    // 有 CLI 事实的已删行会被 orphan 标记，但启动清理不能删它（tombstone 是用户数据）。
    await repo.markCliOrphan({
      workspacePath: WORKSPACE,
      taskId: "session_real",
    });
    repo.close();

    repo = new TaskIndexRepo(undefined, undefined, undefined, undefined, true);
    await repo.ensureReady();

    const rows = await repo.listReconciliationRows({
      workspacePath: WORKSPACE,
    });
    expect(rows.map((row) => row.meta.taskId).sort()).toEqual(["session_fresh", "session_real"]);
    expect(rows.find((row) => row.meta.taskId === "session_fresh")?.unmaterialized).toBe(true);
    expect(rows.find((row) => row.meta.taskId === "session_real")?.unmaterialized).toBe(false);
  });

  it("prunes legacy placeholders absent from the CLI session database", async () => {
    const projectRepo = await repo.getProjectRepository();
    for (const taskId of ["session_absent", "session_persisted"]) {
      projectRepo.reserveCreatedTask({
        task: { workspacePath: WORKSPACE, taskId },
        projectId: null,
      });
    }
    // 真实 CLI 事实行不能被启动自愈删除，即使 session 库不可读。
    await repo.applyCliFacts({
      meta: realTask({ taskId: "session_materialized" }),
      titleSource: "generated",
    });
    const sessionDbPath = join(tempDir, "cli-session.sqlite");
    const sessionDb = new DatabaseSync(sessionDbPath);
    sessionDb.exec("CREATE TABLE session(id TEXT PRIMARY KEY)");
    sessionDb.prepare("INSERT INTO session(id) VALUES('session_persisted')").run();
    sessionDb.close();
    repo.close();

    repo = new TaskIndexRepo(undefined, undefined, undefined, undefined, true, sessionDbPath);
    await repo.ensureReady();

    expect(
      (await repo.listReconciliationRows({ workspacePath: WORKSPACE }))
        .map((row) => row.meta.taskId)
        .sort(),
    ).toEqual(["session_materialized", "session_persisted"]);
  });

  it("does not prune from a non-startup repo instance", async () => {
    const projectRepo = await repo.getProjectRepository();
    projectRepo.reserveCreatedTask({
      task: { workspacePath: WORKSPACE, taskId: "session_orphan" },
      projectId: null,
    });
    await repo.markCliOrphan({
      workspacePath: WORKSPACE,
      taskId: "session_orphan",
    });
    repo.close();

    repo = new TaskIndexRepo();
    await repo.ensureReady();
    expect(
      (await repo.listReconciliationRows({ workspacePath: WORKSPACE })).map(
        (row) => row.meta.taskId,
      ),
    ).toEqual(["session_orphan"]);
  });
});
