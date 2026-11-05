import { describe, expect, it, vi } from "vitest";
import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
} from "@nibi/shared/nibi-protocol-v4";
import type { ZCodeStreamEvent } from "@nibi/shared";
import { V4TaskStreamSink } from "../src/zcode-agent/taskStreamFromV4.js";

function snapshotFrame(
  rows: ConversationRow[],
  overrides: Partial<ConversationSnapshot> = {},
): ConversationTopicFrame {
  const snapshot: ConversationSnapshot = {
    protocolVersion: 1,
    sessionId: "task",
    logEpoch: "epoch-wire",
    seq: 1,
    revision: 1,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1_000 }],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "guard.noGoal" },
      resumeGoal: { allowed: false, reasonCode: "guard.noGoal" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title: "test", titleSource: "custom" },
    config: {
      provider: "glm",
      model: "glm-5",
      thought: "medium",
      thoughtLevels: [],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: {
        usedTokens: 0,
        maxTokens: 200_000,
        autoCompactThresholdTokens: null,
      },
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    workspaceHookAdmission: null,
    goal: null,
    plan: null,
    rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
    ...overrides,
  };
  return {
    topic: "conversation/task",
    subscriptionId: "mine",
    fromSeq: 0,
    toSeq: snapshot.seq,
    sentAt: 1_700_000_000_000,
    payload: { kind: "snapshot", snapshot },
  };
}

function deltasFrame(deltas: ConversationDelta[]): ConversationTopicFrame {
  return {
    topic: "conversation/task",
    subscriptionId: "mine",
    fromSeq: 1,
    toSeq: 2,
    sentAt: 1_700_000_000_100,
    payload: { kind: "deltas", deltas },
  };
}

function turnHeaderRow(rowId: number, state: "running" | "completedSuccess" | "failed"): ConversationRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_000,
    createdAtSeq: rowId,
    kind: "turnHeader",
    origin: "userInput",
    sourceCommandId: "in-1",
    state,
    startedAt: 1_000,
  } as ConversationRow;
}

function assistantRow(rowId: number, text: string, state: "streaming" | "complete"): ConversationRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_000 + rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    text,
    state,
  } as ConversationRow;
}

function createHarness(initialFrame: ConversationTopicFrame) {
  let handler: (wire: unknown) => void = () => {};
  const unsubscribe = vi.fn(async () => undefined);
  let emitOrdinal = 1;
  const emit = (frame: ConversationTopicFrame) => {
    handler({
      wireVersion: 1,
      kind: "complete",
      deliveryKind: emitOrdinal === 1 ? "initial" : "online",
      logicalFrameId: `frame-${emitOrdinal}`,
      logicalFrameOrdinal: emitOrdinal,
      topic: `conversation/${frame.topic.split("/")[1] ?? "task"}`,
      subscriptionId: "mine",
      frame,
    });
    emitOrdinal += 1;
  };
  const agent = {
    onDynamicConversationFrame: () => (next: (wire: unknown) => void) => {
      handler = next;
      return { dispose: vi.fn() };
    },
    subscribeConversationV4: vi.fn(async () => {
      emit(initialFrame);
      return { ack: { subscriptionId: "mine" } };
    }),
    unsubscribeConversationV4: unsubscribe,
  };
  const sink = new V4TaskStreamSink({
    agent: agent as never,
    target: { workspacePath: "/work", sessionId: "task" },
  });
  const events: ZCodeStreamEvent[] = [];
  const release = sink.addListener((event) => events.push(event));
  return { agent, sink, events, emit, unsubscribe, release };
}

describe("v4 task stream projection", () => {
  it("does not subscribe before the legacy stream reports unavailable", async () => {
    const { agent, sink, events } = createHarness(
      snapshotFrame([turnHeaderRow(1, "running"), assistantRow(2, "hel", "streaming")]),
    );
    expect(agent.subscribeConversationV4).not.toHaveBeenCalled();
    sink.activate();
    expect(agent.subscribeConversationV4).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(events.map((event) => event.type)).toEqual(["task_run_started", "agent_message_chunk"]);
  });

  it("replays the running turn, then forwards deltas and closes on the terminal turn header", async () => {
    const { sink, events, emit } = createHarness(
      snapshotFrame([turnHeaderRow(1, "running"), assistantRow(2, "hel", "streaming")]),
    );
    sink.activate();
    await Promise.resolve();
    emit(
      deltasFrame([
        { op: "row.delta", rowId: 2, path: "text", append: "lo" },
        {
          op: "row.upserted",
          row: assistantRow(2, "hello", "complete"),
        },
      ]),
    );
    emit(deltasFrame([{ op: "row.upserted", row: turnHeaderRow(1, "completedSuccess") }]));

    const chunks = events.filter(
      (event): event is Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> =>
        event.type === "agent_message_chunk",
    );
    expect(chunks.map((event) => event.content)).toEqual(["hel", "lo"]);
    expect(chunks.every((event) => event.inputId === "in-1")).toBe(true);
    const runStarted = events.find((event) => event.type === "task_run_started");
    expect(runStarted).toMatchObject({ inputId: "in-1" });
    const complete = events.find((event) => event.type === "task_complete");
    expect(complete).toMatchObject({ inputId: "in-1", stopReason: "complete" });
  });

  it("maps a failed turn to task_error and ignores history before the running turn", async () => {
    const { sink, events, emit } = createHarness(
      snapshotFrame([
        turnHeaderRow(1, "completedSuccess"),
        assistantRow(2, "old reply", "complete"),
        turnHeaderRow(3, "running"),
        assistantRow(4, "new", "streaming"),
      ]),
    );
    sink.activate();
    await Promise.resolve();
    expect(events.some((event) => event.type === "agent_message_chunk" && event.content.includes("old"))).toBe(
      false,
    );
    emit(deltasFrame([{ op: "row.upserted", row: turnHeaderRow(3, "failed") }]));
    expect(events.find((event) => event.type === "task_error")).toMatchObject({
      inputId: "in-1",
      code: "turn_failed",
    });
  });

  it("releases the v4 subscription on dispose", async () => {
    const { sink, unsubscribe, release } = createHarness(snapshotFrame([turnHeaderRow(1, "running")]));
    sink.activate();
    await Promise.resolve();
    release();
    sink.dispose();
    expect(unsubscribe).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "mine", sessionId: "task" }),
    );
  });
});
