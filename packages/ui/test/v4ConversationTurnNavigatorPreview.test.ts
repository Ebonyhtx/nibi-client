import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@nibi/shared/nibi-protocol-v4";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { ConversationTurnRenderUnitCache } from "@/v4/conversationTurnRenderUnitCache.js";
import { buildConversationTurnNavigatorItems } from "@/v4/conversationTurnNavigatorHelpers.js";

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

function userInput(rowId: number, turnId: string, text: string): UserInputRow {
  return baseRow<UserInputRow>({
    rowId,
    turnId,
    kind: "userInput",
    text,
    origin: "realUser",
  });
}

function assistantText(rowId: number, turnId: string, text: string): AssistantTextRow {
  return baseRow<AssistantTextRow>({
    rowId,
    turnId,
    kind: "assistantText",
    text,
    state: "complete",
  });
}

const options = {
  assistantEmptyPreview: "No assistant text yet",
  assistantRunningPreview: "Assistant is still working",
  userFallbackPreview: "User turn",
};

function itemsFor(text: string, overrides: Partial<typeof options> & { maxPreviewChars?: number; maxPreviewParagraphs?: number } = {}) {
  const units = buildConversationTurnRenderUnits(
    [turnHeader(1, "turn-1"), userInput(2, "turn-1", "query"), assistantText(3, "turn-1", text)],
    { nowMs: 1_700_000_100_000 },
  );
  return buildConversationTurnNavigatorItems(units, { ...options, ...overrides });
}

describe("conversation turn navigator preview bounds", () => {
  it("长单段正文按字符上限截断，省略号与 trim 语义保持不变", () => {
    const fullText = `${"word ".repeat(200)}\n\nsecond paragraph`;
    const [item] = itemsFor(fullText, { maxPreviewChars: 88, maxPreviewParagraphs: 2 });
    const normalized = "word ".repeat(200).trim();
    const expected = `${normalized.slice(0, 85).trimEnd()}...`;

    expect(item?.assistantPreview).toBe(expected);
    expect(item?.assistantPreview.length).toBeLessThanOrEqual(88);
  });

  it("段落上限只取前 N 段；后续段落追加不影响已确定的预览", () => {
    const first = itemsFor("first paragraph\n\nsecond paragraph\n\nthird paragraph", {
      maxPreviewChars: 88,
      maxPreviewParagraphs: 2,
    });
    const second = itemsFor("first paragraph\n\nsecond paragraph\n\nthird paragraph with more", {
      maxPreviewChars: 88,
      maxPreviewParagraphs: 2,
    });

    expect(first[0]?.assistantPreview).toBe("first paragraph\nsecond paragraph");
    expect(second[0]?.assistantPreview).toBe(first[0]?.assistantPreview);
  });

  it("超过字符上限后，后续正文变化不改变预览（只扫描足够确定的前缀）", () => {
    const head = `${"a".repeat(400)}`;
    const first = itemsFor(`${head}\n\nlater paragraph`, {
      maxPreviewChars: 88,
      maxPreviewParagraphs: 2,
    });
    const second = itemsFor(`${head}\n\nlater paragraph ${"b".repeat(2_000)}`, {
      maxPreviewChars: 88,
      maxPreviewParagraphs: 2,
    });

    expect(first[0]?.assistantPreview).toBe(`${head.slice(0, 85)}...`);
    expect(second[0]?.assistantPreview).toBe(first[0]?.assistantPreview);
  });

  it("空白归一与空正文 fallback 保持原语义", () => {
    expect(itemsFor("  spaced    out\n\n   text   ")[0]?.assistantPreview).toBe("spaced out\ntext");
    expect(itemsFor("   \n\n  ")[0]?.assistantPreview).toBe(options.assistantEmptyPreview);
  });
});

describe("conversation turn navigator item reuse", () => {
  const rows: ConversationRow[] = [
    turnHeader(1, "turn-1"),
    userInput(2, "turn-1", "first query"),
    assistantText(3, "turn-1", "first answer"),
    turnHeader(4, "turn-2"),
    userInput(5, "turn-2", "second query"),
    assistantText(6, "turn-2", "second answer"),
  ];

  it("同一窗口的目录项按 turn 复用同一对象；新增行只重建所属 turn", () => {
    const cache = new ConversationTurnRenderUnitCache();
    const units = cache.build(rows, { nowMs: 1_700_000_100_000 });
    const first = buildConversationTurnNavigatorItems(units, options);
    const second = buildConversationTurnNavigatorItems(units, options);

    expect(second).toHaveLength(first.length);
    first.forEach((item, index) => {
      expect(second[index]).toBe(item);
    });

    // 尾轮正文更新 → 只有尾轮目录项换新对象，历史项保持引用。
    const streamingRows = rows.map((row) =>
      row.rowId === 6 ? { ...row, text: "second answer +delta" } : row,
    );
    const nextUnits = cache.build(streamingRows, { nowMs: 1_700_000_100_000 });
    expect(nextUnits[0]).toBe(units[0]);
    const third = buildConversationTurnNavigatorItems(nextUnits, options);
    expect(third[0]).toBe(first[0]);
    expect(third[1]).not.toBe(first[1]);
    expect(third[1]?.assistantPreview).toBe("second answer +delta");
  });

  it("预览配置变化会使缓存失效（不会复用旧文案）", () => {
    const units = buildConversationTurnRenderUnits(rows, { nowMs: 1_700_000_100_000 });
    const first = buildConversationTurnNavigatorItems(units, options);
    const second = buildConversationTurnNavigatorItems(units, {
      ...options,
      assistantRunningPreview: "Different running copy",
    });
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]?.assistantPreview).toBe(first[0]?.assistantPreview);
  });
});
