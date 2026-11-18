// K4：子代理失败回传部分报告 + agentId + usage（共享失败形状，Node 侧断言）。
// 前台失败返回 `AgentFailedOutput`（ok:false），后台失败通知带 `<result>` + `<usage>`；
// 成功路径回归确认不受影响。全部走 fake 执行器，不依赖真实模型。

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionId,
  createTraceId,
  createTurnId,
  type AssistantMessageInfo,
  type MessageId,
  type MessageInfo,
  type PartId,
  type SessionId,
  type TextPart,
  type ToolPart,
} from "@nibi/contracts";
import { agentToolEntry } from "../src/tool/handlers/agent.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";

const outputRootDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    outputRootDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function createOutputRootDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nibi-subagent-failure-"));
  outputRootDirs.push(dir);
  return dir;
}

function createRequest(sessionId: SessionId, parentToolCallId: string) {
  const turnId = createTurnId();
  return {
    agentType: "general-purpose",
    description: "Failure report test",
    parentToolCallId,
    prompt: "Do the work",
    sessionId,
    turnId,
    trace: { traceId: createTraceId(), sessionId, turnId },
    workingDirectory: "/workspace/project",
    workspaceRoot: "/workspace/project",
  };
}

/** 子代理已经产出一条带用量与工具调用的 assistant 消息，然后模型失败。 */
function seedPartialChildOutput(
  store: ReturnType<typeof createRecordingSubagentSessionStore>,
  childSessionId: SessionId,
): void {
  const messageId = "msg_child_partial" as MessageId;
  const message: AssistantMessageInfo = {
    id: messageId,
    sessionID: childSessionId,
    role: "assistant",
    time: { created: Date.now() },
    mode: "build",
    agent: "nibi-general-purpose",
    path: { cwd: "/workspace/project", root: "/workspace/project" },
    cost: 0,
    tokens: {
      input: 20,
      output: 5,
      reasoning: 0,
      cache: { read: 7, write: 3 },
    },
  };
  void store.saveMessage(message satisfies MessageInfo);
  const textPart: TextPart = {
    id: "part_child_partial_text" as PartId,
    sessionID: childSessionId,
    messageID: messageId,
    type: "text",
    text: "Found two candidate files before the provider failed.",
  };
  void store.savePart(textPart);
  const toolPart: ToolPart = {
    id: "part_child_partial_tool" as PartId,
    sessionID: childSessionId,
    messageID: messageId,
    type: "tool",
    callID: "call_child_1",
    tool: "Read",
    state: {
      status: "completed",
      input: { file_path: "a.ts" },
      output: "ok",
      title: "Read a.ts",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
  void store.savePart(toolPart);
}

describe("subagent failure reports (K4)", () => {
  it("foreground failure returns ok:false with error, agentId, usage and partialReport", async () => {
    const outputRootDir = await createOutputRootDir();
    const sessionStore = createRecordingSubagentSessionStore();
    const port = createExploreSubagentPort({
      outputRootDir,
      createAgentId: () => "agent_failure_foreground",
      sessionStore,
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        seedPartialChildOutput(sessionStore, request.sessionId);
        throw new Error("provider exploded");
      },
    });

    const result = await port.run(createRequest(createSessionId("failure-fg"), "call_fg"));

    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      error: "provider exploded",
      agentId: "agent_failure_foreground",
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 7,
        cacheWriteTokens: 3,
        totalTokens: 35,
      },
      partialReport: "Found two candidate files before the provider failed.",
    });
    // 失败结果必须是合法的 AgentOutput（运行时 schema 校验），父模型渲染走 `<subagent_failure>` 信封。
    const modelContent = agentToolEntry.formatModelContent?.(result);
    expect(modelContent).toContain("<subagent_failure>");
    expect(modelContent).toContain('"ok":false');
    expect(modelContent).toContain('"partialReport":"Found two candidate files before the provider failed."');
    expect(modelContent).toContain(
      "agentId: agent_failure_foreground (use SendMessage with to: 'agent_failure_foreground'",
    );
    // registry 终态与用量同形状。
    const task = await port.getTask?.("agent_failure_foreground");
    expect(task).toMatchObject({
      status: "failed",
      error: "provider exploded",
      usage: {
        durationMs: expect.any(Number),
        modelUsage: { inputTokens: 20, outputTokens: 5 },
        totalTokens: 35,
        toolUseCount: 1,
      },
    });
  });

  it("background failure notification carries partial result and usage, not only error/agentId/duration", async () => {
    const outputRootDir = await createOutputRootDir();
    const sessionStore = createRecordingSubagentSessionStore();
    const notifications: string[] = [];
    const port = createExploreSubagentPort({
      outputRootDir,
      createAgentId: () => "agent_failure_background",
      sessionStore,
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: ({ text }) => {
        notifications.push(text);
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        seedPartialChildOutput(sessionStore, request.sessionId);
        throw new Error("provider exploded");
      },
    });

    const launched = await port.start?.(createRequest(createSessionId("failure-bg"), "call_bg"));
    expect(launched).toMatchObject({ status: "async_launched" });
    await vi.waitFor(() => expect(notifications).toHaveLength(1));

    const notification = notifications[0]!;
    expect(notification).toContain("<task-id>agent_failure_background</task-id>");
    expect(notification).toContain("<status>failed</status>");
    expect(notification).toContain("<error>provider exploded</error>");
    expect(notification).toContain(
      "<result>Found two candidate files before the provider failed.</result>",
    );
    expect(notification).toContain("<subagent_tokens>35</subagent_tokens>");
    expect(notification).toContain("<tool_uses>1</tool_uses>");
    expect(notification).toContain("<duration_ms>");
    const task = await port.getTask?.("agent_failure_background");
    expect(task).toMatchObject({
      status: "failed",
      usage: { totalTokens: 35, toolUseCount: 1 },
    });
  });

  it("keeps throwing for cancellation, inactivity timeout and pre-session failures", async () => {
    const outputRootDir = await createOutputRootDir();
    const sessionStore = createRecordingSubagentSessionStore();
    const port = createExploreSubagentPort({
      outputRootDir,
      createAgentId: () => "agent_failure_guarded",
      sessionStore,
      emitParentEvent: async () => {},
      runExploreAgent: async (request) => {
        // 不调用 onSessionReady：子会话未持久化前的失败照旧抛错（选择/会话创建失败）。
        void request;
        throw new Error("profile unavailable");
      },
    });

    await expect(
      port.run(createRequest(createSessionId("failure-guarded"), "call_guarded")),
    ).rejects.toThrow("profile unavailable");
    // 子会话未持久化的启动失败走既有 throw 语义，registry 记录随之移除。
    const task = await port.getTask?.("agent_failure_guarded");
    expect(task).toBeUndefined();
  });

  it("keeps the completed output and notification shape unchanged (regression)", async () => {
    const outputRootDir = await createOutputRootDir();
    const notifications: string[] = [];
    const port = createExploreSubagentPort({
      outputRootDir,
      createAgentId: () => "agent_success_regression",
      emitParentEvent: async () => {},
      enqueueParentTaskNotification: ({ text }) => {
        notifications.push(text);
      },
      runExploreAgent: async (request) => {
        await request.onSessionReady?.();
        return {
          response: "All done.",
          traceId: request.traceContext.traceId,
          events: [],
        };
      },
    });

    const result = await port.run(createRequest(createSessionId("success-regression"), "call_ok"));
    expect(result).toMatchObject({
      status: "completed",
      agentId: "agent_success_regression",
      content: [{ type: "text", text: "All done." }],
    });
    expect("ok" in (result as object)).toBe(false);
    const launched = await port.start?.(
      createRequest(createSessionId("success-regression-bg"), "call_ok_bg"),
    );
    expect(launched).toMatchObject({ status: "async_launched" });
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    expect(notifications[0]).toContain("<status>completed</status>");
    expect(notifications[0]).toContain("<result>All done.</result>");
    expect(notifications[0]).not.toContain("<error>");
  });
});
