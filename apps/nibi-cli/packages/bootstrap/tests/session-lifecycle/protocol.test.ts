import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionId } from "@nibi/contracts";
import {
  nibiProtocolMethods,
  sessionLifecycleSnapshotSchema,
  type NibiProtocolMessage,
} from "@nibi/shared";
import { createSqliteSessionStore } from "@nibi/adapters/storage";
import { NibiProtocolAgentServer } from "../../src/nibi-protocol/server.js";
import type {
  NibiProtocolAgentServerContext,
  NibiProtocolSessionRecord,
} from "../../src/nibi-protocol/server-types.js";
import type { NibiApp } from "../../src/app/types.js";
import { createFakeApp } from "../helpers/fake-nibi-app.js";

const WORKSPACE_PATH = "/workspace/session-lifecycle";
const SESSION_ID = "sess_lifecycle_protocol" as SessionId;
type TestSessionStore = Awaited<ReturnType<typeof createSqliteSessionStore>>;

async function requestResult(server: NibiProtocolAgentServer, message: NibiProtocolMessage) {
  const response = await server.handleMessage(message);
  if (!response || !("result" in response)) {
    throw new Error(`Expected protocol success response: ${JSON.stringify(response)}`);
  }
  return response.result;
}

async function seedPersistedSession(dbPath: string): Promise<void> {
  const store = await createSqliteSessionStore({ dbPath });
  try {
    await store.createSession({
      id: SESSION_ID,
      projectID: "project_lifecycle" as never,
      slug: "lifecycle-protocol",
      directory: WORKSPACE_PATH,
      path: WORKSPACE_PATH,
      title: "Lifecycle protocol",
      version: "test-version",
      time: { created: 1, updated: 2 },
    });
  } finally {
    store.close();
  }
}

interface Harness {
  server: NibiProtocolAgentServer;
  store: TestSessionStore;
  apps: NibiApp[];
  context: NibiProtocolAgentServerContext;
  notifications: Array<{ method: string; params: unknown }>;
}

async function bootServer(
  dbPath: string,
  options: {
    appOverrides?: Partial<NibiApp>;
    poolOptions?: { targetCount?: number; highWaterCount?: number };
  } = {},
): Promise<Harness> {
  const store = await createSqliteSessionStore({ dbPath });
  const apps: NibiApp[] = [];
  const server = new NibiProtocolAgentServer({
    createNibiApp: (appOptions) => {
      const app = createFakeApp(appOptions, options.appOverrides ?? {});
      apps.push(app);
      return app;
    },
    cwd: WORKSPACE_PATH,
    sessionResidentPoolOptions: options.poolOptions ?? {
      highWaterCount: 16,
      targetCount: 8,
    },
    sessionStore: store,
  });
  const context = (server as unknown as { context: NibiProtocolAgentServerContext }).context;
  const notifications: Array<{ method: string; params: unknown }> = [];
  server.setNotificationSink((message) => {
    // 挂 sink 后冷恢复会真发 runtime preferences 反向请求并等待响应，自动应答避免超时。
    if (
      "id" in message &&
      "method" in message &&
      message.method === nibiProtocolMethods.sessionRequestRuntimePreferences
    ) {
      void server.handleMessage({
        id: message.id,
        result: { nativeSearchEnhancementsEnabled: true, memoryEnabled: false },
      });
      return;
    }
    if ("method" in message && !("id" in message))
      notifications.push({ method: message.method, params: message.params });
  });
  return { server, store, apps, context, notifications };
}

function lifecycleState(harness: Harness, sessionId = SESSION_ID): Promise<unknown> {
  return requestResult(harness.server, {
    id: `state-${Math.random()}`,
    method: nibiProtocolMethods.sessionLifecycleGetState,
    params: { sessionId },
  });
}

function lifecycleCall(
  harness: Harness,
  method:
    | typeof nibiProtocolMethods.sessionLifecycleEnsureReady
    | typeof nibiProtocolMethods.sessionLifecycleStop
    | typeof nibiProtocolMethods.sessionLifecycleRestart,
  sessionId = SESSION_ID,
) {
  return requestResult(harness.server, {
    id: `${method}-${Math.random()}`,
    method,
    params: { sessionId },
  });
}

describe("session lifecycle protocol", () => {
  let root: string;
  let harness: Harness | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nibi-session-lifecycle-"));
    const dbPath = join(root, "sessions.sqlite");
    await seedPersistedSession(dbPath);
    harness = await bootServer(dbPath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    harness?.store.close();
    await rm(root, { recursive: true, force: true });
  });

  it("queries without activating, then ensureReady/stop/restart stay idempotent", async () => {
    const h = harness!;
    expect(sessionLifecycleSnapshotSchema.parse(await lifecycleState(h))).toMatchObject({
      sessionId: SESSION_ID,
      state: "unloaded",
      lastError: null,
    });
    expect(h.apps).toHaveLength(0);

    await lifecycleCall(h, nibiProtocolMethods.sessionLifecycleEnsureReady);
    expect(await lifecycleState(h)).toMatchObject({ state: "ready", generation: 1 });
    expect(h.apps).toHaveLength(1);

    // 已 ready 时再次 ensureReady 不得重建实例。
    await lifecycleCall(h, nibiProtocolMethods.sessionLifecycleEnsureReady);
    expect(h.apps).toHaveLength(1);

    const close = vi.spyOn(h.apps[0]!, "close");
    await lifecycleCall(h, nibiProtocolMethods.sessionLifecycleStop);
    expect(await lifecycleState(h)).toMatchObject({ state: "unloaded" });
    expect(close).toHaveBeenCalledTimes(1);

    // stop 幂等：旧实例已释放后再次 stop 不产生第二次 close。
    await lifecycleCall(h, nibiProtocolMethods.sessionLifecycleStop);
    expect(close).toHaveBeenCalledTimes(1);
    expect(await lifecycleState(h)).toMatchObject({ state: "unloaded" });

    await lifecycleCall(h, nibiProtocolMethods.sessionLifecycleRestart);
    expect(await lifecycleState(h)).toMatchObject({ state: "ready", generation: 2 });
    expect(h.apps).toHaveLength(2);

    const secondClose = vi.spyOn(h.apps[1]!, "close");
    await lifecycleCall(h, nibiProtocolMethods.sessionLifecycleRestart);
    expect(secondClose).toHaveBeenCalledTimes(1);
    expect(await lifecycleState(h)).toMatchObject({ state: "ready", generation: 3 });
    expect(h.apps).toHaveLength(3);
  });

  it("publishes lifecycle notifications for every transition", async () => {
    const h = harness!;
    await lifecycleCall(h, nibiProtocolMethods.sessionLifecycleEnsureReady);
    await lifecycleCall(h, nibiProtocolMethods.sessionLifecycleStop);

    const lifecycleNotifications = h.notifications.filter(
      (entry) => entry.method === nibiProtocolMethods.sessionLifecycleChanged,
    );
    const states = lifecycleNotifications.map((entry) => (entry.params as { state: string }).state);
    expect(states).toEqual(["starting", "ready", "stopping", "unloaded"]);
    for (const entry of lifecycleNotifications)
      expect(() => sessionLifecycleSnapshotSchema.parse(entry.params)).not.toThrow();
  });

  it("keeps a faulted instance isolated and never auto-recreates it", async () => {
    const dbPath = join(root, "faulty.sqlite");
    await seedPersistedSession(dbPath);
    const faulty = await bootServer(dbPath, {
      appOverrides: {
        close: async () => {
          throw new Error("close failed");
        },
      },
    });
    try {
      await lifecycleCall(faulty, nibiProtocolMethods.sessionLifecycleEnsureReady);
      expect(await lifecycleState(faulty)).toMatchObject({ state: "ready" });
      const appsBefore = faulty.apps.length;

      // close 失败不是释放成功：实例进入 faulted，而不是回到 unloaded。
      const stopped = await faulty.server.handleMessage({
        id: "stop",
        method: nibiProtocolMethods.sessionLifecycleStop,
        params: { sessionId: SESSION_ID },
      });
      expect(stopped).toHaveProperty("error");
      expect(await lifecycleState(faulty)).toMatchObject({
        state: "faulted",
        lastError: { operation: "stop" },
      });

      for (const method of [
        nibiProtocolMethods.sessionLifecycleEnsureReady,
        nibiProtocolMethods.sessionLifecycleRestart,
      ]) {
        const response = await faulty.server.handleMessage({
          id: method,
          method,
          params: { sessionId: SESSION_ID },
        });
        expect(response).toMatchObject({
          error: { message: expect.stringContaining("recovery") },
        });
      }
      expect(faulty.apps).toHaveLength(appsBefore);
    } finally {
      faulty.store.close();
    }
  });

  it("releases a request operation lease and converges the resident pool", async () => {
    const dbPath = join(root, "pool.sqlite");
    await seedPersistedSession(dbPath);
    const pooled = await bootServer(dbPath, { poolOptions: { targetCount: 1, highWaterCount: 1 } });
    try {
      const lease = await pooled.context.sessionResidentPool!.acquireOperation("sess-a");
      for (const sessionId of ["sess-a", "sess-b"]) {
        pooled.context.sessions.set(sessionId, {
          app: createFakeApp({ sessionId: sessionId as SessionId } as never, {}),
          eventStore: { deleteSession: async () => true } as never,
          legacyStreamSubscribed: false,
          persistence: "immediate",
          protocolEventSequences: new Map(),
          protocolToolInputTransmissions: new Map(),
          stateRevision: 0,
          traceContext: { traceId: "trace" },
          updatedAt: 0,
          workspace: { workspacePath: WORKSPACE_PATH, workspaceKey: WORKSPACE_PATH },
        } as unknown as NibiProtocolSessionRecord);
      }
      expect(pooled.context.sessionResidentPool!.operationCount("sess-a")).toBe(1);

      // lease 持有期间即使超过高水位也不回收。
      pooled.server.rebalanceResidentSessions();
      expect(pooled.context.sessions.has("sess-a")).toBe(true);
      expect(pooled.context.sessions.has("sess-b")).toBe(true);

      lease();
      pooled.server.rebalanceResidentSessions();
      await pooled.context.sessionResidentPool!.waitForDeactivation("sess-a");
      await pooled.context.sessionResidentPool!.waitForDeactivation("sess-b");
      // 释放 lease 后不依赖 60s sampler：同一次 rebalance 立即收敛到低水位。
      expect(pooled.context.sessionResidentPool!.operationCount("sess-a")).toBe(0);
      expect(pooled.context.sessions.size).toBe(1);
    } finally {
      pooled.store.close();
    }
  });

  it("prunes transient subagent event stores on the sampler tick", () => {
    const h = harness!;
    const pruneA = vi.fn(() => 2);
    const pruneB = vi.fn(() => 1);
    for (const [sessionId, pruneTransientEvents] of [
      ["sess-subagent-a", pruneA],
      ["sess-subagent-b", pruneB],
    ] as const) {
      h.context.sessions.set(sessionId, {
        app: createFakeApp({ sessionId: sessionId as SessionId } as never, {}),
        eventStore: { deleteSession: async () => true, pruneTransientEvents } as never,
        legacyStreamSubscribed: false,
        persistence: "immediate",
        protocolEventSequences: new Map(),
        protocolToolInputTransmissions: new Map(),
        stateRevision: 0,
        traceContext: { traceId: "trace" },
        updatedAt: 0,
        workspace: { workspacePath: WORKSPACE_PATH, workspaceKey: WORKSPACE_PATH },
      } as unknown as NibiProtocolSessionRecord);
    }

    expect(h.server.pruneSessionEventStores(123_456)).toBe(3);
    expect(pruneA).toHaveBeenCalledWith(123_456);
    expect(pruneB).toHaveBeenCalledWith(123_456);
  });
});
