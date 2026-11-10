/**
 * 作者工具的宿主面（`CreateWorkflow` / `AmendWorkflow` / `SaveWorkflow` / `ListSavedWorkflows` /
 * `EvalWorkflowSnippet` / `ResumeWorkflowRun` / `ListWorkflowRuns` / `ListModels`）。
 *
 * 为什么这层住在 sidecar 而不是 Rust：校验器（TypeScript 程序、saved-workflow frontmatter、
 * 实参声明）、确认前的归一化、诊断形状与 model 内容都是 `@nibi/core` 里的同一份实现。Rust
 * 侧只保留工具面（schema/描述/权限）与技能门的事实——两边各写一份归一化，症状会先出现在
 * 「确认窗展示的字节」与「实际跑的字节」之间，那是这个特性最难解释的一种坏掉方式。
 *
 * 线协议只有两条：`author/prepare`（validateInput + resolveInput，确认前）与
 * `author/execute`（handler + formatModelContent，确认后）。`prepare` 的回复带着确认门
 * （`gate`），Rust 的权限层据此决定是否询问；业务失败在 `prepare` 就返回，模型拿到的是一条
 * 工具结果，用户看不到一个注定作废的确认窗。
 */
import { randomUUID } from "node:crypto";

import { createNodeExecutionAdapter, createNodeFileSystemAdapter } from "@nibi/adapters";
import { createDynamicWorkflowSnippetService } from "@nibi/bootstrap";
import { builtInTools } from "@nibi/core";
import type {
  ModelCatalogEntry,
  ModelMessageContent,
  ModelSelection,
} from "@nibi/contracts";
import type { ToolExecutionContext, ToolEntry } from "@nibi/core";

/** `ToolHandlerFailure` 的形状（core 的桶没导出这个类型，按判别位收窄）。 */
interface ToolHandlerFailure {
  result: false;
  errorCode?: number;
  message: string;
}

/** `author/prepare` 的回复：解析后的入参 + 确认门，或一条业务失败。 */
export type AuthorPrepareReply =
  | { ok: true; input: unknown; gate: "ask" | "proceed" }
  | { ok: false; errorCode?: number; message: string };

/** `author/execute` 的回复：给模型的正文（成功）或一条业务失败。 */
export type AuthorExecuteReply =
  | { ok: true; content: ModelMessageContent; isError: boolean }
  | { ok: false; message: string };

/** run 的展示元数据（AmendWorkflow 的 `predecessor` 与确认窗读它）。 */
export interface AuthorRunSnapshot {
  id: string;
  /** 后台任务追踪器的通用词汇（stopped→cancelled、errored→failed）。 */
  status: string;
  /** journal 的真实终态词；非终态缺席。 */
  runStatus?: string;
  stopReason?: string;
  parentSessionId?: string;
  name?: string;
  maxConcurrency?: number;
  subagentModel?: string;
  modelBindings?: Record<string, string>;
  scriptPath?: string;
}

/** 一次 submit 的参数（runId 已由宿主铸好）。 */
export interface AuthorSubmitRequest {
  runId: string;
  parentSessionId: string;
  cwd: string;
  scriptText: string;
  name?: string;
  args?: Record<string, unknown>;
  maxConcurrency?: number;
  subagentModel?: string;
  modelBindings?: Record<string, string>;
  scriptPath?: string;
  toolCallId?: string;
}

/** 一次脚本修订（新 run id 已由宿主铸好）。 */
export interface AuthorScriptAmendRequest {
  runId: string;
  predecessorRunId: string;
  parentSessionId: string;
  cwd: string;
  scriptText: string;
  name?: string;
  maxConcurrency?: number;
  subagentModel?: string;
  modelBindings?: Record<string, string>;
  scriptPath?: string;
  toolCallId?: string;
}

export interface AuthorListRunsQuery {
  cwd: string;
  limit: number;
  statuses?: readonly string[];
}

export interface AuthorListRunsItem {
  runId: string;
  label: string;
  labelSource: "name" | "script";
  status: string;
  stopReason?: string;
  resumedFrom?: string;
  supersededBy?: string;
  ownedByThisSession: boolean;
  possiblyInterrupted?: boolean;
  createdAt: number;
  updatedAt: number;
  spentTokens: number;
}

export interface AuthorListRunsResult {
  runs: AuthorListRunsItem[];
  truncated?: boolean;
}

/** 引擎侧的宿主回调（run 的启动/修订/恢复与 journal 读面都在 `runDwfEngineCommand` 里）。 */
export interface AuthoringHostDeps {
  dbPath: string;
  /** 发起作者调用的会话（journal 的父会话与 ownedByThisSession 的判据）。 */
  parentSessionId: string;
  defaultConcurrency: number;
  submit(request: AuthorSubmitRequest): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  amendScript(
    request: AuthorScriptAmendRequest,
  ): Promise<{ ok: true; supersededRunId?: string } | { ok: false; reason: string; message: string }>;
  resume(
    runId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string; message: string }>;
  getSnapshot(runId: string): Promise<AuthorRunSnapshot | undefined>;
  getScript(runId: string): Promise<string | undefined>;
  listRuns(query: AuthorListRunsQuery): Promise<AuthorListRunsResult>;
  isLive(runId: string): boolean;
  logger?: {
    warn?(message: string, context?: Record<string, unknown>): void;
  };
}

/** 作者工具体系里由 sidecar 承载的六个工具名（另外两个由 Rust 原生实现）。 */
export const AUTHORING_TOOLS = [
  "CreateWorkflow",
  "AmendWorkflow",
  "SaveWorkflow",
  "ListSavedWorkflows",
  "EvalWorkflowSnippet",
  "ResumeWorkflowRun",
  "ListWorkflowRuns",
] as const;

const TOOL_NAME_SET = new Set<string>(AUTHORING_TOOLS);

function isToolHandlerFailure(value: unknown): value is ToolHandlerFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { result?: unknown }).result === false &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** 规范串：结构化选择 → `providerId/modelId[$level]`（Node `formatModelPickerValue` 同形）。 */
function pickerValue(selection: ModelSelection): string {
  const model = `${selection.providerId}/${selection.modelId}`;
  const level = selection.options?.reasoningLevel;
  return level === undefined || level.length === 0 ? model : `${model}$${level}`;
}

function formatBindings(
  bindings: Record<string, ModelSelection> | undefined,
): Record<string, string> | undefined {
  if (bindings === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [name, selection] of Object.entries(bindings)) {
    out[name] = pickerValue(selection);
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** `formatModelContent` 的回复 → 纯文本（这六个工具都回字符串；块数组按 JSON 交回，不丢信息）。 */
function modelContentText(content: ModelMessageContent): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

/** 由 `requestedSchema` 的字段名与类型构造问题集——与 Node `mcpElicitationQuestions` 同形。 */
export function createAuthoringHost(deps: AuthoringHostDeps): {
  prepare(params: {
    tool: string;
    input: unknown;
    cwd: string;
    session: string;
    toolCall: string;
    hasLoadedSkill: boolean;
    models: ModelCatalogEntry[];
  }): Promise<AuthorPrepareReply>;
  execute(params: {
    tool: string;
    input: unknown;
    cwd: string;
    session: string;
    toolCall: string;
    hasLoadedSkill: boolean;
    models: ModelCatalogEntry[];
  }): Promise<AuthorExecuteReply>;
} {
  const fileSystem = createNodeFileSystemAdapter();
  const execution = createNodeExecutionAdapter();
  let snippet:
    | ReturnType<typeof createDynamicWorkflowSnippetService>
    | undefined;

  function snippetPort() {
    snippet ??= createDynamicWorkflowSnippetService({
      fileSystemPort: fileSystem,
      executionPort: execution,
      ...(deps.logger === undefined ? {} : { logger: deps.logger as never }),
    });
    return snippet;
  }

  function runPort() {
    return {
      submit: async (request: {
        scriptText: string;
        cwd: string;
        name?: string;
        args?: Record<string, unknown>;
        parentSessionId?: string;
        toolCallId?: string;
        maxConcurrency?: number;
        subagentModel?: ModelSelection;
        modelBindings?: Record<string, ModelSelection>;
        scriptPath?: string;
      }) => {
        const runId = `dwfrun-${randomUUID()}`;
        const reply = await deps.submit({
          runId,
          parentSessionId: request.parentSessionId ?? deps.parentSessionId,
          cwd: request.cwd,
          scriptText: request.scriptText,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.args === undefined ? {} : { args: request.args }),
          ...(request.maxConcurrency === undefined
            ? {}
            : { maxConcurrency: request.maxConcurrency }),
          ...(request.subagentModel === undefined
            ? {}
            : { subagentModel: pickerValue(request.subagentModel) }),
          ...(request.modelBindings === undefined
            ? {}
            : { modelBindings: formatBindings(request.modelBindings) }),
          ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
          ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
        });
        if (!reply.ok) throw new Error(reply.message);
        return { ok: true as const, runId };
      },
      amend: async (request: {
        scriptText: string;
        cwd: string;
        predecessorRunId: string;
        name?: string;
        parentSessionId?: string;
        toolCallId?: string;
        maxConcurrency?: number;
        subagentModel?: ModelSelection;
        modelBindings?: Record<string, ModelSelection>;
        scriptPath?: string;
      }) => {
        const runId = `dwfrun-${randomUUID()}`;
        const reply = await deps.amendScript({
          runId,
          predecessorRunId: request.predecessorRunId,
          parentSessionId: request.parentSessionId ?? deps.parentSessionId,
          cwd: request.cwd,
          scriptText: request.scriptText,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.maxConcurrency === undefined
            ? {}
            : { maxConcurrency: request.maxConcurrency }),
          ...(request.subagentModel === undefined
            ? {}
            : { subagentModel: pickerValue(request.subagentModel) }),
          ...(request.modelBindings === undefined
            ? {}
            : { modelBindings: formatBindings(request.modelBindings) }),
          ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
          ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
        });
        if (!reply.ok) {
          return {
            ok: false as const,
            reason: reply.reason as never,
          };
        }
        return {
          ok: true as const,
          runId,
          ...(reply.supersededRunId === undefined
            ? {}
            : { supersededRunId: reply.supersededRunId }),
        };
      },
      resume: async (runId: string) => {
        const reply = await deps.resume(runId);
        if (!reply.ok) {
          return {
            ok: false as const,
            reason: reply.reason as never,
            message: reply.message,
          };
        }
        return { ok: true as const, runId };
      },
      listRuns: (query: AuthorListRunsQuery) => deps.listRuns(query),
      getTask: (runId: string) => deps.getSnapshot(runId),
      getScript: (runId: string) => deps.getScript(runId),
      defaultConcurrency: () => deps.defaultConcurrency,
      cancel: async (runId: string) => deps.isLive(runId),
      waitForTask: (runId: string) => deps.getSnapshot(runId),
      listEvents: () => {
        throw new Error("listEvents is not available in the authoring host");
      },
      resolveQuestion: undefined,
      fillHole: undefined,
    };
  }

  function contextFor(params: {
    tool: string;
    input: unknown;
    cwd: string;
    session: string;
    toolCall: string;
    hasLoadedSkill: boolean;
    models: ModelCatalogEntry[];
  }): ToolExecutionContext {
    const controller = new AbortController();
    return {
      toolSearch: undefined,
      toolCallId: params.toolCall,
      traceId: params.toolCall,
      abortSignal: controller.signal,
      workingDirectory: params.cwd,
      workspaceRoot: params.cwd,
      sessionId: params.session as never,
      dynamicWorkflowRunPort: runPort() as never,
      dynamicWorkflowSnippetPort: snippetPort(),
      modelCatalogPort: { listModels: () => params.models },
      hasLoadedSkill: (skill: string) => params.hasLoadedSkill && skill.length > 0,
      recordReadFileStateMetadata: undefined,
      recordSkillTelemetryMetadata: undefined,
      inputAdjustments: undefined,
    } as unknown as ToolExecutionContext;
  }

  function entryFor(tool: string): ToolEntry {
    if (!TOOL_NAME_SET.has(tool)) {
      throw new Error(`unknown authoring tool: ${tool}`);
    }
    const entry = builtInTools.find((candidate) => candidate.metadata.name === tool);
    if (entry === undefined) {
      throw new Error(`the installed @nibi/core does not export the ${tool} tool`);
    }
    return entry;
  }

  return {
    async prepare(params) {
      let entry: ToolEntry;
      try {
        entry = entryFor(params.tool);
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const context = contextFor(params);
      try {
        if (entry.validateInput !== undefined) {
          const validated = await entry.validateInput(params.input, context);
          if (isToolHandlerFailure(validated)) {
            return {
              ok: false,
              ...(validated.errorCode === undefined ? {} : { errorCode: validated.errorCode }),
              message: validated.message,
            };
          }
        }
        let resolved = params.input;
        if (entry.resolveInput !== undefined) {
          const resolution = await entry.resolveInput(params.input, context);
          if (isToolHandlerFailure(resolution)) {
            return {
              ok: false,
              ...(resolution.errorCode === undefined ? {} : { errorCode: resolution.errorCode }),
              message: resolution.message,
            };
          }
          resolved = resolution.input;
        }
        const gate = entry.prepareApproval?.(resolved).gate ?? "ask";
        return { ok: true, input: resolved, gate };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async execute(params) {
      let entry: ToolEntry;
      try {
        entry = entryFor(params.tool);
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      const context = contextFor(params);
      try {
        const output = await entry.handler(params.input, context);
        const schema = entry.runtimeOutputSchema as
          | { safeParse?: (value: unknown) => { success: boolean } }
          | undefined;
        const parsed = schema?.safeParse?.(output);
        if (parsed !== undefined && parsed.success === false) {
          return {
            ok: true,
            content: `${params.tool} returned an invalid result.`,
            isError: true,
          };
        }
        const content =
          entry.formatModelContent === undefined
            ? JSON.stringify(output)
            : modelContentText(entry.formatModelContent(output));
        return { ok: true, content, isError: false };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
