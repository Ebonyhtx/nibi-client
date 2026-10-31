/**
 * 隐藏子命令 `__nibi-dwf-engine`：动态工作流引擎的 sidecar 入口（NIBI Rust 内核的路线 C）。
 *
 * 形态：Rust 内核（`nibi-rs app-server`）用**客户端自带的 Node**（桌面是 Electron Helper +
 * `ELECTRON_RUN_AS_NODE=1`，开发是 node/tsx）启动本命令，通过 stdin/stdout 的 LF-JSON 驱动。
 * 引擎、沙箱子进程与 journal 都在这一侧；模型、工具、权限在 Rust 一侧——driver 的每个方法都是
 * 一条回宿主（Rust）的 RPC。
 *
 * 线协议（与 `scripts/kernel-baseline/probe-dwf-sidecar.mjs` 的实测一致）：
 *
 *   宿主 → engine：`{id, method:"submit", params:{runId, parentSessionId, cwd, dbPath,
 *                    scriptText? | savedName?+scope?, args?, caps?}}`
 *                   `{id, method:"resume", params:{runId, dbPath}}`
 *                   `{id, method:"amend", params:{predecessorRunId, runId, dbPath,
 *                    subagentModel?, maxConcurrency?, toolCallId?}}`
 *                   `{id, method:"cancel", params:{runId}}`
 *   engine → 宿主：`actor/create`（建 actor 子会话，回 `{session:<id>}`；`model` 在场时带上选型）
 *                   `world/read`（files.glob/read/grep，回结果）
 *                   `ask/start` / `ask/verdict` / `ask/cancel` / `run/event`（通知）
 *   宿主 → engine：`{method:"ask/reply", params:{runId, instance, kind:"submit"|"text"|"fail", payload/text}}`
 *
 * 不变式：读循环绝不 `await` 一个 run——run 期间的 RPC 响应也走这条 stdin，阻塞读循环会死锁。
 */
import { availableParallelism } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createDwfJournalStore } from "@nibi/adapters/storage";
import { resolveSavedWorkflow, validateWorkflowArgs } from "@nibi/core";
import {
  analyzeWorkflowScript,
  buildAskSpecs,
  collectDiagnostics,
  collectPhaseNames,
  collectSites,
  createWorkflowProgram,
  interpret,
  projectControlFlow,
  synthesizeAskSchemas,
  validate,
  type AskMessage,
  type AskSpec,
  type InstanceRef,
  type JournalStorePort,
  type JsonSchema,
  type PersonaSpec,
  type RunEvent,
  type RunSettlement,
  type SessionRef,
  type SubmitVerdict,
  type ValidateFn,
  type WorldReadOp,
} from "@nibi/dynamic-workflow";
import { runWorkflowScript } from "@nibi/dynamic-workflow-runtime";

import type { RunContext } from "@nibi/shared-types";

export const NIBI_DWF_ENGINE_COMMAND = "__nibi-dwf-engine";

export function isDwfEngineInvocation(argv: readonly string[]): boolean {
  return argv[0] === NIBI_DWF_ENGINE_COMMAND;
}

/** 节点校验器适配到引擎的 `ValidateFn` 契约。 */
const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

function askSpecsFor(scriptText: string): {
  askSpecs: Map<string, AskSpec>;
  holes: { siteId: string; name: string; type: string; line: number; open: boolean }[];
  phases: string[];
  openHoleIndexes: number[];
} {
  // run 内通知要用的编译期事实与 askSpecs 一次编译同出（bootstrap 的 compileOnce 同一条链：
  // 站点表 → 留白事实表；控制流投影 → 阶段表）。留白事实表从站点表抄字段而不是持表本身——
  // 表挂着整棵 AST，活到 run 结算会拖住内存。
  const workflow = createWorkflowProgram(scriptText);
  const table = collectSites(workflow);
  const { schemas } = synthesizeAskSchemas(workflow, table);
  const core = interpret(workflow, table);
  const flowNames = collectPhaseNames(projectControlFlow(core));
  return {
    askSpecs: buildAskSpecs(table, schemas),
    holes: table.holes.map((site) => ({
      siteId: site.id,
      name: site.name ?? site.id,
      type: site.typeText ?? "unknown",
      line: site.loc.line,
      open: site.body === undefined,
    })),
    phases: flowNames.phaseNames,
    openHoleIndexes: flowNames.holes,
  };
}

const WORKFLOW_DRAFTS_DIR = ".nibi/workflow-drafts";
const SAVED_WORKFLOW_FILE_EXTENSION = ".dwf.ts";
const WORKFLOW_DRAFT_SLUG_DROP_PATTERN = /[^\p{L}\p{N}_.-]/gu;
const WORKFLOW_DRAFT_WHITESPACE_PATTERN = /\s+/gu;
const WORKFLOW_DRAFT_MAX_SLUG_CHARS = 64;
const WORKFLOW_DRAFT_FALLBACK_SLUG = "workflow";
const WORKFLOW_DRAFT_MAX_ATTEMPTS = 1_000;

/**
 * 名字 → 文件名主干（Node `workflowDraftSlug` 逐字）：空白连成 `-`，字母表（Unicode 字母 /
 * 数字 / `_ . -`）之外的一概丢掉，按码点截到上限；什么都不剩、或只剩点时用兜底词。
 */
function workflowDraftSlug(name: string): string {
  const reduced = Array.from(
    name
      .trim()
      .replace(WORKFLOW_DRAFT_WHITESPACE_PATTERN, "-")
      .replace(WORKFLOW_DRAFT_SLUG_DROP_PATTERN, ""),
  )
    .slice(0, WORKFLOW_DRAFT_MAX_SLUG_CHARS)
    .join("")
    .replace(/^[.-]+|[.-]+$/gu, "");
  if (reduced === "" || /^\.+$/u.test(reduced)) return WORKFLOW_DRAFT_FALLBACK_SLUG;
  return reduced;
}

/**
 * 工作副本：`<cwd>/.nibi/workflow-drafts/<slug>.dwf.ts`，逐字节（saved 来源连元数据块一起）。
 * 同名冲突按 `-2`、`-3`… 顺延，`wx` 独占创建（并发提交不落同一个文件）；目录自带一份
 * `.gitignore: *`（缺席时写一次）。尽力而为：写不进去返回 undefined，调用方退回无草稿文案。
 */
async function writeWorkflowDraft(input: {
  cwd: string;
  name: string;
  source: string;
}): Promise<{ path: string } | undefined> {
  try {
    const dir = path.join(input.cwd, WORKFLOW_DRAFTS_DIR);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(path.join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" });
    } catch {
      // 用户改过就不动它（EEXIST 同义）。
    }
    const slug = workflowDraftSlug(input.name);
    for (let attempt = 1; attempt <= WORKFLOW_DRAFT_MAX_ATTEMPTS; attempt += 1) {
      const fileName = `${attempt === 1 ? slug : `${slug}-${attempt}`}${SAVED_WORKFLOW_FILE_EXTENSION}`;
      const filePath = path.join(dir, fileName);
      try {
        await writeFile(filePath, input.source, { encoding: "utf8", flag: "wx" });
        return { path: filePath };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 引擎的默认并发 D（docs/dynamic-workflow/concurrency.md「Two bounds on a run」）：
 * `max(4, min(16, availableParallelism() − 2))`。宿主那边同一个数（Node 宿主在
 * bootstrap 的 workflow-default-concurrency 里算同一个公式），这里只用来折算 amend 的三态
 * （`null` = 回到默认并发）与设置轮元数据的 `ceiling`。以前这里曾是常量 4，与宿主的 CPU
 * 推导值在多核机上分叉，设置轮的 from/to 因此两边对不上——改回同一个公式。
 */
const DEFAULT_CONCURRENCY = Math.max(
  4,
  Math.min(16, availableParallelism() - 2),
);

/**
 * sidecar 的 sqlite 连接。db 文件与宿主（Rust 进程）共用：宿主在写会话消息、这里在写 dwf 表，
 * 写锁冲突时必须**等**（与存储层的 5s 启动锁同一档），不能当场 SQLITE_BUSY 抛出去把 run 留在
 * running。`node:sqlite` 的缺省 timeout 是 0（立即失败），所以每一处都经这个函数开库。
 */
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

function openDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, { timeout: SQLITE_BUSY_TIMEOUT_MS });
}

/** 规范 picker 串 `providerId/modelId[$level]` → Rust 内核的 selection 形状（$ 是推理档分隔符）。 */
function selectionFromCanonical(
  value: string | undefined,
): { provider: string; model: string; reasoning?: string } | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  const provider = trimmed.slice(0, slash);
  const rest = trimmed.slice(slash + 1);
  const dollar = rest.indexOf("$");
  if (dollar <= 0 || dollar >= rest.length - 1) return { provider, model: rest };
  return { provider, model: rest.slice(0, dollar), reasoning: rest.slice(dollar + 1) };
}

/** run 的子代理模型（`run-launched.subagentModel`）：amend 的三态与 actor 的选型都读这一条。 */
function runSubagentModel(journal: JournalStorePort, runId: string): string | undefined {
  const [first] = journal.listEvents(runId, {
    types: ["run-launched"],
    reportItems: "all",
    limit: 1,
  });
  const event = first?.event;
  return event?.type === "run-launched" ? event.subagentModel : undefined;
}

/** run 的脚本点名绑定表（`run-launched.modelBindings`）：amend 沿用前驱的同名绑定按它。 */
function runModelBindings(journal: JournalStorePort, runId: string): Record<string, string> | undefined {
  const [first] = journal.listEvents(runId, {
    types: ["run-launched"],
    reportItems: "all",
    limit: 1,
  });
  const event = first?.event;
  if (event?.type !== "run-launched" || event.modelBindings === undefined) return undefined;
  const bindings: Record<string, string> = {};
  for (const [name, canonical] of Object.entries(event.modelBindings)) {
    if (typeof canonical === "string") bindings[name] = canonical;
  }
  return Object.keys(bindings).length === 0 ? undefined : bindings;
}

/**
 * 脚本点名的模型名字（launch.md「Models the script names」）：去重、按第一次出现的顺序。编译器
 * 保证这是封闭集合（9010）；解析成规范串是宿主那一半（`models/resolve` RPC 对着本机目录）。
 * 编不过的脚本没有可说的名字——调用方在编译体检里就已经拒绝了。
 */
function scriptModelNames(scriptText: string): string[] {
  let analysis;
  try {
    analysis = analyzeWorkflowScript(scriptText);
  } catch {
    return [];
  }
  if (!analysis.ok) return [];
  return [...new Set(analysis.modelReferences.map((reference) => reference.name))];
}

/**
 * 向宿主解析脚本点名的名字（沿用的名字解的是前驱记下的规范串，不是名字本身——用户在前驱确认窗
 * 里换过的模型因此留得住）。解不出来返回 `null`，`message` 是逐名字的人话（调用方原样进拒绝）。
 */
async function resolveScriptModels(
  request: (method: string, params: unknown) => Promise<unknown>,
  names: readonly string[],
  inherited: Record<string, string> | undefined,
): Promise<{ bindings: Record<string, string> } | { bindings: null; message: string }> {
  if (names.length === 0) return { bindings: {} };
  const answer = (await request("models/resolve", {
    names: [...names],
    ...(inherited === undefined ? {} : { inherited }),
  })) as { bindings?: Record<string, string>; unresolved?: { name: string; message: string }[] };
  const bindings: Record<string, string> = {};
  for (const [name, canonical] of Object.entries(answer.bindings ?? {})) {
    if (typeof canonical === "string") bindings[name] = canonical;
  }
  const unresolved = answer.unresolved ?? [];
  if (unresolved.length === 0) return { bindings };
  return { bindings: null, message: unresolved.map((entry) => entry.message).join("\n") };
}

/** 三态归一（与宿主 runtime 同一张表；**端口不从前驱继承**，缺席即默认）。 */
function nextSetting<T>(input: T | null | undefined, current: T | undefined): T | undefined {
  if (input === undefined) return current;
  if (input === null) return undefined;
  return input;
}

/** run 自己的名字（无名缺席）：设置轮的会话记录按这一条，绝不拿 run id 当标题。 */
function runDisplayName(name: string | null | undefined): string | undefined {
  const trimmed = name?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/** 「改了什么」的 from/to（缺一端即那一端是默认）：只有改动过的设置在场。 */
function fromTo<T>(from: T | undefined, to: T | undefined): { from?: T; to?: T } {
  return { ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

/**
 * amend 回复的设置轮材料：宿主据它往父会话写 controlOnly 记录（Node 宿主的
 * WorkflowSettingsAmendMeta 同形——两项设置只有改动过的在场，`ceiling` 装默认并发 D）。
 * 就地 retune 与铸后继两条路共用：分别只在各自改动过的项上带 from/to。
 */
function settingsTurnOf(
  name: string | null | undefined,
  modelChanged: boolean,
  currentModel: string | undefined,
  nextModel: string | undefined,
  boundChanged: boolean,
  currentBound: number | undefined,
  nextBound: number | undefined,
): {
  name?: string;
  settings: {
    subagentModel?: { from?: string; to?: string };
    maxConcurrency?: { from?: number; to?: number };
    ceiling: number;
  };
} {
  const display = runDisplayName(name);
  return {
    ...(display === undefined ? {} : { name: display }),
    settings: {
      ...(modelChanged ? { subagentModel: fromTo(currentModel, nextModel) } : {}),
      ...(boundChanged ? { maxConcurrency: fromTo(currentBound, nextBound) } : {}),
      ceiling: DEFAULT_CONCURRENCY,
    },
  };
}

/** 一次 run 在 sidecar 里的活状态（受理 / 恢复 / 修订三条路都造一个）。 */
interface EngineRun {
  driver: RemoteDriver;
  abort: AbortController;
  db: DatabaseSync;
  /** 结算 promise：amend 以 `{superseded}` 停下在飞前驱后**等前驱自己结算**。 */
  settlement: Promise<RunSettlement>;
  /** 此刻生效的并发上界（内存副本：retune 与「未改」判定读它）。 */
  maxConcurrency: number;
  /** 本 run 的子代理模型（规范串）；缺席 = 会话模型。 */
  subagentModel?: string;
  /** 引擎的控制面：retune 就地问（bind 发生在引擎构造的同一同步片里）。 */
  control?: { setMaxConcurrency(next: number): boolean };
}

/** 一次 run 的后台执行（受理/恢复/修订共用）：开 journal、建 driver、跑引擎、发 run/settled。 */
function launchRun(
  params: {
    runId: string;
    parentSessionId: string;
    cwd: string;
    dbPath: string;
    scriptText: string;
    args: Record<string, unknown>;
    caps: { maxConcurrency?: number };
    /** amend 路径的两项 run 元数据（verbatim 转交引擎，缺省保持缺席）。 */
    subagentModel?: string;
    resumedFrom?: string;
    inheritedTokens?: number;
    toolCallId?: string;
    /** run 的展示名（saved 名字）；落 dwf_run.name，设置轮的「已修订」记录按它题名。 */
    name?: string;
    /** saved 工作流的脚本文件（绝对路径）：留白通知的 draft 来源；内联脚本缺席。 */
    savedPath?: string;
    /** 脚本点名的模型绑定表（宿主目录解出来的规范串）：落 run-launched，actor 的选型按它。 */
    modelBindings?: Record<string, string>;
  },
  request: (method: string, params: unknown) => Promise<unknown>,
  notify: (method: string, params: unknown) => void,
  runs: Map<string, EngineRun>,
): Promise<RunSettlement> {
  const db = openDatabase(params.dbPath);
  const journal = createDwfJournalStore(db);
  // 本世代的起点（终态通知的 durationMs：completedAt - startedAt；Node 的
  // workflowNotificationDurationMs 同源——跨 resume 的累计 activeDurationMs 由 run 服务
  // 维护，sidecar 路径按本世代算）。
  const startedAtMs = Date.now();
  // 留白通知的编译期事实（留白表 + 阶段表）与 askSpecs 一次编译同出；run 展示名与脚本落点
  // 一起进 driver——hole-reached 的完整载荷从这里组（Node toProgressPayload 的同源派生）。
  const compiled = askSpecsFor(params.scriptText);
  const driver = new RemoteDriver(
    params.runId,
    journal,
    request,
    notify,
    params.subagentModel,
    params.modelBindings,
    { holes: compiled.holes, phases: compiled.phases },
  );
  const abort = new AbortController();
  const maxConcurrency = params.caps.maxConcurrency ?? DEFAULT_CONCURRENCY;
  // 条目先落表：引擎构造的同一同步片里就会 `control.bind`，那时必须能在表里找到它。
  const entry: EngineRun = {
    driver,
    abort,
    db,
    settlement: Promise.resolve({ status: "errored" } as RunSettlement),
    maxConcurrency,
    ...(params.subagentModel === undefined ? {} : { subagentModel: params.subagentModel }),
  };
  runs.set(params.runId, entry);
  // 锚点与选型同车；阶段表、开放留白下标与脚本落点恒在场（Node 的 run-launched 同三件：
  // resume 的冷读面与留白通知从事件头读回）。inputId 缺席锚点时落 runId——引擎只记录不读。
  const launch = {
    inputId: params.toolCallId ?? params.runId,
    ...(params.subagentModel === undefined ? {} : { subagentModel: params.subagentModel }),
    ...(params.modelBindings === undefined ? {} : { modelBindings: params.modelBindings }),
    ...(params.savedPath === undefined ? {} : { scriptPath: params.savedPath }),
    ...(compiled.phases.length === 0 ? {} : { phaseNames: compiled.phases }),
    ...(compiled.openHoleIndexes.length === 0 ? {} : { holes: compiled.openHoleIndexes }),
  };
  const settlement = runWorkflowScript({
    scriptText: params.scriptText,
    cwd: params.cwd,
    runId: params.runId,
    parentSessionId: params.parentSessionId,
    args: params.args,
    caps: { maxConcurrency },
    ...(params.name === undefined ? {} : { name: params.name }),
    askSpecs: compiled.askSpecs,
    validate: validateFn,
    ...(launch === undefined ? {} : { launch }),
    ...(params.resumedFrom === undefined ? {} : { resumedFrom: params.resumedFrom }),
    ...(params.inheritedTokens === undefined ? {} : { inheritedTokens: params.inheritedTokens }),
    control: {
      bind: (engine) => {
        const bound = runs.get(params.runId);
        if (bound !== undefined) bound.control = engine;
      },
    },
    makeDriver: (sink) => {
      driver.attach(sink as unknown as WorkflowSink);
      return driver as unknown as import("@nibi/dynamic-workflow").WorkflowDriver;
    },
    signal: abort.signal,
    // run 没有时长上限；墙钟只防沙箱卡死（24h）。
    timeoutMs: 24 * 60 * 60 * 1000,
  })
    .catch((error) => ({
      status: "errored" as const,
      error: { message: error instanceof Error ? error.message : String(error) },
    }))
    .then((settled) =>
      // 结算通知的事实随结算一起交回（宿主据它组 `<task-notification>` 的终态通知）。journal 是
      // 唯一数据源，此刻还开着——db 在 finally 里才关。submit/resume/amend 三条入口同构。
      {
        return {
          settlement: settled,
          notice: settleNoticeFacts(journal, params.runId, Date.now() - startedAtMs),
        };
      },
    )
    .finally(() => {
      runs.delete(params.runId);
      db.close();
    });
  entry.settlement = settlement as Promise<RunSettlement>;
  return settlement as Promise<RunSettlement>;
}

/**
 * run 结算随附的终态通知事实（`run/settled.notice`）：宿主据它组 Node
 * `formatLocalWorkflowTaskNotification` 同形的 `<task-notification>`，投给父会话。全部从
 * journal 读——名字与 toolCallId 在 run 行上，脚本落点在 `run-launched`，渐进产物与用户面
 * 产物、用量在事件流里。
 */
function settleNoticeFacts(
  journal: ReturnType<typeof createDwfJournalStore>,
  runId: string,
  durationMs: number,
): {
  name?: string;
  toolCallId?: string;
  scriptPath?: string;
  reports: unknown[];
  reportCount: number;
  artifacts: unknown[];
  spentTokens?: number;
  durationMs?: number;
} {
  const record = journal.getRun(runId);
  const launched = journal
    .listEvents(runId, { types: ["run-launched"], reportItems: { limit: 0 } })
    .at(-1)?.event as { scriptPath?: unknown } | undefined;
  const scriptPath =
    typeof launched?.scriptPath === "string" && launched.scriptPath.length > 0
      ? launched.scriptPath
      : undefined;
  // 快照同款上限（DYNAMIC_WORKFLOW_SNAPSHOT_MAX_REPORTS）：预览预算（8k 字符）远先于此截断。
  const reportEvents = journal.listEvents(runId, {
    types: ["report"],
    reportItems: { limit: 256 },
  });
  const reportTotal = journal.listEvents(runId, {
    types: ["report"],
    reportItems: { limit: 0 },
  }).length;
  const artifacts = journal
    .listEvents(runId, { types: ["artifact-published"], reportItems: { limit: 0 } })
    .map((stored) => (stored.event as { artifact?: unknown }).artifact)
    .filter((artifact) => artifact !== undefined && artifact !== null);
  const name = record?.name ?? undefined;
  return {
    ...(name === undefined ? {} : { name }),
    ...(record?.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    reports: reportEvents
      .map((stored) => (stored.event as { item?: unknown }).item)
      .filter((item) => item !== undefined),
    reportCount: Math.max(reportTotal, reportEvents.length),
    artifacts,
    ...(record?.spentTokens === undefined ? {} : { spentTokens: record.spentTokens }),
    durationMs: Math.max(0, durationMs),
  };
}

interface SubmitParams {
  runId: string;
  parentSessionId: string;
  cwd: string;
  dbPath: string;
  scriptText?: string;
  savedName?: string;
  scope?: "project" | "global";
  args?: Record<string, unknown>;
  caps?: { maxConcurrency?: number };
  homeDir?: string;
}

type Outgoing = (message: unknown) => void;

/**
 * 一次 submit 的失败形态（宿主把它映射成 `fault.command.savedWorkflowStartRejected.<reason>`）。
 * 成功时回 `{ok:true, settlement}`。
 */
type SubmitReply =
  | {
      ok: true;
      accepted: true;
      /** 启动轮材料（saved 路径才在场，docs/dynamic-workflow/launch.md「The launch turn」）。 */
      name?: string;
      scope?: string;
      path?: string;
      description?: string;
      script?: string;
      args?: Record<string, unknown>;
    }
  | { ok: false; reason: string; message: string };

/** driver：引擎的手，每一下都伸回宿主。 */
class RemoteDriver {
  readonly journal: JournalStorePort;
  sink: WorkflowSink | undefined;
  private readonly runId: string;
  private readonly request: (method: string, params: unknown) => Promise<unknown>;
  private readonly notify: (method: string, params: unknown) => void;
  /** 本 run 的子代理模型（规范串，来自 `run-launched.subagentModel` / 本次修订的入参）。 */
  private readonly subagentModel: string | undefined;
  /** 脚本点名的绑定表（规范串）：persona 点名的模型按它查（launch.md「Models the script names」）。 */
  private readonly modelBindings: Record<string, string> | undefined;
  /** 留白通知的编译期事实与 run 展示元数据（hole-reached 的完整载荷从这里组）。 */
  private readonly facts: RunFacts;

  constructor(
    runId: string,
    journal: JournalStorePort,
    request: (method: string, params: unknown) => Promise<unknown>,
    notify: (method: string, params: unknown) => void,
    subagentModel?: string,
    modelBindings?: Record<string, string>,
    facts?: RunFacts,
  ) {
    this.runId = runId;
    this.journal = journal;
    this.request = request;
    this.notify = notify;
    this.subagentModel = subagentModel;
    this.modelBindings = modelBindings;
    this.facts = facts ?? { holes: [], phases: [] };
  }

  attach(sink: WorkflowSink): void {
    this.sink = sink;
  }

  async createActorSession(
    actor: { siteId: string; ordinal: number },
    persona: PersonaSpec,
  ): Promise<SessionRef> {
    // 选型优先级（Node workflow-actor-model 的同一张表）：persona 点名的绑定 > 本 run 的
    // 子代理模型 > 缺席（内核默认）。点名的名字不在表里是接线故障（编译器 9010 保证封闭集合、
    // launch 时整张表解析过）——宁可大声失败，悄悄退回 run 的模型就是跑一个没人批过的选型。
    let canonical = this.subagentModel;
    if (persona.model !== undefined) {
      const bound = this.modelBindings?.[persona.model];
      if (bound === undefined) {
        const boundNames = Object.keys(this.modelBindings ?? {});
        throw new Error(
          `This subagent's persona names the model "${persona.model}", which the run did not resolve at launch` +
            (boundNames.length === 0
              ? " (the script named no models)."
              : ` (it resolved: ${boundNames.map((name) => `"${name}"`).join(", ")}).`),
        );
      }
      canonical = bound;
    }
    const model = selectionFromCanonical(canonical);
    const reply = (await this.request("actor/create", {
      runId: this.runId,
      actor,
      persona,
      ...(model === undefined ? {} : { model }),
    })) as { session: string };
    return { id: reply.session };
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    this.notify("ask/start", {
      runId: this.runId,
      key: `${instance.siteId}@${instance.ordinal}`,
      session,
      instance,
      typed: message.typed,
      // 宿主（Rust）要用它跑 actor 轮：指令正文与 typed 时的 schema。
      instructions: message.instructions,
      ...(message.schema === undefined ? {} : { schema: message.schema }),
    });
  }

  respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void {
    this.notify("ask/verdict", {
      runId: this.runId,
      key: `${instance.siteId}@${instance.ordinal}`,
      verdict,
    });
  }

  cancelAsk(instance: InstanceRef): void {
    this.notify("ask/cancel", {
      runId: this.runId,
      key: `${instance.siteId}@${instance.ordinal}`,
    });
  }

  async executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    return this.request("world/read", { runId: this.runId, op, args });
  }

  emit(event: RunEvent): void {
    if (event.type === "hole-reached") {
      // 留白到达的完整载荷（Node toProgressPayload + notifyHoleReached 的快照合并同构）：
      // 事件原文（instance/name/prompt）+ 编译期事实（type/line/before/after）+ 到达时刻
      //（journal 同步片里的墙钟）+ run 展示元数据。宿主据它组 `<workflow-hole>` 通知。
      const hole = this.facts.holes.find((candidate) => candidate.siteId === event.instance.siteId);
      const index = hole === undefined ? -1 : this.facts.phases.indexOf(event.name);
      const before = index > 0 ? this.facts.phases[index - 1] : undefined;
      const after =
        index >= 0 && index + 1 < this.facts.phases.length
          ? this.facts.phases[index + 1]
          : undefined;
      // 展示名与脚本落点从 journal 读（三条入口同构）：名字在 run 行上；脚本落点在
      // run-launched 的事件头（本世或建 run 那一世写的都在）。
      const record = this.journal.getRun(this.runId);
      const launched = this.journal
        .listEvents(this.runId, { types: ["run-launched"], reportItems: { limit: 0 } })
        .at(-1)?.event as { scriptPath?: unknown } | undefined;
      const scriptPath =
        typeof launched?.scriptPath === "string" && launched.scriptPath.length > 0
          ? launched.scriptPath
          : undefined;
      this.notify("run/event", {
        runId: this.runId,
        type: event.type,
        ...(record?.name === undefined ? {} : { name: record.name }),
        ...(scriptPath === undefined ? {} : { scriptPath }),
        hole: {
          instance: event.instance,
          name: event.name,
          ...(event.prompt === undefined ? {} : { prompt: event.prompt }),
          ...(hole === undefined ? {} : { type: hole.type }),
          ...(hole === undefined ? {} : { line: hole.line }),
          ...(before === undefined ? {} : { before }),
          ...(after === undefined ? {} : { after }),
          reachedAt: Date.now(),
        },
      });
      return;
    }
    this.notify("run/event", { runId: this.runId, type: event.type });
  }
}

/** driver 随身带的 run 事实（留白通知的载荷来源；askSpecs 同一次编译产出）。 */
interface RunFacts {
  holes: { siteId: string; name: string; type: string; line: number; open: boolean }[];
  phases: string[];
}

/** 引擎交给 driver 的回报面（`WorkflowReportSink` 中这一层用到的三个）。 */
interface WorkflowSink {
  askSubmitAttempted(instance: InstanceRef, payload: unknown): void;
  askTurnEnded(instance: InstanceRef, finalText: string): void;
  askFailed(instance: InstanceRef, error: unknown): void;
}

/**
 * 跑引擎直到 stdin 关闭。返回值只是退出码（协议错误在 stdout 上回给宿主）。
 */
export async function runDwfEngineCommand(ctx: RunContext): Promise<number> {
  const out: Outgoing = (message) => ctx.stdout.write(`${JSON.stringify(message)}\n`);
  let nextRequest = 1;
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const runs = new Map<string, EngineRun>();

  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolveRequest, rejectRequest) => {
      const id = `e${nextRequest++}`;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      out({ id, method, params });
    });
  const notify = (method: string, params: unknown) => out({ method, params });

  /**
   * 一次 submit 的**受理**：解析脚本文本（saved 名字或内联）→ 编译体检 → 回 accepted。
   * run 本身在后台跑（命令的 ACK 只等受理；结算走 `run/settled` 通知）。
   */
  async function acceptSubmit(params: SubmitParams): Promise<SubmitReply> {
    let scriptText = params.scriptText;
    let args = params.args;
    // 启动轮材料（saved 路径才收集；docs/dynamic-workflow/launch.md「The launch turn」）。
    let launch: {
      name: string;
      scope: string;
      path: string;
      description?: string;
      script: string;
      args?: Record<string, unknown>;
    } | undefined;
    // 工作副本的路径（saved 路径才有）；内联脚本没有——run 的 scriptPath 缺席，通知退回
    // GetWorkflowRun 的老话。
    let draftPath: string | undefined;
    if (params.savedName !== undefined) {
      // JSON 里缺席是 undefined、显式缺省是 null；scope 的 null 与 undefined 同义。
      const scope = params.scope ?? undefined;
      const resolved = resolveSavedWorkflow({
        cwd: params.cwd,
        name: params.savedName,
        ...(scope === undefined ? {} : { scope }),
        ...(params.homeDir === undefined ? {} : { homeDir: params.homeDir }),
      });
      if (!resolved.ok) {
        const reason =
          resolved.reason === "invalid_name"
            ? "invalid_name"
            : resolved.reason === "not_found"
              ? "not_found"
              : "start_failed";
        return {
          ok: false,
          reason,
          message:
            "detail" in resolved && resolved.detail
              ? String(resolved.detail)
              : `workflow ${params.savedName} is not available under ${params.cwd}`,
        };
      }
      const validated = validateWorkflowArgs(resolved.meta.args, args);
      if (!validated.ok) {
        return { ok: false, reason: "invalid_args", message: validated.errors.join("; ") };
      }
      scriptText = resolved.script;
      args = validated.args;
      // 工作副本（Node `writeWorkflowDraft` 同一条规矩）：中枢直接启动把 saved 定义逐字节
      // 拷进 `.nibi/workflow-drafts/`——它是 run 的可编辑脚本文件（留白通知的 draft、补全
      // 落盘的家）。写不成就没有 scriptPath——run 照常起，通知退回 GetWorkflowRun 的老话。
      const draft = await writeWorkflowDraft({
        cwd: params.cwd,
        name: resolved.name,
        source: resolved.script,
      });
      draftPath = draft?.path;
      launch = {
        name: resolved.name,
        scope: resolved.scope,
        // 启动轮 meta 的 path 是 saved 定义的落点（launch.md）；run 的可编辑脚本文件
        // （workflow-drafts 工作副本）另走 launchRun 的 savedPath，两者不同物。
        path: resolved.path,
        ...(resolved.meta.description === undefined
          ? {}
          : { description: resolved.meta.description }),
        script: resolved.script,
        ...(Object.keys(validated.args).length === 0 ? {} : { args: validated.args }),
      };
    }
    if (scriptText === undefined) {
      return {
        ok: false,
        reason: "invalid_name",
        message: "submit needs scriptText or savedName",
      };
    }

    // 编译体检：坏脚本在受理阶段就回 compile_failed（有界诊断），不建 run。
    try {
      const program = createWorkflowProgram(scriptText);
      const diagnostics = collectDiagnostics(program.program);
      if (diagnostics.length > 0) {
        return {
          ok: false,
          reason: "compile_failed",
          message: diagnostics
            .map((diagnostic) => diagnostic.message)
            .join("; ")
            .slice(0, 2_000),
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: "compile_failed",
        message: error instanceof Error ? error.message.slice(0, 2_000) : String(error),
      };
    }

    // 脚本点名的模型（launch.md「Models the script names」）：宿主的目录解出来才起 run——
    // 解不出来的名字按 Node 的启动路径同一个理由码（compile_failed），什么都不跑。
    const names = scriptModelNames(scriptText);
    let modelBindings: Record<string, string> | undefined;
    if (names.length > 0) {
      const resolved = await resolveScriptModels(request, names, undefined);
      if (resolved.bindings === null) {
        return { ok: false, reason: "compile_failed", message: resolved.message.slice(0, 2_000) };
      }
      if (Object.keys(resolved.bindings).length > 0) modelBindings = resolved.bindings;
    }

    // 受理之后在后台跑；结算以 `run/settled` 通知宿主。
    void launchRun(
      {
        runId: params.runId,
        parentSessionId: params.parentSessionId,
        cwd: params.cwd,
        dbPath: params.dbPath,
        scriptText,
        args: args ?? {},
        caps: params.caps ?? { maxConcurrency: DEFAULT_CONCURRENCY },
        // run 的展示名 = saved 名字（Node 的启动路径同一条读法）；设置轮与侧板题名按它。
        ...(params.savedName === undefined ? {} : { name: params.savedName }),
        savedPath: draftPath,
        ...(modelBindings === undefined ? {} : { modelBindings }),
      },
      request,
      notify,
      runs,
    ).then(({ settlement, notice }) =>
        notify("run/settled", { runId: params.runId, settlement, notice }),
      );
    // 启动轮材料（中枢直接启动，launch.md「The launch turn」）：宿主据它往父会话写 controlOnly
    // 的启动轮。saved 路径才有名字/作用域/落点；内联脚本（工具路径专用）没有这些。
    return { ok: true, accepted: true, ...(launch === undefined ? {} : launch) };
  }

  /** 一次 resume 的受理：只认可恢复集（`stopped` 且非 `superseded`），从 journal 取脚本与实参。 */
  async function acceptResume(params: { runId: string; dbPath: string }): Promise<
    | { ok: true; accepted: true; parentSessionId: string; cwd: string }
    | { ok: false; reason: string; message: string }
  > {
    const db = openDatabase(params.dbPath);
    try {
      const journal = createDwfJournalStore(db);
      const record = journal.getRun(params.runId);
      if (record === undefined) {
        return { ok: false, reason: "not_found", message: `run ${params.runId} does not exist` };
      }
      if (runs.has(params.runId)) {
        return { ok: false, reason: "already_running", message: `run ${params.runId} is live` };
      }
      if (record.status === "stopped" && record.stopReason === "superseded") {
        return {
          ok: false,
          reason: "superseded",
          message: `run ${params.runId} was superseded`,
        };
      }
      if (!(record.status === "stopped" && record.stopReason !== "superseded")) {
        return {
          ok: false,
          reason: "not_resumable",
          message: `run ${params.runId} is ${record.status} and cannot be resumed`,
        };
      }
      if (record.scriptText === undefined) {
        return {
          ok: false,
          reason: "script_missing",
          message: `run ${params.runId} has no stored script`,
        };
      }
      const program = createWorkflowProgram(record.scriptText);
      const diagnostics = collectDiagnostics(program.program);
      if (diagnostics.length > 0) {
        return {
          ok: false,
          reason: "compile_failed",
          message: diagnostics
            .map((diagnostic) => diagnostic.message)
            .join("; ")
            .slice(0, 2_000),
        };
      }
      const parentSessionId = record.parentSessionId ?? "";
      const cwd = record.cwd ?? process.cwd();
      // 与 submit 同一条后台执行；引擎构造时看见既有 run 行走 resume 分支。
      void launchRun(
        {
          runId: params.runId,
          parentSessionId,
          cwd,
          dbPath: params.dbPath,
          scriptText: record.scriptText,
          args: record.args ?? {},
          caps: record.caps ?? { maxConcurrency: 4 },
        },
        request,
        notify,
        runs,
      ).then(({ settlement, notice }) =>
        notify("run/settled", { runId: params.runId, settlement, notice }),
      );
      return { ok: true, accepted: true, parentSessionId, cwd };
    } finally {
      db.close();
    }
  }

  interface AmendParams {
    /** 被修订的前驱（`workId`）。 */
    predecessorRunId: string;
    /** 宿主铸出的**新** runId；只改并发且前驱在飞时就地生效，这个 id 不会被用到。 */
    runId: string;
    dbPath: string;
    /** 三态：缺席 = 沿用，`null` = 回到会话模型，值 = 设定（规范串）。 */
    subagentModel?: string | null;
    /** 三态：缺席 = 沿用，`null` = 回到默认并发，值 = 设定。 */
    maxConcurrency?: number | null;
    toolCallId?: string;
  }

  /**
   * 一次修订的受理（`amendWorkflowRunSettings`）。顺序就是语义：
   *
   *   1. 预检前驱（存在、可配置、有存档脚本、脚本编得过）——被拒时**什么都没动**，前驱照旧在跑；
   *   2. 两项设置的三态归一，「未改」当场拒绝（一次修订会停下在飞的 run，没理由为零改动付代价）；
   *   3. 只改并发、run 又在飞 → **就地生效**（同一个 runId、不停、不铸后继）；
   *   4. 否则铸后继：在飞前驱以 `{ superseded }` 停下并**等它自己结算**，再带脚本 / 实参 / 用量起点
   *      在前驱的行上启动新 run（`resumedFrom` 是 lineage 指针）。
   */
  async function acceptAmend(params: AmendParams): Promise<
    | {
        ok: true;
        accepted: true;
        runId: string;
        parentSessionId: string;
        cwd: string;
        supersededRunId?: string;
        /** 设置轮材料：run 自己的名字（无名缺席）与「改了什么」（宿主据此写会话记录）。 */
        name?: string;
        settings?: {
          subagentModel?: { from?: string; to?: string };
          maxConcurrency?: { from?: number; to?: number };
          ceiling: number;
        };
      }
    | { ok: false; reason: string; message: string }
  > {
    const db = openDatabase(params.dbPath);
    try {
      const journal = createDwfJournalStore(db);
      const record = journal.getRun(params.predecessorRunId);
      if (record === undefined) {
        return {
          ok: false,
          reason: "not_found",
          message: `run ${params.predecessorRunId} does not exist`,
        };
      }
      // 已完成的 run 每个 ask 都从缓存重放，新设置无处生效；被替代的 run 活的是它的后继。
      if (record.status === "completed" || record.supersededBy !== undefined) {
        return {
          ok: false,
          reason: "not_configurable",
          message: `run ${params.predecessorRunId} is ${record.status}`,
        };
      }
      if (record.scriptText === undefined || record.scriptText.length === 0) {
        return {
          ok: false,
          reason: "script_missing",
          message: `run ${params.predecessorRunId} has no stored script`,
        };
      }
      // 编译体检在**停下任何东西之前**（与宿主 runtime 的顺序一致：坏脚本不让前驱陪葬）。
      try {
        const program = createWorkflowProgram(record.scriptText);
        const diagnostics = collectDiagnostics(program.program);
        if (diagnostics.length > 0) {
          return {
            ok: false,
            reason: "compile_failed",
            message: diagnostics
              .map((diagnostic) => diagnostic.message)
              .join("; ")
              .slice(0, 2_000),
          };
        }
      } catch (error) {
        return {
          ok: false,
          reason: "compile_failed",
          message: error instanceof Error ? error.message.slice(0, 2_000) : String(error),
        };
      }

      // 脚本点名的模型：重跑的是这个 run 自己的脚本，每个名字在 launch 时都绑定过，照旧沿用那张表
      // 并对着目录再解析一遍（沿用的名字解的是前驱记下的规范串）。解不出来停在这里——与「弹层选的
      // 模型解不出来」同一个原因码（model_unavailable），旧 run 不动。
      const names = scriptModelNames(record.scriptText);
      let modelBindings: Record<string, string> | undefined;
      if (names.length > 0) {
        const inherited = runModelBindings(journal, params.predecessorRunId);
        const resolved = await resolveScriptModels(request, names, inherited);
        if (resolved.bindings === null) {
          return {
            ok: false,
            reason: "model_unavailable",
            message:
              `The models named in the script of run ${params.predecessorRunId} cannot be used now: ${resolved.message}`.slice(
                0,
                2_000,
              ),
          };
        }
        if (Object.keys(resolved.bindings).length > 0) modelBindings = resolved.bindings;
      }

      const live = runs.get(params.predecessorRunId);
      const currentModel = live?.subagentModel ?? runSubagentModel(journal, record.runId);
      // 等于默认并发的界就是「没有自己的界」：快照只在 ≠ 默认时带 maxConcurrency，同一个读法。
      const storedBound =
        live?.maxConcurrency ?? record.caps.maxConcurrency ?? DEFAULT_CONCURRENCY;
      const currentBound = storedBound === DEFAULT_CONCURRENCY ? undefined : storedBound;
      const nextModel = nextSetting(params.subagentModel, currentModel);
      const nextBound = nextSetting(params.maxConcurrency, currentBound);
      const modelChanged = nextModel !== currentModel;
      const boundChanged = nextBound !== currentBound;
      if (!modelChanged && !boundChanged) {
        return {
          ok: false,
          reason: "unchanged",
          message: `run ${params.predecessorRunId} already has those settings`,
        };
      }

      // 只改并发、run 又在飞：就地换引擎的 caps，同一个 runId、不停、不铸后继。
      if (boundChanged && !modelChanged && live?.control !== undefined) {
        const target = nextBound ?? DEFAULT_CONCURRENCY;
        if (live.control.setMaxConcurrency(target)) {
          live.maxConcurrency = target;
          return {
            ok: true,
            accepted: true,
            runId: params.predecessorRunId,
            parentSessionId: record.parentSessionId ?? "",
            cwd: record.cwd ?? process.cwd(),
            ...settingsTurnOf(record.name, modelChanged, currentModel, nextModel, boundChanged, currentBound, nextBound),
          };
        }
        // 引擎说没改（恰好结算）：顺着修订走，与宿主 not_live 的回落同一条。
      }

      // 前驱在飞：以 `{ superseded }` 停下并等它自己的结算 promise（不是超时、不是轮询 journal）。
      let supersededRunId: string | undefined;
      if (live !== undefined) {
        live.abort.abort({ superseded: params.runId });
        await live.settlement;
        supersededRunId = params.predecessorRunId;
      }
      // 结算之后再读一次行：用量起点要含前驱最后几轮的花费；实参按前驱自己的那份沿用。
      const settled = journal.getRun(params.predecessorRunId) ?? record;
      const parentSessionId = settled.parentSessionId ?? record.parentSessionId ?? "";
      const cwd = settled.cwd ?? record.cwd ?? process.cwd();
      void launchRun(
        {
          runId: params.runId,
          parentSessionId,
          cwd,
          dbPath: params.dbPath,
          scriptText: record.scriptText,
          args: settled.args ?? {},
          caps: { maxConcurrency: nextBound ?? DEFAULT_CONCURRENCY },
          ...(nextModel === undefined ? {} : { subagentModel: nextModel }),
          ...(modelBindings === undefined ? {} : { modelBindings }),
          resumedFrom: params.predecessorRunId,
          inheritedTokens: settled.spentTokens ?? 0,
          ...(params.toolCallId === undefined ? {} : { toolCallId: params.toolCallId }),
        },
        request,
        notify,
        runs,
      ).then(({ settlement, notice }) =>
        notify("run/settled", { runId: params.runId, settlement, notice }),
      );
      return {
        ok: true,
        accepted: true,
        runId: params.runId,
        parentSessionId,
        cwd,
        ...(supersededRunId === undefined ? {} : { supersededRunId }),
        ...settingsTurnOf(record.name, modelChanged, currentModel, nextModel, boundChanged, currentBound, nextBound),
      };
    } finally {
      db.close();
    }
  }

  const { createInterface } = await import("node:readline");
  const reader = createInterface({ input: ctx.stdin });
  for await (const line of reader) {
    if (!line.trim()) continue;
    let message: {
      id?: string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: string;
    };
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
      continue;
    }
    if (message.method === "ask/reply") {
      const params = message.params as {
        runId: string;
        instance: InstanceRef;
        kind: "submit" | "text" | "fail";
        payload?: unknown;
        text?: string;
      };
      const run = runs.get(params.runId);
      const sink = run?.driver.sink;
      if (!sink) continue;
      if (params.kind === "submit") sink.askSubmitAttempted(params.instance, params.payload);
      else if (params.kind === "text") sink.askTurnEnded(params.instance, params.text ?? "");
      else sink.askFailed(params.instance, params.payload);
      continue;
    }
    if (message.method === "resume") {
      const id = message.id;
      void acceptResume(message.params as { runId: string; dbPath: string }).then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "submit") {
      // 绝不在这里 await：run 期间的 RPC 响应也走这条 stdin。
      const id = message.id;
      void acceptSubmit(message.params as SubmitParams).then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "amend") {
      // 同一条纪律：acceptAmend 会 await 前驱的结算，绝不能挡住这条读循环。
      const id = message.id;
      void acceptAmend(message.params as AmendParams).then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "cancel") {
      const params = message.params as { runId: string };
      runs.get(params.runId)?.abort.abort();
      continue;
    }
  }
  return 0;
}
