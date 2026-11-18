// App-exclusive 会话控制 4 个工具：只做可信绑定核对、模型输入解析、requestId 注入与回执复验。
// App 数据、项目发现、任务索引写入与窗口导航全部在 Host；handler 不读 session store，
// 也不持有任何全局单例。
import {
  ListProjectsInputJsonSchema,
  ListProjectsInputSchema,
  ListProjectsOutputJsonSchema,
  ListProjectsOutputSchema,
  OpenSessionInputJsonSchema,
  OpenSessionInputSchema,
  OpenSessionOutputJsonSchema,
  OpenSessionOutputSchema,
  SetSessionArchivedInputJsonSchema,
  SetSessionArchivedInputSchema,
  SetSessionArchivedOutputJsonSchema,
  SetSessionArchivedOutputSchema,
  SetSessionPinnedInputJsonSchema,
  SetSessionPinnedInputSchema,
  SetSessionPinnedOutputJsonSchema,
  SetSessionPinnedOutputSchema,
} from "@nibi/contracts";
import { SessionControlError } from "@nibi/session-control/contracts";
import type { AppSessionControlBinding, AppSessionControlPort } from "@nibi/contracts";
import type { ToolEntry, ToolExecutionContext } from "../types.js";

const OUTPUT_BYTES = 32_768;
const TOOL_TIMEOUT_MS = 60_000;

type Shape = {
  parse(input: unknown): unknown;
  safeParse?(input: unknown): unknown;
  shape?: Record<string, unknown>;
};

type AppMethod = keyof AppSessionControlPort;

type Definition = {
  name: string;
  method: AppMethod;
  hint: string;
  description: string;
  input: Shape;
  inputJsonSchema: Record<string, unknown>;
  output: Shape;
  outputJsonSchema: Record<string, unknown>;
  readOnly?: boolean;
};

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
  "Target an existing App session by its sessionId. Use ListProjects to discover project references; never infer project identity from a title or a path.",
  "The App host owns discovery, task-index writes and window navigation. Never provide workspace paths, scopes, uiTargets or request ids yourself.",
  "opened, applied, rejected and unavailable are authoritative outcomes. Do not retry an inconclusive result with a fresh call: pass its requestId as `retryOf`.",
] as const;

const definitions: Definition[] = [
  {
    name: "ListProjects",
    method: "listProjects",
    hint: "list projects visible in the App and the sources searched",
    description:
      "List App projects and the sources that were actually searched. Read-only; does not start sessions or navigate.",
    input: ListProjectsInputSchema,
    inputJsonSchema: ListProjectsInputJsonSchema,
    output: ListProjectsOutputSchema,
    outputJsonSchema: ListProjectsOutputJsonSchema,
    readOnly: true,
  },
  {
    name: "OpenSession",
    method: "openSession",
    hint: "open an App session in the bound window",
    description:
      "Ask the App window bound to this conversation to open a session. Requires user approval. It never raises or focuses an OS window; when no window accepts, the result is unavailable.",
    input: OpenSessionInputSchema,
    inputJsonSchema: OpenSessionInputJsonSchema,
    output: OpenSessionOutputSchema,
    outputJsonSchema: OpenSessionOutputJsonSchema,
  },
  {
    name: "SetSessionArchived",
    method: "setSessionArchived",
    hint: "archive or restore an App session",
    description:
      "Archive or restore a session through the App task index. Never touches the kernel session store or interrupts execution.",
    input: SetSessionArchivedInputSchema,
    inputJsonSchema: SetSessionArchivedInputJsonSchema,
    output: SetSessionArchivedOutputSchema,
    outputJsonSchema: SetSessionArchivedOutputJsonSchema,
  },
  {
    name: "SetSessionPinned",
    method: "setSessionPinned",
    hint: "pin or unpin an App session",
    description:
      "Pin or unpin a session through the App task index. Never touches the kernel session store or interrupts execution.",
    input: SetSessionPinnedInputSchema,
    inputJsonSchema: SetSessionPinnedInputJsonSchema,
    output: SetSessionPinnedOutputSchema,
    outputJsonSchema: SetSessionPinnedOutputJsonSchema,
  },
];

function requireBinding(context: ToolExecutionContext): {
  binding: AppSessionControlBinding;
  trusted: ReturnType<AppSessionControlBinding["context"]>;
} {
  const binding = context.appSessionControl;
  if (!binding || binding.kind !== "app" || context.runtimeScope === "subagent")
    throw new SessionControlError(
      "forbidden",
      "App session control is unavailable in this execution context.",
    );
  const trusted = binding.context();
  const root = trusted.rootSession;
  if (!root || root.kind !== "app" || root.sessionId !== context.sessionId)
    throw new SessionControlError(
      "forbidden",
      "App session control root binding does not match the executing session.",
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
  const mutating = !readOnly;
  const sideEffectScope = readOnly ? "none" : "system";
  const riskLevel = readOnly ? "low" : "medium";
  return {
    capability: definition.description,
    metadata: {
      name: definition.name,
      description: definition.description,
      searchHint: definition.hint,
      modelInstructions: sharedInstructions,
      shouldDefer: true,
      readOnly,
      destructive: false,
      concurrentSafe: readOnly,
      sideEffectScope,
      riskLevel,
      needsApproval: mutating,
      maxOutputBytes: OUTPUT_BYTES,
      timeoutMs: TOOL_TIMEOUT_MS,
    },
    inputSchema: definition.inputJsonSchema,
    outputSchema: definition.outputJsonSchema,
    runtimeInputSchema: definition.input,
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
    timeout: { defaultMs: TOOL_TIMEOUT_MS, maxMs: TOOL_TIMEOUT_MS, allowCallOverride: false },
    cancellation: {
      supported: true,
      cleanup: "required",
      userVisibleMessage: "App control cancelled. Target work is not stopped.",
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
      const parsed = definition.input.parse(input) as Record<string, unknown>;
      const value = needsRequestId(definition.input) ? withRequestId(parsed, context) : parsed;
      const run = () =>
        (
          binding.control as unknown as Record<
            string,
            (ctx: typeof trusted, input: unknown) => Promise<unknown>
          >
        )[definition.method](trusted, value);
      const output = parseOutput(definition.output, await run());
      if (needsRequestId(definition.input)) {
        const echoed = (output as { requestId?: unknown } | null)?.requestId;
        if (echoed !== value.requestId)
          throw new SessionControlError(
            "invalid_output",
            "App host returned a different requestId",
          );
      }
      return output;
    },
  } as ToolEntry;
}

export const appSessionControlToolEntries: readonly ToolEntry[] = definitions.map((definition) =>
  createEntry(definition),
);