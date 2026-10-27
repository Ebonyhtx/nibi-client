import { describe, expect, it, vi } from "vitest";
import { createTestModelSelection } from "./test-model-selection.js";
import {
  CoreErrorType,
  ModelErrorCode,
  ModelProtocolError,
  ModelRetryBudget,
  SessionEventType,
  createModelId,
  createModelProviderId,
  createSessionId,
  type Logger,
} from "@nibi/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

/** 只捕获 warn 的 Logger 桩：退回路径的留痕本身是回归断言的一部分。 */
function createWarnCapturingLogger(warn: ReturnType<typeof vi.fn>): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => logger,
  };
  return logger as unknown as Logger;
}

/** 加速 provider 上的请求按卡过期（3402）失败，其他 provider 正常完成。 */
function createCardExpiryModelFactory(
  highspeedProviderId: string,
  requests: Array<{ modelId: string; providerId: string }>,
) {
  return createTestModelFactory({
    async generateText(_request, observation) {
      requests.push({
        modelId: String(observation.model.modelId),
        providerId: String(observation.model.providerId),
      });
      if (String(observation.model.providerId) === highspeedProviderId) {
        throw Object.assign(new Error("highspeed card is invalid"), {
          code: "invalid_model_request",
          context: {
            providerCode: "3402",
            providerId: highspeedProviderId,
            modelId: "GLM-5.3",
            source: "provider",
            statusCode: 400,
          },
          name: "AiSdkModelAdapterError",
        });
      }
      return {
        finishReason: "stop",
        model: observation.model,
        text: "continued with the original model",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      };
    },
  });
}

const cardExpiryFallbackRules = [
  { reason: "highspeed_card_expired" as const, providerErrorCode: "3402" },
  { reason: "highspeed_request_failed" as const },
];

describe("AgentRuntime model selection event", () => {
  it("首轮只按 admitted Active Model 构造一次 Context", async () => {
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-first-turn-single-context-build"),
      {
        modelSelection: createTestModelSelection("provider-a/model-a"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(_request, observation) {
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );
    const internalRuntime = runtime as typeof runtime & {
      createContextBuilderFromSnapshot: (...args: unknown[]) => unknown;
    };
    const createContextBuilderFromSnapshot =
      internalRuntime.createContextBuilderFromSnapshot.bind(internalRuntime);
    let contextBuildCount = 0;
    internalRuntime.createContextBuilderFromSnapshot = (...args: unknown[]) => {
      contextBuildCount++;
      return createContextBuilderFromSnapshot(...args);
    };

    await runtime.executeTurn("first turn");
    expect(contextBuildCount).toBe(1);

    await runtime.executeTurn("second turn");
    expect(contextBuildCount).toBe(2);
  });

  it("uses the admitted Active Model for both Context and the provider request", async () => {
    const requests: Array<{ modelId: string; providerId: string; text: string }> = [];
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-active-model-context"),
      {
        modelSelection: createTestModelSelection("provider-a/model-a"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              modelId: String(observation.model.modelId),
              providerId: String(observation.model.providerId),
              text: JSON.stringify(request.messages),
            });
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("switch now", undefined, {
      intent: {
        kind: "sendText",
        modelSelection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
        requestedDelivery: "start-now",
        sourceCommandId: "switch-command",
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ providerId: "provider-b", modelId: "model-b" });
    expect(requests[0]?.text).toContain("provider-b/model-b");
    expect(requests[0]?.text).not.toContain("provider-a/model-a");
  });

  it("uses an execution-scoped Active Model in Context without changing Session Selection", async () => {
    const requests: Array<{ modelId: string; providerId: string; text: string }> = [];
    const sessionSelection = createTestModelSelection("provider-a/model-a");
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-execution-model-context"),
      {
        modelSelection: sessionSelection,
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              modelId: String(observation.model.modelId),
              providerId: String(observation.model.providerId),
              text: JSON.stringify(request.messages),
            });
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("idle task", undefined, {
      intent: {
        kind: "sendText",
        modelSelection: {
          providerId: "account:zai-offpeak-idle-plan",
          modelId: "GLM-5.2",
          options: { reasoningLevel: "high" },
        },
        requestedDelivery: "start-now",
        sourceCommandId: "idle-command",
      },
      modelExecution: { selectionScope: "execution" },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      providerId: "account:zai-offpeak-idle-plan",
      modelId: "GLM-5.2",
    });
    expect(requests[0]?.text).toContain("account:zai-offpeak-idle-plan/GLM-5.2");
    expect(requests[0]?.text).not.toContain("provider-a/model-a");
    expect(runtime.getSessionModelSelection()).toEqual(sessionSelection);
  });

  it("applies a Session Selection change during an active turn only to the next Active Model", async () => {
    const requests: Array<{ modelId: string; providerId: string; text: string }> = [];
    let runtime: ReturnType<typeof createTestAgentRuntime>;
    runtime = createTestAgentRuntime(
      createSessionId("runtime-active-turn-selection-change"),
      {
        modelSelection: createTestModelSelection("provider-a/model-a"),
        titleGeneration: { enabled: false },
        workingDirectory: "/workspace/project",
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: createTestModelFactory({
          async generateText(request, observation) {
            requests.push({
              modelId: String(observation.model.modelId),
              providerId: String(observation.model.providerId),
              text: JSON.stringify(request.messages),
            });
            if (requests.length === 1) {
              runtime.setSessionModelSelection({
                providerId: "provider-b",
                modelId: "model-b",
                options: { reasoningLevel: "high" },
              });
            }
            return {
              finishReason: "stop",
              model: observation.model,
              text: "done",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        }),
      },
    );

    await runtime.executeTurn("first");
    await runtime.executeTurn("second");

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ providerId: "provider-a", modelId: "model-a" });
    expect(requests[0]?.text).toContain("provider-a/model-a");
    expect(requests[0]?.text).not.toContain("provider-b/model-b");
    expect(requests[1]).toMatchObject({ providerId: "provider-b", modelId: "model-b" });
    expect(requests[1]?.text).toContain("provider-b/model-b");
    expect(requests[1]?.text).not.toContain("provider-a/model-a");
  });

  it("uses structured ModelSelection as the current Session model fact", () => {
    const runtime = createTestAgentRuntime(
      createSessionId("runtime-structured-session-model-selection"),
      {
        modelSelection: {
          providerId: "provider-a",
          modelId: "model-a",
          options: {
            reasoningLevel: "high",
          },
        },
      },
      { eventStore: createTestSessionEventStore() },
    );

    expect(runtime.getSessionModelSelection()).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      options: {
        reasoningLevel: "high",
      },
    });

    const nextSelection = {
      providerId: "provider-b",
      modelId: "model-b",
      options: {
        reasoningLevel: "low",
      },
    };
    runtime.setSessionModelSelection(nextSelection);
    nextSelection.options.reasoningLevel = "mutated-outside-runtime";

    expect(runtime.getSessionModelSelection()).toEqual({
      providerId: "provider-b",
      modelId: "model-b",
      options: {
        reasoningLevel: "low",
      },
    });
  });

  it("publishes the Active Model context window with ModelSelected", async () => {
    const sessionId = createSessionId("runtime-model-selection-context-window");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(
      sessionId,
      {},
      {
        eventStore,
        modelFactory: createTestModelFactory({ properties: { contextWindow: 1_000_000 } }),
      },
    );

    await runtime.emitModelSelected({
      modelSelection: {
        providerId: createModelProviderId("deepseek"),
        modelId: createModelId("deepseek-v4-flash"),
      },
      supportedThoughtLevels: ["max", "high", "nothink"],
      traceContext: { traceId: "trace-runtime-model-selection" } as never,
    });

    const selected = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.ModelSelected,
    );
    expect(selected?.payload).toMatchObject({
      contextWindow: 1_000_000,
      modelSelection: {
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
      },
      supportedThoughtLevels: ["max", "high", "nothink"],
    });
  });

  it("preserves the registry fallback origin in ModelSelected", async () => {
    const sessionId = createSessionId("runtime-model-selection-registry-fallback");
    const eventStore = createTestSessionEventStore();
    const runtime = createTestAgentRuntime(sessionId, {}, { eventStore });

    await runtime.emitModelSelected({
      modelSelection: {
        providerId: createModelProviderId("provider-b"),
        modelId: createModelId("model-b"),
      },
      previousModelSelection: {
        providerId: createModelProviderId("provider-a"),
        modelId: createModelId("model-a"),
      },
      origin: "registryFallback",
      traceContext: { traceId: "trace-runtime-model-selection-fallback" } as never,
    });

    const selected = (await eventStore.getEvents(sessionId)).find(
      (event) => event.type === SessionEventType.ModelSelected,
    );
    expect(selected?.payload).toMatchObject({
      origin: "registryFallback",
      previousModelSelection: {
        providerId: "provider-a",
        modelId: "model-a",
      },
    });
  });

});
