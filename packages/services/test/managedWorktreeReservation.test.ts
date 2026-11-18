import { describe, expect, it } from "vitest";
import { fixture, port } from "#src/project-storage/test-fixture.js";

describe("managed worktree task reservation", () => {
  it("reserves a worktree cwd under the source project with no extra execution directories", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const project = repo.saveProject({ roots: ["/repo/packages/app"] });
    const task = {
      workspacePath: "/repo/.nibi/worktrees/feature/packages/app",
      taskId: "worktree-task",
    };

    const directories = repo.reserveCreatedTask({
      task,
      projectId: project.id,
      additionalDirectories: [],
      managedWorktree: {
        repoRoot: "/repo",
        worktreeRoot: "/repo/.nibi/worktrees/feature",
      },
    });

    expect(directories).toEqual({
      workspacePath: task.workspacePath,
      projectId: project.id,
      additionalDirectories: [],
    });
    expect(
      db
        .prepare("SELECT project_id,root_path,execution_directories FROM tasks WHERE task_id=?")
        .get(task.taskId),
    ).toEqual({
      project_id: project.id,
      root_path: task.workspacePath,
      execution_directories: "[]",
    });
    expect(repo.resolveSessionDirectories(task).additionalDirectories).toEqual([]);
  });

  it("still rejects unmanaged paths outside project roots", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const project = repo.saveProject({ roots: ["/repo/packages/app"] });

    expect(() =>
      repo.reserveCreatedTask({
        task: { workspacePath: "/outside/task", taskId: "outside" },
        projectId: project.id,
      }),
    ).toThrow("project.cwd-not-in-roots");
  });

  it("rejects a managed marker that is not under a .nibi/worktrees root", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const project = repo.saveProject({ roots: ["/repo"] });

    expect(() =>
      repo.reserveCreatedTask({
        task: {
          workspacePath: "/repo/.nibi/worktrees/feature",
          taskId: "invalid-root",
        },
        projectId: project.id,
        additionalDirectories: [],
        managedWorktree: {
          repoRoot: "/repo",
          worktreeRoot: "/elsewhere/feature",
        },
      }),
    ).toThrow("project.managed-worktree-invalid");
    expect(() =>
      repo.reserveCreatedTask({
        task: {
          workspacePath: "/repo/.nibi/worktrees/feature",
          taskId: "outside-worktree",
        },
        projectId: project.id,
        additionalDirectories: [],
        managedWorktree: {
          repoRoot: "/repo",
          worktreeRoot: "/repo/.nibi/worktrees/other",
        },
      }),
    ).toThrow("project.managed-worktree-workspace-outside");
  });

  it("requires a project and rejects extra execution directories", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const project = repo.saveProject({ roots: ["/repo"] });
    const managedWorktree = {
      repoRoot: "/repo",
      worktreeRoot: "/repo/.nibi/worktrees/feature",
    };

    expect(() =>
      repo.reserveCreatedTask({
        task: {
          workspacePath: "/repo/.nibi/worktrees/feature",
          taskId: "missing-project",
        },
        projectId: null,
        additionalDirectories: [],
        managedWorktree,
      }),
    ).toThrow("project.managed-worktree-project-required");

    expect(() =>
      repo.reserveCreatedTask({
        task: {
          workspacePath: "/repo/.nibi/worktrees/feature",
          taskId: "extra-directories",
        },
        projectId: project.id,
        additionalDirectories: ["/repo/other"],
        managedWorktree,
      }),
    ).toThrow("project.managed-worktree-directories-unsupported");
  });

  it("rejects a worktree belonging to a repository outside the project roots", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const repo = port.repository(db);
    const project = repo.saveProject({ roots: ["/other/project"] });

    expect(() =>
      repo.reserveCreatedTask({
        task: {
          workspacePath: "/repo/.nibi/worktrees/feature",
          taskId: "foreign-repo",
        },
        projectId: project.id,
        additionalDirectories: [],
        managedWorktree: {
          repoRoot: "/repo",
          worktreeRoot: "/repo/.nibi/worktrees/feature",
        },
      }),
    ).toThrow("project.managed-worktree-project-mismatch");
  });

  it("rejects managed worktrees for remote projects", async () => {
    const { db, context } = await fixture();
    await port.migrate(db, context);
    const hostId = "remote:server:worktree";
    db.exec("INSERT INTO hosts(host_id,kind) VALUES ('remote:server:worktree','server')");
    const remote = port.repository(db, hostId);
    const project = remote.saveProject({ roots: ["/remote/repo"] });

    expect(() =>
      remote.reserveCreatedTask({
        task: {
          workspacePath: "/remote/repo/.nibi/worktrees/feature",
          taskId: "remote-worktree",
        },
        projectId: project.id,
        additionalDirectories: [],
        managedWorktree: {
          repoRoot: "/remote/repo",
          worktreeRoot: "/remote/repo/.nibi/worktrees/feature",
        },
      }),
    ).toThrow("project.managed-worktree-local-only");
  });
});
