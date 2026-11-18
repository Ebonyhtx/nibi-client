import { describe, expect, it } from "vitest";
import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  SessionEventType,
  createSessionId,
  type CompactBoundaryPayload,
} from "@nibi/contracts";
import {
  legacySyntheticRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../src/agent/message-history.js";
import { estimateMessageTokens } from "../src/compact/index.js";
import { estimateCurrentModelInputTokens } from "../src/runtime/methods/compact.js";
import { resolveModelStepMaxOutputTokens } from "../src/runtime/methods/model-token-limits.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

/**
 * 压缩后 token 占用 rollover（K2）：
 * - 压缩前的 provider usage 属于被替换的旧前缀，占用投影不得越过 compact 边界取锚点；
 * - 压缩刚完成时以边界锚（prefix+summary 估算一次）替换 pre 份额，保留段与新增消息按增量计；
 * - 连续多次压缩只有最近一条边界生效；没有 rollover 锚的旧边界回退全量估算，行为不回退。
 */

function tokensOf(input: number, output: number): RuntimeMessageEntry["tokens"] {
  return {
    input,
    output,
    reasoning: 0,
    cache: { read: 0, write: 0 },
    total: input + output,
  };
}

function zeroedTokens(): RuntimeMessageEntry["tokens"] {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
    total: 0,
  };
}

function boundaryMetadata(input: {
  boundaryId: string;
  rolloverContextTokens?: number;
}): RuntimeMessageEntry["metadata"] {
  return {
    ...legacySyntheticRuntimeMetadata(),
    compactBoundary: {
      boundaryId: input.boundaryId,
      ...(input.rolloverContextTokens !== undefined
        ? { rolloverContextTokens: input.rolloverContextTokens }
        : {}),
    },
  };
}

function makeEntry(
  role: "user" | "assistant",
  content: string,
  options: {
    tokens?: RuntimeMessageEntry["tokens"];
    metadata?: RuntimeMessageEntry["metadata"];
  } = {},
): RuntimeMessageEntry {
  return {
    message: { role, content },
    ...(options.tokens ? { tokens: options.tokens } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };
}

function messagesOf(entries: readonly RuntimeMessageEntry[]) {
  return entries.map((runtimeEntry) => runtimeEntry.message);
}

describe("compact token rollover", () => {
  it("replaces the pre-compact usage share with the boundary rollover anchor", () => {
    // 压缩刚完成：pre-compact assistant（usage 10_000）已被摘要替换，
    // 保留段 assistant 的 usage 被清零，边界带 prefix+summary 的 rollover 估算。
    const entries: RuntimeMessageEntry[] = [
      makeEntry("assistant", "old response", { tokens: tokensOf(10_000, 40) }),
      makeEntry("user", "Summary of the compacted conversation", {
        metadata: boundaryMetadata({ boundaryId: "compact_a", rolloverContextTokens: 120 }),
      }),
      makeEntry("assistant", "preserved response", { tokens: zeroedTokens() }),
      makeEntry("user", "new request after compact"),
    ];
    const messages = messagesOf(entries);

    const tokenCount = estimateCurrentModelInputTokens(messages, entries);

    // 累计只算一次：rollover（120）+ 边界之后的增量；10_000 的压缩前 usage 不再进入。
    const expected = 120 + estimateMessageTokens(messages.slice(2));
    expect(tokenCount).toBe(expected);
    expect(tokenCount).toBeLessThan(1_000);
  });

  it("prefers a fresh committed assistant after the boundary over the rollover anchor", () => {
    const entries: RuntimeMessageEntry[] = [
      makeEntry("user", "Summary of the compacted conversation", {
        metadata: boundaryMetadata({ boundaryId: "compact_a", rolloverContextTokens: 120 }),
      }),
      makeEntry("assistant", "fresh response", { tokens: tokensOf(200, 10) }),
      makeEntry("user", "new request"),
    ];
    const messages = messagesOf(entries);

    // 边界之后已有 committed assistant：标准 usage 锚点接管，rollover 只在无新锚时生效。
    expect(estimateCurrentModelInputTokens(messages, entries)).toBe(
      210 + estimateMessageTokens(messages.slice(2)),
    );
  });

  it("does not double count across two consecutive compactions", () => {
    const entries: RuntimeMessageEntry[] = [
      makeEntry("assistant", "oldest response", { tokens: tokensOf(50_000, 40) }),
      makeEntry("user", "First summary", {
        metadata: boundaryMetadata({ boundaryId: "compact_a", rolloverContextTokens: 100 }),
      }),
      makeEntry("assistant", "middle response", { tokens: zeroedTokens() }),
      makeEntry("user", "Second summary", {
        metadata: boundaryMetadata({ boundaryId: "compact_b", rolloverContextTokens: 60 }),
      }),
      makeEntry("assistant", "preserved response", { tokens: zeroedTokens() }),
      makeEntry("user", "new request after second compact"),
    ];
    const messages = messagesOf(entries);

    // 只有最近一条边界生效：50_000/100 的更早份额不重复计入。
    const expected = 60 + estimateMessageTokens(messages.slice(4));
    expect(estimateCurrentModelInputTokens(messages, entries)).toBe(expected);
    expect(estimateCurrentModelInputTokens(messages, entries)).toBeLessThan(500);
  });

  it("falls back to the full local estimate for a legacy boundary without a rollover anchor", () => {
    // 旧会话边界没有 rollover 锚：即便历史里残留压缩前的 usage 锚点，
    // 也只做全量本地估算（与升级前行为一致，不回退）。
    const entries: RuntimeMessageEntry[] = [
      makeEntry("assistant", "old response", { tokens: tokensOf(10_000, 40) }),
      makeEntry("user", "Summary of the compacted conversation", {
        metadata: boundaryMetadata({ boundaryId: "compact_legacy" }),
      }),
      makeEntry("assistant", "preserved response", { tokens: zeroedTokens() }),
      makeEntry("user", "new request after compact"),
    ];
    const messages = messagesOf(entries);

    expect(estimateCurrentModelInputTokens(messages, entries)).toBe(
      estimateMessageTokens(messages),
    );
  });

  it("keeps the pre-compact usage anchor when no compact boundary exists", () => {
    const committed = makeEntry("assistant", "committed response", { tokens: tokensOf(100, 20) });
    const entries: RuntimeMessageEntry[] = [committed, makeEntry("user", "new request")];
    const messages = messagesOf(entries);

    expect(estimateCurrentModelInputTokens(messages, entries)).toBe(
      120 + estimateMessageTokens(messages.slice(1)),
    );
  });

  it("keeps the threshold budget projection on the post-compact occupancy", () => {
    const entries: RuntimeMessageEntry[] = [
      makeEntry("user", "Summary of the compacted conversation", {
        metadata: boundaryMetadata({ boundaryId: "compact_a", rolloverContextTokens: 120 }),
      }),
      makeEntry("assistant", "preserved response", { tokens: zeroedTokens() }),
      makeEntry("user", "new request after compact"),
    ];
    const messages = messagesOf(entries);
    const estimatedCurrentUsage = estimateCurrentModelInputTokens(messages, entries);

    // 阈值/占用投影使用同一个口径：post-compact 占用决定本次请求的输出预算。
    expect(
      resolveModelStepMaxOutputTokens({
        baselineMaxOutputTokens: 32_000,
        contextWindow: 10_000,
        estimatedCurrentUsage,
        modelContextBudgetStrategy: "preflight-v1",
      }),
    ).toBe(9_000 - estimatedCurrentUsage);
  });
});

describe("compact token rollover in the runtime", () => {
  it("stamps the rollover anchor on the summary entry without changing the persisted boundary", async () => {
    const sessionId = createSessionId("compact-token-rollover-live");
    const eventStore = createTestSessionEventStore();
    let responseCount = 0;
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        compact: {
          bufferTokens: 10,
          contextWindow: 120,
          summaryReserveTokens: 0,
        },
        maxOutputTokens: 1,
        systemPrompt: "You are a compact rollover test agent.",
      },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText(request) {
            const lastContent =
              typeof request.messages.at(-1)?.content === "string"
                ? (request.messages.at(-1)!.content as string)
                : JSON.stringify(request.messages.at(-1)?.content);
            if (lastContent.includes("create a detailed summary")) {
              return {
                finishReason: "stop",
                text: "<summary>Compact rollover preserves the latest plan.</summary>",
                usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
              };
            }
            responseCount += 1;
            return {
              finishReason: "stop",
              text: `response ${responseCount}`,
              usage: {
                inputTokens: responseCount === 2 ? 115 : 3,
                outputTokens: 1,
                totalTokens: responseCount === 2 ? 116 : 4,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("rollover warmup");
    await runtime.executeTurn("rollover long context ".repeat(20));
    const result = await runtime.executeTurn("trigger auto compact");

    expect(result.response).toBe("response 3");

    const boundaryEvent = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.CompactBoundary,
    );
    const boundary = boundaryEvent?.payload as CompactBoundaryPayload | undefined;
    // 持久化字段保持不变：pre/post 计数照旧落库，rollover 锚不进入持久化 schema。
    expect(boundary).toMatchObject({
      trigger: CompactTrigger.Auto,
      phase: CompactPhase.PreRequest,
      compactReason: CompactReason.ContextLimit,
    });
    expect(boundary?.preCompactTokenCount).toBeGreaterThan(0);
    expect(boundary?.postCompactTokenCount).toBe(120);

    const runtimeInternals = runtime as unknown as {
      messageHistory: {
        borrowReadOnlyRuntimeEntries(): readonly RuntimeMessageEntry[];
      };
    };
    const boundaryEntry = runtimeInternals.messageHistory
      .borrowReadOnlyRuntimeEntries()
      .find((entry) => entry.metadata?.compactBoundary !== undefined);
    // runtime 内存条目携带 rollover 锚，压缩后的占用投影以它为界替换 pre 份额。
    expect(boundaryEntry?.metadata?.compactBoundary?.boundaryId).toBe(boundary?.boundaryId);
    expect(boundaryEntry?.metadata?.compactBoundary?.rolloverContextTokens).toBeGreaterThan(0);

    const postCompactEntries = runtimeInternals.messageHistory.borrowReadOnlyRuntimeEntries();
    const postCompactOccupancy = estimateCurrentModelInputTokens(
      messagesOf(postCompactEntries.filter((entry) => "message" in entry) as RuntimeMessageEntry[]),
      postCompactEntries.filter((entry) => "message" in entry) as RuntimeMessageEntry[],
    );
    // 压缩后的占用应显著低于压缩前水位（rollover 生效，未把压缩前 usage 再算一遍）。
    expect(postCompactOccupancy).toBeLessThan(200);
    await runtime.closeBrowserSession();
  });
});
