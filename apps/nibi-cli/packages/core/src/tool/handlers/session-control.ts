// 会话控制工具：只做可信绑定核对、模型输入解析、requestId 注入与回执复验。
// 业务语义（授权、self_wait、等待、生产 owner）全部在 SessionControlHost/共享包 facade；
// handler 不读 session store，也不持有任何全局单例。
import {
  CreateSessionInputJsonSchema,
  CreateSessionInputSchema,
  CreateSessionOutputJsonSchema,
  CreateSessionOutputSchema,
  ForkSessionInputJsonSchema,
  ForkSessionInputSchema,
  ForkSessionOutputJsonSchema,
  ForkSessionOutputSchema,
  InterruptSessionInputJsonSchema,
  InterruptSessionInputSchema,
  InterruptSessionOutputJsonSchema,
  InterruptSessionOutputSchema,
  ListSessionsInputJsonSchema,
  ListSessionsInputSchema,
  ListSessionsOutputJsonSchema,
  ListSessionsOutputSchema,
  ReadSessionInputJsonSchema,
  ReadSessionInputSchema,
  ReadSessionOutputJsonSchema,
  ReadSessionOutputSchema,
  RenameSessionInputJsonSchema,
  RenameSessionInputSchema,
  RenameSessionOutputJsonSchema,
  RenameSessionOutputSchema,
  SendToSessionInputJsonSchema,
  SendToSessionInputSchema,
  SendToSessionOutputJsonSchema,
  SendToSessionOutputSchema,
  WaitSessionsInputJsonSchema,
  WaitSessionsInputSchema,
  WaitSessionsOutputJsonSchema,
  WaitSessionsOutputSchema,
} from "@nibi/contracts";
import { SessionControlError, type CliSessionControl } from "@nibi/session-control/contracts";
import { SessionControlReceiptCache } from "../session-control/receipt-cache.js";
import type { SessionControlBinding } from "../session-control/contract.js";
import type { ToolEntry, ToolExecutionContext } from "../types.js";

const OUTPUT_BYTES = 32_768;
const TOOL_TIMEOUT_MS = 60_000;
// wait 的契约上限是 300s；工具超时多留 10s 给清理，不能把合法等待提前打断。
const WAIT_TIMEOUT_MS = 310_000;

type Shape = {
  parse(input: unknown): unknown;
  safeParse?(input: unknown): unknown;
  shape?: Record<string, unknown>;
};

type CliMethod = keyof CliSessionControl;

type Definition = {
  name: string;
  method: CliMethod;
  hint: string;
  description: string;
  input: Shape;
  inputJsonSchema: Record<string, unknown>;
  output: Shape;
  outputJsonSchema: Record<string, unknown>;
  readOnly?: boolean;
};

/**
 * 模型只看 `tool` 变体：目标只有 sessionId，写操作只有可选 retryOf。
 * 端口与用例层仍用完整引用与 requestId；这个辅助同时服务注册声明与 handler。
 */
function modelFacing(schema: Shape): Shape {
  return schema;
}

/** 规格 0.14：请求身份由工具层注入；重试时模型把回执里的 requestId 放进 retryOf。 */
function requestIdentity(input: unknown, toolCallId: string): string {
  const retryOf = (input as { retryOf?: unknown } | null)?.retryOf;
  return typeof retryOf === "string" ? retryOf : toolCallId;
}

function withRequestId(parsed: unknown, context: ToolExecutionContext): Record<string, unknown> {
  const { retryOf: _retryOf, ...rest } = parsed as Record<string, unknown>;
  return { ...rest, requestId: requestIdentity(parsed, context.toolCallId) };
}

function needsRequestId(schema: Shape): boolean {
  return schema.shape !== undefined && "retryOf" in schema.shape;
}

const sharedInstructions = [
  "Target an existing session by its sessionId. When you do not know the id, find it with ListSessions by title substring; never infer identity from a title or a path.",
  "Create or send work only when authorized by the user or an existing delegation. Keep the target session's permissions; this tool never approves its later permission requests.",
  "Accepted or queued means admitted, not completed. Wait for the returned operation, and surface needs_attention to the user.",
] as const;
const retryInstruction =
  "An inconclusive result needs reconciliation, not a fresh call: take the requestId from that result and pass it as `retryOf`. Otherwise leave `retryOf` out — there is no requestId input to set." as const;

function instructionsFor(schema: Shape): readonly string[] {
  return needsRequestId(modelFacing(schema))
    ? [...sharedInstructions, retryInstruction]
    : sharedInstructions;
}

const definitions: Definition[] = [
  {
    name: "ListSessions",
    method: "listSessions",
    hint: "find sessions in the bound workspace by title",
    description:
      "List authorized sessions and their actual available actions without resuming or navigating.",
    input: ListSessionsInputSchema,
    inputJsonSchema: ListSessionsInputJsonSchema,
    output: ListSessionsOutputSchema,
    outputJsonSchema: ListSessionsOutputJsonSchema,
    readOnly: true,
  },
  {
    name: "ReadSession",
    method: "readSession",
    hint: "read session status or message history",
    description:
      "Read a session summary or bounded history without execution, navigation or marking it read.",
    input: ReadSessionInputSchema,
    inputJsonSchema: ReadSessionInputJsonSchema,
    output: ReadSessionOutputSchema,
    outputJsonSchema: ReadSessionOutputJsonSchema,
    readOnly: true,
  },
  {
    name: "CreateSession",
    method: "createSession",
    hint: "create an independent session with a first prompt",
    description:
      "Create a root session and submit its first prompt. Creation and input admission are reported separately. Does not steal focus.",
    input: CreateSessionInputSchema,
    inputJsonSchema: CreateSessionInputJsonSchema,
    output: CreateSessionOutputSchema,
    outputJsonSchema: CreateSessionOutputJsonSchema,
  },
  {
    name: "ForkSession",
    method: "forkSession",
    hint: "fork a session at a stable message",
    description:
      "Fork at an explicit stable message boundary. Does not copy running tools, permission approvals, pending inputs, or change workspace files. Does not send a prompt.",
    input: ForkSessionInputSchema,
    inputJsonSchema: ForkSessionInputJsonSchema,
    output: ForkSessionOutputSchema,
    outputJsonSchema: ForkSessionOutputJsonSchema,
  },
  {
    name: "SendToSession",
    method: "sendToSession",
    hint: "send a prompt to an existing session",
    description:
      "Submit input to the target session owner. Busy targets queue it. Preserve the target model, mode and permissions.",
    input: SendToSessionInputSchema,
    inputJsonSchema: SendToSessionInputJsonSchema,
    output: SendToSessionOutputSchema,
    outputJsonSchema: SendToSessionOutputJsonSchema,
  },
  {
    name: "WaitSessions",
    method: "waitSessions",
    hint: "wait for specific session operations",
    description:
      "Wait for the exact create/send operations, using any or all. timeoutMs=0 queries now. Cancelling this wait does not stop target execution. Never wait for your own future completion.",
    input: WaitSessionsInputSchema,
    inputJsonSchema: WaitSessionsInputJsonSchema,
    output: WaitSessionsOutputSchema,
    outputJsonSchema: WaitSessionsOutputJsonSchema,
    readOnly: true,
  },
  {
    name: "InterruptSession",
    method: "interruptSession",
    hint: "interrupt an observed session execution",
    description:
      "Interrupt only expectedExecutionId. A changed execution is rejected; session history is retained.",
    input: InterruptSessionInputSchema,
    inputJsonSchema: InterruptSessionInputJsonSchema,
    output: InterruptSessionOutputSchema,
    outputJsonSchema: InterruptSessionOutputJsonSchema,
  },
  {
    name: "RenameSession",
    method: "renameSession",
    hint: "rename a session title",
    description: "Set the target session title through its metadata owner.",
    input: RenameSessionInputSchema,
    inputJsonSchema: RenameSessionInputJsonSchema,
    output: RenameSessionOutputSchema,
    outputJsonSchema: RenameSessionOutputJsonSchema,
  },
];

/**
 * 回执缓存按 binding.control 隔离：同一进程内的独立 manager 不共享 requestId 空间。
 * WeakMap 让控制端口回收后缓存随之释放，不引入进程级单例。
 */
const receiptCaches = new WeakMap<object, SessionControlReceiptCache>();

function receiptsFor(binding: SessionControlBinding): SessionControlReceiptCache {
  const key = binding.control as object;
  let cache = receiptCaches.get(key);
  if (!cache) {
    cache = new SessionControlReceiptCache();
    receiptCaches.set(key, cache);
  }
  return cache;
}

function requireBinding(context: ToolExecutionContext): {
  binding: SessionControlBinding;
  trusted: ReturnType<SessionControlBinding["context"]>;
} {
  const binding = context.sessionControl;
  if (!binding || binding.kind !== "cli" || context.runtimeScope === "subagent")
    throw new SessionControlError(
      "forbidden",
      "Session control is unavailable in this execution context.",
    );
  const trusted = binding.context();
  if (trusted.rootSession.kind !== "cli" || trusted.rootSession.sessionId !== context.sessionId)
    throw new SessionControlError(
      "forbidden",
      "Session control root binding does not match the executing session.",
    );
  return {
    binding,
    trusted: {
      ...trusted,
      signal: context.abortSignal,
      traceId: context.traceId,
      turnId: context.traceContext?.turnId ?? context.turnId,
      toolCallId: context.toolCallId,
    },
  };
}

function parseOutput(schema: Shape, output: unknown): unknown {
  const result = schema.safeParse?.(output) as
    | { success: true; data: unknown }
    | { success: false; error: { message: string } }
    | undefined;
  if (!result) return schema.parse(output);
  if (!result.success) throw new SessionControlError("invalid_output", result.error.message);
  return result.data;
}

function createEntry(definition: Definition): ToolEntry {
  const readOnly = definition.readOnly === true;
  const timeoutMs = definition.method === "waitSessions" ? WAIT_TIMEOUT_MS : TOOL_TIMEOUT_MS;
  const sideEffectScope = readOnly ? "none" : "system";
  const riskLevel = readOnly ? "low" : "medium";
  const mutating = !readOnly;
  return {
    capability: definition.description,
    metadata: {
      name: definition.name,
      description: definition.description,
      searchHint: definition.hint,
      modelInstructions: instructionsFor(modelFacing(definition.input)),
      shouldDefer: true,
      readOnly,
      destructive: false,
      concurrentSafe: readOnly,
      sideEffectScope,
      riskLevel,
      needsApproval: mutating,
      maxOutputBytes: OUTPUT_BYTES,
      timeoutMs,
    },
    // io: "input" —— 默认按 output 投影会把 .default() 字段算进 required，
    // 于是 cursor/limit/timeoutMs 带着默认值却被标成必填，与工具说明矛盾。
    inputSchema: definition.inputJsonSchema,
    outputSchema: definition.outputJsonSchema,
    runtimeInputSchema: modelFacing(definition.input),
    runtimeOutputSchema: definition.output,
    permission: {
      // 与上游 3.18.2 同一条规则名：session_control.<camelCase method>。
      permission: `session_control.${definition.method}`,
      reason: definition.description,
      riskLevel,
      sideEffectScope,
      needsApproval: mutating,
      patternSources: ["toolName", "input"],
      denyPriority: "beforeAsk",
    },
    resultBudget: {
      maxInlineBytes: OUTPUT_BYTES,
      maxModelBytes: OUTPUT_BYTES,
      strategy: "artifact",
      preview: { maxBytes: OUTPUT_BYTES, direction: "head" },
      artifact: { enabled: true, retention: "session" },
    },
    timeout: { defaultMs: timeoutMs, maxMs: timeoutMs, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "required",
      userVisibleMessage: "Session control cancelled. Target work is not stopped.",
    },
    trace: {
      required: true,
      propagateToAdapters: true,
      recordInput: "summary",
      recordOutput: "summary",
    },
    handler: async (input, context) => {
      const { binding, trusted } = requireBinding(context);
      context.abortSignal.throwIfAborted();
      const schema = modelFacing(definition.input);
      const raw = schema.parse(input);
      const parsed = needsRequestId(schema)
        ? withRequestId(raw, context)
        : (raw as Record<string, unknown>);
      const run = () =>
        (
          binding.control as unknown as Record<
            string,
            (ctx: typeof trusted, value: unknown) => Promise<unknown>
          >
        )[definition.method](trusted, parsed);
      let result: unknown;
      if (mutating) {
        const requestId = parsed.requestId as string;
        result = await receiptsFor(binding).remember({
          callerId: trusted.callerId,
          rootSession: trusted.rootSession,
          requestId,
          action: definition.method,
          payload: parsed,
          run,
        });
      } else {
        result = await run();
      }
      return parseOutput(definition.output, result);
    },
  } as ToolEntry;
}

export const sessionControlToolEntries: readonly ToolEntry[] = definitions.map((definition) =>
  createEntry(definition),
);
