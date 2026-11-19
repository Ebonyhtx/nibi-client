import { describe, expect, it } from "vitest";
import {
  CONVERSATION_SELECTION_MAX_COMMENT_LENGTH,
  CONVERSATION_SELECTION_MAX_AGENT_LENGTH,
  CONVERSATION_SELECTION_MAX_COUNT,
  CONVERSATION_SELECTION_MAX_TOTAL_LENGTH,
  buildPromptWithConversationSelections,
  conversationQuotesSchema,
} from "../src/conversationSelection.js";

describe("conversation selection quote contract", () => {
  it("serializes comment and agent after the quoted text", () => {
    const prompt = buildPromptWithConversationSelections("Explain", [
      { text: "answer", agent: "Explore", comment: "  check this  " },
      { text: "plain" },
    ]);
    expect(prompt).toBe(
      [
        "Explain",
        "",
        "# userselect:",
        "```userselect",
        JSON.stringify([
          { text: "answer", agent: "Explore", comment: "  check this  " },
          { text: "plain" },
        ]),
        "```",
      ].join("\n"),
    );
  });

  it("keeps path before text and omits blank comments", () => {
    const prompt = buildPromptWithConversationSelections("", [
      { path: "a.md", text: "excerpt", comment: "   " },
    ]);
    expect(prompt).toContain(JSON.stringify([{ path: "a.md", text: "excerpt" }]));
  });

  it("enforces comment and agent length limits", () => {
    expect(
      conversationQuotesSchema.safeParse([
        { text: "x", comment: "c".repeat(CONVERSATION_SELECTION_MAX_COMMENT_LENGTH) },
      ]).success,
    ).toBe(true);
    expect(
      conversationQuotesSchema.safeParse([
        { text: "x", comment: "c".repeat(CONVERSATION_SELECTION_MAX_COMMENT_LENGTH + 1) },
      ]).success,
    ).toBe(false);
    expect(
      conversationQuotesSchema.safeParse([
        { text: "x", agent: "a".repeat(CONVERSATION_SELECTION_MAX_AGENT_LENGTH + 1) },
      ]).success,
    ).toBe(false);
  });

  it("keeps the existing count and total text limits", () => {
    expect(
      conversationQuotesSchema.safeParse(
        Array.from({ length: CONVERSATION_SELECTION_MAX_COUNT }, () => ({ text: "x" })),
      ).success,
    ).toBe(true);
    expect(
      conversationQuotesSchema.safeParse(
        Array.from({ length: CONVERSATION_SELECTION_MAX_COUNT + 1 }, () => ({ text: "x" })),
      ).success,
    ).toBe(false);
    expect(
      conversationQuotesSchema.safeParse([
        { text: "x".repeat(CONVERSATION_SELECTION_MAX_TOTAL_LENGTH + 1) },
      ]).success,
    ).toBe(false);
  });
});
