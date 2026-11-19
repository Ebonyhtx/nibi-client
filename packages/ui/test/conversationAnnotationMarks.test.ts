// @vitest-environment jsdom
import { createElement, useRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import {
  ConversationAnnotationMarks,
  type AnnotationMarkItem,
} from "@/selection-comment/ConversationAnnotationMarks.js";
import { ConversationSelectionTooltip } from "@/v4/ConversationSelectionTooltip.js";
import {
  setConversationSelectionReferenceScope,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

const lineRects = [
  { left: 10, right: 60, top: 20, bottom: 36, width: 50, height: 16 },
] as DOMRect[];

function TooltipHarness({ workspaceKey }: { workspaceKey?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  return createElement(
    "div",
    { ref },
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
      rows: [],
      sourceSessionId: "session-1",
      enabled: false,
      ...(workspaceKey ? { annotationWorkspaceKey: workspaceKey } : {}),
      onAddToCurrentTask: () => undefined,
      onAskInSideChat: () => undefined,
    }),
  );
}

function marksHarness(items: readonly AnnotationMarkItem[]) {
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    return createElement(
      "div",
      { ref },
      createElement(
        "div",
        { "data-v4-timeline-message-layer": "true" },
        createElement(
          "div",
          { "data-row-id": "1" },
          createElement("div", { "data-conversation-selectable": "true" }, "hello world"),
        ),
      ),
      createElement(ConversationAnnotationMarks, {
        rootRef: ref,
        items,
        hoveredId: null,
        onHover: () => undefined,
        onActivate: () => undefined,
      }),
    );
  }
  return createElement(Harness);
}

const anchor = { regionIndex: 0, start: 0, end: 5, rangeText: "hello" };

beforeEach(() => {
  if (typeof Range.prototype.getClientRects !== "function") {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      writable: true,
      value: () => [],
    });
  }
  vi.spyOn(Range.prototype, "getClientRects").mockReturnValue(lineRects as unknown as DOMRectList);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("ConversationAnnotationMarks", () => {
  it("portals underlines and numbered bubbles into the timeline message layer", async () => {
    const items: AnnotationMarkItem[] = [
      {
        id: "ref-1",
        number: 1,
        variant: "comment",
        rowId: 1,
        anchor,
        text: "hello world",
      },
    ];
    const { container } = render(marksHarness(items));
    await waitFor(() => {
      expect(container.querySelector('[data-annotation-mark="ref-1"]')).not.toBeNull();
    });
    const layer = container.querySelector('[data-v4-timeline-message-layer="true"]');
    expect(layer?.querySelector('[data-conversation-annotation-marks="true"]')).not.toBeNull();
    const bubble = layer?.querySelector<HTMLElement>('[data-annotation-mark-id="ref-1"]');
    expect(bubble?.dataset.annotationMarkNumber).toBe("1");
    expect(bubble?.querySelector("[data-annotation-number-variant]")?.textContent).toBe("1");
  });

  it("draws no mark when the text anchor no longer resolves", async () => {
    const items: AnnotationMarkItem[] = [
      {
        id: "ref-broken",
        number: 1,
        variant: "comment",
        rowId: 1,
        anchor: { ...anchor, rangeText: "changed" },
        text: "hello world",
      },
    ];
    const { container } = render(marksHarness(items));
    await waitFor(() => {
      expect(container.querySelector('[data-annotation-mark="ref-broken"]')).toBeNull();
    });
  });

  it("renders the sent variant without an interactive bubble", async () => {
    const items: AnnotationMarkItem[] = [
      {
        id: "sent:ref-1",
        number: 1,
        variant: "sent-comment",
        rowId: 1,
        anchor,
        text: "hello world",
      },
    ];
    const { container } = render(marksHarness(items));
    await waitFor(() => {
      expect(container.querySelector('[data-annotation-mark="sent:ref-1"]')).not.toBeNull();
    });
    expect(container.querySelector("[data-annotation-mark-id]")).toBeNull();
    expect(
      container.querySelector('[data-annotation-number-variant="sent-comment"]')?.textContent,
    ).toBe("1");
  });

  it("workspace key absent means no marks even when annotations exist", async () => {
    const reference: ConversationSelectionReference = {
      id: "ref-1",
      contentType: "assistant",
      sourceSessionId: "session-1",
      sourceRowId: 1,
      text: "hello world",
      comment: "note",
      anchor,
    };
    setConversationSelectionReferenceScope("session-1", "/ws", [reference]);
    const renderTooltip = (workspaceKey?: string) =>
      render(
        createElement(
          NibiIntlProvider,
          { initialLocale: "en-US" },
          createElement(TooltipHarness, { workspaceKey }),
        ),
      );

    const withoutKey = renderTooltip();
    await waitFor(() => {
      expect(withoutKey.container.querySelector("[data-annotation-mark]")).toBeNull();
    });
    withoutKey.unmount();

    const withKey = renderTooltip("/ws");
    await waitFor(() => {
      expect(withKey.container.querySelector("[data-annotation-mark]")).not.toBeNull();
    });
    setConversationSelectionReferenceScope("session-1", "/ws", []);
  });
});
