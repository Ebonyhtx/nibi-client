import { describe, expect, it, vi } from "vitest";
import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
  ConversationTopicFrame,
} from "@nibi/shared/nibi-protocol-v4";
import type { NibiStreamEvent } from "@nibi/shared";
import { V4TaskStreamSink } from "../src/nibi-agent/taskStreamFromV4.js";

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
  const globalEvents: NibiStreamEvent[] = [];
  const sink = new V4TaskStreamSink({
    agent: agent as never,
    target: { workspacePath: "/work", sessionId: "task" },
    publishGlobal: (event) => globalEvents.push(event),
  });
  const events: NibiStreamEvent[] = [];
  const release = sink.addListener((event) => events.push(event));
  return { agent, sink, events, globalEvents, emit, unsubscribe, release };
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
    // 状态面（模式/模型/用量/标题）先播，再播运行中的回合。
    expect(events.map((event) => event.type)).toEqual([
      "mode_update",
      "glm_agent_model_state_update",
      "config_option_update",
      "usage_update",
      "session_info_update",
      "task_run_started",
      "agent_message_chunk",
    ]);
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
      (event): event is Extract<NibiStreamEvent, { type: "agent_message_chunk" }> =>
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

  it("publishes every projected event to the global source", async () => {
    const { sink, events, globalEvents } = createHarness(
      snapshotFrame([turnHeaderRow(1, "running"), assistantRow(2, "hi", "streaming")]),
    );
    sink.activate();
    await Promise.resolve();
    // 全局源 = onDynamicStreamEvent（bot 的 fallback、Host 间镜像）；只投 listener 会让它静默。
    expect(globalEvents.length).toBeGreaterThan(0);
    expect(globalEvents.map((event) => event.type)).toEqual(events.map((event) => event.type));
  });

  it("projects a pending permission so the bot is not stuck waiting", async () => {
    const { sink, events, emit } = createHarness(snapshotFrame([turnHeaderRow(1, "running")]));
    sink.activate();
    await Promise.resolve();
    emit(
      deltasFrame([
        {
          op: "state.updated",
          patch: {
            pendingInteractions: [
              {
                interactionId: "ix-1",
                kind: "permission",
                anchorRowId: 2,
                createdAt: 1_000,
                payload: {
                  kind: "permission",
                  toolCallId: "tool-1",
                  toolName: "Write",
                  summary: "Write to a.txt",
                  detail: { file_path: "a.txt" },
                  freeText: true,
                  options: [
                    {
                      optionId: "allowOnce",
                      label: "Allow once",
                      kind: "allowOnce",
                      response: { decision: "allow" },
                    },
                    {
                      optionId: "deny",
                      label: "Deny",
                      kind: "deny",
                      response: { decision: "deny" },
                    },
                  ],
                },
              },
            ],
          },
        },
      ]),
    );
    const request = events.find((event) => event.type === "permission_request");
    expect(request).toMatchObject({
      requestId: "ix-1",
      kind: "Write",
      kind: "Write",
      description: "Write to a.txt",
      freeText: true,
    });
    expect(
      (request as Extract<NibiStreamEvent, { type: "permission_request" }>).options.map(
        (option) => option.optionId,
      ),
    ).toEqual(["allowOnce", "deny"]);

    // 同一个 interaction 在后续 patch 里重复出现时不重发（bot 会重复弹卡片）。
    emit(
      deltasFrame([
        {
          op: "state.updated",
          patch: {
            pendingInteractions: [
              {
                interactionId: "ix-1",
                kind: "permission",
                anchorRowId: 2,
                createdAt: 1_000,
                payload: {
                  kind: "permission",
                  toolCallId: "tool-1",
                  toolName: "Write",
                  summary: "Write to a.txt",
                  detail: {},
                  options: [],
                },
              },
            ],
          },
        },
      ]),
    );
    expect(events.filter((event) => event.type === "permission_request")).toHaveLength(1);
  });

  it("turns a disappearing interaction into a response event", async () => {
    const { sink, events, emit } = createHarness(snapshotFrame([turnHeaderRow(1, "running")]));
    sink.activate();
    await Promise.resolve();
    emit(
      deltasFrame([
        {
          op: "state.updated",
          patch: {
            pendingInteractions: [
              {
                interactionId: "ix-q",
                kind: "userInput",
                anchorRowId: 2,
                createdAt: 1_000,
                payload: {
                  kind: "userInput",
                  prompt: "AskUserQuestion pauses execution",
                  freeText: true,
                  toolName: "AskUserQuestion",
                  questions: [
                    {
                      question: "Which one?",
                      header: "Choice",
                      options: [{ value: "a", label: "A" }],
                    },
                  ],
                },
              },
            ],
          },
        },
      ]),
    );
    expect(events.find((event) => event.type === "elicitation_request")).toMatchObject({
      requestId: "ix-q",
      message: "Which one?",
      header: "Choice",
    });
    emit(deltasFrame([{ op: "state.updated", patch: { pendingInteractions: [] } }]));
    expect(events.find((event) => event.type === "elicitation_response")).toMatchObject({
      requestId: "ix-q",
      action: "accept",
    });
  });

  it("projects config changes once and suppresses repeats", async () => {
    const { sink, events, emit } = createHarness(snapshotFrame([turnHeaderRow(1, "running")]));
    sink.activate();
    await Promise.resolve();
    const before = events.filter((event) => event.type === "mode_update").length;
    emit(
      deltasFrame([
        {
          op: "state.updated",
          patch: {
            config: {
              provider: "glm",
              model: "glm-5",
              thought: "high",
              thoughtLevels: ["low", "high"],
              followupMode: "queue",
              mode: "plan",
            },
          },
        },
      ]),
    );
    // mode 与思考档都变了：各发一次（seed 时已各发过一次）。
    expect(events.filter((event) => event.type === "mode_update")).toHaveLength(before + 1);
    expect(events.filter((event) => event.type === "glm_agent_model_state_update")).toHaveLength(2);
    emit(
      deltasFrame([
        {
          op: "state.updated",
          patch: {
            config: {
              provider: "glm",
              model: "glm-5",
              thought: "high",
              thoughtLevels: ["low", "high"],
              followupMode: "queue",
              mode: "plan",
            },
          },
        },
      ]),
    );
    expect(events.filter((event) => event.type === "mode_update")).toHaveLength(before + 1);
  });

  it("projects plan steps from state and from TodoWrite tool rows", async () => {
    const { sink, events, emit } = createHarness(snapshotFrame([turnHeaderRow(1, "running")]));
    sink.activate();
    await Promise.resolve();
    emit(
      deltasFrame([
        {
          op: "state.updated",
          patch: {
            plan: {
              items: [
                { id: "1", content: "Read the file", status: "completed" },
                { id: "2", content: "Patch it", status: "inProgress" },
              ],
              updatedAt: 2_000,
            },
          },
        },
      ]),
    );
    const fromState = events.filter((event) => event.type === "plan");
    expect(fromState).toHaveLength(1);
    expect(
      (fromState[0] as Extract<NibiStreamEvent, { type: "plan" }>).steps.map((step) => [
        step.title,
        step.status,
      ]),
    ).toEqual([
      ["Read the file", "completed"],
      ["Patch it", "in_progress"],
    ]);

    emit(
      deltasFrame([
        {
          op: "row.appended",
          row: {
            rowId: 5,
            turnId: "turn-1",
            createdAt: 2_100,
            createdAtSeq: 5,
            kind: "toolCall",
            toolCallId: "todo-1",
            toolName: "TodoWrite",
            status: "running",
            inputText: "",
            input: {
              todos: [
                { id: "1", content: "Read the file", status: "completed" },
                { id: "2", content: "Patch it", status: "completed" },
              ],
            },
          } as ConversationRow,
        },
      ]),
    );
    const plans = events.filter((event) => event.type === "plan");
    expect(plans).toHaveLength(2);
    expect(
      (plans[1] as Extract<NibiStreamEvent, { type: "plan" }>).steps.map((step) => step.status),
    ).toEqual(["completed", "completed"]);
  });

  it("settles a vanished queue item as discarded when another input starts", async () => {
    const { sink, events, emit } = createHarness(snapshotFrame([turnHeaderRow(1, "running")]));
    sink.activate();
    await Promise.resolve();
    const queued = (sourceCommandId: string) => ({
      sourceCommandId,
      queueItemId: `queue_${sourceCommandId}`,
      clientId: "c1",
      kind: "sendText" as const,
      text: sourceCommandId,
      attachments: [],
      delivery: { requested: "queue" as const, admitted: "queue" as const },
      order: { admissionSeq: 0 },
      steer: { state: "notRequested" as const },
      dispatch: { state: "queued" as const },
      admittedAt: 1_000,
    });
    emit(
      deltasFrame([
        { op: "state.updated", patch: { queue: { items: [queued("in-2")], autoDrain: true } } },
      ]),
    );
    // 队列空了，但下一个开跑的是 in-3：in-2 是被丢弃的。
    emit(deltasFrame([{ op: "state.updated", patch: { queue: { items: [], autoDrain: true } } }]));
    expect(events.some((event) => event.type === "turn_steer_status")).toBe(false);

    emit(
      deltasFrame([
        {
          op: "row.appended",
          row: {
            rowId: 9,
            turnId: "turn-2",
            createdAt: 3_000,
            createdAtSeq: 9,
            kind: "turnHeader",
            origin: "userInput",
            sourceCommandId: "in-3",
            state: "running",
            startedAt: 3_000,
          } as ConversationRow,
        },
      ]),
    );
    const status = events.find(
      (event): event is Extract<NibiStreamEvent, { type: "turn_steer_status" }> =>
        event.type === "turn_steer_status",
    );
    expect(status).toMatchObject({ status: "discarded", pendingInputIds: ["in-2"] });
    expect(status?.reason).toBeUndefined();
  });

  it("settles a vanished queue item as drained when that same input starts", async () => {
    const { sink, events, emit } = createHarness(snapshotFrame([turnHeaderRow(1, "running")]));
    sink.activate();
    await Promise.resolve();
    const queued = {
      sourceCommandId: "in-2",
      queueItemId: "queue_in-2",
      clientId: "c1",
      kind: "sendText" as const,
      text: "next",
      attachments: [],
      delivery: { requested: "queue" as const, admitted: "queue" as const },
      order: { admissionSeq: 0 },
      steer: { state: "notRequested" as const },
      dispatch: { state: "queued" as const },
      admittedAt: 1_000,
    };
    emit(
      deltasFrame([{ op: "state.updated", patch: { queue: { items: [queued], autoDrain: true } } }]),
    );
    emit(deltasFrame([{ op: "state.updated", patch: { queue: { items: [], autoDrain: true } } }]));
    emit(
      deltasFrame([
        {
          op: "row.appended",
          row: {
            rowId: 9,
            turnId: "turn-2",
            createdAt: 3_000,
            createdAtSeq: 9,
            kind: "turnHeader",
            origin: "userInput",
            sourceCommandId: "in-2",
            state: "running",
            startedAt: 3_000,
          } as ConversationRow,
        },
      ]),
    );
    const statuses = events.filter(
      (event): event is Extract<NibiStreamEvent, { type: "turn_steer_status" }> =>
        event.type === "turn_steer_status",
    );
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ status: "drained", pendingInputIds: ["in-2"] });
  });
});
