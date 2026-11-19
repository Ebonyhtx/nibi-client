// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectTask, ProjectTree } from "@/project-sidebar/contract.js";
import { buildArchiveGroups, archiveTaskKey } from "@/project-sidebar/archive-view.js";
import { mutateProjectTask } from "@/project-sidebar/task-mutation.js";
import { useArchiveManagement } from "@/project-sidebar/useArchiveManagement.js";

const mocks = vi.hoisted(() => ({
  directory: {} as any,
  mutateTask: vi.fn(),
  preview: vi.fn(),
  permanentDelete: vi.fn(),
  confirm: vi.fn(),
  removeTaskState: vi.fn(),
  findArchiveRow: vi.fn(),
  playFeather: vi.fn(),
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useProjectDirectory: () => mocks.directory,
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ windowControllerService: mocks, nibiTaskService: {} }),
}));
vi.mock("@/project-sidebar/task-mutation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/project-sidebar/task-mutation.js")>();
  return {
    ...actual,
    previewProjectTaskDeletion: mocks.preview,
    permanentlyDeleteProjectTask: mocks.permanentDelete,
  };
});
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => mocks.confirm }));
vi.mock("@/lib/nibiFeatherFall.js", () => ({
  findArchiveTaskRowRect: mocks.findArchiveRow,
  playNibiFeatherFallFromRect: mocks.playFeather,
}));
vi.mock("@/store/nibiSessionStore.js", () => ({
  useNibiSessionStore: (select: any) => select(mocks),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    intl: { formatMessage: ({ id }: any, values: any) => `${id}:${JSON.stringify(values)}` },
  }),
}));
const task = (id: string, extra: Partial<ProjectTask> = {}): ProjectTask => ({
  taskId: id,
  title: id,
  traceId: id,
  workspacePath: "/same",
  hostId: "local",
  projectId: "one",
  pinned: false,
  archived: true,
  createdAt: 1,
  updatedAt: 2,
  mode: "default",
  ...extra,
});
const project = (id: string, extra = {}) => ({
  id,
  hostId: "local",
  name: `Virtual ${id}`,
  roots: [{ rootPath: "/same", isPrimary: true, position: 0 }],
  deleted: false,
  pinned: false,
  position: 0,
  nameOverridden: true,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});
const tree = (): ProjectTree => ({
  projects: [
    project("one"),
    project("two"),
    project("one", { hostId: "remote:server:r", name: "Remote virtual" }),
    project("deleted", { deleted: true }),
  ],
  tasks: [
    task("alpha"),
    task("beta", { projectId: "two", cronAutomationId: "cron" }),
    task("alpha", { hostId: "remote:server:r", workspaceIdentity: "remote:server:r:/same" }),
    task("orphan", { projectId: null }),
    task("old", { projectId: "deleted" }),
    task("active", { archived: false }),
  ],
});

function preview(extra: Record<string, unknown> = {}) {
  return {
    taskId: "alpha",
    revision: "rev-1",
    sessionIds: ["alpha"],
    forks: [],
    retainedArtifacts: [],
    deletedFiles: 1,
    incomplete: false,
    completed: false,
    ...extra,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("groups by virtual identity rather than shared roots and preserves removed/unclassified archives", () => {
  const groups = buildArchiveGroups(tree());
  expect(groups.map((g) => g.tasks.length)).toEqual([1, 1, 1, 1, 1]);
  expect(new Set(groups.map((g) => g.key)).size).toBe(5);
  expect(groups.find((g) => g.project?.id === "deleted")?.project?.deleted).toBe(true);
  expect(groups.find((g) => g.project === undefined)?.tasks[0]?.taskId).toBe("orphan");
  expect(archiveTaskKey(tree().tasks[0]!)).not.toBe(archiveTaskKey(tree().tasks[2]!));
});
it("intersects title/project and switches between CLI updated and created time", () => {
  const t = tree();
  t.tasks.push(task("alpha-second", { createdAt: 9, updatedAt: 1 }));
  const before = JSON.stringify(t);
  const key = buildArchiveGroups(t).find(
    (g) => g.project?.id === "one" && g.hostId === "local",
  )!.key;
  expect(
    buildArchiveGroups(t, { query: "ALPHA", sort: "updated", project: key })[0]?.tasks.map(
      (t) => t.taskId,
    ),
  ).toEqual(["alpha", "alpha-second"]);
  expect(
    buildArchiveGroups(t, { query: "ALPHA", sort: "created", project: key })[0]?.tasks.map(
      (t) => t.taskId,
    ),
  ).toEqual(["alpha-second", "alpha"]);
  expect(JSON.stringify(t)).toBe(before);
});
it("routes archived actions with full remote identity and uses the existing local service fallback", async () => {
  const row = task("same", {
    workspaceIdentity: "remote:server:r:/same",
    hostId: "remote:server:r",
  });
  await mutateProjectTask(
    { controller: mocks, service: {} as never },
    row,
    { kind: "delete" },
    "attachment",
  );
  expect(mocks.mutateTask).toHaveBeenCalledWith({
    address: {
      taskId: "same",
      workspacePath: "/same",
      workspaceIdentity: "remote:server:r:/same",
      remoteSessionId: "attachment",
      sourceServerId: "r",
    },
    mutation: { kind: "delete" },
  });
  const service = { unarchiveTask: vi.fn(async () => row) };
  await mutateProjectTask({ service: service as never }, task("local"), {
    kind: "archive",
    archived: false,
  });
  expect(service.unarchiveTask).toHaveBeenCalledWith({
    workspacePath: "/same",
    workspaceIdentity: undefined,
    taskId: "local",
  });
});
function setup() {
  mocks.directory = {
    tree: tree(),
    directory: { hosts: [], entries: [] },
    availability: new Map(),
    refresh: vi.fn(async () => {}),
    error: null,
    loading: false,
  };
  // 真实确认框会在打开后执行 prepare；测试里显式调用，覆盖“预检完成前取消”的路径。
  mocks.confirm.mockImplementation(async (request: any) => {
    await request.prepare?.();
    return true;
  });
  mocks.preview.mockResolvedValue(preview());
  mocks.permanentDelete.mockResolvedValue({
    taskId: "alpha",
    status: "deleted",
    sessionIds: ["alpha"],
    retainedArtifacts: 0,
  });
  return renderHook(() => useArchiveManagement());
}

it("取消预检不执行永久删除", async () => {
  const { result } = setup();
  mocks.confirm.mockImplementation(async (request: any) => {
    await request.prepare?.();
    return false;
  });
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "delete");
  });
  expect(mocks.preview).toHaveBeenCalledTimes(1);
  expect(mocks.permanentDelete).not.toHaveBeenCalled();
  expect(result.current.result).toBeNull();
});
it("deleted：确认后调用永久删除并移除本地状态", async () => {
  const { result } = setup();
  const rowRect = { right: 100, top: 40, height: 32 } as DOMRect;
  mocks.findArchiveRow.mockReturnValue(rowRect);
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "delete");
  });
  expect(mocks.permanentDelete).toHaveBeenCalledWith(
    { service: {}, controller: mocks },
    expect.objectContaining({ taskId: "alpha" }),
    "rev-1",
    expect.any(String),
    null,
  );
  expect(mocks.removeTaskState).toHaveBeenCalledWith("/same", "alpha", undefined);
  expect(mocks.playFeather).toHaveBeenCalledWith(rowRect);
  expect(result.current.result).toEqual({ succeeded: 1, failed: 0, skipped: 0, incomplete: 0 });
  expect(mocks.directory.refresh).toHaveBeenCalledOnce();
});
it("blocked：不执行删除、不计成功，并展示无法删除的原因", async () => {
  const { result } = setup();
  mocks.preview.mockResolvedValue(preview({ blockedReason: "running" }));
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "delete");
  });
  expect(mocks.permanentDelete).not.toHaveBeenCalled();
  expect(mocks.removeTaskState).not.toHaveBeenCalled();
  expect(result.current.result).toEqual({ succeeded: 0, failed: 1, skipped: 0, incomplete: 0 });
  const request = mocks.confirm.mock.calls[0]![0];
  const patch = await request.prepare();
  expect(patch.confirmDisabled).toBe(true);
  expect(patch.description).toContain("archives.previewCannotDelete");
  expect(patch.description).toContain("archives.previewBlocked.running");
});
it("incomplete：保留行并暴露继续删除，续删成功后收敛", async () => {
  const { result } = setup();
  mocks.preview.mockResolvedValue(preview({ incomplete: true }));
  mocks.permanentDelete.mockResolvedValueOnce({
    taskId: "alpha",
    status: "incomplete",
    sessionIds: ["alpha"],
    retainedArtifacts: 1,
    reason: "session-data.file-busy",
  });
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "delete");
  });
  expect(mocks.removeTaskState).not.toHaveBeenCalled();
  expect(result.current.result).toEqual({ succeeded: 0, failed: 0, skipped: 0, incomplete: 1 });
  expect(result.current.resumable.map((t) => t.taskId)).toEqual(["alpha"]);

  mocks.permanentDelete.mockResolvedValueOnce({
    taskId: "alpha",
    status: "deleted",
    sessionIds: ["alpha"],
    retainedArtifacts: 0,
  });
  await act(async () => {
    await result.current.run(result.current.resumable, "delete");
  });
  expect(mocks.removeTaskState).toHaveBeenCalledWith("/same", "alpha", undefined);
});
it("一次在途批次拒绝重复点击，并跳过确认期间已恢复的归档行", async () => {
  const { result, rerender } = setup();
  let release!: () => void;
  mocks.permanentDelete.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            taskId: "alpha",
            status: "deleted",
            sessionIds: ["alpha"],
            retainedArtifacts: 0,
          });
      }),
  );
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.run([tree().tasks[0]!], "delete");
  });
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "delete");
  });
  expect(mocks.permanentDelete).toHaveBeenCalledTimes(1);
  await act(async () => {
    release();
    await pending;
  });
  expect(mocks.permanentDelete).toHaveBeenCalledTimes(1);

  mocks.directory = {
    ...mocks.directory,
    tree: { ...tree(), tasks: [task("alpha", { archived: false })] },
  };
  rerender();
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "delete");
  });
  expect(mocks.permanentDelete).toHaveBeenCalledTimes(1);
  expect(result.current.result?.skipped).toBe(1);
});
it("unarchive 仍走原有归档写入且不需要永久删除确认", async () => {
  const { result } = setup();
  mocks.mutateTask.mockResolvedValue(null);
  await act(async () => {
    await result.current.run([tree().tasks[0]!], "unarchive");
  });
  expect(mocks.confirm).not.toHaveBeenCalled();
  expect(mocks.mutateTask).toHaveBeenCalledWith({
    address: expect.objectContaining({ taskId: "alpha", workspacePath: "/same" }),
    mutation: { kind: "archive", archived: false },
  });
  expect(result.current.result).toEqual({ succeeded: 1, failed: 0, skipped: 0, incomplete: 0 });
});
