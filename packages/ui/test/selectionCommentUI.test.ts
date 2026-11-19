// @vitest-environment jsdom
import { createElement, type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { SelectionActionMenu } from "@/v4/SelectionActionMenu.js";
import { SelectionCommentEditor } from "@/selection-comment/SelectionCommentEditor.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import type { ConversationSelectionReference } from "@/lib/conversationSelectionReference.js";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

function withIntl(node: ReactElement) {
  return createElement(NibiIntlProvider, { initialLocale: "en-US" }, node);
}

describe("selection action menu annotation entry", () => {
  it("replaces add-to-task with Annotate when the capability is on", () => {
    const onComment = vi.fn();
    const { unmount } = render(
      withIntl(
        createElement(SelectionActionMenu, {
          center: 100,
          top: 100,
          bottom: 120,
          onAddToCurrentTask: vi.fn(),
          onAskInSideChat: vi.fn(),
          onComment,
        }),
      ),
    );
    const comment = document.querySelector<HTMLElement>(
      '[data-conversation-selection-action="comment"]',
    );
    expect(comment?.textContent).toContain("Annotate");
    expect(document.querySelector('[data-conversation-selection-action="add-to-task"]')).toBeNull();
    fireEvent.click(comment!);
    expect(onComment).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("keeps the old add-to-task action when the capability is off", () => {
    const onAdd = vi.fn();
    render(
      withIntl(
        createElement(SelectionActionMenu, {
          center: 100,
          top: 100,
          bottom: 120,
          onAddToCurrentTask: onAdd,
          onAskInSideChat: vi.fn(),
        }),
      ),
    );
    const add = document.querySelector<HTMLElement>(
      '[data-conversation-selection-action="add-to-task"]',
    );
    expect(add).not.toBeNull();
    expect(document.querySelector('[data-conversation-selection-action="comment"]')).toBeNull();
    fireEvent.click(add!);
    expect(onAdd).toHaveBeenCalledTimes(1);
  });
});

describe("selection comment editor", () => {
  it("keeps the editor open and the input intact when save is rejected", () => {
    const onSave = vi.fn(() => false);
    render(
      withIntl(
        createElement(SelectionCommentEditor, {
          mode: "add",
          number: 1,
          center: 100,
          top: 100,
          bottom: 120,
          quote: "hello",
          error: "You can add at most 8 annotations.",
          onSave,
          onCancel: vi.fn(),
        }),
      ),
    );
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-conversation-selection-comment-input]",
    )!;
    fireEvent.change(input, { target: { value: "  my note  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("my note");
    expect(document.querySelector("[data-conversation-selection-comment-editor]")).not.toBeNull();
    expect(input.value).toBe("  my note  ");
    expect(screen.getByRole("alert").textContent).toContain("at most 8 annotations");
  });

  it("supports Shift+Enter newline, Escape cancel and IME Enter guard", () => {
    const onSave = vi.fn(() => true);
    const onCancel = vi.fn();
    render(
      withIntl(
        createElement(SelectionCommentEditor, {
          mode: "add",
          number: 1,
          center: 100,
          top: 100,
          bottom: 120,
          quote: "hello",
          onSave,
          onCancel,
        }),
      ),
    );
    const input = document.querySelector<HTMLTextAreaElement>(
      "[data-conversation-selection-comment-input]",
    )!;
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("deletes only in edit mode", () => {
    const onDelete = vi.fn();
    render(
      withIntl(
        createElement(SelectionCommentEditor, {
          mode: "edit",
          number: 2,
          center: 100,
          top: 100,
          bottom: 120,
          quote: "hello",
          initialComment: "existing",
          onSave: () => true,
          onCancel: vi.fn(),
          onDelete,
        }),
      ),
    );
    fireEvent.click(document.querySelector("[data-conversation-selection-comment-delete]")!);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe("conversation selection reference chip", () => {
  const references: ConversationSelectionReference[] = [
    {
      id: "ref-1",
      contentType: "assistant",
      sourceSessionId: "session-1",
      sourceRowId: 3,
      text: "hello world",
      comment: "my note",
    },
    {
      id: "ref-2",
      contentType: "assistant",
      sourceSessionId: "session-1",
      sourceRowId: 4,
      text: "second quote",
    },
  ];

  it("numbers rows and syncs hover/edit to the annotation id", async () => {
    const onEdit = vi.fn();
    render(
      withIntl(
        createElement(ConversationSelectionReferenceChip, {
          references,
          numbered: true,
          onEdit,
          onRemove: vi.fn(),
          onRemoveAll: vi.fn(),
        }),
      ),
    );
    const trigger = document.querySelector<HTMLElement>(
      '[data-conversation-selection-reference-count="2"]',
    )!;
    fireEvent.pointerEnter(trigger);
    await waitFor(() => {
      expect(document.querySelectorAll("[data-annotation-number-variant]")).toHaveLength(2);
    });
    const numbers = Array.from(document.querySelectorAll("[data-annotation-number-variant]")).map(
      (node) => node.textContent,
    );
    expect(numbers).toEqual(["1", "2"]);
    expect(document.body.textContent).toContain("my note");
    expect(document.body.textContent).toContain("Add comment");
    const rows = document.querySelectorAll("[data-conversation-annotation-row]");
    expect(rows).toHaveLength(2);
    fireEvent.mouseEnter(rows[0]!);
    fireEvent.click(document.querySelector("[data-conversation-annotation-edit]")!);
    expect(onEdit).toHaveBeenCalledWith(
      "ref-1",
      expect.objectContaining({ center: expect.any(Number), top: expect.any(Number) }),
    );
  });

  it("offers add-comment for quote-only rows when editing is available", async () => {
    const onEdit = vi.fn();
    render(
      withIntl(
        createElement(ConversationSelectionReferenceChip, {
          references: [references[1]!],
          numbered: true,
          onEdit,
        }),
      ),
    );
    fireEvent.pointerEnter(
      document.querySelector('[data-conversation-selection-reference-count="1"]')!,
    );
    await waitFor(() => {
      expect(document.querySelector("[data-conversation-annotation-add-comment]")).not.toBeNull();
    });
    fireEvent.click(document.querySelector("[data-conversation-annotation-add-comment]")!);
    expect(onEdit).toHaveBeenCalledWith("ref-2", expect.any(Object));
  });
});
