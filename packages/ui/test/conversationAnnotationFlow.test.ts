// @vitest-environment jsdom
import { act, createElement, useRef } from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationRow } from "@nibi/shared/nibi-protocol-v4";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationSelectionTooltip } from "@/v4/ConversationSelectionTooltip.js";
import {
  dispatchConversationSelectionAdd,
  getConversationSelectionReferenceScope,
  setConversationSelectionReferenceScope,
} from "@/lib/conversationSelectionReference.js";

const rows = [{ kind: "assistantText", rowId: 1 }] as unknown as ConversationRow[];

function FlowHarness() {
  const ref = useRef<HTMLDivElement>(null);
  return createElement(
    "div",
    { ref, "data-flow-root": "true" },
    createElement(
      "div",
      { "data-v4-timeline-message-layer": "true" },
      createElement(
        "div",
        { "data-row-id": "1" },
        createElement("div", { "data-conversation-selectable": "true" }, "hello world"),
      ),
    ),
    createElement(ConversationSelectionTooltip, {
      rootRef: ref,
      rows,
      sourceSessionId: "session-1",
      enabled: true,
      commentEnabled: true,
      annotationWorkspaceKey: "/ws",
      onAddToCurrentTask: (reference) =>
        dispatchConversationSelectionAdd({
          targetSessionId: "session-1",
          workspaceKey: "/ws",
          reference,
        }),
      onAskInSideChat: () => undefined,
    }),
  );
}

beforeEach(() => {
  if (typeof Range.prototype.getClientRects !== "function") {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      writable: true,
      value: () => [],
    });
  }
  if (typeof Range.prototype.getBoundingClientRect !== "function") {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      writable: true,
      value: () => ({ left: 20, top: 20, right: 120, bottom: 40, width: 100, height: 20 }),
    });
  }
  vi.spyOn(Range.prototype, "getBoundingClientRect").mockReturnValue({
    left: 20,
    top: 20,
    right: 120,
    bottom: 40,
    width: 100,
    height: 20,
  } as DOMRect);
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue([
    { left: 20, top: 20, right: 120, bottom: 36, width: 100, height: 16 },
  ] as unknown as DOMRectList);
  // jsdom 没有可视帧循环：同步执行，保证选区浮层与正文标记在一次事件内完成测量。
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(performance.now());
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  setConversationSelectionReferenceScope("session-1", "/ws", []);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  setConversationSelectionReferenceScope("session-1", "/ws", []);
});

function selectRowText(): void {
  const root = document.querySelector<HTMLElement>("[data-flow-root]")!;
  const textNode = root.querySelector("[data-conversation-selectable]")!.firstChild as Text;
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, 5);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  fireEvent.mouseUp(root);
}

describe("selection annotation flow", () => {
  it("selects text, annotates it, and stores the comment for the next message", async () => {
    render(createElement(NibiIntlProvider, { initialLocale: "en-US" }, createElement(FlowHarness)));
    act(selectRowText);

    await waitFor(() => {
      expect(
        document.querySelector('[data-conversation-selection-action="comment"]'),
      ).not.toBeNull();
    });
    fireEvent.click(document.querySelector('[data-conversation-selection-action="comment"]')!);

    await waitFor(() => {
      expect(
        document.querySelector('[data-conversation-selection-comment-editor="true"]'),
      ).not.toBeNull();
    });
    // 保存前正文已经预占编号 1，证明 pending 标记与输入浮层同步出现。
    await waitFor(() => {
      expect(document.querySelector('[data-annotation-mark="__pending__"]')).not.toBeNull();
    });
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-conversation-selection-comment-input]",
    )!;
    fireEvent.change(input, { target: { value: "  explain this  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(getConversationSelectionReferenceScope("session-1", "/ws")).toHaveLength(1);
    });
    expect(getConversationSelectionReferenceScope("session-1", "/ws")[0]).toMatchObject({
      text: "hello",
      comment: "explain this",
      contentType: "assistant",
      sourceRowId: 1,
      anchor: { regionIndex: 0, start: 0, end: 5, rangeText: "hello" },
    });
    expect(
      document.querySelector('[data-conversation-selection-comment-editor="true"]'),
    ).toBeNull();
    await waitFor(() => {
      expect(document.querySelector("[data-annotation-mark-id]")).not.toBeNull();
    });
  });
});
