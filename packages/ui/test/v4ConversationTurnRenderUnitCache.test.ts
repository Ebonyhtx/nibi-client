import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@nibi/shared/nibi-protocol-v4";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { ConversationTurnRenderUnitCache } from "@/v4/conversationTurnRenderUnitCache.js";

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

function turnHeader(
  rowId: number,
  turnId: string,
  overrides: Partial<TurnHeaderRow> = {},
): TurnHeaderRow {
  return baseRow<TurnHeaderRow>({
    rowId,
    turnId,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000 + rowId,
    activeMs: 11_000,
    ...overrides,
  });
}

function userInput(rowId: number, turnId: string, text: string): UserInputRow {
  return baseRow<UserInputRow>({
    rowId,
    turnId,
    kind: "userInput",
    text,
    origin: "realUser",
  });
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

function completedTurn(turnId: string, baseRowId: number): ConversationRow[] {
  return [
    turnHeader(baseRowId, turnId),
    userInput(baseRowId + 1, turnId, `${turnId} query`),
    assistantText(baseRowId + 2, turnId, `${turnId} answer`),
  ];
}

describe("ConversationTurnRenderUnitCache", () => {
  it("已完成 turn 不因逐秒变化的 nowMs 失效（稳定引用）", () => {
    const rows = [...completedTurn("turn-1", 1), ...completedTurn("turn-2", 4)];
    const cache = new ConversationTurnRenderUnitCache();

    const first = cache.build(rows, { nowMs: 1_700_000_100_000 });
    const second = cache.build(rows, { nowMs: 1_700_000_101_000 });

    expect(first.map((unit) => unit.key)).toEqual(["turn-1", "turn-2"]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it("时钟只让运行轮失效，历史轮保持原 render unit", () => {
    const rows: ConversationRow[] = [
      ...completedTurn("turn-1", 1),
      turnHeader(4, "turn-2", {
        state: "running",
        activeMs: undefined,
        startedAt: 1_700_000_100_000,
      }),
      userInput(5, "turn-2", "streaming query"),
      assistantText(6, "turn-2", "partial", { state: "streaming" }),
    ];
    const cache = new ConversationTurnRenderUnitCache();

    const first = cache.build(rows, { nowMs: 1_700_000_101_000 });
    const second = cache.build(rows, { nowMs: 1_700_000_104_000 });

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(first[1]?.workSegments?.at(-1)?.workStatus?.durationMs).toBe(1_000);
    expect(second[1]?.workSegments?.at(-1)?.workStatus?.durationMs).toBe(4_000);
  });

  it("流式正文只重建尾轮；未变化的历史 turn 保持引用", () => {
    const baseRows: ConversationRow[] = [
      ...completedTurn("turn-1", 1),
      ...completedTurn("turn-2", 4),
    ];
    const cache = new ConversationTurnRenderUnitCache();
    const first = cache.build(baseRows, { nowMs: 1_700_000_100_000 });
    const streamingRows = baseRows.map((row) =>
      row.rowId === 6 ? { ...row, text: `${(row as AssistantTextRow).text} +delta` } : row,
    );
    const second = cache.build(streamingRows, { nowMs: 1_700_000_100_000 });

    expect(second[0]).toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1]?.latestAssistantTextRow?.text).toContain("+delta");
  });

  it("缓存只保留当前窗口：离开窗口的 turn 条目被删除", () => {
    const cache = new ConversationTurnRenderUnitCache();
    cache.build([...completedTurn("turn-1", 1), ...completedTurn("turn-2", 4)]);
    expect(cache.size).toBe(2);
    expect(cache.has("turn-1")).toBe(true);

    cache.build(completedTurn("turn-2", 4));
    expect(cache.size).toBe(1);
    expect(cache.has("turn-1")).toBe(false);
    expect(cache.has("turn-2")).toBe(true);
  });

  it("新轮追加时最后一轮的位置语义重新归一（isLastTurn 不滞留）", () => {
    const cache = new ConversationTurnRenderUnitCache();
    const first = cache.build(completedTurn("turn-1", 1));
    expect(first[0]?.isLastTurn).toBe(true);

    const second = cache.build([...completedTurn("turn-1", 1), ...completedTurn("turn-2", 4)]);
    expect(second[0]?.isLastTurn).toBe(false);
    expect(second[1]?.isLastTurn).toBe(true);
    // 尾轮位置变化后不再复用旧的归一化结果。
    expect(second[0]).not.toBe(first[0]);
  });

  it("缓存结果与无缓存 builder 逐值一致", () => {
    const rows: ConversationRow[] = [
      ...completedTurn("turn-1", 1),
      turnHeader(5, "turn-2"),
      userInput(6, "turn-2", "second query"),
      assistantText(7, "turn-2", "second answer", { actions: { canRetry: true } }),
    ];
    const options = { nowMs: 1_700_000_100_000 } as const;
    const cache = new ConversationTurnRenderUnitCache();

    expect(cache.build(rows, options)).toEqual(buildConversationTurnRenderUnits(rows, options));
    // 缓存命中路径也返回同一值。
    expect(cache.build(rows, options)).toEqual(buildConversationTurnRenderUnits(rows, options));
  });
});
