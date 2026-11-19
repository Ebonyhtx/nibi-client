import { seedTaskIndex } from "./helpers/taskIndexFixture.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NibiTaskMeta } from "@nibi/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

const target = { workspacePath: "/workspace/project", taskId: "task-1" };

function createTask(): NibiTaskMeta {
  return {
    taskId: target.taskId,
    traceId: "trace-task-1",
    title: "Task 1",
    workspacePath: target.workspacePath,
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    status: "completed",
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "nibi-task-index-purge-"));
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

describe("TaskIndexRepo permanent deletion", () => {
  it("只给仍归档的 task 预留，并允许续删用新 operationId 覆盖", async () => {
    await seedTaskIndex(repo, { meta: createTask(), archived: true });
    expect(
      await repo.reservePermanentDeletion({
        ...target,
        revision: "rev-1",
        operationId: "op-1",
      }),
    ).toBe(true);
    expect(
      await repo.reservePermanentDeletion({
        ...target,
        revision: "rev-2",
        operationId: "op-2",
      }),
    ).toBe(true);
    // 预检/预留本身不隐藏行。
    expect(await repo.getTaskMeta(target)).not.toBeNull();
    expect(await repo.listPermanentlyDeletedTaskIds(target)).toEqual([]);
  });

  it("拒绝未归档或已删除的 task 预留", async () => {
    await seedTaskIndex(repo, { meta: createTask(), archived: false });
    expect(
      await repo.reservePermanentDeletion({ ...target, revision: "rev", operationId: "op" }),
    ).toBe(false);
    await repo.updateTaskState({ ...target, patch: { archived: true } });
    await repo.applyCliDeletion(target);
    expect(
      await repo.reservePermanentDeletion({ ...target, revision: "rev", operationId: "op" }),
    ).toBe(false);
  });

  it("blocked 回滚只删除同 operationId 的 reserved 预留", async () => {
    await seedTaskIndex(repo, { meta: createTask(), archived: true });
    await repo.reservePermanentDeletion({ ...target, revision: "rev", operationId: "op-1" });
    expect(await repo.releasePermanentDeletion({ ...target, operationId: "op-other" })).toBe(false);
    expect(await repo.releasePermanentDeletion({ ...target, operationId: "op-1" })).toBe(true);
    expect(
      await repo.reservePermanentDeletion({ ...target, revision: "rev-2", operationId: "op-2" }),
    ).toBe(true);
  });

  it("完成后写 purged、删除索引行，并阻止再次预留/恢复", async () => {
    await seedTaskIndex(repo, { meta: createTask(), archived: true });
    await repo.reservePermanentDeletion({ ...target, revision: "rev", operationId: "op-1" });
    await repo.completePermanentDeletion({ ...target, operationId: "op-1" });

    expect(await repo.getTaskMeta(target)).toBeNull();
    expect(await repo.listPermanentlyDeletedTaskIds(target)).toEqual([target.taskId]);
    expect(await repo.releasePermanentDeletion({ ...target, operationId: "op-1" })).toBe(false);
    expect(
      await repo.reservePermanentDeletion({ ...target, revision: "rev", operationId: "op-2" }),
    ).toBe(false);
    // 对账/同步试图重建已永久删除的行时必须失败，不能复活。
    await expect(repo.applyCliFacts({ meta: createTask() })).rejects.toThrow(/task-data\.purged/);
  });

  it("Host 在 reserve 前中断时，complete 仍留下 purged 证据", async () => {
    await seedTaskIndex(repo, { meta: createTask(), archived: true });
    await repo.completePermanentDeletion({ ...target, operationId: "op-1" });
    expect(await repo.getTaskMeta(target)).toBeNull();
    expect(await repo.listPermanentlyDeletedTaskIds(target)).toEqual([target.taskId]);
  });
});
