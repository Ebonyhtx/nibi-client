import { describe, expect, it } from "vitest";
import type { CliSessionRef } from "@nibi/session-control/contracts";
import { createCliSessionControl } from "@nibi/session-control/cli";
import {
  createOperationFeed,
  createTestPorts,
  flushMicrotasks,
  type CliTestPorts,
} from "@nibi/session-control/testing";
import type { SessionControlHost, TraceContext } from "@nibi/contracts";
import { createToolRegistry, registerBuiltInTools } from "../../src/tool/index.js";
import { sessionControlToolEntries } from "../../src/tool/handlers/session-control.js";
import { sessionControlForRuntime } from "../../src/tool/session-control/contract.js";
import { serializeOutput } from "../../src/tool/executor/result-serialization.js";
import type { ToolExecutorDeps } from "../../src/tool/executor/types.js";
import type { ToolEntry, ToolExecutionContext } from "../../src/tool/types.js";

const rootSession: CliSessionRef = {
  kind: "cli",
  workspacePath: "/workspace",
  sessionId: "sess_root",
};
const targetSession: CliSessionRef = { ...rootSession, sessionId: "sess_target" };

function entry(name: string): ToolEntry {
  const found = sessionControlToolEntries.find((tool) => tool.metadata.name === name);
  if (!found) throw new Error(`Missing tool entry ${name}`);
  return found;
}

function hostFor(ports: CliTestPorts): SessionControlHost {
  const facade = createCliSessionControl(ports.cli);
  return {
    ...facade,
    async openOperation(_ctx, operation) {
      return createOperationFeed({
        operation,
        epoch: "test-epoch",
        revision: 0,
        status: "unknown",
      });
    },
    createDeadline(timeoutMs) {
      return ports.deadlines.create(timeoutMs);
    },
  };
}

interface TestContextOptions {
  ports: CliTestPorts;
  host?: SessionControlHost;
  toolCallId?: string;
  runtimeScope?: "main" | "subagent";
  sessionId?: string;
  abortSignal?: AbortSignal;
}

function context(options: TestContextOptions): ToolExecutionContext {
  return {
    toolCallId: options.toolCallId ?? "tool-1",
    traceId: "trace-1" as never,
    sessionId: (options.sessionId ?? "sess_root") as never,
    runtimeScope: options.runtimeScope ?? "main",
    abortSignal: options.abortSignal ?? new AbortController().signal,
    workingDirectory: "/workspace",
    workspaceRoot: "/workspace",
    sessionControl: {
      kind: "cli",
      control: options.host ?? hostFor(options.ports),
      context: () => ({
        callerId: "trusted-caller",
        rootSession,
        allowedScopes: [{ kind: "cli", workspacePath: "/workspace" }],
      }),
    },
  };
}

function fixture() {
  const ports = createTestPorts("cli", rootSession);
  const host = hostFor(ports);
  return { ports, host, context: () => context({ ports, host }) };
}

describe("session control tool registration gate", () => {
  it("registers all eight CLI tools only when the trusted gate is open", () => {
    for (const include of [false, undefined]) {
      const registry = createToolRegistry();
      registerBuiltInTools(registry, { includeSessionControl: include });
      for (const tool of sessionControlToolEntries)
        expect(registry.has(tool.metadata.name), `${tool.metadata.name}:${include}`).toBe(false);
    }
    const registry = createToolRegistry();
    registerBuiltInTools(registry, { includeSessionControl: true });
    expect(sessionControlToolEntries.map((tool) => tool.metadata.name)).toEqual([
      "ListSessions",
      "ReadSession",
      "CreateSession",
      "ForkSession",
      "SendToSession",
      "WaitSessions",
      "InterruptSession",
      "RenameSession",
    ]);
    for (const tool of sessionControlToolEntries)
      expect(registry.has(tool.metadata.name)).toBe(true);
  });

  it("gates by task type, root identity and runtime scope", () => {
    const binding = fixturesBinding();
    for (const taskType of [
      "subagent_child",
      "workflow_child",
      "nested_workflow_child",
      "selection_side_chat",
    ] as const)
      expect(sessionControlForRuntime(binding, taskType, "sess_root")).toBeUndefined();
    expect(sessionControlForRuntime(binding, "interactive", "other")).toBeUndefined();
    expect(sessionControlForRuntime(binding, undefined, "sess_root")).toBe(binding);
    expect(
      sessionControlForRuntime(binding, "interactive", "sess_root", "subagent"),
    ).toBeUndefined();
    expect(sessionControlForRuntime(binding, "interactive", "sess_root", "main")).toBe(binding);
    expect(sessionControlForRuntime(binding, "fork", "sess_root")).toBe(binding);
    expect(sessionControlForRuntime(binding, "workflow_parent", "sess_root")).toBe(binding);
  });
});

function fixturesBinding() {
  const ports = createTestPorts("cli", rootSession);
  return {
    kind: "cli" as const,
    control: hostFor(ports),
    context: () => ({
      callerId: "trusted-caller",
      rootSession,
      allowedScopes: [{ kind: "cli" as const, workspacePath: "/workspace" }],
    }),
  };
}

describe("session control tool metadata", () => {
  const readTools = ["ListSessions", "ReadSession", "WaitSessions"];
  const writeTools = [
    "CreateSession",
    "ForkSession",
    "SendToSession",
    "InterruptSession",
    "RenameSession",
  ];

  it("maps read-only and mutating permissions exactly", () => {
    for (const name of readTools) {
      const tool = entry(name);
      expect(tool.metadata.readOnly).toBe(true);
      expect(tool.metadata.sideEffectScope).toBe("none");
      expect(tool.metadata.needsApproval).toBe(false);
      expect(tool.metadata.riskLevel).toBe("low");
      expect(tool.metadata.destructive).toBe(false);
      expect(tool.permission.sideEffectScope).toBe("none");
      expect(tool.permission.needsApproval).toBe(false);
    }
    for (const name of writeTools) {
      const tool = entry(name);
      expect(tool.metadata.readOnly).toBe(false);
      expect(tool.metadata.sideEffectScope).toBe("system");
      expect(tool.metadata.needsApproval).toBe(true);
      expect(tool.metadata.riskLevel).toBe("medium");
      expect(tool.metadata.destructive).toBe(false);
      expect(tool.permission.sideEffectScope).toBe("system");
      expect(tool.permission.needsApproval).toBe(true);
      expect(tool.permission.riskLevel).toBe("medium");
    }
  });

  it("uses session_control.<camelCase method> permission rules", () => {
    expect(sessionControlToolEntries.map((tool) => tool.permission.permission).sort()).toEqual([
      "session_control.createSession",
      "session_control.forkSession",
      "session_control.interruptSession",
      "session_control.listSessions",
      "session_control.readSession",
      "session_control.renameSession",
      "session_control.sendToSession",
      "session_control.waitSessions",
    ]);
  });

  it("declares the 32 KiB artifact result budget on every tool", () => {
    for (const tool of sessionControlToolEntries) {
      expect(tool.resultBudget).toEqual({
        maxInlineBytes: 32_768,
        maxModelBytes: 32_768,
        strategy: "artifact",
        preview: { maxBytes: 32_768, direction: "head" },
        artifact: { enabled: true, retention: "session" },
      });
      expect(tool.metadata.maxOutputBytes).toBe(32_768);
      expect(tool.outputSchema).toBeDefined();
      expect(tool.runtimeOutputSchema).toBeDefined();
      expect(tool.metadata.shouldDefer).toBe(true);
      expect(tool.metadata.searchHint).toBeTruthy();
      expect(tool.permission.denyPriority).toBe("beforeAsk");
    }
  });

  it("persists a result over 32 KiB as a session artifact", async () => {
    const writes: Array<{ content: string; retention: string; toolName: string }> = [];
    const deps = {
      sessionId: "sess_root",
      artifactStore: {
        writeToolResultArtifact: async (input: {
          content: string;
          retention: string;
          toolName: string;
        }) => {
          writes.push(input);
          return { uri: "artifact://session/tool-1", path: "/tmp/tool-1.json" };
        },
      },
    } as unknown as ToolExecutorDeps;
    const output = { sessions: [], nextCursor: "x".repeat(40_000) };
    const result = await serializeOutput(
      deps,
      output,
      entry("ListSessions"),
      { traceId: "trace-1", sessionId: "sess_root" } as unknown as TraceContext,
      "tool-1",
      new AbortController().signal,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      retention: "session",
      toolName: "ListSessions",
    });
    expect(result.artifactPath).toBe("/tmp/tool-1.json");
    expect(result.truncated).toBe(true);
    expect(result.content).toContain("/tmp/tool-1.json");
  });

  it("keeps requestId out of every model-facing schema and only accepts retryOf on writes", () => {
    for (const tool of sessionControlToolEntries) {
      expect(tool.inputSchema.properties ?? {}).not.toHaveProperty("requestId");
      const retryable = "retryOf" in (tool.inputSchema.properties ?? {});
      expect(retryable).toBe(writeTools.includes(tool.metadata.name));
      expect(tool.inputSchema.required ?? []).not.toContain("retryOf");
    }
    const create = entry("CreateSession");
    expect(create.inputSchema.required).toEqual(["prompt"]);
  });
});

describe("session control handlers", () => {
  it("lists and reads through the trusted binding", async () => {
    const fixturePorts = fixture();
    await expect(entry("ListSessions").handler({}, fixturePorts.context())).resolves.toEqual({
      sessions: [],
    });
    const read = await entry("ReadSession").handler(
      { sessionId: "sess_target", view: "summary" },
      fixturePorts.context(),
    );
    expect(read).toMatchObject({
      view: "summary",
      summary: { session: { sessionId: "sess_target" } },
    });
    expect(fixturePorts.ports.calls.map((call) => call.method)).toContain("readSession");
  });

  it("rejects a full reference the model surface no longer accepts", async () => {
    const fixturePorts = fixture();
    await expect(
      entry("ReadSession").handler(
        { session: targetSession, view: "summary" },
        fixturePorts.context(),
      ),
    ).rejects.toThrow();
    expect(fixturePorts.ports.calls).toEqual([]);
  });

  it("denies a target outside the trusted workspace before the owner call", async () => {
    const fixturePorts = fixture();
    const foreign = { ...targetSession, workspacePath: "/other" };
    fixturePorts.ports.cli.sessions.resolveSession = async () => foreign;
    await expect(
      entry("SendToSession").handler(
        { sessionId: "sess_target", prompt: "go" },
        fixturePorts.context(),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(fixturePorts.ports.calls.some((call) => call.method === "sendToSession")).toBe(false);
  });

  it("rejects self-wait before authorization or observation", async () => {
    const fixturePorts = fixture();
    await expect(
      entry("WaitSessions").handler(
        { operations: [{ sessionId: "sess_root", commandId: "c" }], mode: "all" },
        fixturePorts.context(),
      ),
    ).rejects.toMatchObject({ code: "self_wait" });
    expect(fixturePorts.ports.calls.map((call) => call.method)).toEqual(["resolveSession"]);
  });

  it("returns baseline snapshots for timeoutMs=0 and closes every feed", async () => {
    const fixturePorts = fixture();
    const feedA = createOperationFeed({
      operation: {
        session: { ...rootSession, sessionId: "sess_a" },
        sessionId: "sess_a",
        commandId: "a",
      },
      epoch: "epoch",
      revision: 0,
      status: "completed",
    });
    const feedB = createOperationFeed({
      operation: {
        session: { ...rootSession, sessionId: "sess_b" },
        sessionId: "sess_b",
        commandId: "b",
      },
      epoch: "epoch",
      revision: 0,
      status: "running",
    });
    fixturePorts.ports.cli.observations.open = async (_ctx, operation) =>
      operation.commandId === "a" ? feedA : feedB;
    const all = await entry("WaitSessions").handler(
      {
        operations: [
          { sessionId: "sess_a", commandId: "a" },
          { sessionId: "sess_b", commandId: "b" },
        ],
        mode: "all",
        timeoutMs: 0,
      },
      fixturePorts.context(),
    );
    expect(all).toMatchObject({
      status: "timed_out",
      operations: [{ status: "completed" }, { status: "running" }],
    });
    expect(feedA.closeCount).toBe(1);
    expect(feedB.closeCount).toBe(1);
  });

  it("satisfies any as soon as one terminal arrives and all only after every target", async () => {
    const fixturePorts = fixture();
    const feedA = createOperationFeed({
      operation: {
        session: { ...rootSession, sessionId: "sess_a" },
        sessionId: "sess_a",
        commandId: "a",
      },
      epoch: "epoch",
      revision: 0,
      status: "running",
    });
    const feedB = createOperationFeed({
      operation: {
        session: { ...rootSession, sessionId: "sess_b" },
        sessionId: "sess_b",
        commandId: "b",
      },
      epoch: "epoch",
      revision: 0,
      status: "running",
    });
    fixturePorts.ports.cli.observations.open = async (_ctx, operation) =>
      operation.commandId === "a" ? feedA : feedB;
    const any = entry("WaitSessions").handler(
      {
        operations: [
          { sessionId: "sess_a", commandId: "a" },
          { sessionId: "sess_b", commandId: "b" },
        ],
        mode: "any",
      },
      fixturePorts.context(),
    );
    await flushMicrotasks();
    feedB.push({
      type: "snapshot",
      snapshot: {
        operation: {
          session: { ...rootSession, sessionId: "sess_b" },
          sessionId: "sess_b",
          commandId: "b",
        },
        epoch: "epoch",
        revision: 1,
        status: "failed",
      },
    });
    await expect(any).resolves.toMatchObject({ status: "completed" });
    expect(feedA.closeCount).toBe(1);
    expect(feedB.closeCount).toBe(1);

    const allPorts = fixture();
    const feedC = createOperationFeed({
      operation: {
        session: { ...rootSession, sessionId: "sess_c" },
        sessionId: "sess_c",
        commandId: "c",
      },
      epoch: "epoch",
      revision: 0,
      status: "running",
    });
    const feedD = createOperationFeed({
      operation: {
        session: { ...rootSession, sessionId: "sess_d" },
        sessionId: "sess_d",
        commandId: "d",
      },
      epoch: "epoch",
      revision: 0,
      status: "running",
    });
    allPorts.ports.cli.observations.open = async (_ctx, operation) =>
      operation.commandId === "c" ? feedC : feedD;
    let settled = false;
    const all = entry("WaitSessions")
      .handler(
        {
          operations: [
            { sessionId: "sess_c", commandId: "c" },
            { sessionId: "sess_d", commandId: "d" },
          ],
          mode: "all",
        },
        allPorts.context(),
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await flushMicrotasks();
    feedC.push({
      type: "snapshot",
      snapshot: {
        operation: {
          session: { ...rootSession, sessionId: "sess_c" },
          sessionId: "sess_c",
          commandId: "c",
        },
        epoch: "epoch",
        revision: 1,
        status: "completed",
      },
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    feedD.push({
      type: "snapshot",
      snapshot: {
        operation: {
          session: { ...rootSession, sessionId: "sess_d" },
          sessionId: "sess_d",
          commandId: "d",
        },
        epoch: "epoch",
        revision: 1,
        status: "interrupted",
      },
    });
    await expect(all).resolves.toMatchObject({ status: "completed" });
  });

  it("replays an identical requestId and conflicts on a different fingerprint", async () => {
    const fixturePorts = fixture();
    const ctx = fixturePorts.context();
    const first = await entry("SendToSession").handler(
      { sessionId: "sess_target", prompt: "go", retryOf: "req-1" },
      ctx,
    );
    expect(first).toMatchObject({ requestId: "req-1", admission: "accepted" });
    const replay = await entry("SendToSession").handler(
      { sessionId: "sess_target", prompt: "go", retryOf: "req-1" },
      { ...ctx, toolCallId: "tool-2" },
    );
    expect(replay).toEqual(first);
    expect(fixturePorts.ports.calls.filter((call) => call.method === "sendToSession")).toHaveLength(
      1,
    );
    await expect(
      entry("SendToSession").handler(
        { sessionId: "sess_target", prompt: "different", retryOf: "req-1" },
        { ...ctx, toolCallId: "tool-3" },
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("uses the tool call id as the default request identity", async () => {
    const fixturePorts = fixture();
    const first = await entry("RenameSession").handler(
      { sessionId: "sess_target", title: "Renamed" },
      { ...fixturePorts.context(), toolCallId: "tool-abc" },
    );
    expect(first).toMatchObject({ requestId: "tool-abc", status: "applied" });
    const replay = await entry("RenameSession").handler(
      { sessionId: "sess_target", title: "Renamed", retryOf: "tool-abc" },
      { ...fixturePorts.context(), toolCallId: "tool-def" },
    );
    expect(replay).toEqual(first);
    expect(fixturePorts.ports.calls.filter((call) => call.method === "renameSession")).toHaveLength(
      1,
    );
  });

  it("forbids a subagent, a missing binding and a mismatched root", async () => {
    const fixturePorts = fixture();
    await expect(
      entry("ReadSession").handler(
        { sessionId: "sess_target", view: "summary" },
        { ...fixturePorts.context(), runtimeScope: "subagent" },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const withoutBinding = { ...fixturePorts.context() };
    delete withoutBinding.sessionControl;
    await expect(
      entry("ReadSession").handler({ sessionId: "sess_target", view: "summary" }, withoutBinding),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      entry("ReadSession").handler(
        { sessionId: "sess_target", view: "summary" },
        { ...fixturePorts.context(), sessionId: "sess_other" as never },
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("propagates the execution abort signal and trace identity", async () => {
    const fixturePorts = fixture();
    const controller = new AbortController();
    const ctx = { ...fixturePorts.context(), abortSignal: controller.signal };
    controller.abort();
    const observed = fixturePorts.ports.calls.length;
    await expect(entry("ListSessions").handler({}, ctx)).rejects.toThrow();
    expect(fixturePorts.ports.calls).toHaveLength(observed);
  });
});
