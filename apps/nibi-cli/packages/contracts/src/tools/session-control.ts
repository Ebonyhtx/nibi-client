// 会话控制 8 个 CLI 模型工具的 wire 契约。
// 模型只看共享包的 `tool` 变体：目标只有 sessionId，写操作只收可选 retryOf；
// 端口/用例层仍用完整引用与 requestId，由工具层注入。
import {
  cliCreateSessionInputSchema,
  cliForkSessionInputSchema,
  cliInterruptSessionInputSchema,
  cliListSessionsInputSchema,
  cliReadSessionInputSchema,
  cliRenameSessionInputSchema,
  cliSendToSessionInputSchema,
  cliWaitSessionsInputSchema,
  createSessionResultSchema,
  forkSessionResultSchema,
  listSessionsResultSchema,
  mutationResultSchema,
  readSessionResultSchema,
  sendToSessionResultSchema,
  toOutputJsonSchema,
  toToolJsonSchema,
  waitSessionsResultSchema,
  type CliSessionControl,
} from "@nibi/session-control/contracts";

export const LIST_SESSIONS_TOOL_NAME = "ListSessions";
export const READ_SESSION_TOOL_NAME = "ReadSession";
export const CREATE_SESSION_TOOL_NAME = "CreateSession";
export const FORK_SESSION_TOOL_NAME = "ForkSession";
export const SEND_TO_SESSION_TOOL_NAME = "SendToSession";
export const WAIT_SESSIONS_TOOL_NAME = "WaitSessions";
export const INTERRUPT_SESSION_TOOL_NAME = "InterruptSession";
export const RENAME_SESSION_TOOL_NAME = "RenameSession";

export const SESSION_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  LIST_SESSIONS_TOOL_NAME,
  READ_SESSION_TOOL_NAME,
  CREATE_SESSION_TOOL_NAME,
  FORK_SESSION_TOOL_NAME,
  SEND_TO_SESSION_TOOL_NAME,
  WAIT_SESSIONS_TOOL_NAME,
  INTERRUPT_SESSION_TOOL_NAME,
  RENAME_SESSION_TOOL_NAME,
]);

// 模型侧 schema：target 类工具只暴露 sessionId；写工具用 retryOf 替代 requestId。
export const ListSessionsInputSchema = cliListSessionsInputSchema;
export const ReadSessionInputSchema = cliReadSessionInputSchema.tool;
export const CreateSessionInputSchema = cliCreateSessionInputSchema.tool;
export const ForkSessionInputSchema = cliForkSessionInputSchema.tool;
export const SendToSessionInputSchema = cliSendToSessionInputSchema.tool;
export const WaitSessionsInputSchema = cliWaitSessionsInputSchema.tool;
export const InterruptSessionInputSchema = cliInterruptSessionInputSchema.tool;
export const RenameSessionInputSchema = cliRenameSessionInputSchema.tool;

export const ListSessionsOutputSchema = listSessionsResultSchema;
export const ReadSessionOutputSchema = readSessionResultSchema;
export const CreateSessionOutputSchema = createSessionResultSchema;
export const ForkSessionOutputSchema = forkSessionResultSchema;
export const SendToSessionOutputSchema = sendToSessionResultSchema;
export const WaitSessionsOutputSchema = waitSessionsResultSchema;
export const InterruptSessionOutputSchema = mutationResultSchema;
export const RenameSessionOutputSchema = mutationResultSchema;

// JSON Schema 用 input IO 投影：默认值字段（cursor/limit/timeoutMs）不进入 required。
export const ListSessionsInputJsonSchema = toToolJsonSchema(ListSessionsInputSchema);
export const ReadSessionInputJsonSchema = toToolJsonSchema(ReadSessionInputSchema);
export const CreateSessionInputJsonSchema = toToolJsonSchema(CreateSessionInputSchema);
export const ForkSessionInputJsonSchema = toToolJsonSchema(ForkSessionInputSchema);
export const SendToSessionInputJsonSchema = toToolJsonSchema(SendToSessionInputSchema);
export const WaitSessionsInputJsonSchema = toToolJsonSchema(WaitSessionsInputSchema);
export const InterruptSessionInputJsonSchema = toToolJsonSchema(InterruptSessionInputSchema);
export const RenameSessionInputJsonSchema = toToolJsonSchema(RenameSessionInputSchema);

export const ListSessionsOutputJsonSchema = toOutputJsonSchema(ListSessionsOutputSchema);
export const ReadSessionOutputJsonSchema = toOutputJsonSchema(ReadSessionOutputSchema);
export const CreateSessionOutputJsonSchema = toOutputJsonSchema(CreateSessionOutputSchema);
export const ForkSessionOutputJsonSchema = toOutputJsonSchema(ForkSessionOutputSchema);
export const SendToSessionOutputJsonSchema = toOutputJsonSchema(SendToSessionOutputSchema);
export const WaitSessionsOutputJsonSchema = toOutputJsonSchema(WaitSessionsOutputSchema);
export const InterruptSessionOutputJsonSchema = toOutputJsonSchema(InterruptSessionOutputSchema);
export const RenameSessionOutputJsonSchema = toOutputJsonSchema(RenameSessionOutputSchema);

// 工具层输入/输出类型直接从共享 facade 派生，避免两份类型漂移。
export type ListSessionsToolInput = Parameters<CliSessionControl["listSessions"]>[1];
export type ReadSessionToolInput = Parameters<CliSessionControl["readSession"]>[1];
export type CreateSessionToolInput = Parameters<CliSessionControl["createSession"]>[1];
export type ForkSessionToolInput = Parameters<CliSessionControl["forkSession"]>[1];
export type SendToSessionToolInput = Parameters<CliSessionControl["sendToSession"]>[1];
export type WaitSessionsToolInput = Parameters<CliSessionControl["waitSessions"]>[1];
export type InterruptSessionToolInput = Parameters<CliSessionControl["interruptSession"]>[1];
export type RenameSessionToolInput = Parameters<CliSessionControl["renameSession"]>[1];

export type ListSessionsToolOutput = Awaited<ReturnType<CliSessionControl["listSessions"]>>;
export type ReadSessionToolOutput = Awaited<ReturnType<CliSessionControl["readSession"]>>;
export type CreateSessionToolOutput = Awaited<ReturnType<CliSessionControl["createSession"]>>;
export type ForkSessionToolOutput = Awaited<ReturnType<CliSessionControl["forkSession"]>>;
export type SendToSessionToolOutput = Awaited<ReturnType<CliSessionControl["sendToSession"]>>;
export type WaitSessionsToolOutput = Awaited<ReturnType<CliSessionControl["waitSessions"]>>;
export type InterruptSessionToolOutput = Awaited<ReturnType<CliSessionControl["interruptSession"]>>;
export type RenameSessionToolOutput = Awaited<ReturnType<CliSessionControl["renameSession"]>>;
