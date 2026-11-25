// 逐行降级：snapshot 的 `rows.window` 与 rows/range 的历史回补按行容错，
// deltas 仍严格（丢一条行变更会让投影与权威发散）。
//
// 修复前：`rows.window` 是 `z.array(conversationRowSchema)`，一行读不懂则整帧被拒
// （`proto.frameAssemblyInvalidPayload`）→ 确定性内容失败 → 强制 snapshot → 同一份内容再被拒
// → `fault.subscription.contentRejected`，会话永久打不开。
// 修复后：只在这两处逐行降级；连 RowBase 的四个稳定字段都读不懂时仍 fail closed。
//
// 这些用例是跨版本偏斜的**消费端**契约，schema 由 `@nibi/shared/nibi-protocol-v4` 提供，
// CLI 与 App 两侧共用同一份。

import { describe, expect, it } from "vitest";
import {
  WIRE_FAULT_INVALID_PAYLOAD,
  conversationTopicFrameSchema,
  isDeterministicContentFault,
  v4ConversationRowsRangeResultSchema,
  type ConversationSnapshot,
} from "../src/nibi-protocol-v4/index.js";

const TOPIC = "conversation/row-degradation";
const SUBSCRIPTION_ID = "sub-row-degradation";

function baseSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-row-degradation",
    logEpoch: "epoch-row-degradation",
    seq: 1,
    revision: 1,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "assistant",
      activeWorks: [{ kind: "primaryTurn", startedAt: 1000 }],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: false, reasonCode: "guard.manualCompact" },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: false, reasonCode: "guard.sendQueuedNowStopsBeforeDrain" },
      pauseGoal: { allowed: false, reasonCode: "guard.noGoal" },
      resumeGoal: { allowed: false, reasonCode: "guard.stopPausesActiveGoalTarget" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title: "", titleSource: "default" },
    config: {
      provider: "nibi-agent",
      model: "glm-5",
      thought: "medium",
      thoughtLevels: ["medium", "high", "max"],
      followupMode: "queue",
      mode: "build",
    },
    modelTransition: null,
    usage: {
      contextWindow: { usedTokens: 100, maxTokens: 200000, autoCompactThresholdTokens: null },
      cumulative: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    workspaceHookAdmission: null,
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

/** 走一次 JSON 往返，得到和 wire 上完全一样的原始对象，再在上面制造偏斜。 */
function wireSnapshot(): {
  rows: { window: Array<Record<string, unknown>>; totalCount: number; firstRowId: number | null };
} {
  return JSON.parse(JSON.stringify(baseSnapshot())) as {
    rows: { window: Array<Record<string, unknown>>; totalCount: number; firstRowId: number | null };
  };
}

function frameWith(snapshot: unknown) {
  return {
    topic: TOPIC,
    subscriptionId: SUBSCRIPTION_ID,
    fromSeq: 0,
    toSeq: 1,
    sentAt: 0,
    payload: { kind: "snapshot", snapshot },
  };
}

function parseWindow(frame: unknown) {
  const parsed = conversationTopicFrameSchema.parse(frame);
  if (parsed.payload.kind !== "snapshot") throw new Error("Expected a snapshot payload");
  return parsed.payload.snapshot.rows.window;
}

const VALID_ASSISTANT_ROW = {
  rowId: 1,
  turnId: "turn-1",
  createdAt: 1_700_000_000_000,
  createdAtSeq: 1,
  kind: "assistantText",
  text: "hello",
  state: "complete",
};

/** 比本端新的发送端：一种本端没有的行类型。这是最可能的偏斜源。 */
const UNKNOWN_KIND_ROW = {
  rowId: 9001,
  turnId: "turn-future",
  createdAt: 1_700_000_000_000,
  createdAtSeq: 9001,
  kind: "holographicPreview",
  payload: { anything: true },
};

/** 已知行类型，但必填字段缺席（闭集枚举加值、字段改名都会落到这一档）。 */
const SKEWED_TOOL_CALL_ROW = {
  rowId: 9002,
  turnId: "turn-future",
  createdAt: 1_700_000_000_001,
  createdAtSeq: 9002,
  kind: "toolCall",
  toolCallId: "future-call",
  // toolName、status、inputText 全部缺席：没有卡可丢，修复前必然拒整帧。
};

describe("snapshot 的 rows.window 逐行降级", () => {
  it("未知行类型只让那一行退化，整帧照常交付", () => {
    const snapshot = wireSnapshot();
    snapshot.rows.window.push(VALID_ASSISTANT_ROW);
    const knownRowCount = snapshot.rows.window.length;
    snapshot.rows.window.push(UNKNOWN_KIND_ROW);
    const rows = parseWindow(frameWith(snapshot));
    expect(rows).toHaveLength(knownRowCount + 1);
    // 身份与位置必须原样保留：降级改变的是能不能渲染，不是它是否存在、排在哪里。
    expect(rows.at(-1)).toEqual({
      kind: "unreadable",
      rowId: 9001,
      turnId: "turn-future",
      createdAt: 1_700_000_000_000,
      createdAtSeq: 9001,
      sourceKind: "holographicPreview",
    });
    // 占位行不携带任何无法确认的事实。
    expect(rows.at(-1)).not.toHaveProperty("payload");
  });

  it("已知行类型的必填字段偏斜同样只退化那一行", () => {
    const snapshot = wireSnapshot();
    snapshot.rows.window.push(SKEWED_TOOL_CALL_ROW);
    const degraded = parseWindow(frameWith(snapshot)).at(-1);
    expect(degraded).toMatchObject({ kind: "unreadable", rowId: 9002 });
    // sourceKind 保留原自报类型，诊断时才分得清「未知类型」与「已知类型但字段偏斜」。
    expect(degraded).toHaveProperty("sourceKind", "toolCall");
  });

  it("合法行不受影响，计数与游标事实不变", () => {
    const clean = wireSnapshot();
    clean.rows.window.push(VALID_ASSISTANT_ROW);
    clean.rows.totalCount = 1;
    clean.rows.firstRowId = 1;
    const skewed = JSON.parse(JSON.stringify(clean)) as ReturnType<typeof wireSnapshot>;
    skewed.rows.window.push(UNKNOWN_KIND_ROW);
    const cleanRows = parseWindow(frameWith(clean));
    const skewedRows = parseWindow(frameWith(skewed));
    // union 的顺序是语义的一部分：严格成员在前，合法行不能被当成占位行。
    expect(skewedRows.slice(0, -1)).toEqual(cleanRows);
    expect(skewedRows[0]).toMatchObject({ kind: "assistantText", rowId: 1 });
    const parsed = conversationTopicFrameSchema.parse(frameWith(skewed));
    if (parsed.payload.kind !== "snapshot") throw new Error("Expected a snapshot payload");
    expect(parsed.payload.snapshot.rows.totalCount).toBe(clean.rows.totalCount);
    expect(parsed.payload.snapshot.rows.firstRowId).toBe(clean.rows.firstRowId);
  });

  it("连 RowBase 的四个字段都读不懂时仍然拒帧", () => {
    const snapshot = wireSnapshot();
    // 没有 rowId 就无法确定身份与排序，降级会把「少一行」变成「错位的一屏」，必须 fail closed。
    snapshot.rows.window.push({ turnId: "turn-future", kind: "holographicPreview" });
    expect(() => conversationTopicFrameSchema.parse(frameWith(snapshot))).toThrow();
    expect(isDeterministicContentFault(WIRE_FAULT_INVALID_PAYLOAD)).toBe(true);
  });

  it("deltas 不走降级：丢一条行变更会让投影与权威发散", () => {
    expect(() =>
      conversationTopicFrameSchema.parse({
        topic: TOPIC,
        subscriptionId: SUBSCRIPTION_ID,
        fromSeq: 0,
        toSeq: 1,
        sentAt: 0,
        payload: { kind: "deltas", deltas: [{ op: "row.appended", row: UNKNOWN_KIND_ROW }] },
      }),
    ).toThrow();
  });
});

describe("rows/range 逐行降级", () => {
  it("历史回补里的未知行退化成 unreadable 占位行", () => {
    const parsed = v4ConversationRowsRangeResultSchema.parse({
      rows: [VALID_ASSISTANT_ROW, UNKNOWN_KIND_ROW],
      atSeq: 1,
      atRevision: 1,
      atLogEpoch: "epoch-row-degradation",
      hasMore: false,
    });
    expect(parsed.rows[0]).toMatchObject({ kind: "assistantText", rowId: 1 });
    expect(parsed.rows[1]).toEqual({
      kind: "unreadable",
      rowId: 9001,
      turnId: "turn-future",
      createdAt: 1_700_000_000_000,
      createdAtSeq: 9001,
      sourceKind: "holographicPreview",
    });
  });
});
