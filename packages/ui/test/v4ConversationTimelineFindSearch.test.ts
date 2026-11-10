// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  TurnHeaderRow,
  UserInputRow,
} from "@nibi/shared/nibi-protocol-v4";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { useConversationTimelineFind } from "@/v4/useConversationTimelineFind.js";

const highlight = vi.hoisted(() => ({
  applySearchResultHighlight: vi.fn(),
  isConversationFindRowMounted: vi.fn(),
  scrollConversationFindRangeIntoView: vi.fn(),
}));

vi.mock("@/v4/conversationFindHighlightDom.js", () => ({
  applyConversationFindHighlights: () => null,
  applySearchResultHighlight: highlight.applySearchResultHighlight,
  clearConversationFindHighlights: () => {},
  clearSearchResultHighlight: () => {},
  isConversationFindRowMounted: highlight.isConversationFindRowMounted,
  scrollConversationFindRangeIntoView: highlight.scrollConversationFindRangeIntoView,
}));

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

const rows: ConversationRow[] = [
  baseRow<TurnHeaderRow>({
    rowId: 1,
    turnId: "turn-1",
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_700_000_000_000,
    activeMs: 1_000,
  }),
  baseRow<UserInputRow>({
    rowId: 2,
    turnId: "turn-1",
    kind: "userInput",
    text: "needle query",
    origin: "realUser",
  }),
  baseRow<AssistantTextRow>({
    rowId: 3,
    turnId: "turn-1",
    kind: "assistantText",
    text: "answer",
    state: "complete",
  }),
];
const renderUnits = buildConversationTurnRenderUnits(rows, { nowMs: 1 });

const request = {
  requestId: 7,
  taskId: "task-1",
  workspacePath: "/workspace",
  query: "needle",
};

function mountFind(options: {
  done: (requestId: number) => void;
  scrollToUnit: (unitIndex: number) => void;
}) {
  const rootRef = { current: document.createElement("div") };
  return renderHook(
    (props: { mountedRowsKey: string }) =>
      useConversationTimelineFind({
        rootRef,
        renderUnits,
        rows,
        mountedRowsKey: props.mountedRowsKey,
        canLoadOlder: false,
        loadingOlder: false,
        sessionPhase: "completedSuccess",
        conversationFindQuery: "",
        conversationFindActiveIndex: -1,
        conversationFindNavigationRequestId: 0,
        searchResultHighlightRequest: request,
        onSearchResultHighlightDone: options.done,
        scrollToUnit: options.scrollToUnit,
      }),
    { initialProps: { mountedRowsKey: "0" } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  highlight.applySearchResultHighlight.mockReset();
  highlight.isConversationFindRowMounted.mockReset();
  highlight.scrollConversationFindRangeIntoView.mockReset();
});

describe("useConversationTimelineFind search result localization", () => {
  it("目标未挂载时继续粗定位，不把它当成无 Range 的已完成定位", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    highlight.isConversationFindRowMounted.mockReturnValue(false);
    const done = vi.fn();
    const scrollToUnit = vi.fn();

    const view = mountFind({ done, scrollToUnit });
    expect(scrollToUnit).toHaveBeenCalledWith(0);
    expect(done).not.toHaveBeenCalled();

    // 挂载窗口变化（目标仍未挂载）：未完成请求允许再次粗定位。
    scrollToUnit.mockClear();
    highlight.isConversationFindRowMounted.mockReturnValue(false);
    view.rerender({ mountedRowsKey: "1" });
    expect(scrollToUnit).toHaveBeenCalledWith(0);
    expect(done).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("目标已挂载但没有可高亮 Range 时直接回报结束，不再滚动", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    highlight.isConversationFindRowMounted.mockReturnValue(true);
    highlight.applySearchResultHighlight.mockReturnValue(null);
    const done = vi.fn();
    const scrollToUnit = vi.fn();

    mountFind({ done, scrollToUnit });
    expect(highlight.applySearchResultHighlight).toHaveBeenCalled();
    expect(highlight.scrollConversationFindRangeIntoView).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(request.requestId);
    vi.unstubAllGlobals();
  });

  it("目标已挂载且命中真实 Range 时立即居中", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    highlight.isConversationFindRowMounted.mockReturnValue(true);
    const range = document.createRange();
    highlight.applySearchResultHighlight.mockReturnValue(range);
    const done = vi.fn();
    const scrollToUnit = vi.fn();

    mountFind({ done, scrollToUnit });
    expect(highlight.scrollConversationFindRangeIntoView).toHaveBeenCalledWith(range);
    vi.unstubAllGlobals();
  });
});
