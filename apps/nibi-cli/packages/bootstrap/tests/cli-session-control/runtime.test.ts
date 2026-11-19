import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  MessageWithParts,
  SessionInfo,
  SessionStorePort,
  SessionControlHost,
} from "@nibi/contracts";
import type { CliSessionRef } from "@nibi/session-control/contracts";
import { createNibiSessionControlRuntime } from "../../src/cli-session-control/index.js";
import type { NibiApp } from "../../src/app/types.js";

const workspace = resolve("/workspace");
const root: SessionInfo = {
  id: "sess_root" as never,
  projectID: "project" as never,
  taskType: "interactive",
  slug: "root",
  directory: workspace,
  title: "Root session",
  version: "1",
  time: { created: 1, updated: 2 },
};
const messages: MessageWithParts[] = [
  {
    info: {
      id: "message-1" as never,
      sessionID: root.id,
      role: "user",
      time: { created: 1 },
      agent: "nibi",
    },
    parts: [{ id: "part-1" as never, type: "text", text: "hello" } as never],
  },
];

function fakeApp() {
  const titles: string[] = [];
  const submitted: Array<{ input: string; options?: Record<string, unknown> }> = [];
  const app = {
    sessionId: root.id,
    traceId: "trace",
    runtime: {
      subscribeEvents: () => () => undefined,
      hasActiveOrQueuedTurnWork: () => false,
      getActiveForegroundExecutionId: () => undefined,
      getSessionEventStore: () => ({ getEvents: async () => [] }),
      beginShutdown: () => undefined,
      stopActiveForegroundExecution: () => ({ kind: "idle" }),
      cancelRunningRuntimeBackgroundTasks: async () => undefined,
    },
    sendInput: async (input: string, options?: Record<string, unknown>) => {
      submitted.push({ input, options });
      return {
        kind: "started_turn",
        turnId: "turn-send-to-session",
        completion: Promise.resolve({ events: [] }),
      };
    },
    clearQueueItems: async () => 0,
    setCustomSessionTitle: async ({ title }: { title: string }) => {
      titles.push(title);
    },
    close: async () => undefined,
  } as unknown as NibiApp;
  return { app, titles, submitted };
}

function fakeStore(): SessionStorePort {
  return {
    getSession: async (id) => (id === root.id ? root : null),
    listSessions: async () => [root],
    messages: async () => messages,
  } as unknown as SessionStorePort;
}

function context(): Parameters<SessionControlHost["listSessions"]>[0] {
  const ref: CliSessionRef = {
    kind: "cli",
    workspacePath: workspace,
    sessionId: String(root.id),
  };
  return {
    callerId: "cli:sess_root",
    rootSession: ref,
    allowedScopes: [{ kind: "cli", workspacePath: workspace }],
  };
}

function fixture() {
  const { app, titles, submitted } = fakeApp();
  const runtime = createNibiSessionControlRuntime({
    workspace: { kind: "cli", workspacePath: workspace },
    sessionStore: fakeStore(),
    createRootApp: async () => {
      throw new Error("createRootApp must not be called by this test");
    },
  });
  runtime.attachRoot(app, "new-independent-root");
  return { runtime, control: runtime.control, titles, submitted };
}

describe("NibiSessionControlRuntime production adapter", () => {
  it("lists and reads attached roots through the real store", async () => {
    const { control } = fixture();
    await expect(control.listSessions(context(), {})).resolves.toMatchObject({
      sessions: [{ title: "Root session", status: "idle" }],
    });
    await expect(
      control.readSession(context(), { sessionId: "sess_root", view: "summary" }),
    ).resolves.toMatchObject({ view: "summary", summary: { title: "Root session" } });
    await expect(
      control.readSession(context(), { sessionId: "sess_root", view: "messages" }),
    ).resolves.toMatchObject({
      view: "messages",
      messages: [{ id: "message-1", role: "user", text: "hello" }],
    });
  });

  it("replays the same requestId and conflicts on a different fingerprint", async () => {
    const { control, titles } = fixture();
    await expect(
      control.renameSession(context(), {
        sessionId: "sess_root",
        title: "Renamed",
        requestId: "request-1",
      }),
    ).resolves.toEqual({ requestId: "request-1", status: "applied" });
    await expect(
      control.renameSession(context(), {
        sessionId: "sess_root",
        title: "Renamed",
        requestId: "request-1",
      }),
    ).resolves.toEqual({ requestId: "request-1", status: "applied" });
    expect(titles).toEqual(["Renamed"]);
    await expect(
      control.renameSession(context(), {
        sessionId: "sess_root",
        title: "Different",
        requestId: "request-1",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("sendToSession records the caller session as the input source", async () => {
    const { control, submitted } = fixture();
    await expect(
      control.sendToSession(context(), {
        sessionId: "sess_root",
        prompt: "hello from caller",
        requestId: "send-1",
      }),
    ).resolves.toMatchObject({ admission: "accepted" });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.options).toMatchObject({
      intent: {
        text: "hello from caller",
        source: { kind: "session", sessionId: "sess_root" },
      },
    });
  });

  it("denies a target outside the manager workspace", async () => {
    const { control } = fixture();
    const foreign: CliSessionRef = {
      kind: "cli",
      workspacePath: "/elsewhere",
      sessionId: "sess_root",
    };
    await expect(
      control.readSession(context(), { session: foreign, view: "summary" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});
