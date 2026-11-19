import { describe, expect, it } from "vitest";
import { fixture, port } from "../src/project-storage/test-fixture.js";

describe("project storage worktree placement", () => {
  it("persists worktree cwd/root once and lists tasks by worktree", async () => {
    const { db, context } = await fixture(["/work/a"]);
    await port.migrate(db, context);
    const repo = port.repository(db);
    const projectId = repo.readTree({ includeTasks: false }).projects[0]!.id;
    const cwd = "/data/.nibi/worktrees/ab12/repo/packages/app";
    const worktreeRoot = "/data/.nibi/worktrees/ab12/repo";
    const task = { workspacePath: "/work/a", taskId: "sess_wt" };

    repo.reserveCreatedTask({
      task,
      projectId,
      cwd,
      worktreeRoot,
      additionalDirectories: [],
    });
    expect(repo.readTaskCwd(task)).toBe(cwd);
    expect(repo.listTasksByWorktree({ worktreeRoot })).toEqual([
      {
        taskId: "sess_wt",
        workspacePath: "/work/a",
        projectId,
        title: "",
        archived: false,
      },
    ]);
    expect(
      db.prepare("SELECT root_path,worktree_root FROM tasks WHERE task_id='sess_wt'").get(),
    ).toEqual({ root_path: cwd, worktree_root: worktreeRoot });

    // 行已有 CLI 事实时撤销必须保留；无事实时删除预留。
    db.exec("UPDATE tasks SET cli_created_at=1 WHERE task_id='sess_wt'");
    expect(repo.releaseReservedTask({ task })).toBe("kept");
    db.exec("UPDATE tasks SET cli_created_at=NULL WHERE task_id='sess_wt'");
    expect(repo.releaseReservedTask({ task })).toBe("released");
    expect(repo.releaseReservedTask({ task })).toBe("absent");
    expect(repo.readTaskCwd(task)).toBeNull();
  });

  it("inherits a parent worktree placement for same-directory forks", async () => {
    const { db, context } = await fixture(["/work/a"]);
    await port.migrate(db, context);
    const repo = port.repository(db);
    const projectId = repo.readTree({ includeTasks: false }).projects[0]!.id;
    const parentCwd = "/data/.nibi/worktrees/beef/repo/pkg";
    repo.reserveCreatedTask({
      task: { workspacePath: "/work/a", taskId: "parent" },
      projectId,
      cwd: parentCwd,
      worktreeRoot: "/data/.nibi/worktrees/beef/repo",
      additionalDirectories: ["/data/.nibi/worktrees/beef/repo/other"],
    });
    repo.reserveCreatedTask({
      task: { workspacePath: "/work/a", taskId: "child" },
      projectId,
      forkedFromTaskId: "parent",
    });
    expect(repo.readTaskCwd({ workspacePath: "/work/a", taskId: "child" })).toBe(parentCwd);
    expect(
      db
        .prepare("SELECT worktree_root,execution_directories FROM tasks WHERE task_id='child'")
        .get(),
    ).toEqual({
      worktree_root: "/data/.nibi/worktrees/beef/repo",
      execution_directories: JSON.stringify(["/data/.nibi/worktrees/beef/repo/other"]),
    });
    expect(
      repo
        .listTasksByWorktree({ worktreeRoot: "/data/.nibi/worktrees/beef/repo" })
        .map((row) => row.taskId),
    ).toEqual(expect.arrayContaining(["parent", "child"]));
  });
});