// App-exclusive 会话控制 4 个模型工具的 wire 契约。
// 模型只看共享包的 `tool` 变体：目标只有 sessionId，写操作只收可选 retryOf；
// 端口/用例层仍用完整引用与 requestId，由工具层注入。这里不复制任何 wire 形状。
import {
  appListProjectsInputSchema,
  appOpenSessionInputSchema,
  appSetSessionArchivedInputSchema,
  appSetSessionPinnedInputSchema,
  listProjectsResultSchema,
  mutationResultSchema,
  openSessionResultSchema,
  toOutputJsonSchema,
  toToolJsonSchema,
  type AppSessionControl,
} from "@nibi/session-control/contracts";

export const LIST_PROJECTS_TOOL_NAME = "ListProjects";
export const OPEN_SESSION_TOOL_NAME = "OpenSession";
export const SET_SESSION_ARCHIVED_TOOL_NAME = "SetSessionArchived";
export const SET_SESSION_PINNED_TOOL_NAME = "SetSessionPinned";

export const APP_SESSION_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set([
  LIST_PROJECTS_TOOL_NAME,
  OPEN_SESSION_TOOL_NAME,
  SET_SESSION_ARCHIVED_TOOL_NAME,
  SET_SESSION_PINNED_TOOL_NAME,
]);

// 模型侧 schema：ListProjects 只有 query；其余目标只有 sessionId，写工具用 retryOf 替代 requestId。
export const ListProjectsInputSchema = appListProjectsInputSchema;
export const OpenSessionInputSchema = appOpenSessionInputSchema.tool;
export const SetSessionArchivedInputSchema = appSetSessionArchivedInputSchema.tool;
export const SetSessionPinnedInputSchema = appSetSessionPinnedInputSchema.tool;

export const ListProjectsOutputSchema = listProjectsResultSchema;
export const OpenSessionOutputSchema = openSessionResultSchema;
export const SetSessionArchivedOutputSchema = mutationResultSchema;
export const SetSessionPinnedOutputSchema = mutationResultSchema;

export const ListProjectsInputJsonSchema = toToolJsonSchema(ListProjectsInputSchema);
export const OpenSessionInputJsonSchema = toToolJsonSchema(OpenSessionInputSchema);
export const SetSessionArchivedInputJsonSchema = toToolJsonSchema(SetSessionArchivedInputSchema);
export const SetSessionPinnedInputJsonSchema = toToolJsonSchema(SetSessionPinnedInputSchema);

export const ListProjectsOutputJsonSchema = toOutputJsonSchema(ListProjectsOutputSchema);
export const OpenSessionOutputJsonSchema = toOutputJsonSchema(OpenSessionOutputSchema);
export const SetSessionArchivedOutputJsonSchema = toOutputJsonSchema(SetSessionArchivedOutputSchema);
export const SetSessionPinnedOutputJsonSchema = toOutputJsonSchema(SetSessionPinnedOutputSchema);

// 工具层输入/输出类型直接从共享 facade 派生，避免两份类型漂移。
export type ListProjectsToolInput = Parameters<AppSessionControl["listProjects"]>[1];
export type OpenSessionToolInput = Parameters<AppSessionControl["openSession"]>[1];
export type SetSessionArchivedToolInput = Parameters<AppSessionControl["setSessionArchived"]>[1];
export type SetSessionPinnedToolInput = Parameters<AppSessionControl["setSessionPinned"]>[1];

export type ListProjectsToolOutput = Awaited<ReturnType<AppSessionControl["listProjects"]>>;
export type OpenSessionToolOutput = Awaited<ReturnType<AppSessionControl["openSession"]>>;
export type SetSessionArchivedToolOutput = Awaited<
  ReturnType<AppSessionControl["setSessionArchived"]>
>;
export type SetSessionPinnedToolOutput = Awaited<ReturnType<AppSessionControl["setSessionPinned"]>>;