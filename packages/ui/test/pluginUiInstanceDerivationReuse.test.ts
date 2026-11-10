import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  ToolCallRow,
  TurnHeaderRow,
  UserInputRow,
} from "@nibi/shared/nibi-protocol-v4";
import { deriveLogicalUiInstances } from "@/plugin-ui/domain/pluginUiInstancePolicy.js";

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
  return baseRow<UserInputRow>({
    rowId,
    turnId,
    kind: "userInput",
    text: "query",
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

function pluginTool(rowId: number, turnId: string, status: ToolCallRow["status"]): ToolCallRow {
  return baseRow<ToolCallRow>({
    rowId,
    turnId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName: "read_plugin_resource",
    status,
    inputText: "{}",
    display: {
      kind: "mcp_tool",
      serverName: "plugin-server",
      ui: {
        pluginId: "plugin-1",
        resourceUri: "ui://plugin/card",
      },
    } as ToolCallRow["display"],
  });
}

describe("deriveLogicalUiInstances identity reuse", () => {
  it("正文更新不改变插件展示裁决对象；插件行或回合顺序变化才重建", () => {
    const base: ConversationRow[] = [
      turnHeader(1, "turn-1"),
      userInput(2, "turn-1"),
      pluginTool(3, "turn-1", "success"),
      assistantText(4, "turn-1", "answer"),
    ];
    const first = deriveLogicalUiInstances(base);

    const textOnly = base.map((row) =>
      row.rowId === 4 ? { ...row, text: "answer +delta" } : row,
    );
    expect(deriveLogicalUiInstances(textOnly)).toBe(first);

    const statusChanged = base.map((row) =>
      row.rowId === 3 ? { ...row, status: "running" } : row,
    );
    const second = deriveLogicalUiInstances(statusChanged);
    expect(second).not.toBe(first);
    expect(second.byToolCallId["tool-3"]?.superseded).toBe(false);

    const nextTurn: ConversationRow[] = [
      ...base,
      turnHeader(5, "turn-2"),
      userInput(6, "turn-2"),
      assistantText(7, "turn-2", "second answer"),
    ];
    // 回合顺序变化会改变“最近 N 轮自动展开”的裁决，必须重建。
    expect(deriveLogicalUiInstances(nextTurn)).not.toBe(first);
  });
});
