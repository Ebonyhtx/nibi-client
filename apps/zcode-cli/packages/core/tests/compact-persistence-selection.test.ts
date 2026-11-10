import { describe, expect, it } from "vitest";
import type { MessageCommitBundle, MessageInfo } from "@nibi/contracts";
import { createMessageId } from "@nibi/contracts";
import { persistCompactSummary } from "../src/runtime/methods/compact-persistence.js";

describe("compact persistence model selection", () => {
  it("projects the session selection when no execution model was supplied", async () => {
    const saved: MessageInfo[] = [];
    const runtime = {
      config: { agentName: "test-agent", systemPrompt: "test" },
      getSessionModelSelection: () => ({
        providerId: "selection-provider",
        modelId: "selection-model",
        options: { reasoningLevel: "high" },
      }),
      getTools: () => [],
      persistMessage: async (message: MessageInfo) => {
        saved.push(message);
      },
      persistPart: async () => {},
      sessionId: "session-compact-selection",
      sessionStore: {},
    };

    await persistCompactSummary.call(
      runtime as never,
      createMessageId(),
      "compact content",
      "compact summary",
      {
        trigger: "manual",
        phase: "post_response",
        compactReason: "manual",
      } as never,
      { traceId: "trace-compact-selection" } as never,
    );

    expect(saved[0]).toMatchObject({
      modelSelection: {
        providerId: "selection-provider",
        modelId: "selection-model",
      },
    });
  });

  it("commits the summary and post-compact reminders in one message bundle", async () => {
    const bundles: MessageCommitBundle[] = [];
    const saved: MessageInfo[] = [];
    const runtime = {
      config: { agentName: "test-agent", systemPrompt: "test" },
      getSessionModelSelection: () => undefined,
      getTools: () => [],
      persistMessage: async (message: MessageInfo) => {
        saved.push(message);
      },
      persistPart: async () => {
        saved.push({} as MessageInfo);
      },
      sessionId: "session-compact-bundle",
      sessionStore: {
        commitMessageBundle: async (bundle: MessageCommitBundle) => {
          bundles.push(bundle);
        },
      },
    };

    await persistCompactSummary.call(
      runtime as never,
      createMessageId(),
      "compact content",
      "compact summary",
      {
        trigger: "manual",
        phase: "post_response",
        compactReason: "manual",
      } as never,
      { traceId: "trace-compact-bundle" } as never,
      {
        postCompactReminderEntries: [
          {
            kind: "attachment",
            content: "reminder content",
            metadata: { source: "resume_referenced_session_context" },
          },
        ],
      },
    );

    expect(saved).toEqual([]);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.sessionID).toBe("session-compact-bundle");
    expect(bundles[0]!.messages).toHaveLength(2);
    expect(bundles[0]!.messages[0]!.info).toMatchObject({
      summary: { title: "Compact summary", body: "compact summary" },
    });
    expect(bundles[0]!.messages[0]!.parts.map((part) => part.type)).toEqual(["text", "compaction"]);
    expect(bundles[0]!.messages[1]!.parts[0]).toMatchObject({
      type: "text",
      text: "reminder content",
    });
  });
});
