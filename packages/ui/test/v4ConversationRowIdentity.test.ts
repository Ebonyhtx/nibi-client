import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@nibi/shared/nibi-protocol-v4";
import { applyConversationDelta } from "@nibi/shared/nibi-protocol-v4";
import type { ConversationSnapshot } from "@nibi/shared/nibi-protocol-v4";
import { ConversationTurnRenderUnitCache } from "@/v4/turnRenderUnitCache/index.js";

function baseRow<T extends ConversationRow>(
  row: Omit<T, "createdAt" | "createdAtSeq" | "rowId" | "turnId"> & {
    rowId: number;
    turnId: string;
  },
): T {
  return {
    createdAt: 1_700_000_000_000 + row.rowId,
    createdAtSeq: row.rowId,
    ...row,
  } as T;
}

function turnHeader(rowId: number, turnId: string): TurnHeaderRow {
  return baseRow<TurnHeaderRow>({
    rowId,
    turnId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000 + rowId,
    activeMs: 1_000,
  });
}

function userInput(rowId: number, turnId: string): UserInputRow {
  return baseRow<UserInputRow>({ rowId, turnId, kind: "userInput", text: "query", origin: "realUser" });
}

function assistantText(
  rowId: number,
  turnId: string,
  text: string,
  overrides: Partial<AssistantTextRow> = {},
): AssistantTextRow {
  return baseRow<AssistantTextRow>({
    rowId,
    turnId,
    kind: "assistantText",
    text,
    state: "complete",
    ...overrides,
  });
}

function snapshotFor(rows: ConversationRow[]): ConversationSnapshot {
  return {
    seq: 1,
    sessionId: "session-1",
    phase: "completedSuccess",
    rows: {
      window: rows,
      totalCount: rows.length,
      firstRowId: rows[0]?.rowId ?? null,
      lastRowId: rows.at(-1)?.rowId ?? null,
    },
    workflowRuns: {},
  } as unknown as ConversationSnapshot;
}

describe("projection row identity → turn derivation identity", () => {
  it("row.delta 只替换目标行；历史 turn 的派生结果继续复用", () => {
    const historyRows: ConversationRow[] = [
      turnHeader(1, "turn-1"),
      userInput(2, "turn-1"),
      assistantText(3, "turn-1", "done answer"),
    ];
    const tailRows: ConversationRow[] = [
      turnHeader(4, "turn-2"),
      userInput(5, "turn-2"),
      assistantText(6, "turn-2", "streaming", { state: "streaming" }),
    ];
    const cache = new ConversationTurnRenderUnitCache();
    const initialSnapshot = snapshotFor([...historyRows, ...tailRows]);
    const first = cache.build(initialSnapshot.rows.window, { nowMs: 1_700_000_100_000 });

    const nextSnapshot = applyConversationDelta(initialSnapshot, {
      op: "row.delta",
      rowId: 6,
      path: "text",
      append: " +delta",
      seq: 2,
    });
    // 未变化的行保持对象引用（projection store 的稳定引用前提）。
    expect(nextSnapshot.rows.window[0]).toBe(initialSnapshot.rows.window[0]);
    expect(nextSnapshot.rows.window[2]).toBe(initialSnapshot.rows.window[2]);
    expect(nextSnapshot.rows.window[5]).not.toBe(initialSnapshot.rows.window[5]);

    const second = cache.build(nextSnapshot.rows.window, { nowMs: 1_700_000_100_000 });
    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]?.latestAssistantTextRow?.text).toBe("streaming +delta");
  });
});
