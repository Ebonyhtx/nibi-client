// @vitest-environment jsdom
import { act } from "react";
import { cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANNOTATION_UNDO_MS,
  deleteConversationAnnotationWithUndo,
} from "@/selection-comment/annotationActions.js";
import {
  clearConversationSelectionReferenceScope,
  getConversationSelectionReferenceScope,
  setConversationSelectionReferenceScope,
  type ConversationSelectionReference,
} from "@/lib/conversationSelectionReference.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const reference: ConversationSelectionReference = {
  id: "ref-1",
  contentType: "assistant",
  sourceSessionId: "session-1",
  sourceRowId: 3,
  text: "hello world",
  comment: "note",
  anchor: { regionIndex: 0, start: 0, end: 5, rangeText: "hello" },
};

function deleteWithUndo() {
  deleteConversationAnnotationWithUndo({
    sessionId: "session-1",
    workspaceKey: "/ws",
    id: "ref-1",
    formatMessage: (id) =>
      id === "chat.selections.commentUndo"
        ? "Undo"
        : id === "chat.selections.commentDeleted"
          ? "Delete annotation"
          : id,
  });
}

function findUndoButton(): HTMLElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLElement>("button")).find(
      (button) => button.textContent === "Undo",
    ) ?? null
  );
}

async function flushToastTimers(ms = 100): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await Promise.resolve();
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  setConversationSelectionReferenceScope("session-1", "/ws", [reference]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  clearConversationSelectionReferenceScope("session-1", "/ws");
});

describe("annotation delete undo", () => {
  it("uses a 6 second undo window", () => {
    expect(ANNOTATION_UNDO_MS).toBe(6000);
  });

  it("deletes immediately and restores at the original position when Undo is clicked", async () => {
    await act(async () => {
      deleteWithUndo();
    });
    await flushToastTimers();
    expect(getConversationSelectionReferenceScope("session-1", "/ws")).toEqual([]);
    const undo = findUndoButton();
    expect(undo).not.toBeNull();
    await act(async () => {
      fireEvent.click(undo!);
    });
    await flushToastTimers(250);
    expect(getConversationSelectionReferenceScope("session-1", "/ws")).toEqual([reference]);
  });

  it("drops the undo entry after the 6 second window", async () => {
    await act(async () => {
      deleteWithUndo();
    });
    await flushToastTimers();
    expect(findUndoButton()).not.toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(ANNOTATION_UNDO_MS + 250);
    });
    await flushToastTimers(250);
    expect(findUndoButton()).toBeNull();
    expect(getConversationSelectionReferenceScope("session-1", "/ws")).toEqual([]);
  });
});
