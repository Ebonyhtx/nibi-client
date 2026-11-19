import { describe, expect, it, vi } from "vitest";
import { createAppControlNavigationService } from "../src/app-control/navigation.js";
import { createAppControlService } from "../src/app-control/index.js";
import { createAppControlReverseRpc } from "../src/app-control/reverseRpc.js";
import { createTrustedContext, hostScope } from "../src/app-control/context.js";
import type { AppControlOpenSessionResult } from "../src/app-control/contract.js";
import type { AppControlNavigationRuntime } from "../src/app-control/navigation.js";

const WORKSPACE = "/workspace";

function project(id: string, name: string) {
  return {
    id,
    hostId: "local",
    name,
    nameOverridden: false,
    roots: [{ rootPath: `/workspace/${id}`, position: 0, isPrimary: true }],
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

function task(taskId: string, projectId: string | null, archived = false) {
  return {
    taskId,
    traceId: `trace_${taskId}`,
    title: taskId,
    workspacePath: `/workspace/${projectId ?? "global"}`,
    projectId,
    hostId: "local",
    pinned: false,
    archived,
    createdAt: 0,
    updatedAt: 0,
    mode: "build",
  };
}

function remoteDirectory() {
  return {
    hosts: [
      {
        id: "remote-1",
        membershipId: "m1",
        kind: "ssh",
        target: null,
        position: 1,
        connectionStatus: "online",
      },
    ],
    entries: [
      {
        id: "e1",
        hostId: "remote-1",
        projectId: "p9",
        name: "Remote",
        roots: [{ rootPath: "/remote/p9", position: 0, isPrimary: true }],
        legacyWorkspace: null,
        lastSyncedAt: 0,
      },
    ],
  };
}

function remoteController(options?: {
  mutateTask?: ReturnType<typeof vi.fn>;
  archivedTaskIds?: string[];
}) {
  const mutateTask = options?.mutateTask ?? vi.fn(async () => ({ taskId: "sess_remote" }));
  const getTaskMeta = vi.fn(async (params: { address: { taskId: string } }) =>
    params.address.taskId === "sess_remote"
      ? { taskId: "sess_remote", workspacePath: "/remote/p9", sourceServerId: "remote-1" }
      : null,
  );
  const listTaskList = vi.fn(async () => ({
    items: (options?.archivedTaskIds ?? []).map((taskId) => ({ taskId })),
    total: (options?.archivedTaskIds ?? []).length,
    hasMore: false,
  }));
  return { mutateTask, getTaskMeta, listTaskList };
}

function projectService(tree: {
  projects?: ReturnType<typeof project>[];
  tasks?: ReturnType<typeof task>[];
}) {
  return {
    readTree: vi.fn(async () => ({
      projects: tree.projects ?? [],
      tasks: tree.tasks ?? [],
    })),
    readProjects: vi.fn(async () => tree.projects ?? []),
  } as never;
}

function remoteService(directory: {
  hosts: Array<Record<string, unknown>>;
  entries: Array<Record<string, unknown>>;
}) {
  return { readDirectory: vi.fn(async () => directory) } as never;
}

function navigation(
  openSession: AppControlNavigationRuntime["openSession"] = vi.fn(
    async (): Promise<AppControlOpenSessionResult> => ({
      status: "unavailable",
      reason: "No app window is listening for open requests",
    }),
  ),
): AppControlNavigationRuntime {
  return {
    service: { onOpenSession: vi.fn(), settleOpenSession: vi.fn() } as never,
    openSession,
    dispose: vi.fn(),
  };
}

describe("App control discovery", () => {
  it("lists local projects and reports offline remote sources", async () => {
    const service = createAppControlService({
      projectService: projectService({
        projects: [project("p1", "Alpha"), project("p2", "Beta")],
        tasks: [task("sess_1", "p1")],
      }),
      remoteProjectService: remoteService({
        hosts: [
          { id: "remote-online", membershipId: "m1", kind: "ssh", target: null, position: 1, connectionStatus: "online" },
          { id: "remote-offline", membershipId: "m2", kind: "ssh", target: null, position: 2, connectionStatus: "offline" },
          { id: "remote-legacy", membershipId: "m3", kind: "server", target: null, position: 3, connectionStatus: "online" },
        ],
        entries: [
          {
            id: "e1",
            hostId: "remote-online",
            projectId: "p9",
            name: "Remote",
            roots: [{ rootPath: "/remote/p9", position: 0, isPrimary: true }],
            legacyWorkspace: null,
            lastSyncedAt: 0,
          },
          {
            id: "e2",
            hostId: "remote-offline",
            projectId: "p8",
            name: "Offline",
            roots: [{ rootPath: "/remote/p8", position: 0, isPrimary: true }],
            legacyWorkspace: null,
            lastSyncedAt: 0,
          },
          {
            id: "e3",
            hostId: "remote-legacy",
            projectId: null,
            name: "Legacy",
            roots: [{ rootPath: "/remote/legacy", position: 0, isPrimary: true }],
            legacyWorkspace: { workspacePath: "/remote/legacy" },
            lastSyncedAt: 0,
          },
        ],
      }),
      navigation: navigation(),
    });
    const ctx = createTrustedContext(
      {
        callerSessionId: "sess_root",
        callId: "call-1",
        workspacePath: WORKSPACE,
        input: {},
      },
      [],
    );
    const result = await service.listProjects(ctx, {});
    expect(result.projects.map((entry) => entry.title)).toEqual(["Alpha", "Beta", "Remote"]);
    expect(result.projects.find((entry) => entry.title === "Remote")?.project).toEqual({
      kind: "app",
      projectId: "p9",
      sourceServerId: "remote-online",
    });
    expect(result.searchScope.scopes).toEqual([
      hostScope(),
      hostScope("remote-online"),
    ]);
    expect(result.searchScope.unavailableSources).toEqual([
      { sourceServerId: "remote-offline", reason: "offline" },
      { sourceServerId: "remote-legacy", reason: "legacy project without a stable project id" },
    ]);
  });

  it("filters by title and project id", async () => {
    const service = createAppControlService({
      projectService: projectService({
        projects: [project("alpha-1", "Alpha"), project("beta-2", "Beta")],
      }),
      navigation: navigation(),
    });
    const ctx = createTrustedContext(
      { callerSessionId: "sess_root", callId: "call-1", workspacePath: WORKSPACE, input: {} },
      [],
    );
    expect((await service.listProjects(ctx, { query: "BET" })).projects).toHaveLength(1);
    expect((await service.listProjects(ctx, { query: "alpha-1" })).projects).toHaveLength(1);
    expect((await service.listProjects(ctx, { query: "none" })).projects).toHaveLength(0);
  });

  it("reports a missing project service instead of pretending the host was searched", async () => {
    const service = createAppControlService({ navigation: navigation() });
    const ctx = createTrustedContext(
      { callerSessionId: "sess_root", callId: "call-1", workspacePath: WORKSPACE, input: {} },
      [],
    );
    const result = await service.listProjects(ctx, {});
    expect(result.searchScope.scopes).toEqual([]);
    expect(result.searchScope.unavailableSources).toEqual([
      { sourceServerId: "local", reason: "Project service is unavailable" },
    ]);
  });

  it("rejects sessions outside the discovered tasks", async () => {
    const service = createAppControlService({
      projectService: projectService({ tasks: [task("sess_1", "p1")] }),
      navigation: navigation(),
    });
    const ctx = createTrustedContext(
      { callerSessionId: "sess_root", callId: "call-1", workspacePath: WORKSPACE, input: {} },
      [],
    );
    await expect(
      service.setSessionArchived(ctx, { sessionId: "sess_unknown", archived: true, requestId: "r1" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("App control mutations", () => {
  it("routes local archive/pin through the window controller and echoes requestId", async () => {
    const mutateTask = vi.fn(async () => ({ taskId: "sess_1" }));
    const service = createAppControlService({
      projectService: projectService({ tasks: [task("sess_1", "p1")] }),
      resolveWindowControllerService: () => ({ getTaskMeta: vi.fn(), mutateTask }) as never,
      navigation: navigation(),
    });
    const ctx = createTrustedContext(
      { callerSessionId: "sess_root", callId: "call-1", workspacePath: WORKSPACE, input: {} },
      [],
    );
    await expect(
      service.setSessionArchived(ctx, { sessionId: "sess_1", archived: true, requestId: "req-1" }),
    ).resolves.toEqual({ status: "applied", requestId: "req-1" });
    expect(mutateTask).toHaveBeenCalledWith({
      address: { taskId: "sess_1", workspacePath: "/workspace/p1" },
      mutation: { kind: "archive", archived: true },
    });
  });

  it("falls back to the task service when there is no window controller", async () => {
    const archiveTask = vi.fn(async () => ({ taskId: "sess_1" }));
    const unarchiveTask = vi.fn(async () => ({ taskId: "sess_1" }));
    const setTaskPinned = vi.fn(async () => ({ taskId: "sess_1" }));
    const service = createAppControlService({
      projectService: projectService({ tasks: [task("sess_1", "p1")] }),
      taskService: { archiveTask, unarchiveTask, setTaskPinned },
      navigation: navigation(),
    });
    const ctx = createTrustedContext(
      { callerSessionId: "sess_root", callId: "call-1", workspacePath: WORKSPACE, input: {} },
      [],
    );
    await service.setSessionArchived(ctx, { sessionId: "sess_1", archived: true, requestId: "r1" });
    await service.setSessionArchived(ctx, { sessionId: "sess_1", archived: false, requestId: "r2" });
    await service.setSessionPinned(ctx, { sessionId: "sess_1", pinned: true, requestId: "r3" });
    expect(archiveTask).toHaveBeenCalledTimes(1);
    expect(unarchiveTask).toHaveBeenCalledTimes(1);
    expect(setTaskPinned).toHaveBeenCalledWith({
      taskId: "sess_1",
      workspacePath: "/workspace/p1",
      pinned: true,
    });
  });

  it("returns unknown instead of applied when the task index yields no task", async () => {
    const service = createAppControlService({
      projectService: projectService({ tasks: [task("sess_1", "p1")] }),
      resolveWindowControllerService: () => ({ getTaskMeta: vi.fn(), mutateTask: vi.fn(async () => null) }) as never,
      navigation: navigation(),
    });
    const ctx = createTrustedContext(
      { callerSessionId: "sess_root", callId: "call-1", workspacePath: WORKSPACE, input: {} },
      [],
    );
    await expect(
      service.setSessionPinned(ctx, { sessionId: "sess_1", pinned: true, requestId: "r1" }),
    ).resolves.toEqual({ status: "unknown", requestId: "r1", reason: "Task index returned no task" });
  });

  it("routes a remote session mutation to its owning source without touching the local index", async () => {
    const archiveTask = vi.fn();
    const controller = remoteController();
    const service = createAppControlService({
      remoteProjectService: remoteService(remoteDirectory()),
      resolveWindowControllerService: () => controller as never,
      taskService: { archiveTask, unarchiveTask: vi.fn(), setTaskPinned: vi.fn() },
      navigation: navigation(),
    });
    const ctx = createTrustedContext(
      { callerSessionId: "sess_root", callId: "call-1", workspacePath: WORKSPACE, input: {} },
      [],
    );
    await expect(
      service.setSessionArchived(ctx, {
        sessionId: "sess_remote",
        archived: true,
        requestId: "r1",
      }),
    ).resolves.toEqual({ status: "applied", requestId: "r1" });
    expect(controller.mutateTask).toHaveBeenCalledWith({
      address: {
        taskId: "sess_remote",
        workspacePath: "/remote/p9",
        sourceServerId: "remote-1",
      },
      mutation: { kind: "archive", archived: true },
    });
    expect(archiveTask).not.toHaveBeenCalled();
  });

  it("does not let a source host discover or mutate another source", async () => {
    const archiveTask = vi.fn(async () => ({ taskId: "sess_local" }));
    const service = createAppControlService({
      sourceServerId: "source-a",
      projectService: projectService({
        projects: [project("p1", "Alpha")],
        tasks: [task("sess_local", "p1")],
      }),
      remoteProjectService: remoteService(remoteDirectory()),
      taskService: { archiveTask, unarchiveTask: vi.fn(), setTaskPinned: vi.fn() },
      navigation: navigation(),
    });
    const ctx = createTrustedContext(
      { callerSessionId: "sess_root", callId: "call-1", workspacePath: WORKSPACE, input: {} },
      [],
    );
    const listed = await service.listProjects(ctx, {});
    expect(listed.projects.map((entry) => entry.project)).toEqual([
      { kind: "app", projectId: "p1", sourceServerId: "source-a" },
    ]);
    expect(listed.searchScope.scopes).toEqual([hostScope("source-a")]);
    await expect(
      service.setSessionArchived(ctx, {
        sessionId: "sess_remote",
        archived: true,
        requestId: "r1",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(archiveTask).not.toHaveBeenCalled();
    await expect(
      service.setSessionArchived(ctx, {
        sessionId: "sess_local",
        archived: true,
        requestId: "r2",
      }),
    ).resolves.toEqual({ status: "applied", requestId: "r2" });
    expect(archiveTask).toHaveBeenCalledWith({
      taskId: "sess_local",
      workspacePath: "/workspace/p1",
    });
  });

  it("does not fall back to the local task index when the owning host rejects a remote mutation", async () => {
    const setTaskPinned = vi.fn();
    const controller = remoteController({
      mutateTask: vi.fn(async () => {
        throw new Error("owning host offline");
      }),
    });
    const service = createAppControlService({
      remoteProjectService: remoteService(remoteDirectory()),
      resolveWindowControllerService: () => controller as never,
      taskService: { archiveTask: vi.fn(), unarchiveTask: vi.fn(), setTaskPinned },
      navigation: navigation(),
    });
    const ctx = createTrustedContext(
      { callerSessionId: "sess_root", callId: "call-1", workspacePath: WORKSPACE, input: {} },
      [],
    );
    await expect(
      service.setSessionPinned(ctx, { sessionId: "sess_remote", pinned: true, requestId: "r1" }),
    ).resolves.toEqual({ status: "unknown", requestId: "r1", reason: "owning host offline" });
    expect(setTaskPinned).not.toHaveBeenCalled();
  });

  it("rejects cross-source mutation when the window controller is absent", async () => {
    const service = createAppControlService({
      remoteProjectService: remoteService({
        hosts: [
          { id: "remote-1", membershipId: "m1", kind: "ssh", target: null, position: 1, connectionStatus: "online" },
        ],
        entries: [
          {
            id: "e1",
            hostId: "remote-1",
            projectId: "p9",
            name: "Remote",
            roots: [{ rootPath: "/remote/p9", position: 0, isPrimary: true }],
            legacyWorkspace: null,
            lastSyncedAt: 0,
          },
        ],
      }),
      navigation: navigation(),
    });
    // 没有 window controller 时远端会话无法解析，按 forbidden 失败（fail closed）。
    const ctx = createTrustedContext(
      { callerSessionId: "sess_root", callId: "call-1", workspacePath: WORKSPACE, input: {} },
      [],
    );
    await expect(
      service.setSessionArchived(ctx, { sessionId: "sess_remote", archived: true, requestId: "r1" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("App control archived targets", () => {
  const ctx = createTrustedContext(
    { callerSessionId: "sess_root", callId: "call-1", workspacePath: WORKSPACE, input: {} },
    [],
  );

  it("rejects opening an archived local task without firing navigation", async () => {
    const openSession = vi.fn(async () => ({ status: "opened" as const, uiTarget: "window:1" }));
    const service = createAppControlService({
      projectService: projectService({ tasks: [task("sess_archived", "p1", true)] }),
      navigation: navigation(openSession as never),
    });
    await expect(service.openSession(ctx, { sessionId: "sess_archived" })).resolves.toEqual({
      status: "unavailable",
      reason: "project.task-not-found",
    });
    expect(openSession).not.toHaveBeenCalled();
  });

  it("rejects opening an archived remote task using the owning host projection", async () => {
    const openSession = vi.fn(async () => ({ status: "opened" as const, uiTarget: "window:1" }));
    const controller = remoteController({ archivedTaskIds: ["sess_remote"] });
    const service = createAppControlService({
      remoteProjectService: remoteService(remoteDirectory()),
      resolveWindowControllerService: () => controller as never,
      navigation: navigation(openSession as never),
    });
    await expect(service.openSession(ctx, { sessionId: "sess_remote" })).resolves.toEqual({
      status: "unavailable",
      reason: "project.task-not-found",
    });
    expect(controller.listTaskList).toHaveBeenCalledWith({
      kind: "archived",
      workspaceScopes: [{ workspacePath: "/remote/p9" }],
      sortBy: "updated",
      limit: 200,
    });
    expect(openSession).not.toHaveBeenCalled();
  });

  it("fails closed when a remote archive projection is unavailable", async () => {
    const openSession = vi.fn(async () => ({ status: "opened" as const, uiTarget: "window:1" }));
    const controller = remoteController();
    controller.listTaskList.mockRejectedValueOnce(new Error("projection unavailable"));
    const service = createAppControlService({
      remoteProjectService: remoteService(remoteDirectory()),
      resolveWindowControllerService: () => controller as never,
      navigation: navigation(openSession as never),
    });
    await expect(service.openSession(ctx, { sessionId: "sess_remote" })).resolves.toEqual({
      status: "unavailable",
      reason: "project.task-not-found",
    });
    expect(openSession).not.toHaveBeenCalled();
  });

  it("routes a non-archived remote open to the bound UI with its source", async () => {
    const openSession = vi.fn(async () => ({ status: "opened" as const, uiTarget: "window:1" }));
    const controller = remoteController();
    const service = createAppControlService({
      remoteProjectService: remoteService(remoteDirectory()),
      resolveWindowControllerService: () => controller as never,
      navigation: navigation(openSession as never),
    });
    await expect(service.openSession(ctx, { sessionId: "sess_remote" })).resolves.toEqual({
      status: "opened",
      uiTarget: "window:1",
    });
    expect(openSession).toHaveBeenCalledWith(
      {
        sessionId: "sess_remote",
        workspacePath: "/remote/p9",
        sourceServerId: "remote-1",
        projectId: "p9",
      },
      undefined,
    );
  });
});

describe("App control navigation", () => {
  it("opens through the event channel and settles with a uiTarget", async () => {
    const runtime = createAppControlNavigationService({ createRequestId: () => "open-1" });
    const subscription = runtime.service.onOpenSession()((event) => {
      expect(event).toMatchObject({ requestId: "open-1", sessionId: "sess_1" });
      runtime.service.settleOpenSession({ requestId: "open-1", uiTarget: "window:1" });
    });
    await expect(
      runtime.openSession({ sessionId: "sess_1", workspacePath: WORKSPACE }),
    ).resolves.toEqual({ status: "opened", uiTarget: "window:1" });
    subscription.dispose();
    runtime.dispose();
  });

  it("fails closed when no window is listening", async () => {
    const runtime = createAppControlNavigationService({ createRequestId: () => "open-1" });
    await expect(
      runtime.openSession({ sessionId: "sess_1", workspacePath: WORKSPACE }),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "No app window is listening for open requests",
    });
    runtime.dispose();
  });

  it("times out when the window never settles", async () => {
    vi.useFakeTimers();
    try {
      const runtime = createAppControlNavigationService({ timeoutMs: 100, createRequestId: () => "open-1" });
      const subscription = runtime.service.onOpenSession()(() => {});
      const pending = runtime.openSession({ sessionId: "sess_1", workspacePath: WORKSPACE });
      await vi.advanceTimersByTimeAsync(101);
      await expect(pending).resolves.toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("did not accept"),
      });
      subscription.dispose();
      runtime.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("App control reverse RPC", () => {
  const params = {
    callerSessionId: "sess_root",
    callId: "call-1",
    workspacePath: WORKSPACE,
    input: {},
  };

  it("returns the unavailable envelope for unknown methods", async () => {
    const rpc = createAppControlReverseRpc({
      service: createAppControlService({ navigation: navigation() }),
    });
    await expect(rpc.handle("appControl/wipe", params)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  });

  it("validates input strictly and maps errors to the envelope", async () => {
    const service = createAppControlService({
      projectService: projectService({ tasks: [] }),
      navigation: navigation(),
    });
    const rpc = createAppControlReverseRpc({ service });
    await expect(
      rpc.handle("appControl/listProjects", { ...params, extra: true }),
    ).resolves.toMatchObject({ ok: false, error: { code: "invalid_input" } });
    await expect(
      rpc.handle("appControl/openSession", {
        ...params,
        input: { sessionId: "sess_unknown" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("exposes archived state for fork gating without leaking unknown targets", async () => {
    const rpc = createAppControlReverseRpc({
      service: createAppControlService({
        projectService: projectService({
          tasks: [task("sess_archived", "p1", true), task("sess_active", "p1")],
        }),
        navigation: navigation(),
      }),
    });
    await expect(
      rpc.handle("appControl/sessionArchived", {
        ...params,
        input: { sessionId: "sess_archived" },
      }),
    ).resolves.toEqual({ ok: true, result: { archived: true } });
    await expect(
      rpc.handle("appControl/sessionArchived", {
        ...params,
        input: { sessionId: "sess_active" },
      }),
    ).resolves.toEqual({ ok: true, result: { archived: false } });
    await expect(
      rpc.handle("appControl/sessionArchived", {
        ...params,
        input: { sessionId: "sess_unknown" },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("fails closed when a remote archive projection is unavailable", async () => {
    const controller = remoteController();
    controller.listTaskList.mockRejectedValueOnce(new Error("projection unavailable"));
    const rpc = createAppControlReverseRpc({
      service: createAppControlService({
        remoteProjectService: remoteService(remoteDirectory()),
        resolveWindowControllerService: () => controller as never,
        navigation: navigation(),
      }),
    });
    await expect(
      rpc.handle("appControl/sessionArchived", {
        ...params,
        input: { sessionId: "sess_remote" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable", message: "Session archive state is unavailable" },
    });
  });

  it("deduplicates a requestId with the same payload and conflicts on a different one", async () => {
    const mutateTask = vi.fn(async () => ({ taskId: "sess_1" }));
    const rpc = createAppControlReverseRpc({
      service: createAppControlService({
        projectService: projectService({ tasks: [task("sess_1", "p1")] }),
        resolveWindowControllerService: () => ({ getTaskMeta: vi.fn(), mutateTask }) as never,
        navigation: navigation(),
      }),
    });
    const input = { sessionId: "sess_1", archived: true, requestId: "req-1" };
    await expect(
      rpc.handle("appControl/setSessionArchived", { ...params, input }),
    ).resolves.toMatchObject({ ok: true, result: { status: "applied", requestId: "req-1" } });
    await expect(
      rpc.handle("appControl/setSessionArchived", { ...params, input }),
    ).resolves.toMatchObject({ ok: true, result: { status: "applied", requestId: "req-1" } });
    expect(mutateTask).toHaveBeenCalledTimes(1);
    await expect(
      rpc.handle("appControl/setSessionArchived", {
        ...params,
        input: { ...input, archived: false },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("cancel aborts an in-flight open", async () => {
    let seen: AbortSignal | undefined;
    const openSession = vi.fn((_request, signal?: AbortSignal) => {
      seen = signal;
      return new Promise<AppControlOpenSessionResult>((resolve) => {
        signal?.addEventListener("abort", () =>
          resolve({ status: "unavailable", reason: "cancelled" }),
        );
      });
    });
    const rpc = createAppControlReverseRpc({
      service: createAppControlService({
        projectService: projectService({ tasks: [task("sess_1", "p1")] }),
        navigation: navigation(openSession as never),
      }),
    });
    const pending = rpc.handle("appControl/openSession", {
      ...params,
      input: { sessionId: "sess_1" },
    });
    await vi.waitFor(() => expect(seen).toBeDefined());
    expect(seen?.aborted).toBe(false);
    await rpc.handle("appControl/cancel", { ...params, input: {} });
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
  });
});