import type { ZCodeProvider } from "./zcode-task-types-core.js";
import { modelSelectionSchema, type ModelSelection } from "./model-selection.js";

export type AgentScope = "built-in" | "workspace" | "user";

export type AgentSource = "built-in" | "user" | "plugin";

export type BuiltInSubagentName = "general-purpose" | "Explore";

export type BuiltInSubagentModelSelectionOverrides = Partial<
  Record<BuiltInSubagentName, ModelSelection>
>;

export type PluginSubagentModelSelectionOverrides = Readonly<Record<string, ModelSelection>>;

/**
 * 子代理的模型选择**解析不出来**时怎么办（`agents-state.json` 的 `selectionFallback`）。
 *
 * 语义与判据（与 core 的 `resolveSubagentSelection` 一一对应，改一处必须改另一处）：
 * - `fail`：照旧抛错，不换模型。
 * - `inherit`：退回会话模型。
 * - `capability`：优先挑**能读图**的可用模型，其次会话模型，最后任一可用模型。
 *
 * ⛔ 三种档位**只对"本机此刻用不了"生效**（供应商/模型不存在、账号不可用）。
 * "选择本身写错"（档位不支持等）一律照旧抛错 —— 那是用户的意图有问题，必须让他看见，
 * 换模型只会把"配置写错"伪装成"跑起来了"。
 */
export type SubagentSelectionFallbackMode = "fail" | "inherit" | "capability";

export const SUBAGENT_SELECTION_FALLBACK_MODES = [
  "fail",
  "inherit",
  "capability",
] as const satisfies readonly SubagentSelectionFallbackMode[];

/**
 * 出厂默认：`capability`（**NIBI 产品口径，与上游 ZCode 的原本行为不同**）。
 *
 * 上游原本是"解析不出来就报错"。本产品改成自动挑一个能用的，理由是实测出来的：
 * agent 定义里 pin 供应商是常态（官方插件的 `visual-judge` 就钉了一个本机根本没有的
 * `account:bigmodel-individual-coding-plan/…`），而 pin 落空的代价是**整个能力消失**
 * —— 视觉评审直接起不来，用户看到的是一句 `Provider unavailable`，很难自己想到
 * "去把那个 agent 的模型换一下"。
 *
 * 放宽的只是"从没碰过这一项"的实例：用户主动选了 `fail` 时字段是**存在**的，照原样尊重。
 * 而且每次替换都会留痕（日志 + 子代理自己的系统提示），设置页里也一直可见可改。
 *
 * ⛔ `parseSubagentSelectionFallbackMode` 是**唯一**读取入口：运行时（bootstrap）与
 * 设置页（services）必须共用它，否则会出现"界面显示照旧报错、后端实际在自动换模型"
 * 这种两边说法不一致的情况。
 */
export const DEFAULT_SUBAGENT_SELECTION_FALLBACK_MODE: SubagentSelectionFallbackMode =
  "capability";

export function isSubagentSelectionFallbackMode(
  value: unknown,
): value is SubagentSelectionFallbackMode {
  return (
    typeof value === "string" &&
    (SUBAGENT_SELECTION_FALLBACK_MODES as readonly string[]).includes(value)
  );
}

/** 读取该字段：缺席或值非法一律回出厂默认 —— 一个坏字段不该让整份 agent 状态不可读。 */
export function parseSubagentSelectionFallbackMode(
  value: unknown,
): SubagentSelectionFallbackMode {
  return isSubagentSelectionFallbackMode(value)
    ? value
    : DEFAULT_SUBAGENT_SELECTION_FALLBACK_MODE;
}


/** 正式 reader 只接受结构化覆盖，不在读取时解释旧双 map 或重新匹配 Provider。 */
export function parsePluginSubagentModelSelectionOverrides(
  value: unknown,
): PluginSubagentModelSelectionOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([id, candidate]) => {
      const selection = modelSelectionSchema.safeParse(candidate);
      return id.startsWith("plugin:") && selection.success ? [[id, selection.data]] : [];
    }),
  );
}

export type AgentPermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan";

export type AgentColor =
  | "red"
  | "blue"
  | "green"
  | "yellow"
  | "purple"
  | "orange"
  | "pink"
  | "cyan";

export type SubagentsListMode = "allRuntimeScopes" | "settingsUserOnly";

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  defaultModelSelection?: ModelSelection;
  modelSelectionOverride?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
  path: string;
  scope: AgentScope;
  source: AgentSource;
  enabled: boolean;
  readOnly?: boolean;
  projectPath?: string;
  pluginId?: string;
  pluginName?: string;
  diagnostics?: AgentDiagnostic[];
}

export interface AgentDiagnostic {
  code: string;
  message: string;
  path?: string;
}

export interface AgentsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export interface AgentsListResult {
  agents: AgentSummary[];
  userAgents: AgentSummary[];
  pluginAgents: AgentSummary[];
  capability: AgentsCapability;
  diagnostics?: AgentDiagnostic[];
}

/** Agent 配置，用于创建/更新 agent */
export interface SubAgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  color?: AgentColor;
  modelSelection?: ModelSelection;
  tools?: string[];
  disallowedTools?: string[];
  injectAgentsMd?: boolean;
  skills?: string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  background?: boolean;
  mcpServers?: unknown[];
}

/** Agent 创建参数 */
export interface AgentCreateParams {
  config: SubAgentConfig;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 更新参数 */
export interface AgentUpdateParams {
  agentId: string;
  config: SubAgentConfig;
  oldFilePath?: string;
  provider: ZCodeProvider;
  scope?: "user" | "workspace";
  workspacePath?: string;
  workspaceIdentity?: string;
}

/** Agent 删除参数 */
export interface AgentDeleteParams {
  agentId: string;
  filePath: string;
}

export interface BuiltInSubagentModelOverrideParams {
  agentName: BuiltInSubagentName;
  modelSelection?: ModelSelection;
}

export interface PluginSubagentModelOverrideParams {
  agentId: string;
  modelSelection?: ModelSelection;
}

/**
 * 插件 subagent 的稳定 id：`plugin:<pluginId>:<裸名小写>`。
 * pluginId 为 `<name>@<marketplace>`，不含版本，插件升级后 id 不变，覆盖随之保留。
 * services 与 CLI bootstrap 都用它做 agents-state.json 的键，必须共用一处实现。
 */
export function createPluginAgentStateId(pluginId: string, agentName: string): string {
  return `plugin:${pluginId}:${agentName.trim().toLowerCase()}`;
}

export function createAgentStateId(input: {
  name: string;
  scope: AgentScope;
  source: AgentSource;
}): string {
  return `${input.source}:${input.scope}:${input.name.trim().toLowerCase()}`;
}
