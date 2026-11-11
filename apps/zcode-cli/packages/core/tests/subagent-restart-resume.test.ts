import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectId,
  createSessionId,
  createTraceId,
  type SessionId,
  type SubagentPort,
  type SubagentRestoreSessionParams,
  type TraceContext,
} from "@nibi/contracts";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import {
  createExploreSubagentPort,
  type ExploreSubagentPortOptions,
  type ExploreSubagentRuntimeRequest,
  type ParentTaskNotificationCommand,
} from "../src/subagent/runner.js";
import {
  SUBAGENT_RESTART_CONTINUE_PROMPT,
  SUBAGENT_RESTART_FORK_BLOCKED_TEXT,
  SUBAGENT_RESULT_DELIVERED_ENTRY,
  SUBAGENT_RESULT_ENTRY,
  SUBAGENT_RESUME_ATTEMPT_ENTRY,
  SUBAGENT_RUN_ENTRY,
  SUBAGENT_SPAWN_ENTRY,
  subagentRestartAttemptLimitText,
  subagentRestartEntryId,
  subagentRestartEntryType,
  type SubagentResultEntryData,
  type SubagentSpawnEntryData,
} from "../src/subagent/restart-entries.js";

const tempDirs: string[] = [];
const openStores: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

interface RestartHarness {
  dir: string;
  store: Awaited<ReturnType<typeof createSqliteSessionStore>>;
  parentSessionId: SessionId;
  trace: TraceContext;
}

async function createHarness(name: string): Promise<RestartHarness> {
  const dir = await mkdtemp(join(tmpdir(), `zcode-subagent-restart-${name}-`));
  tempDirs.push(dir);
  const store = await createSqliteSessionStore({ dbPath: join(dir, "session.sqlite") });
  openStores.push(store);
  const parentSessionId = createSessionId(`restart-parent-${name}`);
  await store.createSession({
    directory: dir,
    id: parentSessionId,
    projectID: createProjectId("restart-project"),
    slug: `restart-parent-${name}`,
    title: "Restart parent",
    version: "0.1.0",
  });
  return {
    dir,
    parentSessionId,
    store,
    trace: { sessionId: parentSessionId, traceId: createTraceId() },
  };
}

async function createChildSession(
  harness: RestartHarness,
  childSessionId: SessionId,
  options: { taskType?: "subagent_child" | "workflow_child" | "interactive" } = {},
): Promise<void> {
  await harness.store.createSession({
    directory: harness.dir,
    id: childSessionId,
    parentID: harness.parentSessionId,
    projectID: createProjectId("restart-project"),
    slug: `child-${childSessionId}`,
    taskType: options.taskType ?? "subagent_child",
    title: "Restart child",
    version: "0.1.0",
  });
}

async function saveRestartEntry(
  harness: RestartHarness,
  sessionId: SessionId,
  kind: string,
  agentId: string,
  data: unknown,
  createdAt: number,
): Promise<void> {
  await harness.store.saveSessionEntry({
    data,
    id: subagentRestartEntryId(sessionId, kind, agentId),
    sessionID: sessionId,
    time: { created: createdAt, updated: createdAt },
    touchSession: false,
    type: subagentRestartEntryType(kind),
  });
}

async function readRestartEntry<T>(
  harness: RestartHarness,
  sessionId: SessionId,
  kind: string,
  agentId: string,
): Promise<T | undefined> {
  const entries = await harness.store.sessionEntries({
    sessionID: sessionId,
    type: subagentRestartEntryType(kind),
  });
  const prefix = `${sessionId}:${subagentRestartEntryType(kind)}:${agentId}`;
  const entry = entries.find((candidate) => candidate.id === prefix) ?? entries.at(-1);
  return entry?.data as T | undefined;
}

function createSpawnData(
  harness: RestartHarness,
  agentId: string,
  childSessionId: SessionId,
  overrides: Partial<SubagentSpawnEntryData> = {},
): SubagentSpawnEntryData {
  return {
    agentId,
    agentType: "general-purpose",
    background: true,
    childSessionId,
    createdAtMs: 1_000,
    depth: 1,
    description: "Inspect restart",
    fork: false,
    parentSession: harness.parentSessionId,
    rootSession: harness.parentSessionId,
    toolUseId: "tool-restart-1",
    workspace: { workingDirectory: harness.dir, workspaceRoot: harness.dir },
    ...overrides,
  };
}

interface PortHarness {
  notifications: ParentTaskNotificationCommand[];
  port: ReturnType<typeof createExploreSubagentPort>;
  registry: InMemoryRuntimeTaskRegistry;
  runExploreAgent: ReturnType<typeof vi.fn>;
}

function createPortHarness(input: {
  harness: RestartHarness;
  response?: string;
  runExploreAgent?: ExploreSubagentPortOptions["runExploreAgent"];
}): PortHarness {
  const registry = new InMemoryRuntimeTaskRegistry();
  const notifications: ParentTaskNotificationCommand[] = [];
  const runExploreAgent = vi.fn(
    input.runExploreAgent ??
      (async (request: ExploreSubagentRuntimeRequest) => {
        if (!(await input.harness.store.getSession(request.sessionId))) {
          await createChildSession(input.harness, request.sessionId);
        }
        await request.onSessionReady?.();
        return {
          events: [],
          response: input.response ?? "child done",
          traceId: request.traceContext.traceId,
        };
      }),
  );
  const port = createExploreSubagentPort({
    emitParentEvent: async () => {},
    enqueueParentTaskNotification: (notification) => {
      notifications.push(notification);
      return undefined;
    },
    outputRootDir: input.harness.dir,
    runExploreAgent,
    runtimeTaskRegistry: registry,
    sessionStore: input.harness.store,
  });
  return { notifications, port, registry, runExploreAgent };
}

function launchRequest(harness: RestartHarness) {
  return {
    agentType: "general-purpose",
    description: "Inspect restart",
    parentToolCallId: "tool-restart-1",
    prompt: "Inspect the workspace",
    sessionId: harness.parentSessionId,
    trace: harness.trace,
    workingDirectory: harness.dir,
    workspaceRoot: harness.dir,
  };
}

async function restore(portHarness: PortHarness, harness: RestartHarness): Promise<void> {
  await portHarness.port.restoreSession?.({
    sessionId: harness.parentSessionId,
    trace: harness.trace,
    workingDirectory: harness.dir,
    workspaceRoot: harness.dir,
  });
}

describe("subagent restart persistence", () => {
  it("invokes subagentPort.restoreSession after the parent history is loaded", async () => {
    const harness = await createHarness("wiring");
    const restoreSession = vi.fn(async (_params: SubagentRestoreSessionParams) => {});
    const runtime = createTestAgentRuntime(
      harness.parentSessionId,
      { titleGeneration: { enabled: false }, workingDirectory: harness.dir },
      {
        eventStore: createTestSessionEventStore(),
        sessionStore: harness.store,
        subagentPort: {
          launch: vi.fn(),
          restoreSession,
          run: vi.fn(),
        } as unknown as SubagentPort,
      },
    );

    await runtime.resumeFromStore();

    expect(restoreSession).toHaveBeenCalledTimes(1);
    const params = restoreSession.mock.calls[0]?.[0] as SubagentRestoreSessionParams;
    expect(params.sessionId).toBe(harness.parentSessionId);
    expect(params.workingDirectory).toBe(harness.dir);
    expect(params.workspaceRoot).toBe(harness.dir);
    expect(params.trace.traceId).toBeTruthy();
  });

  it("writes a killed result when a foreground subagent is cancelled", async () => {
    const harness = await createHarness("foreground-killed");
    let signalChildReady: (() => void) | undefined;
    const childReady = new Promise<void>((resolve) => {
      signalChildReady = resolve;
    });
    const portHarness = createPortHarness({
      harness,
      runExploreAgent: async (request) => {
        if (!(await harness.store.getSession(request.sessionId))) {
          await createChildSession(harness, request.sessionId);
        }
        await request.onSessionReady?.();
        signalChildReady?.();
        // 父回合取消后子循环可能永不 settle；外层 guard 负责收口。
        await new Promise<void>(() => {});
        return { events: [], response: "never", traceId: request.traceContext.traceId };
      },
    });
    const controller = new AbortController();
    const runPromise = portHarness.port.run(launchRequest(harness), {
      signal: controller.signal,
    });
    await childReady;
    controller.abort(new Error("parent turn cancelled"));
    await expect(runPromise).rejects.toThrow();

    const childSessions = await harness.store.listSessions({
      parentID: harness.parentSessionId,
      taskTypes: ["subagent_child"],
    });
    const childSessionId = childSessions[0]?.id as SessionId;
    expect(childSessionId).toBeTruthy();
    const agentId = Object.keys(portHarness.registry.all())[0] ?? "";
    const result = await readRestartEntry<SubagentResultEntryData>(
      harness,
      childSessionId,
      SUBAGENT_RESULT_ENTRY,
      agentId,
    );
    expect(result?.ending).toBe("killed");
  });

  it("writes spawn/run at start and result at completion", async () => {
    const harness = await createHarness("persist");
    const portHarness = createPortHarness({ harness });

    const launched = await portHarness.port.start(launchRequest(harness));
    const childSessionId = launched.childSessionId as SessionId;
    await vi.waitFor(() =>
      expect(portHarness.registry.get(launched.agentId)?.status).toBe("completed"),
    );

    const spawn = await readRestartEntry<SubagentSpawnEntryData>(
      harness,
      childSessionId,
      SUBAGENT_SPAWN_ENTRY,
      launched.agentId,
    );
    expect(spawn).toMatchObject({
      agentId: launched.agentId,
      agentType: "general-purpose",
      background: true,
      childSessionId,
      description: "Inspect restart",
      fork: false,
      parentSession: harness.parentSessionId,
      rootSession: harness.parentSessionId,
      toolUseId: "tool-restart-1",
      workspace: { workingDirectory: harness.dir, workspaceRoot: harness.dir },
    });

    const run = await readRestartEntry<{ startedAtMs: number }>(
      harness,
      childSessionId,
      SUBAGENT_RUN_ENTRY,
      launched.agentId,
    );
    expect(run?.startedAtMs).toBeGreaterThan(0);

    const result = await readRestartEntry<SubagentResultEntryData>(
      harness,
      childSessionId,
      SUBAGENT_RESULT_ENTRY,
      launched.agentId,
    );
    expect(result).toMatchObject({
      ending: "completed",
      text: "child done",
      toolUseId: "tool-restart-1",
    });
    expect(result?.finishedAtMs).toBeGreaterThanOrEqual(run?.startedAtMs ?? 0);
    expect(portHarness.notifications).toHaveLength(1);
  });

  it("restores a completed subagent after restart and resends the lost notification without rerunning", async () => {
    const harness = await createHarness("completed");
    const first = createPortHarness({ harness });
    const launched = await first.port.start(launchRequest(harness));
    await vi.waitFor(() => expect(first.registry.get(launched.agentId)?.status).toBe("completed"));

    // 重启：同一 store，新 registry / 新 port。
    const second = createPortHarness({ harness });
    await restore(second, harness);

    await vi.waitFor(() => expect(second.registry.get(launched.agentId)?.status).toBe("completed"));
    expect(second.runExploreAgent).not.toHaveBeenCalled();
    expect(second.notifications).toHaveLength(1);
    const text = second.notifications[0]?.text ?? "";
    expect(text).toContain(`<task-id>${launched.agentId}</task-id>`);
    expect(text).toContain("<tool-use-id>tool-restart-1</tool-use-id>");
    expect(text).toContain("<status>completed</status>");
    expect(text).toContain("<result>child done</result>");

    // 再恢复一次：delivered 标记 + registry 去重，不再补发。
    await restore(second, harness);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second.notifications).toHaveLength(1);

    const delivered = await harness.store.sessionEntries({
      sessionID: harness.parentSessionId,
      type: subagentRestartEntryType(SUBAGENT_RESULT_DELIVERED_ENTRY),
    });
    expect(delivered).toHaveLength(1);
  });

  it("lets SendMessage resume a subagent restored from a completed result", async () => {
    const harness = await createHarness("send-message");
    const first = createPortHarness({ harness });
    const launched = await first.port.start(launchRequest(harness));
    await vi.waitFor(() => expect(first.registry.get(launched.agentId)?.status).toBe("completed"));

    const second = createPortHarness({ harness, response: "follow-up done" });
    await restore(second, harness);
    await vi.waitFor(() => expect(second.registry.get(launched.agentId)?.status).toBe("completed"));

    const sent = await second.port.sendMessage?.({
      message: "carry on",
      parentToolCallId: "tool-send-message",
      sessionId: harness.parentSessionId,
      summary: "follow up",
      to: launched.agentId,
      trace: harness.trace,
      workingDirectory: harness.dir,
      workspaceRoot: harness.dir,
    });
    expect(sent?.status).toBe("success");
    expect(sent?.delivery).toBe("resumed_background");

    await vi.waitFor(() => expect(second.runExploreAgent).toHaveBeenCalledTimes(1));
    const request = second.runExploreAgent.mock.calls[0]?.[0] as ExploreSubagentRuntimeRequest;
    expect(request.sessionId).toBe(launched.childSessionId);
    expect(request.resumeFromStore).toBe(true);
    expect(request.prompt).toBe("carry on");
    // 等续跑收尾：终态写 result/artifacts 与临时目录清理不能互相抢跑。
    await vi.waitFor(() => expect(second.registry.get(launched.agentId)?.status).toBe("completed"));
  });

  it("resumes a subagent without a result in the same child session with the continue prompt", async () => {
    const harness = await createHarness("resume");
    const childSessionId = createSessionId("restart-child-resume");
    const agentId = "agent_restart_resume";
    await createChildSession(harness, childSessionId);
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_SPAWN_ENTRY,
      agentId,
      createSpawnData(harness, agentId, childSessionId),
      1_000,
    );
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_RUN_ENTRY,
      agentId,
      { startedAtMs: 1_100 },
      1_100,
    );

    const second = createPortHarness({ harness, response: "resumed work" });
    await restore(second, harness);

    await vi.waitFor(() => expect(second.runExploreAgent).toHaveBeenCalledTimes(1));
    const request = second.runExploreAgent.mock.calls[0]?.[0] as ExploreSubagentRuntimeRequest;
    expect(request.sessionId).toBe(childSessionId);
    expect(request.agentId).toBe(agentId);
    expect(request.resumeFromStore).toBe(true);
    expect(request.prompt).toBe(SUBAGENT_RESTART_CONTINUE_PROMPT);
    expect(request.workingDirectory).toBe(harness.dir);

    const attempt = await readRestartEntry<{
      count: number;
      lastAtMs: number;
      reason: string;
    }>(harness, childSessionId, SUBAGENT_RESUME_ATTEMPT_ENTRY, agentId);
    expect(attempt).toMatchObject({ count: 1, reason: "process_restart" });

    await vi.waitFor(() => expect(second.registry.get(agentId)?.status).toBe("completed"));
    const result = await readRestartEntry<SubagentResultEntryData>(
      harness,
      childSessionId,
      SUBAGENT_RESULT_ENTRY,
      agentId,
    );
    expect(result?.ending).toBe("completed");
    expect(result?.text).toBe("resumed work");
  });

  it("resumes when a newer run supersedes the old completed result", async () => {
    const harness = await createHarness("superseded");
    const childSessionId = createSessionId("restart-child-superseded");
    const agentId = "agent_restart_superseded";
    await createChildSession(harness, childSessionId);
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_SPAWN_ENTRY,
      agentId,
      createSpawnData(harness, agentId, childSessionId),
      1_000,
    );
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_RESULT_ENTRY,
      agentId,
      {
        durationMs: 10,
        ending: "completed",
        finishedAtMs: 1_500,
        text: "previous run",
        tokens: 1,
        toolUses: 0,
        toolUseId: "tool-restart-1",
      } satisfies SubagentResultEntryData,
      1_500,
    );
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_RUN_ENTRY,
      agentId,
      { startedAtMs: 2_000 },
      2_000,
    );

    const second = createPortHarness({ harness, response: "second run" });
    await restore(second, harness);

    await vi.waitFor(() => expect(second.runExploreAgent).toHaveBeenCalledTimes(1));
    const request = second.runExploreAgent.mock.calls[0]?.[0] as ExploreSubagentRuntimeRequest;
    expect(request.resumeFromStore).toBe(true);
    expect(request.prompt).toBe(SUBAGENT_RESTART_CONTINUE_PROMPT);
    await vi.waitFor(() => expect(second.registry.get(agentId)?.status).toBe("completed"));

    const result = await readRestartEntry<SubagentResultEntryData>(
      harness,
      childSessionId,
      SUBAGENT_RESULT_ENTRY,
      agentId,
    );
    expect(result?.text).toBe("second run");
    expect(result?.finishedAtMs).toBeGreaterThan(2_000);
  });

  it("does not resume a killed subagent and restores its terminal status", async () => {
    const harness = await createHarness("killed");
    const childSessionId = createSessionId("restart-child-killed");
    const agentId = "agent_restart_killed";
    await createChildSession(harness, childSessionId);
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_SPAWN_ENTRY,
      agentId,
      createSpawnData(harness, agentId, childSessionId),
      1_000,
    );
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_RUN_ENTRY,
      agentId,
      { startedAtMs: 1_100 },
      1_100,
    );
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_RESULT_ENTRY,
      agentId,
      {
        durationMs: 20,
        ending: "killed",
        finishedAtMs: 1_200,
        text: "Background agent task stopped.",
        tokens: 0,
        toolUses: 0,
        toolUseId: "tool-restart-1",
      } satisfies SubagentResultEntryData,
      1_200,
    );

    const second = createPortHarness({ harness });
    await restore(second, harness);

    await vi.waitFor(() => expect(second.registry.get(agentId)?.status).toBe("killed"));
    expect(second.runExploreAgent).not.toHaveBeenCalled();
    expect(second.notifications[0]?.text ?? "").toContain("<status>stopped</status>");
  });

  it("stops automatic resume at the attempt limit", async () => {
    const harness = await createHarness("limit");
    const childSessionId = createSessionId("restart-child-limit");
    const agentId = "agent_restart_limit";
    await createChildSession(harness, childSessionId);
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_SPAWN_ENTRY,
      agentId,
      createSpawnData(harness, agentId, childSessionId),
      1_000,
    );
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_RESUME_ATTEMPT_ENTRY,
      agentId,
      { count: 2, lastAtMs: 2_000, reason: "process_restart" },
      2_000,
    );

    const second = createPortHarness({ harness });
    await restore(second, harness);

    await vi.waitFor(() => expect(second.registry.get(agentId)?.status).toBe("failed"));
    expect(second.runExploreAgent).not.toHaveBeenCalled();
    const result = await readRestartEntry<SubagentResultEntryData>(
      harness,
      childSessionId,
      SUBAGENT_RESULT_ENTRY,
      agentId,
    );
    expect(result?.ending).toBe("failed");
    expect(result?.text).toBe(subagentRestartAttemptLimitText());
    expect(second.notifications).toHaveLength(1);
  });

  it("does not resume a fork subagent", async () => {
    const harness = await createHarness("fork");
    const childSessionId = createSessionId("restart-child-fork");
    const agentId = "agent_restart_fork";
    await createChildSession(harness, childSessionId);
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_SPAWN_ENTRY,
      agentId,
      createSpawnData(harness, agentId, childSessionId, { fork: true }),
      1_000,
    );

    const second = createPortHarness({ harness });
    await restore(second, harness);

    await vi.waitFor(() => expect(second.registry.get(agentId)?.status).toBe("failed"));
    expect(second.runExploreAgent).not.toHaveBeenCalled();
    const result = await readRestartEntry<SubagentResultEntryData>(
      harness,
      childSessionId,
      SUBAGENT_RESULT_ENTRY,
      agentId,
    );
    expect(result?.text).toBe(SUBAGENT_RESTART_FORK_BLOCKED_TEXT);
  });

  it("ignores non-subagent-child sessions and child sessions without a spawn entry", async () => {
    const harness = await createHarness("isolation");
    const dwfChild = createSessionId("restart-child-dwf");
    await createChildSession(harness, dwfChild, { taskType: "workflow_child" });
    await saveRestartEntry(
      harness,
      dwfChild,
      SUBAGENT_SPAWN_ENTRY,
      "agent_dwf",
      createSpawnData(harness, "agent_dwf", dwfChild),
      1_000,
    );

    const plainChild = createSessionId("restart-child-no-spawn");
    await createChildSession(harness, plainChild);

    const second = createPortHarness({
      harness,
      runExploreAgent: async () => {
        throw new Error("DWF or spawn-less sessions must not be resumed");
      },
    });
    await restore(second, harness);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(second.runExploreAgent).not.toHaveBeenCalled();
    expect(second.registry.all()).toEqual({});
    expect(second.notifications).toHaveLength(0);
  });

  it("restores terminal entries for a child session discovered through the parent id filter", async () => {
    const harness = await createHarness("filter");
    const childSessionId = createSessionId("restart-child-filter");
    const agentId = "agent_restart_filter";
    await createChildSession(harness, childSessionId);
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_SPAWN_ENTRY,
      agentId,
      createSpawnData(harness, agentId, childSessionId),
      1_000,
    );
    await saveRestartEntry(
      harness,
      childSessionId,
      SUBAGENT_RESULT_ENTRY,
      agentId,
      {
        durationMs: 5,
        ending: "failed",
        finishedAtMs: 1_200,
        text: "child failed",
        tokens: 0,
        toolUses: 0,
        toolUseId: "tool-restart-1",
      } satisfies SubagentResultEntryData,
      1_200,
    );

    const children = await harness.store.listSessions({
      parentID: harness.parentSessionId,
      taskTypes: ["subagent_child"],
    });
    expect(children.map((child) => child.id)).toEqual([childSessionId]);

    const second = createPortHarness({ harness });
    await restore(second, harness);
    await vi.waitFor(() => expect(second.registry.get(agentId)?.status).toBe("failed"));
    expect(second.notifications[0]?.text ?? "").toContain("<error>child failed</error>");
  });
});
