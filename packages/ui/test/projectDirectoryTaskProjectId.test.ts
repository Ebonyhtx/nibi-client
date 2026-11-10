import { expect, it } from "vitest";
import type { ProjectTask, ProjectTree } from "@/project-sidebar/contract.js";
import { readDirectoryTaskProjectId } from "@/project-sidebar/view.js";

const task = (overrides: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: "session-1",
  projectId: "project-a",
  hostId: "local",
  pinned: false,
  archived: false,
  workspacePath: "/workspace",
  title: "session",
  mode: "build",
  traceId: "session-1",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const tree = (...tasks: ProjectTask[]): Pick<ProjectTree, "tasks"> => ({ tasks });

it("按任务地址命中目录行时返回其项目归属", () => {
  expect(
    readDirectoryTaskProjectId(tree(task()), {
      taskId: "session-1",
      hostId: "local",
      workspacePath: "/workspace",
    }),
  ).toBe("project-a");
});

it("行存在但未归类返回 null，与缺行区分", () => {
  expect(
    readDirectoryTaskProjectId(tree(task({ projectId: null })), {
      taskId: "session-1",
      hostId: "local",
      workspacePath: "/workspace",
    }),
  ).toBeNull();
});

it("缺行或没有窗口目录时返回 undefined，调用方需回退查询", () => {
  const address = { taskId: "session-1", hostId: "local", workspacePath: "/workspace" };
  expect(readDirectoryTaskProjectId(tree(), address)).toBeUndefined();
  expect(readDirectoryTaskProjectId(tree(task({ taskId: "other" })), address)).toBeUndefined();
  expect(readDirectoryTaskProjectId(null, address)).toBeUndefined();
});

it("按 host 与 workspace identity 隔离同路径任务", () => {
  const address = {
    taskId: "session-1",
    hostId: "source:server-1",
    workspacePath: "/workspace",
    workspaceIdentity: "remote:server-1:/workspace",
  };
  const remote = task({
    hostId: "source:server-1",
    workspacePath: "/workspace",
    workspaceIdentity: "remote:server-1:/workspace",
  });
  expect(readDirectoryTaskProjectId(tree(remote), address)).toBe("project-a");
  // 同路径的另一台设备/本机行不能被当成命中。
  expect(readDirectoryTaskProjectId(tree(task()), address)).toBeUndefined();
  expect(
    readDirectoryTaskProjectId(
      tree(task({ hostId: "source:server-1", workspaceIdentity: "remote:server-2:/workspace" })),
      address,
    ),
  ).toBeUndefined();
});
