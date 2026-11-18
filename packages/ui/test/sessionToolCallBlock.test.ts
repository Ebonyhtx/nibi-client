import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { resolveToolCallRenderer } from "@/ToolCallBlocks/resolveRenderer.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import {
  SessionToolCallBlock,
  isSessionToolCallRenderable,
  isSessionToolName,
} from "@/ToolCallBlocks/session/session.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import { resolveToolCallIdentity } from "@/lib/toolIdentity.js";

const SESSION_TOOL_NAMES = [
  "ListSessions",
  "ReadSession",
  "CreateSession",
  "ForkSession",
  "SendToSession",
  "WaitSessions",
  "InterruptSession",
  "RenameSession",
] as const;

const displayModel = {
  inlinePreview: { type: "none" as const },
  planResult: null,
  viewerSource: null,
  viewerLabelId: "codeViewer.viewCode" as const,
  showSummaryFileLink: false,
  showInput: false,
  showOutput: true,
  showKind: false,
};

const SESSION_ID = "sess_alpha_1234567890";
const FORKED_ID = "sess_beta_0987654321";

function sessionRef(sessionId = SESSION_ID) {
  return { kind: "cli", workspacePath: "/work/project", sessionId };
}

function buildContext(
  toolName: string,
  fields: Record<string, unknown>,
  context: Record<string, unknown> = {},
): ToolCallBlockRenderContext {
  return {
    toolCallNode: {
      toolCall: {
        toolId: `tool-${toolName}`,
        toolName,
        kind: toolName,
        title: toolName,
        input: {},
        status: "completed",
        ...fields,
      },
      childToolCalls: [],
    },
    workspacePath: "/workspace",
    displayModel,
    viewerSource: null,
    rawFileSummaries: [],
    isRunning: false,
    statusLabel: "",
    childToolList: null,
    forceOpen: true,
    canToggle: true,
    showIcon: true,
    ...context,
  } as unknown as ToolCallBlockRenderContext;
}

function renderSession(
  toolName: string,
  fields: Record<string, unknown>,
  context: Record<string, unknown> = {},
): string {
  return renderToStaticMarkup(
    createElement(
      NibiIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SessionToolCallBlock, buildContext(toolName, fields, context)),
    ),
  );
}

describe("session tool identity", () => {
  it("recognizes all 8 session-control tools as the session family", () => {
    for (const toolName of SESSION_TOOL_NAMES) {
      expect(resolveToolCallIdentity({ toolName, kind: toolName, title: toolName })).toMatchObject({
        toolName,
        family: "session",
        isLegacy: false,
      });
    }
  });

  it("routes every session-control tool to the dedicated renderer", () => {
    for (const toolName of SESSION_TOOL_NAMES) {
      expect(resolveToolCallRenderer(buildContext(toolName, { output: undefined }))).toBe(
        SessionToolCallBlock,
      );
    }
  });

  it("does not claim a lookalike name", () => {
    expect(resolveToolCallRenderer(buildContext("OtherSession", {}))).not.toBe(
      SessionToolCallBlock,
    );
  });

  it("matches only the declared session names", () => {
    expect(isSessionToolName("ListSessions")).toBe(true);
    expect(isSessionToolName("listsessions")).toBe(true);
    expect(isSessionToolName("OtherSession")).toBe(false);
    expect(isSessionToolName(undefined)).toBe(false);
  });
});

describe("session tool shape guard", () => {
  it("keeps running and aborted calls on the session card", () => {
    expect(
      isSessionToolCallRenderable({
        toolId: "running",
        kind: "ReadSession",
        toolName: "ReadSession",
        input: { sessionId: SESSION_ID },
        status: "in_progress",
      }),
    ).toBe(true);
    expect(
      isSessionToolCallRenderable({
        toolId: "failed",
        kind: "SendToSession",
        toolName: "SendToSession",
        input: {},
        status: "failed",
        output: { unexpected: true },
      }),
    ).toBe(true);
  });

  it("falls back to the generic renderer for an unknown result shape", () => {
    const listContext = buildContext("ListSessions", { output: { unexpected: true } });
    expect(isSessionToolCallRenderable(listContext.toolCallNode.toolCall)).toBe(false);
    expect(resolveToolCallRenderer(listContext)).toBe(FallbackToolCallBlock);

    const readContext = buildContext("ReadSession", { output: { view: "unexpected" } });
    expect(isSessionToolCallRenderable(readContext.toolCallNode.toolCall)).toBe(false);
    expect(resolveToolCallRenderer(readContext)).toBe(FallbackToolCallBlock);
  });

  it("keeps a text result because truncation is not an unknown shape", () => {
    expect(
      isSessionToolCallRenderable({
        toolId: "truncated",
        kind: "ReadSession",
        toolName: "ReadSession",
        input: {},
        status: "completed",
        output: "Tool output truncated at 32 KiB",
      }),
    ).toBe(true);
  });
});

describe("ListSessions card", () => {
  it("renders titles, statuses, updated time and partial scope", () => {
    const html = renderSession("ListSessions", {
      input: { query: "迁移" },
      output: {
        sessions: [
          {
            session: sessionRef(),
            title: "迁移任务",
            status: "running",
            updatedAt: "2026-11-18T07:30:00.000Z",
          },
          {
            session: sessionRef("sess_doc_1234567890"),
            title: "文档整理",
            status: "idle",
            updatedAt: "2026-11-17T12:00:00.000Z",
          },
        ],
        nextCursor: "cursor-1",
        searchScope: {
          scopes: [],
          unavailableSources: [{ sourceServerId: "secret", reason: "offline" }],
        },
      },
    });

    expect(html).toContain("找到 2 个会话");
    expect(html).toContain("迁移任务");
    expect(html).toContain("文档整理");
    expect(html).toContain("进行中");
    expect(html).toContain("空闲");
    expect(html).toContain("data-session-updated");
    expect(html).toContain("搜索范围不完整");
    expect(html).toContain("还有更多结果");
    expect(html).toContain('data-testid="session-tool-sessions"');
  });

  it("renders an empty result without inventing rows", () => {
    const html = renderSession("ListSessions", {
      output: { sessions: [] },
    });

    expect(html).toContain("找到 0 个会话");
    expect(html).toContain("已搜索范围内未找到会话");
    expect(html).not.toContain('data-testid="session-tool-sessions"');
  });

  it("prioritizes the error over stale sessions", () => {
    const html = renderSession(
      "ListSessions",
      {
        input: { query: "迁移" },
        status: "failed",
        output: { sessions: [{ session: sessionRef(), title: "旧结果", status: "idle" }] },
      },
      { errorText: "Session store unavailable" },
    );

    expect(html).toContain("执行失败");
    expect(html).toContain("Session store unavailable");
    expect(html).not.toContain("旧结果");
  });
});

describe("ReadSession card", () => {
  it("renders a summary status and updated time", () => {
    const html = renderSession("ReadSession", {
      input: { sessionId: SESSION_ID, view: "summary" },
      output: {
        view: "summary",
        summary: {
          session: sessionRef(),
          title: "迁移任务",
          status: "needs_attention",
          updatedAt: "2026-11-18T07:30:00.000Z",
          availableActions: ["readSession"],
        },
      },
    });

    expect(html).toContain("迁移任务");
    expect(html).toContain("需要处理");
    expect(html).toContain('data-session-section="summary"');
  });

  it("falls back to legacy rawOutput when the live output is absent", () => {
    const html = renderSession("ReadSession", {
      input: { sessionId: SESSION_ID, view: "summary" },
      output: undefined,
      raw: {
        rawOutput: {
          view: "summary",
          summary: {
            session: sessionRef(),
            title: "迁移任务",
            status: "running",
          },
        },
      },
    });

    expect(html).toContain("迁移任务");
    expect(html).toContain("进行中");
  });

  it("renders message roles and preserves the message body", () => {
    const html = renderSession("ReadSession", {
      input: { sessionId: SESSION_ID, view: "messages" },
      output: {
        view: "messages",
        session: sessionRef(),
        messages: [
          { id: "m1", role: "user", text: "请检查构建" },
          { id: "m2", role: "assistant", text: "构建通过\n下一步是发布" },
        ],
        nextCursor: "more",
      },
    });

    expect(html).toContain("用户");
    expect(html).toContain("助手");
    expect(html).toContain("请检查构建");
    expect(html).toContain("构建通过");
    expect(html).toContain("下一步是发布");
    expect(html).toContain('data-testid="session-tool-messages"');
    expect(html).toContain("还有更多结果");
  });

  it("renders no messages honestly", () => {
    const html = renderSession("ReadSession", {
      output: { view: "messages", session: sessionRef(), messages: [] },
    });

    expect(html).toContain("暂无消息");
  });

  it("preserves a truncated text result and marks the truncation", () => {
    const truncated = "Tool output truncated at 32768 bytes\n<persisted-output>…";
    const html = renderSession("ReadSession", {
      output: truncated,
      raw: { outputTruncated: true },
    });

    expect(html).toContain("文本结果");
    expect(html).toContain("Tool output truncated at 32768 bytes");
    expect(html).toContain("&lt;persisted-output&gt;");
    expect(html).toContain('data-testid="session-tool-truncated"');
    expect(html).toContain("输出已截断");
    expect(html).not.toContain("暂无可展示结果");
  });
});

describe("CreateSession card", () => {
  it("shows creation, first-input admission and queue delivery separately", () => {
    const html = renderSession("CreateSession", {
      input: { prompt: "请分析迁移风险" },
      output: {
        requestId: "req-create",
        creation: "created",
        firstInput: "accepted",
        delivery: "queued",
        session: sessionRef(FORKED_ID),
      },
    });

    expect(html).toContain("已排队");
    expect(html).toContain("请分析迁移风险");
    expect(html).toContain('data-session-section="target"');
    expect(html).toContain("已创建");
    expect(html).toContain("已接收");
    expect(html).toContain("创建");
    expect(html).toContain("首条消息");
    expect(html).toContain("投递");
  });

  it("shows a rejected creation with its reason and no queued delivery", () => {
    const html = renderSession("CreateSession", {
      input: { prompt: "请分析迁移风险" },
      output: {
        requestId: "req-create",
        creation: "rejected",
        firstInput: "rejected",
        delivery: "none",
        reason: "Workspace unavailable",
      },
    });

    expect(html).toContain("已拒绝");
    expect(html).toContain("Workspace unavailable");
    expect(html).toContain("未投递");
    expect(html).not.toContain("已排队");
  });

  it("shows an unknown outcome instead of guessing", () => {
    const html = renderSession("CreateSession", {
      output: {
        requestId: "req-create",
        creation: "unknown",
        firstInput: "unknown",
        delivery: "unknown",
      },
    });

    expect(html).toContain("结果未知");
  });
});

describe("ForkSession card", () => {
  it("shows the forked session and its source", () => {
    const html = renderSession("ForkSession", {
      input: { sessionId: SESSION_ID, atMessage: "m1" },
      output: {
        requestId: "req-fork",
        status: "created",
        session: sessionRef(FORKED_ID),
      },
    });

    expect(html).toContain("已创建");
    expect(html).toContain("sess_beta_09");
    expect(html).toContain("sess_alpha_1");
    expect(html).toContain('data-session-section="source"');
  });

  it("shows a rejection reason", () => {
    const html = renderSession("ForkSession", {
      input: { sessionId: SESSION_ID, atMessage: "m1" },
      output: {
        requestId: "req-fork",
        status: "rejected",
        reason: "Message boundary is no longer stable",
      },
    });

    expect(html).toContain("已拒绝");
    expect(html).toContain("Message boundary is no longer stable");
  });
});

describe("SendToSession card", () => {
  it("shows the prompt, admission and queued delivery", () => {
    const html = renderSession("SendToSession", {
      input: { sessionId: SESSION_ID, prompt: "请检查复用点" },
      output: {
        requestId: "req-send",
        session: sessionRef(),
        operation: { session: sessionRef(), sessionId: SESSION_ID, commandId: "cmd-1" },
        admission: "accepted",
        delivery: "queued",
      },
    });

    expect(html).toContain("已排队");
    expect(html).toContain("请检查复用点");
    expect(html).toContain("已接收");
    expect(html).toContain('data-session-section="prompt"');
  });

  it("parses the JSON text form produced by v4 tool rows", () => {
    const html = renderSession("SendToSession", {
      input: { sessionId: SESSION_ID, prompt: "请检查复用点" },
      output: JSON.stringify({
        requestId: "req-send",
        session: sessionRef(),
        operation: { session: sessionRef(), sessionId: SESSION_ID, commandId: "cmd-1" },
        admission: "accepted",
        delivery: "queued",
      }),
    });

    expect(html).toContain("已排队");
    expect(html).toContain("请检查复用点");
  });

  it("shows a rejected admission with its reason", () => {
    const html = renderSession("SendToSession", {
      input: { sessionId: SESSION_ID, prompt: "请检查复用点" },
      output: {
        requestId: "req-send",
        session: sessionRef(),
        admission: "rejected",
        delivery: "none",
        reason: "Permission denied",
      },
    });

    expect(html).toContain("已拒绝");
    expect(html).toContain("Permission denied");
    expect(html).not.toContain("已排队");
  });

  it("shows an unknown outcome", () => {
    const html = renderSession("SendToSession", {
      output: {
        requestId: "req-send",
        session: sessionRef(),
        admission: "unknown",
        delivery: "unknown",
      },
    });

    expect(html).toContain("结果未知");
  });

  it("never reports queued when the tool itself failed", () => {
    const html = renderSession(
      "SendToSession",
      {
        input: { sessionId: SESSION_ID, prompt: "请检查复用点" },
        status: "failed",
        output: {
          requestId: "req-send",
          session: sessionRef(),
          admission: "accepted",
          delivery: "queued",
        },
      },
      { errorText: "Execution failed" },
    );

    expect(html).toContain("执行失败");
    expect(html).toContain("Execution failed");
    expect(html).not.toContain("已排队");
  });
});

describe("WaitSessions card", () => {
  it("shows any/all mode, timed-out status and per-operation attention", () => {
    const html = renderSession("WaitSessions", {
      input: {
        operations: [{ sessionId: SESSION_ID, commandId: "cmd-1" }],
        mode: "all",
        timeoutMs: 30000,
      },
      output: {
        status: "timed_out",
        operations: [
          {
            operation: { session: sessionRef(), sessionId: SESSION_ID, commandId: "cmd-1" },
            epoch: "epoch-1",
            revision: 3,
            status: "needs_attention",
            reason: "等待用户审批",
            attention: { kind: "question", message: "选择目标" },
          },
        ],
      },
    });

    expect(html).toContain("等待超时");
    expect(html).toContain("全部会话");
    expect(html).toContain("需要处理");
    expect(html).toContain("等待用户审批");
    expect(html).toContain("选择目标");
    expect(html).toContain('data-testid="session-tool-operations"');
  });

  it("shows a cancelled wait", () => {
    const html = renderSession("WaitSessions", {
      input: { operations: [{ sessionId: SESSION_ID, commandId: "cmd-1" }], mode: "any" },
      output: {
        status: "cancelled",
        operations: [
          {
            operation: { session: sessionRef(), sessionId: SESSION_ID, commandId: "cmd-1" },
            epoch: "epoch-1",
            revision: 1,
            status: "queued",
          },
        ],
      },
    });

    expect(html).toContain("等待已取消");
    expect(html).toContain("任一会话");
  });

  it("renders pending input operations while the wait is running", () => {
    const html = renderSession(
      "WaitSessions",
      {
        input: { operations: [{ sessionId: SESSION_ID, commandId: "cmd-1" }] },
        output: undefined,
        status: "in_progress",
      },
      { isRunning: true },
    );

    expect(html).toContain("等待中");
    expect(html).toContain('data-testid="session-tool-operations"');
    expect(html).toContain("sess_alpha_1");
  });

  it("reports a completed wait even when the operation list is empty", () => {
    const html = renderSession("WaitSessions", {
      output: { status: "completed", operations: [] },
    });

    expect(html).toContain("等待结束");
    expect(html).not.toContain("暂无可展示结果");
  });
});

describe("InterruptSession and RenameSession cards", () => {
  it("shows applied interrupt with its target", () => {
    const html = renderSession("InterruptSession", {
      input: { sessionId: SESSION_ID, expectedExecutionId: "exec-1" },
      output: { requestId: "req-interrupt", status: "applied" },
    });

    expect(html).toContain("已应用");
    expect(html).toContain("sess_alpha_1");
    expect(html).toContain('data-session-section="target"');
  });

  it("shows a rejected interrupt with its reason", () => {
    const html = renderSession("InterruptSession", {
      input: { sessionId: SESSION_ID, expectedExecutionId: "exec-1" },
      output: {
        requestId: "req-interrupt",
        status: "rejected",
        reason: "Execution changed",
      },
    });

    expect(html).toContain("已拒绝");
    expect(html).toContain("Execution changed");
  });

  it("shows an unknown rename outcome without inventing success", () => {
    const html = renderSession("RenameSession", {
      input: { sessionId: SESSION_ID, title: "新标题" },
      output: { requestId: "req-rename", status: "unknown" },
    });

    expect(html).toContain("结果未知");
    expect(html).toContain("新标题");
    expect(html).toContain('data-session-section="title"');
  });

  it("shows an applied rename with the requested title", () => {
    const html = renderSession("RenameSession", {
      input: { sessionId: SESSION_ID, title: "新标题" },
      output: { requestId: "req-rename", status: "applied" },
    });

    expect(html).toContain("已应用");
    expect(html).toContain("新标题");
  });
});

describe("session tool status precedence", () => {
  it("shows denied without rendering the stale result", () => {
    const html = renderSession("ReadSession", {
      input: { sessionId: SESSION_ID, view: "summary" },
      status: "denied",
      output: {
        view: "summary",
        summary: { session: sessionRef(), title: "迁移任务", status: "needs_attention" },
      },
    });

    expect(html).toContain("已拒绝");
    expect(html).not.toContain("需要处理");
  });

  it("shows stopped for a cancelled wait", () => {
    const html = renderSession("WaitSessions", {
      input: { operations: [{ sessionId: SESSION_ID, commandId: "cmd-1" }] },
      status: "stopped",
      output: { status: "completed", operations: [] },
    });

    expect(html).toContain("已停止");
    expect(html).not.toContain("等待结束");
  });

  it("does not guess an outcome before execution", () => {
    const html = renderSession(
      "SendToSession",
      {
        input: { sessionId: SESSION_ID, prompt: "请检查复用点" },
        output: undefined,
      },
      { isPermissionPreview: true },
    );

    expect(html).not.toContain("结果未知");
    expect(html).not.toContain('data-testid="session-tool-details"');
  });

  it.each(SESSION_TOOL_NAMES)("prioritizes failure over the %s result", (name) => {
    const html = renderSession(
      name,
      { output: {}, status: "failed" },
      { errorText: `${name} failed` },
    );

    expect(html).toContain("执行失败");
    expect(html).toContain(`${name} failed`);
  });
});

describe("session i18n keys", () => {
  const keys = [
    ...SESSION_TOOL_NAMES.map((name) => `chat.toolCall.session.${name}`),
    ...SESSION_TOOL_NAMES.map((name) => `chat.toolCall.session.${name}.running`),
    "chat.toolCall.session.foundOne",
    "chat.toolCall.session.found",
    "chat.toolCall.session.countOne",
    "chat.toolCall.session.count",
    "chat.toolCall.session.unknown",
    "chat.toolCall.session.idle",
    "chat.toolCall.session.running",
    "chat.toolCall.session.attention",
    "chat.toolCall.session.accepted",
    "chat.toolCall.session.queued",
    "chat.toolCall.session.completed",
    "chat.toolCall.session.stopped",
    "chat.toolCall.session.failed",
    "chat.toolCall.session.rejected",
    "chat.toolCall.session.pending",
    "chat.toolCall.session.waitEnded",
    "chat.toolCall.session.timedOut",
    "chat.toolCall.session.cancelled",
    "chat.toolCall.session.created",
    "chat.toolCall.session.applied",
    "chat.toolCall.session.inputRejected",
    "chat.toolCall.session.started",
    "chat.toolCall.session.deliveryNone",
    "chat.toolCall.session.textResult",
    "chat.toolCall.session.message",
    "chat.toolCall.session.messages",
    "chat.toolCall.session.target",
    "chat.toolCall.session.source",
    "chat.toolCall.session.sessions",
    "chat.toolCall.session.result",
    "chat.toolCall.session.status",
    "chat.toolCall.session.updated",
    "chat.toolCall.session.unknownSession",
    "chat.toolCall.session.empty",
    "chat.toolCall.session.scope",
    "chat.toolCall.session.partial",
    "chat.toolCall.session.more",
    "chat.toolCall.session.noMessages",
    "chat.toolCall.session.waitingResult",
    "chat.toolCall.session.noResult",
    "chat.toolCall.session.truncated",
    "chat.toolCall.session.truncation",
    "chat.toolCall.session.mode",
    "chat.toolCall.session.mode.any",
    "chat.toolCall.session.mode.all",
    "chat.toolCall.session.title",
    "chat.toolCall.session.creation",
    "chat.toolCall.session.firstInput",
    "chat.toolCall.session.delivery",
    "chat.toolCall.session.admission",
    "chat.toolCall.session.attentionApproval",
    "chat.toolCall.session.attentionQuestion",
    "chat.toolCall.session.role.user",
    "chat.toolCall.session.role.assistant",
    "chat.toolCall.session.role.system",
    "chat.toolCall.session.role.tool",
  ];

  it("defines every session key in both locales", () => {
    for (const key of keys) {
      expect(enUS[key], `en-US missing ${key}`).toBeTruthy();
      expect(zhCN[key], `zh-CN missing ${key}`).toBeTruthy();
    }
  });
});
