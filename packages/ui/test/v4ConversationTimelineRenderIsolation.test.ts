// @vitest-environment jsdom
// 渲染隔离验收：时钟只让运行中的 turn 重新渲染，已完成 turn 的 render unit 保持引用。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@nibi/shared/nibi-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";

const groupRenders = vi.hoisted(() => [] as string[]);

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: {
    count: number;
    getItemKey?: (index: number) => string | number;
  }) => {
    const totalSize = options.count * 100;
    return {
      // 渲染全部历史虚拟行，才能观察“历史 turn 不随时钟/尾流重渲染”。
      getVirtualItems: () =>
        Array.from({ length: options.count }, (_, index) => ({
          index,
          key: options.getItemKey?.(index) ?? index,
          start: index * 100,
          size: 100,
          end: (index + 1) * 100,
          lane: 0,
        })),
      getTotalSize: () => totalSize,
      getVirtualItemForOffset: () => null,
      measure: () => {},
      measureElement: () => {},
      resizeItem: () => {},
      scrollOffset: 0,
      scrollRect: { height: 600 },
      scrollToIndex: () => {},
    };
  },
}));

vi.mock("@/v4/ConversationTurnGroup.js", async () => {
  const React = await import("react");
  // 与真实组件一致：turn group 是 memo 边界，unit 引用不变时跳过渲染。
  return {
    ConversationTurnGroup: React.memo(function MockConversationTurnGroup(props: {
      unit: ConversationTurnRenderUnit;
    }) {
      groupRenders.push(props.unit.key);
      return React.createElement("div", { "data-turn-key": props.unit.key });
    }),
  };
});

vi.mock("@/v4/ConversationTurnNavigator.js", () => ({
  ConversationTurnNavigator: () => null,
}));

vi.mock("@/v4/useConversationTimelineFind.js", () => ({
  useConversationTimelineFind: () => undefined,
}));

const { ConversationTimeline } = await import("@/v4/ConversationTimeline.js");

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

function userInput(rowId: number, turnId: string): UserInputRow {
  return baseRow<UserInputRow>({
    rowId,
    turnId,
    kind: "userInput",
    text: "query",
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

const completedTurn: ConversationRow[] = [
  turnHeader(1, "turn-1"),
  userInput(2, "turn-1"),
  assistantText(3, "turn-1", "completed answer"),
];
const runningTurn: ConversationRow[] = [
  turnHeader(4, "turn-2", {
    state: "running",
    activeMs: undefined,
    startedAt: 1_700_000_100_000,
  }),
  userInput(5, "turn-2"),
  assistantText(6, "turn-2", "streaming", { state: "streaming" }),
];

const rowContext = {
  workspacePath: "/workspace",
  theme: "dark",
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
} as ConversationRowRenderContext;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderTimeline(rows: ConversationRow[]) {
  act(() => {
    root!.render(
      createElement(
        ZCodeIntlProvider,
        null,
        createElement(ConversationTimeline, {
          rows,
          sessionKey: "session-1",
          rowContext,
        }),
      ),
    );
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  groupRenders.length = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  groupRenders.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("ConversationTimeline render isolation", () => {
  it("每秒时钟只重渲染运行 turn，已完成 turn 保持 memo 稳定引用", () => {
    const rows = [...completedTurn, ...runningTurn];
    renderTimeline(rows);
    expect(groupRenders.sort()).toEqual(["turn-1", "turn-2"]);

    groupRenders.length = 0;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(groupRenders).toEqual(["turn-2"]);

    groupRenders.length = 0;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(groupRenders).toEqual(["turn-2"]);
  });

  it("尾轮流式追加只重渲染该轮，历史轮不重渲染", () => {
    renderTimeline([...completedTurn, ...runningTurn]);
    groupRenders.length = 0;

    const streamingRows = [...completedTurn, ...runningTurn].map((row) =>
      row.rowId === 6 ? { ...row, text: "streaming +delta" } : row,
    );
    renderTimeline(streamingRows);
    expect(groupRenders).toEqual(["turn-2"]);
  });
});
