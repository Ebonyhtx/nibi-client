import { describe, expect, it } from "vitest";
import {
  getNibiGoalActiveIterationCount,
  getNibiGoalIterationByAssistantMessageId,
  getNibiUserVisibleMessages,
  getConversationMessageProjectionPolicy,
  getConversationModelOnlyTurnTriggerSource,
  isNibiModelOnlySyntheticUserMessage,
  resolveNibiVisibleSessionTitle,
  type NibiMessagePart,
  type NibiMessageWithParts,
} from "../src/index.js";

const model = {
  providerId: "glm",
  modelId: "glm-4.6",
};
type NibiUserMessageInfo = Extract<NibiMessageWithParts["info"], { role: "user" }>;
type NibiUserMessageInfoPatch = Partial<
  Pick<
    NibiUserMessageInfo,
    "metadata" | "semantics" | "source" | "synthetic" | "time" | "visibility"
  >
>;

function userMessage(
  messageId: string,
  text: string,
  partPatch: Partial<Extract<NibiMessagePart, { type: "text" }>> = {},
  createdAt = 1,
  infoPatch: NibiUserMessageInfoPatch = {},
): NibiMessageWithParts {
  const part: Extract<NibiMessagePart, { type: "text" }> = {
    partId: `part_${messageId}`,
    sessionId: "sess_1",
    messageId,
    type: "text",
    text,
    ...partPatch,
  };
  return {
    info: {
      messageId,
      sessionId: "sess_1",
      role: "user",
      time: { created: createdAt },
      agent: "nibi-agent",
      model,
      ...infoPatch,
    },
    parts: [part],
  };
}

function assistantMessage(
  messageId: string,
  text: string,
  createdAt: number,
): NibiMessageWithParts {
  return {
    info: {
      messageId,
      sessionId: "sess_1",
      role: "assistant",
      time: { created: createdAt, completed: createdAt + 10 },
      agent: "nibi-agent",
      model,
      path: { cwd: "/workspace/app", root: "/workspace/app" },
      cost: 0,
      tokens: {
        input: 1,
        output: 1,
        reasoning: 0,
        total: 2,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [
      {
        partId: `part_${messageId}`,
        sessionId: "sess_1",
        messageId,
        type: "text",
        text,
      },
    ],
  };
}

describe("Nibi session visible content", () => {
  it("only advances failed verifier iteration counts for active goals", () => {
    const failedTimeline = [
      {
        goalIteration: 1,
        status: "completed" as const,
        verification: {
          nextAction: "继续下一轮。",
          passed: false,
          reason: "目标还没完成。",
        },
      },
    ];
    const cancelledTimeline = [
      {
        goalIteration: 1,
        status: "cancelled" as const,
      },
    ];

    expect(
      getNibiGoalActiveIterationCount({
        targetStatus: "active",
        timeline: failedTimeline,
      }),
    ).toBe(2);
    expect(
      getNibiGoalActiveIterationCount({
        targetStatus: "paused",
        timeline: cancelledTimeline,
      }),
    ).toBe(1);
  });

  it("filters background task notifications from user-visible messages", () => {
    const realUserMessage = userMessage("msg_real", "继续总结结果");
    const notification = userMessage(
      "msg_background",
      [
        "<task-notification>",
        "  <task-id>exec_bg</task-id>",
        "  <status>completed</status>",
        "</task-notification>",
      ].join("\n"),
      {
        synthetic: true,
        metadata: { source: "background_task" },
      },
    );

    expect(isNibiModelOnlySyntheticUserMessage(notification)).toBe(true);
    expect(getNibiUserVisibleMessages([realUserMessage, notification])).toEqual([realUserMessage]);
  });

  it("filters legacy synthetic task notification text without metadata", () => {
    const notification = userMessage(
      "msg_legacy_background",
      "<task-notification>\n  <status>completed</status>\n</task-notification>",
      {
        synthetic: true,
      },
    );

    expect(isNibiModelOnlySyntheticUserMessage(notification)).toBe(true);
    expect(getNibiUserVisibleMessages([notification])).toEqual([]);
  });

  it("filters compact summary user messages from user-visible messages", () => {
    const summary: NibiMessageWithParts = {
      info: {
        messageId: "msg_summary",
        sessionId: "sess_1",
        role: "user",
        time: { created: 10 },
        agent: "nibi-agent",
        model,
      },
      parts: [
        {
          partId: "part_summary",
          sessionId: "sess_1",
          messageId: "msg_summary",
          type: "compaction",
          auto: false,
          metadata: {
            operationId: "cmp-summary",
            phase: "standalone_turn",
            trigger: "manual",
          },
        },
      ],
    };

    expect(getNibiUserVisibleMessages([summary])).toEqual([]);
  });

  it("filters background subagent notifications from user-visible messages", () => {
    const notification = userMessage(
      "msg_subagent_background",
      "<subagent-notification>\nAgent Explore task completed.\n</subagent-notification>",
      {
        synthetic: true,
        metadata: { source: "subagent" },
      },
    );

    expect(isNibiModelOnlySyntheticUserMessage(notification)).toBe(true);
    expect(getNibiUserVisibleMessages([notification])).toEqual([]);
  });

  it("filters canonical and source-only subagent messages from visible content and titles", () => {
    const canonical = userMessage(
      "msg_subagent_message_canonical",
      "internal canonical response",
      { synthetic: true },
      1,
      {
        source: "subagent_message",
        synthetic: true,
        visibility: "model-only",
      },
    );
    const infoSourceOnly = userMessage(
      "msg_subagent_message_info_source",
      "internal info source response",
      { synthetic: true },
      2,
      { source: "subagent_message", synthetic: true },
    );
    const partSourceOnly = userMessage(
      "msg_subagent_message_part_source",
      "internal part source response",
      {
        synthetic: true,
        metadata: { source: "subagent_message" },
      },
      3,
      { synthetic: true },
    );
    const realUserMessage = userMessage("msg_real_after_subagent_message", "真实用户问题", {}, 4);

    expect(
      getNibiUserVisibleMessages([canonical, infoSourceOnly, partSourceOnly, realUserMessage]),
    ).toEqual([realUserMessage]);
    expect(
      resolveNibiVisibleSessionTitle({
        messages: [infoSourceOnly, partSourceOnly, realUserMessage],
        target: null,
      }),
    ).toBe("真实用户问题");
  });

  it("classifies subagent_message as one provider-context model-only turn trigger", () => {
    const sourceOnly = userMessage(
      "msg_subagent_message_turn_trigger",
      "internal coordinator response",
      { synthetic: true, metadata: { source: "subagent_message" } },
      1,
      { source: "subagent_message", synthetic: true },
    );

    expect(getConversationMessageProjectionPolicy(sourceOnly)).toBe("providerContextOnly");
    expect(getConversationModelOnlyTurnTriggerSource(sourceOnly)).toBe("subagent_message");
  });

  it("keeps persisted plugin references in provider context without creating a UI turn", () => {
    const pluginReference = userMessage(
      "msg_plugin_reference",
      "<plugin_reference>demo</plugin_reference>",
      { synthetic: true, metadata: { source: "plugin_reference" } },
      1,
      {
        source: "plugin_reference",
        synthetic: true,
        visibility: "model-only",
      },
    );

    expect(getConversationMessageProjectionPolicy(pluginReference)).toBe("providerContextOnly");
    expect(isNibiModelOnlySyntheticUserMessage(pluginReference)).toBe(true);
    expect(getConversationModelOnlyTurnTriggerSource(pluginReference)).toBeNull();
    expect(getNibiUserVisibleMessages([pluginReference])).toEqual([]);
  });

  it("uses the target fallback when a subagent message is the only user-like input", () => {
    const sourceOnly = userMessage(
      "msg_subagent_message_target_fallback",
      "internal response must not become the title",
      { synthetic: true, metadata: { source: "subagent_message" } },
      1,
      { synthetic: true },
    );

    expect(
      resolveNibiVisibleSessionTitle({
        messages: [sourceOnly],
        target: {
          createdAt: 1,
          objective: "完成权限链路检查",
          sessionId: "sess_1",
          status: "active",
          summaryTitle: null,
          targetId: "goal_subagent_message",
          timeUsedSeconds: 0,
          tokenBudget: null,
          tokensUsed: 0,
          updatedAt: 1,
        },
      }),
    ).toBe("完成权限链路检查");
  });

  it("filters rewind notices from user-visible messages", () => {
    const notification = userMessage(
      "msg_rewind",
      [
        "<system-reminder>",
        "Conversation rewind applied.",
        "Continue from the conversation state before the target user message.",
        "</system-reminder>",
      ].join("\n"),
      {
        synthetic: true,
        metadata: { source: "rewind" },
      },
    );

    expect(isNibiModelOnlySyntheticUserMessage(notification)).toBe(true);
    expect(getNibiUserVisibleMessages([notification])).toEqual([]);
  });

  it("filters model-only goal continuation reminders from user-visible messages", () => {
    const realUserMessage = userMessage("msg_real_goal", "加一个地址系统，可以加，可以选");
    const continuation = userMessage(
      "msg_goal_continuation",
      [
        '<system-reminder source="goal-continuation">',
        "Continue working toward the active session goal.",
        "</system-reminder>",
      ].join("\n"),
      {
        synthetic: true,
        metadata: {
          source: "goal-continuation",
          visibility: "model-only",
        },
      },
    );

    expect(isNibiModelOnlySyntheticUserMessage(continuation)).toBe(true);
    expect(getNibiUserVisibleMessages([realUserMessage, continuation])).toEqual([realUserMessage]);
  });

  it("filters model-only goal state change reminders from user-visible messages", () => {
    const realUserMessage = userMessage("msg_real_goal_state", "继续做目标");
    const reminder = userMessage(
      "msg_goal_state_change",
      "The active session goal is paused. Do not continue pursuing it unless the user resumes or replaces the goal.",
      {
        synthetic: true,
        metadata: { source: "goal_state_change" },
      },
      2,
      {
        synthetic: true,
        source: "goal_state_change",
      },
    );

    expect(isNibiModelOnlySyntheticUserMessage(reminder)).toBe(true);
    expect(getNibiUserVisibleMessages([realUserMessage, reminder])).toEqual([realUserMessage]);
  });

  it("filters legacy goal continuation reminders without metadata", () => {
    const continuation = userMessage(
      "msg_legacy_goal_continuation",
      [
        '<system-reminder source="goal-continuation">',
        "<untrusted_objective>",
        "优化性能到 60fps",
        "</untrusted_objective>",
        "</system-reminder>",
      ].join("\n"),
    );

    expect(isNibiModelOnlySyntheticUserMessage(continuation)).toBe(true);
    expect(getNibiUserVisibleMessages([continuation])).toEqual([]);
    expect(
      resolveNibiVisibleSessionTitle({
        messages: [continuation],
        target: {
          createdAt: 1,
          objective: "优化性能到 60fps",
          sessionId: "sess_1",
          status: "active",
          summaryTitle: null,
          targetId: "goal_1",
          timeUsedSeconds: 0,
          tokenBudget: null,
          tokensUsed: 0,
          updatedAt: 1,
        },
      }),
    ).toBe("优化性能到 60fps");
  });

  it("does not count current goal state reminders as a new goal iteration", () => {
    const continuation = userMessage(
      "msg_goal_continuation",
      [
        "<system-reminder>",
        "Continue working toward the active session goal.",
        "</system-reminder>",
      ].join("\n"),
      { synthetic: true },
      100,
      {
        synthetic: true,
        visibility: "model-only",
        metadata: { visibility: "model-only" },
      },
    );
    const firstAssistant = assistantMessage("msg_goal_assistant_1", "第一段。", 200);
    const stateReminder = userMessage(
      "msg_goal_state",
      [
        "<system-reminder>",
        "Current session goal state (authoritative):",
        "Status: active",
        "</system-reminder>",
      ].join("\n"),
      { synthetic: true },
      300,
      {
        synthetic: true,
        visibility: "model-only",
        metadata: { visibility: "model-only" },
      },
    );
    const followupAssistant = assistantMessage(
      "msg_goal_assistant_1_followup",
      "继续第一轮。",
      400,
    );

    expect(isNibiModelOnlySyntheticUserMessage(stateReminder)).toBe(true);
    const iterations = getNibiGoalIterationByAssistantMessageId(
      [continuation, firstAssistant, stateReminder, followupAssistant],
      {
        target: {
          createdAt: 100,
          objective: "优化性能到 60fps",
          sessionId: "sess_1",
          status: "active",
          summaryTitle: null,
          targetId: "goal_1",
          timeUsedSeconds: 0,
          tokenBudget: null,
          tokensUsed: 0,
          updatedAt: 100,
        },
      },
    );

    expect(iterations.get("msg_goal_assistant_1")).toBe(1);
    expect(iterations.get("msg_goal_assistant_1_followup")).toBe(1);
  });

  it("does not double count a visible goal input followed by a model-only continuation", () => {
    const visibleGoalInput = userMessage("msg_visible_goal", "增加单测覆盖率，直到 90%", {}, 101);
    const continuation = userMessage(
      "msg_goal_continuation",
      [
        '<system-reminder source="goal-continuation">',
        "Continue working toward the active session goal.",
        "</system-reminder>",
      ].join("\n"),
      { synthetic: true },
      102,
      {
        synthetic: true,
        source: "goal-continuation",
        visibility: "model-only",
        metadata: { source: "goal-continuation", visibility: "model-only" },
      },
    );
    const assistant = assistantMessage("msg_goal_assistant_1", "第一轮。", 200);

    const iterations = getNibiGoalIterationByAssistantMessageId(
      [visibleGoalInput, continuation, assistant],
      {
        target: {
          createdAt: 100,
          objective: "增加单测覆盖率，直到 90%",
          sessionId: "sess_1",
          status: "active",
          summaryTitle: null,
          targetId: "goal_1",
          timeUsedSeconds: 0,
          tokenBudget: null,
          tokensUsed: 0,
          updatedAt: 100,
        },
      },
    );

    expect(iterations.get("msg_goal_assistant_1")).toBe(1);
  });

  it("uses a visible goal input as a fallback boundary when continuation is absent", () => {
    const visibleGoalInput = userMessage("msg_visible_goal", "增加单测覆盖率，直到 90%", {}, 101);
    const assistant = assistantMessage("msg_goal_assistant_1", "第一轮。", 200);

    const iterations = getNibiGoalIterationByAssistantMessageId([visibleGoalInput, assistant], {
      target: {
        createdAt: 100,
        objective: "增加单测覆盖率，直到 90%",
        sessionId: "sess_1",
        status: "active",
        summaryTitle: null,
        targetId: "goal_1",
        timeUsedSeconds: 0,
        tokenBudget: null,
        tokensUsed: 0,
        updatedAt: 100,
      },
    });

    expect(iterations.get("msg_goal_assistant_1")).toBe(1);
  });

  it("caps assistant display iteration by verified goal iteration count", () => {
    const firstContinuation = userMessage(
      "msg_goal_continuation_1",
      [
        '<system-reminder source="goal-continuation">',
        "Continue working toward the active session goal.",
        "</system-reminder>",
      ].join("\n"),
      { synthetic: true },
      102,
      {
        synthetic: true,
        source: "goal-continuation",
        visibility: "model-only",
        metadata: { source: "goal-continuation", visibility: "model-only" },
      },
    );
    const firstAssistant = assistantMessage("msg_goal_assistant_1", "第一轮。", 200);
    const secondContinuation = userMessage(
      "msg_goal_continuation_2",
      [
        '<system-reminder source="goal-continuation">',
        "Continue working toward the active session goal.",
        "</system-reminder>",
      ].join("\n"),
      { synthetic: true },
      300,
      {
        synthetic: true,
        source: "goal-continuation",
        visibility: "model-only",
        metadata: { source: "goal-continuation", visibility: "model-only" },
      },
    );
    const secondAssistant = assistantMessage("msg_goal_assistant_2", "继续处理。", 400);

    const iterations = getNibiGoalIterationByAssistantMessageId(
      [firstContinuation, firstAssistant, secondContinuation, secondAssistant],
      {
        maxGoalIteration: 1,
        target: {
          createdAt: 100,
          objective: "增加单测覆盖率，直到 90%",
          sessionId: "sess_1",
          status: "active",
          summaryTitle: null,
          targetId: "goal_1",
          timeUsedSeconds: 0,
          tokenBudget: null,
          tokensUsed: 0,
          updatedAt: 100,
        },
      },
    );

    expect(iterations.get("msg_goal_assistant_1")).toBe(1);
    expect(iterations.get("msg_goal_assistant_2")).toBe(1);
  });

  it("does not assign completed goal iteration to follow-up assistant replies", () => {
    const visibleGoalInput = userMessage("msg_visible_goal", "把重连恢复修好", {}, 101);
    const goalAssistant = assistantMessage("msg_goal_assistant_1", "第一轮已完成。", 200);
    const followupUser = userMessage("msg_followup_user", "你刚刚的方案是什么？", {}, 400);
    const followupAssistant = assistantMessage(
      "msg_followup_assistant",
      "刚刚的方案是先补边界测试。",
      500,
    );

    const iterations = getNibiGoalIterationByAssistantMessageId(
      [visibleGoalInput, goalAssistant, followupUser, followupAssistant],
      {
        maxGoalIteration: 1,
        target: {
          createdAt: 100,
          objective: "把重连恢复修好",
          sessionId: "sess_1",
          status: "complete",
          summaryTitle: null,
          targetId: "goal_1",
          timeUsedSeconds: 0,
          tokenBudget: null,
          tokensUsed: 0,
          updatedAt: 300,
        },
      },
    );

    expect(iterations.get("msg_goal_assistant_1")).toBe(1);
    expect(iterations.get("msg_followup_assistant")).toBeUndefined();
  });

  it("does not assign paused goal iteration to follow-up assistant replies", () => {
    const visibleGoalInput = userMessage("msg_visible_goal", "把停止目标修好", {}, 101);
    const goalAssistant = assistantMessage("msg_goal_assistant_1", "第一轮被停止。", 200);
    const followupUser = userMessage("msg_followup_user", "nihao", {}, 400);
    const followupAssistant = assistantMessage(
      "msg_followup_assistant",
      "你好！有什么我可以帮你的吗？",
      500,
    );

    const iterations = getNibiGoalIterationByAssistantMessageId(
      [visibleGoalInput, goalAssistant, followupUser, followupAssistant],
      {
        maxGoalIteration: 1,
        target: {
          createdAt: 100,
          objective: "把停止目标修好",
          sessionId: "sess_1",
          status: "paused",
          summaryTitle: null,
          targetId: "goal_1",
          timeUsedSeconds: 0,
          tokenBudget: null,
          tokensUsed: 0,
          updatedAt: 300,
        },
      },
    );

    expect(iterations.get("msg_goal_assistant_1")).toBe(1);
    expect(iterations.get("msg_followup_assistant")).toBeUndefined();
  });

  it("classifies old persisted fork notices as timeline-only", () => {
    const notification = userMessage(
      "msg_fork",
      "<system-reminder>\nThis session was forked from a previous session checkpoint.\n</system-reminder>",
      {
        synthetic: true,
        metadata: {
          source: "fork",
          forkContext: {
            kind: "session_fork",
            parentSessionId: "sess_parent",
            targetMessageId: "msg_target",
            targetCheckpointId: "checkpoint_1",
          },
        },
      },
    );

    expect(getConversationMessageProjectionPolicy(notification)).toBe("timelineOnly");
    expect(isNibiModelOnlySyntheticUserMessage(notification)).toBe(false);
    expect(getNibiUserVisibleMessages([notification])).toEqual([notification]);
  });

  it("classifies model-only fork notices as provider context", () => {
    const forkMetadata = {
      forkContext: {
        kind: "session_fork",
        parentSessionId: "sess_parent",
        targetMessageId: "msg_target",
      },
      source: "fork",
      visibility: "model-only",
    };
    const notification = userMessage(
      "msg_fork_model_only",
      "This session was forked from a previous session message.",
      {
        metadata: forkMetadata,
        synthetic: true,
      },
      1,
      {
        metadata: forkMetadata,
        semantics: {
          kind: "fork_notice",
          origin: "agent_runtime",
          providerVisibility: "visible",
          source: "fork",
          transcriptVisibility: "hidden",
          uiVisibility: "hidden",
        },
        source: "fork",
        synthetic: true,
        visibility: "model-only",
      },
    );

    expect(getConversationMessageProjectionPolicy(notification)).toBe("providerContextOnly");
    expect(getNibiUserVisibleMessages([notification])).toEqual([]);
  });

  it("classifies model-only synthetic users as provider context", () => {
    const notification = userMessage("msg_model_only", "hidden context", { synthetic: true }, 1, {
      synthetic: true,
      visibility: "model-only",
    });

    expect(getConversationMessageProjectionPolicy(notification)).toBe("providerContextOnly");
    expect(getNibiUserVisibleMessages([notification])).toEqual([]);
  });

  it("does not treat unknown synthetic users as real user input", () => {
    const notification = userMessage(
      "msg_unknown_synthetic",
      "runtime context",
      { synthetic: true },
      1,
      { synthetic: true },
    );

    expect(getConversationMessageProjectionPolicy(notification)).toBe("hiddenSynthetic");
    expect(getNibiUserVisibleMessages([notification])).toEqual([]);
  });

  it("classifies plain user text as real user input", () => {
    const message = userMessage("msg_real_input", "真实用户输入");

    expect(getConversationMessageProjectionPolicy(message)).toBe("realUserInput");
    expect(getNibiUserVisibleMessages([message])).toEqual([message]);
  });

  it("classifies a persisted visible assistant response as visible assistant content", () => {
    const base = assistantMessage("msg_visible_assistant", "已完成首轮回复", 2);
    const message: NibiMessageWithParts = {
      ...base,
      info: {
        ...base.info,
        semantics: {
          origin: "agent_runtime",
          kind: "assistant_response",
          uiVisibility: "visible",
          providerVisibility: "visible",
          transcriptVisibility: "visible",
        },
      },
    };

    expect(getConversationMessageProjectionPolicy(message)).toBe("visibleAssistant");
    expect(getNibiUserVisibleMessages([message])).toEqual([message]);
  });

  it("does not treat plain user text as a task notification", () => {
    const message = userMessage(
      "msg_user_xml",
      "<task-notification>为什么这里显示出来了？</task-notification>",
    );

    expect(isNibiModelOnlySyntheticUserMessage(message)).toBe(false);
    expect(getNibiUserVisibleMessages([message])).toEqual([message]);
  });

  it("does not use background task notifications as the visible session title", () => {
    const notification = userMessage(
      "msg_background_first",
      "<task-notification>\n  <status>completed</status>\n</task-notification>",
      {
        synthetic: true,
        metadata: { source: "background_task" },
      },
    );
    const realUserMessage = userMessage("msg_real", "修复登录按钮");

    expect(
      resolveNibiVisibleSessionTitle({
        messages: [notification, realUserMessage],
      }),
    ).toBe("修复登录按钮");
  });
});
