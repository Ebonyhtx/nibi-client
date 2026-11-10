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
 *                   `{id, method:"holes", params:{runId, dbPath}}`（FillWorkflowHole 的确认前读面）
 *                   `{id, method:"fill", params:{runId, holeId, body, dbPath, parentSessionId?}}`
 *                   `{id, method:"workflows/list"|"workflows/get", params:{workspacePath, name?, scope?}}`
 *                   （GUI 中枢读面）`{id, method:"workflows/save"|"workflows/updateMeta"|
 *                   "workflows/delete"|"workflows/move"|"workflows/forRun", params:{workspacePath, …}}`
 *                   （写面与完成卡的推导判定；save / forRun 另带 runId + dbPath，journal 在这一侧）
 *                   `{id, method:"author/prepare"|"author/execute", params:{tool, input, cwd, session,
 *                    toolCall, hasLoadedSkill, models, dbPath, parentSessionId}}`
 *                   （作者工具的确认前/后两跳；跑 @nibi/core 的同一份 handler 与归一化）
 *   engine → 宿主：`actor/create`（建 actor 子会话，回 `{session:<id>}`；`model` 在场时带上选型）
 *                   `world/read`（files.glob/read/grep，回结果）
 *                   `ask/start` / `ask/verdict` / `ask/cancel` / `run/event`（通知）
 *   宿主 → engine：`{method:"ask/reply", params:{runId, instance, kind:"submit"|"text"|"fail", payload/text}}`
 *
 * 不变式：读循环绝不 `await` 一个 run——run 期间的 RPC 响应也走这条 stdin，阻塞读循环会死锁。
 */
import { createHash } from "node:crypto";
import { mkdir, open as openFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createDwfJournalStore } from "@nibi/adapters/storage";
import { SavedWorkflowMetaSchema, isValidSavedWorkflowName } from "@nibi/contracts";
import type { SavedWorkflowMeta } from "@nibi/contracts";
import {
  analyzeScript,
  findSavedWorkflowShadowing,
  listSavedWorkflows,
  moveSavedWorkflow,
  resolveSavedWorkflow,
  saveSavedWorkflow,
  savedWorkflowExists,
  savedWorkflowPath,
  savedWorkflowRoot,
  serializeSavedWorkflow,
  validateWorkflowArgs,
} from "@nibi/core";
import {
  ARTIFACT_CAPS,
  ARTIFACT_ID_PATTERN,
  analyzeWorkflowScript,
  buildAskSpecs,
  checkSiteStability,
  collectDiagnostics,
  collectPhaseNames,
  collectSitePhases,
  collectSites,
  createWorkflowProgram,
  interpret,
  lowerWorkflow,
  projectControlFlow,
  spliceHoleBody,
  synthesizeAskSchemas,
  validate,
  MODEL_UNRESOLVED_CODE,
  type AskMessage,
  type AskSpec,
  type CompileDiagnostic,
  type InstanceRef,
  type JournalStorePort,
  type JsonSchema,
  type ModelReference,
  type PersonaSpec,
  type RunEvent,
  type RunSettlement,
  type SessionRef,
  type SiteTable,
  type SubmitVerdict,
  type ValidateFn,
  type ActorSessionSeed,
  type ImportedRunCache,
  type WorkflowProgram,
  type WorldReadOp,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
  type WorkflowErrorCode,
  WorkflowError,
} from "@nibi/dynamic-workflow";
import { runWorkflowScript } from "@nibi/dynamic-workflow-runtime";

// 修订/恢复的导入缓存构建（Node 同一份纯函数——「两侧必须是同一张表」的正确性前提就是
// 字面上跑同一段代码；buildImportedCache 的门与降级语义见 bootstrap 的
// dynamic-workflow-import.ts 文件头）。转录存取面缺席：候选照收（源诚实性检查降级，
// driver 侧的种子兑现仍是 corruption 级的兜底）。
import {
  buildImportedCache,
  rebuildImportedCacheForResume,
} from "@nibi/bootstrap";

import type { RunContext } from "@nibi/shared-types";

import {
  createAuthoringHost,
  type AuthorListRunsResult,
  type AuthorRunSnapshot,
} from "./authoring.js";

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
  /** 结算 promise：amend 以 `{superseded}` 停下在飞前驱后**等前驱自己结算**（只等结束，不读值）。 */
  settlement: Promise<unknown>;
  /** 此刻生效的并发上界（内存副本：retune 与「未改」判定读它）。 */
  maxConcurrency: number;
  /** 本 run 的子代理模型（规范串）；缺席 = 会话模型。 */
  subagentModel?: string;
  /** 引擎的控制面：retune 就地问（bind 发生在引擎构造的同一同步片里）；留白放行与停驻表同面。 */
  control?: {
    setMaxConcurrency(next: number): boolean;
    fillHole(fill: {
      siteId: string;
      code: string;
      script: { text: string; hash: string };
      askSpecs: ReadonlyMap<string, AskSpec>;
      sitePhases: ReadonlyMap<string, string>;
      phaseNames: string[];
      holes?: number[];
      filledBy?: string;
      scriptPath?: string;
    }): { ok: true } | { ok: false; reason: "not_waiting" | "settled" };
    openHoles(): { siteId: string; ordinal: number; name: string; since: number }[];
  };
}

/** 一次 run 的后台执行（受理/恢复/修订共用）：开 journal、建 driver、跑引擎、发 run/settled。 */
function launchRun(
  params: {
    runId: string;
    parentSessionId: string;
    cwd: string;
    dbPath: string;
    scriptText: string;
    /** 实参**原样**转交 harness（落 args_json 与冻结 args 全局）；缺席保持缺席（行上 NULL）。 */
    args?: Record<string, unknown>;
    caps: { maxConcurrency?: number };
    /** amend 路径的两项 run 元数据（verbatim 转交引擎，缺省保持缺席）。 */
    subagentModel?: string;
    resumedFrom?: string;
    inheritedTokens?: number;
    /** 发起 run 的锚点（`launch-`/`settings-`/工具调用的 id）：落 dwf_run.tool_call_id。 */
    toolCallId?: string;
    /** run 的展示名（saved 名字）；落 dwf_run.name，设置轮的「已修订」记录按它题名。 */
    name?: string;
    /** saved 工作流的脚本文件（绝对路径）：留白通知的 draft 来源；内联脚本缺席。 */
    savedPath?: string;
    /** 脚本点名的模型绑定表（宿主目录解出来的规范串）：落 run-launched，actor 的选型按它。 */
    modelBindings?: Record<string, string>;
    /** 修订/恢复带来的导入缓存（前驱 journal 构建的加速结构；缺席即无缓存可用）。 */
    importedCache?: ImportedRunCache;
  },
  request: (method: string, params: unknown) => Promise<unknown>,
  notify: (method: string, params: unknown) => void,
  runs: Map<string, EngineRun>,
): Promise<{ settlement: RunSettlement; notice: SettleNotice }> {
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
    params.cwd,
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
    // 锚点落 dwf_run.tool_call_id（Node 的 run 行同一条写法）；launch.inputId 是事件头，两处同源。
    ...(params.toolCallId === undefined ? {} : { toolCallId: params.toolCallId }),
    askSpecs: compiled.askSpecs,
    validate: validateFn,
    ...(launch === undefined ? {} : { launch }),
    ...(params.resumedFrom === undefined ? {} : { resumedFrom: params.resumedFrom }),
    ...(params.inheritedTokens === undefined ? {} : { inheritedTokens: params.inheritedTokens }),
    ...(params.importedCache === undefined ? {} : { importedCache: params.importedCache }),
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
    .catch((error): RunSettlement => ({
      status: "errored",
      // 引擎抛出的裸错误折算成 errored 结算：DriverError 是引擎错误码表里「引擎自身失败」的那一档。
      error: new WorkflowError(
        "DriverError",
        error instanceof Error ? error.message : String(error),
      ),
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
  entry.settlement = settlement;
  return settlement;
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

type SettleNotice = ReturnType<typeof settleNoticeFacts>;

// ============================================================
// 留白补全（FillWorkflowHole 的服务面；docs/dynamic-workflow/launch.md「The `FillWorkflowHole`
// tool」）——bootstrap `dynamic-workflow-run-fill.ts` 的 fillOnce 逐字移植：拼接、与提交同款的
// 分析、站点稳定性复核、lowering 出函数体、引擎放行、草稿就地改写。拒绝即零副作用（留白照旧在等）。
// ============================================================

/** 「run 没有 draftPath 时铸草稿用的兜底名」与补全拒绝码表（fill-service 面共用）。 */
const FILL_DRAFT_FALLBACK_NAME = "workflow";

interface FillDiagnostic {
  line: number;
  column: number;
  message: string;
  code: number;
  inFill: boolean;
}

/**
 * 补全的有效脚本里点名了本 run 绑定表之外的模型 → 9011，每个名字一条，落在它第一次出现的位置
 * （bootstrap `unboundFillModelDiagnostics` 逐字）。
 */
function unboundFillModelDiagnostics(
  references: readonly ModelReference[],
  bindings: Readonly<Record<string, string>> | undefined,
): CompileDiagnostic[] {
  const bound = Object.entries(bindings ?? {});
  const available =
    bound.length === 0
      ? "this run was launched without naming any model"
      : `this run was launched with ${bound.map(([name, canonical]) => `"${name}" = ${canonical}`).join("; ")}`;
  const reported = new Set<string>();
  const diagnostics: CompileDiagnostic[] = [];
  for (const reference of references) {
    if (bindings?.[reference.name] !== undefined || reported.has(reference.name)) continue;
    reported.add(reference.name);
    diagnostics.push({
      code: MODEL_UNRESOLVED_CODE,
      line: reference.line,
      column: reference.column,
      message: `The model "${reference.name}" is not one the run can use: ${available}, and a fill can name only those. Use one of them, or drop \`model\` from the persona; to add a model, revise the run with AmendWorkflow.`,
    });
  }
  return diagnostics;
}

function leadingWhitespace(line: string): number {
  return /^[ \t]*/u.exec(line)?.[0].length ?? 0;
}

/**
 * 补全被拒时的诊断映射（bootstrap `mapFillDiagnostics` 逐字）：拼接把函数体插在脚本第
 * `insertedAtLine` 行起的 `insertedLines - 1` 行里（最后一行是右花括号），每行前面垫了调用缩进
 * 加两格。落在函数体行里的诊断标 `inFill`，行列改成函数体自己的坐标；落在右花括号那一行的算到
 * 调用那一行上；落在插入点之后的整体前移 `insertedLines`。
 */
function mapFillDiagnostics(input: {
  diagnostics: readonly CompileDiagnostic[];
  effectiveText: string;
  body: string;
  insertedAtLine: number;
  insertedLines: number;
}): FillDiagnostic[] {
  const { diagnostics, insertedAtLine, insertedLines } = input;
  const firstBodyLine = insertedAtLine;
  const lastBodyLine = insertedAtLine + insertedLines - 2;
  const closingLine = insertedAtLine + insertedLines - 1;
  const effectiveLines = input.effectiveText.split("\n");
  const bodyLines = input.body.replace(/\r?\n$/u, "").split(/\r?\n/u);
  return diagnostics.map((diagnostic) => {
    const base = { message: diagnostic.message, code: diagnostic.code };
    if (diagnostic.line >= firstBodyLine && diagnostic.line <= lastBodyLine) {
      const bodyLine = diagnostic.line - firstBodyLine + 1;
      const indent =
        leadingWhitespace(effectiveLines[diagnostic.line - 1] ?? "") -
        leadingWhitespace(bodyLines[bodyLine - 1] ?? "");
      return {
        ...base,
        inFill: true,
        line: bodyLine,
        column: Math.max(1, diagnostic.column - Math.max(0, indent)),
      };
    }
    if (diagnostic.line === closingLine) {
      return { ...base, inFill: false, line: insertedAtLine - 1, column: diagnostic.column };
    }
    if (diagnostic.line > closingLine) {
      return {
        ...base,
        inFill: false,
        line: diagnostic.line - insertedLines,
        column: diagnostic.column,
      };
    }
    return { ...base, inFill: false, line: diagnostic.line, column: diagnostic.column };
  });
}

/**
 * 「编译一次」的后半段对**已建好的** Program（bootstrap `compileProgram` 的 fill 面裁剪：补全不
 * 铸 actor submit profile、不做 world.run 字面量复核——那两件与放行无关，前面的分析与稳定性复核
 * 已经把脏脚本挡完）。哈希算在作者原文上（与 resume 比对的对象同一把尺）。
 */
function compileFillProgram(
  scriptText: string,
  workflow: WorkflowProgram,
  collected?: SiteTable,
): {
  askSpecs: Map<string, AskSpec>;
  sitePhases: ReadonlyMap<string, string>;
  holeBodies: Record<string, string>;
  phases: { phaseNames: string[]; holes: number[] };
  scriptHash: string;
} {
  const table = collected ?? collectSites(workflow);
  const { diagnostics: schemaDiagnostics, schemas } = synthesizeAskSchemas(workflow, table);
  if (schemaDiagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with unsupported ask result types: ${schemaDiagnostics
        .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  const askSpecs = buildAskSpecs(table, schemas);
  const core = interpret(workflow, table);
  const lowered = lowerWorkflow(workflow, table);
  return {
    askSpecs,
    sitePhases: collectSitePhases(core),
    holeBodies: lowered.holeBodies,
    phases: collectPhaseNames(projectControlFlow(core)),
    scriptHash: createHash("sha256").update(scriptText, "utf8").digest("hex"),
  };
}

/** 拼接前脚本的阶段表（同一条投影规则），`phasesAdded` 的比对基准。 */
function phaseNamesOf(workflow: WorkflowProgram, table: SiteTable): Set<string> {
  return new Set(collectPhaseNames(projectControlFlow(interpret(workflow, table))).phaseNames);
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
  /** 发起 run 的锚点（宿主铸的 `launch-`）：落 dwf_run.tool_call_id。 */
  toolCallId?: string;
  /** run 的展示名（工具路径的 `CreateWorkflow.name`）。 */
  name?: string;
  /** 子代理模型（规范串）：工具路径的 `subagent_model`。 */
  subagentModel?: string;
  /** 脚本点名的模型绑定表（规范串）：工具路径的 `model_bindings`。 */
  modelBindings?: Record<string, string>;
  /** 脚本文件（内联提交的工作副本或 `path` 来源）：留白通知的 draft 来源。 */
  scriptPath?: string;
}

/** 模型目录的一行（Node `ModelCatalogEntry` 的 JSON 面）。 */
interface AuthorModelEntry {
  providerId: string;
  modelId: string;
  providerLabel?: string;
  reasoningLevels: string[];
  defaultReasoningLevel?: string;
  contextWindow?: number;
  current: boolean;
  disabledReason?: string;
}

/** 作者工具一跳的入参（Rust 的 `WorkflowAuthorRequest` + sidecar 自己的 journal 身份）。 */
interface AuthorParams {
  tool: string;
  input: unknown;
  cwd: string;
  session: string;
  toolCall: string;
  hasLoadedSkill: boolean;
  dbPath: string;
  parentSessionId: string;
  models?: AuthorModelEntry[];
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

/** 扩展名 → MIME（与 Node `workflow-artifact-publish` 同一张表；表外一律 octet-stream）。 */
const ARTIFACT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  htm: "text/html",
  html: "text/html",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  markdown: "text/markdown",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** 裸 MIME（不带参数）：UI 在精确字符串上分派。 */
const BARE_CONTENT_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;

function assertArtifactId(request: ArtifactPublishRequest): void {
  const { id } = request;
  if (id.length > ARTIFACT_CAPS.maxIdLength || !ARTIFACT_ID_PATTERN.test(id)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: id '${id}' is not a valid artifact id. Use at most ` +
        `${ARTIFACT_CAPS.maxIdLength} characters from [A-Za-z0-9_.-].`,
    );
  }
}

function artifactPublishOptions(request: ArtifactPublishRequest): {
  title?: string;
  description?: string;
  contentType?: string;
} {
  const raw = request.opts;
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts must be an options object. Pass an object or omit the argument.`,
    );
  }
  const bag = raw as { title?: unknown; description?: unknown; contentType?: unknown };
  const title = artifactOptionText(request, "title", bag.title, ARTIFACT_CAPS.maxTitleLength);
  const description = artifactOptionText(
    request,
    "description",
    bag.description,
    ARTIFACT_CAPS.maxDescriptionLength,
  );
  const contentType =
    request.op === "file" ? artifactOptionContentType(request, bag.contentType) : undefined;
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

function artifactOptionText(
  request: ArtifactPublishRequest,
  name: string,
  value: unknown,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `artifact.${request.op}: opts.${name} must be a string.`,
    );
  }
  if (value.length > max) {
    throw new WorkflowError(
      "ArtifactTooLarge",
      `artifact.${request.op}: opts.${name} is ${value.length} characters, over the cap of ${max}.`,
    );
  }
  return value;
}

function artifactOptionContentType(
  request: ArtifactPublishRequest,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new WorkflowError("DriverError", "artifact.file: opts.contentType must be a string.");
  }
  if (!BARE_CONTENT_TYPE.test(value)) {
    throw new WorkflowError(
      "DriverError",
      `artifact.file: opts.contentType '${value}' is not a bare MIME type such as 'application/pdf'.`,
    );
  }
  return value;
}

function artifactContentTypeOf(file: string): string {
  const name = path.basename(file);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "application/octet-stream";
  const extension = name.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]+$/.test(extension)) return "application/octet-stream";
  return ARTIFACT_CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * 工作区相对路径 → 可读的真实路径，两次越界判定（词法 + realpath）：与 Node 的实现同一条
 * 纪律——软链按真实路径判，发布把字节拷进持久 store，一条软链不能把 `~/.ssh/id_rsa` 变成卡片。
 */
async function resolveWorkspaceFile(
  cwd: string,
  given: string,
): Promise<{ real: string; relative: string }> {
  const resolved = path.resolve(cwd, given);
  const relative = path.relative(cwd, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WorkflowError(
      "ArtifactPathOutsideWorkspace",
      `artifact.file: path '${given}' resolves outside the workspace. Only files inside the workspace can be published.`,
    );
  }
  const realCwd = await realpath(cwd);
  let real: string;
  try {
    real = await realpath(resolved);
  } catch (cause) {
    throw new WorkflowError(
      "ArtifactSourceMissing",
      `artifact.file: '${given}' does not exist or is not a regular file.`,
      { cause },
    );
  }
  const realRelative = path.relative(realCwd, real);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new WorkflowError(
      "ArtifactPathOutsideWorkspace",
      `artifact.file: path '${given}' resolves outside the workspace (symlinks are judged by their real path).`,
    );
  }
  return { real, relative: path.relative(cwd, resolved) };
}

/** cap+1 字节探测：恰好 cap 放行，超过拒绝。 */
async function readCappedBytes(target: string, cap: number): Promise<Buffer> {
  const handle = await openFile(target, "r");
  try {
    const buffer = Buffer.alloc(cap + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > cap) {
      throw new WorkflowError(
        "ArtifactTooLarge",
        `artifact.file: file is over the cap of ${cap} bytes. Publish a smaller artifact.`,
      );
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

/** driver：引擎的手，每一下都伸回宿主。 */
class RemoteDriver {
  readonly journal: JournalStorePort;
  sink: WorkflowSink | undefined;
  private readonly runId: string;
  /** 本 run 的工作区（`artifact.file` 的越界判定与相对路径出处）。 */
  private readonly cwd: string;
  private readonly request: (method: string, params: unknown) => Promise<unknown>;
  private readonly notify: (method: string, params: unknown) => void;
  /** 本 run 的子代理模型（规范串，来自 `run-launched.subagentModel` / 本次修订的入参）。 */
  private readonly subagentModel: string | undefined;
  /** 脚本点名的绑定表（规范串）：persona 点名的模型按它查（launch.md「Models the script names」）。 */
  private readonly modelBindings: Record<string, string> | undefined;
  /** 留白通知的编译期事实与 run 展示元数据（hole-reached 的完整载荷从这里组）。 */
  private readonly facts: RunFacts;
  /** 每个 ask 实例最近一次宿主报的边界计数（先数后报：宿主在交出本轮前已数好）。 */
  private readonly lastCounts = new Map<string, number>();

  constructor(
    runId: string,
    cwd: string,
    journal: JournalStorePort,
    request: (method: string, params: unknown) => Promise<unknown>,
    notify: (method: string, params: unknown) => void,
    subagentModel?: string,
    modelBindings?: Record<string, string>,
    facts?: RunFacts,
  ) {
    this.runId = runId;
    this.cwd = cwd;
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
    seed?: ActorSessionSeed,
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
      // amend-resume 的转录种子：兑现是宿主的事（node-store 的种子复制，建会话时幂等）。
      ...(seed === undefined ? {} : { seed }),
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

  /**
   * 用户面产物发布（`artifact.markdown` / `artifact.file`）：形状、路径越界与字节读取在这一侧
   * （与 Node `executeArtifactPublish` 同一套判据），字节交给 Rust 的 artifact store
   * （`ArtifactPurpose::Deliverable`），回执由 store 给出 `nibi-artifact://` 引用。
   */
  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    assertArtifactId(request);
    const options = artifactPublishOptions(request);
    let payload: { bytes: Buffer; contentType: string; sourcePath?: string };
    if (request.op === "file") {
      const given = request.path;
      if (typeof given !== "string" || given.length === 0) {
        throw new WorkflowError(
          "DriverError",
          "artifact.file: path must be a non-empty string. Pass the workspace-relative path the subagent wrote.",
        );
      }
      const { real, relative } = await resolveWorkspaceFile(this.cwd, given);
      let bytes: Buffer;
      try {
        bytes = await readCappedBytes(real, ARTIFACT_CAPS.maxFileBytes);
      } catch (cause) {
        if (cause instanceof WorkflowError) throw cause;
        throw new WorkflowError(
          "ArtifactSourceMissing",
          `artifact.file: '${given}' does not exist or is not a regular file.`,
          { cause },
        );
      }
      payload = {
        bytes,
        contentType: options.contentType ?? artifactContentTypeOf(real),
        sourcePath: relative,
      };
    } else {
      const content = request.content;
      if (typeof content !== "string") {
        throw new WorkflowError("DriverError", "artifact.markdown: content must be a string.");
      }
      const bytes = Buffer.from(content, "utf8");
      if (bytes.length > ARTIFACT_CAPS.maxMarkdownBytes) {
        throw new WorkflowError(
          "ArtifactTooLarge",
          `artifact.markdown: content is ${bytes.length} bytes, over the cap of ${ARTIFACT_CAPS.maxMarkdownBytes} bytes.`,
        );
      }
      payload = { bytes, contentType: "text/markdown" };
    }
    const reply = (await this.request("artifact/publish", {
      runId: this.runId,
      request: {
        id: request.id,
        op: request.op,
        version: request.version,
        contentType: payload.contentType,
        ...(options.title === undefined ? {} : { title: options.title }),
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(payload.sourcePath === undefined ? {} : { sourcePath: payload.sourcePath }),
        ...(request.op === "file"
          ? { bytesBase64: payload.bytes.toString("base64") }
          : { content: request.content }),
      },
    })) as {
      ok?: boolean;
      record?: ArtifactVersionRecord;
      code?: string;
      message?: string;
    };
    if (reply.ok !== true || reply.record === undefined) {
      throw new WorkflowError(
        (reply.code ?? "ArtifactStoreUnavailable") as WorkflowErrorCode,
        reply.message ?? "the artifact could not be published",
      );
    }
    return reply.record;
  }

  /** 宿主每轮报的 messageCount：最近一次的值就是本次交换的边界候选。 */
  noteCount(instance: InstanceRef, messageCount: number): void {
    this.lastCounts.set(`${instance.siteId}@${instance.ordinal}`, messageCount);
  }

  /**
   * ask 边界记账（Node journalAskMessageBoundary 同一族）：引擎结算 ask 节点时（emit 看见
   * node-settled）把宿主报的条数补写进 journal 行——getNode 拿整条记录、只加边界再 putNode，
   * status / result / inputHash 一个不动。node-settled 时记录已在 journal 且结算即整条替换，
   * 补写必须在它之后（写在之前会被抹掉）。宿主报数先于引擎知晓本轮结束，所以这个数就是
   * 本次交换结束那一刻的会话长度。
   */
  private backfillBoundary(event: {
    instance: { siteId: string; ordinal: number };
    outcome?: unknown;
  }): void {
    if (event.outcome !== "ok") return;
    const key = `${event.instance.siteId}@${event.instance.ordinal}`;
    const boundary = this.lastCounts.get(key);
    if (boundary === undefined) return;
    this.lastCounts.delete(key);
    try {
      const recorded = this.journal.getNode(this.runId, event.instance.siteId, event.instance.ordinal);
      if (recorded === undefined) return;
      this.journal.putNode({ ...recorded, messageBoundary: boundary });
    } catch {
      // 记账写入失败不打挂一个已经结算好的 ask（这里跑在 emit 的同步片里，抛出会把事件流炸断）。
      // 代价与 Node 相同：这个 ask 不可导入，run 因此不可作前驱。
    }
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
        // 宿主 `workflowRuns` 投影的输入：事件原文（与 journal 里那份同一个对象）。
        event,
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
    if (event.type === "node-settled") {
      this.backfillBoundary(event);
    }
    if (event.type === "run-stalled") {
      // run 级停滞的载荷（Node toProgressPayload 同形）：driver 的 stall 钟发现「连续
      // sinceMs 没有一次成功的模型请求、期间至少排定过一次重试」。宿主据它组
      // `<workflow-stall>` 通知；展示名同 hole 分支从 journal 读。
      const record = this.journal.getRun(this.runId);
      this.notify("run/event", {
        runId: this.runId,
        type: event.type,
        event,
        ...(record?.name === undefined ? {} : { name: record.name }),
        stall: {
          sinceMs: event.sinceMs,
          ...(event.reason === undefined ? {} : { reason: event.reason }),
          ...(event.cap === undefined ? {} : { cap: event.cap }),
        },
      });
      return;
    }
    this.notify("run/event", { runId: this.runId, type: event.type, event });
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
  // 每个 run 的补全串行链（enqueueFill）：runId → 该 run 最后一次排进去的补全。链排空即删键。
  const fills = new Map<string, Promise<unknown>>();

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
    // 工具路径的绑定表由 `CreateWorkflow` 的 resolveInput 解好（确认窗批准的正是那张表）；
    // 缺席时才在这里按脚本点名的名字现解（中枢/老宿主路径）。
    let modelBindings: Record<string, string> | undefined = params.modelBindings;
    if (modelBindings === undefined && names.length > 0) {
      const resolved = await resolveScriptModels(request, names, undefined);
      if (resolved.bindings === null) {
        return { ok: false, reason: "compile_failed", message: resolved.message.slice(0, 2_000) };
      }
      if (Object.keys(resolved.bindings).length > 0) modelBindings = resolved.bindings;
    }

    // 空实参归一成缺席（Node 启动路径的 hasArgs 同一条判据：无实参时行上 args_json 缺席，
    // 「没有实参」与「实参是空袋」在行层面不区分）。
    const rowArgs = args !== undefined && Object.keys(args).length > 0 ? args : undefined;
    // 受理之后在后台跑；结算以 `run/settled` 通知宿主。
    void launchRun(
      {
        runId: params.runId,
        parentSessionId: params.parentSessionId,
        cwd: params.cwd,
        dbPath: params.dbPath,
        scriptText,
        args: rowArgs,
        caps: params.caps ?? { maxConcurrency: DEFAULT_CONCURRENCY },
        ...(params.toolCallId === undefined ? {} : { toolCallId: params.toolCallId }),
        // run 的展示名 = 工具给的 name，其次 saved 名字（Node 的启动路径同一条读法）。
        ...((params.name ?? params.savedName) === undefined
          ? {}
          : { name: params.name ?? params.savedName }),
        ...(params.subagentModel === undefined ? {} : { subagentModel: params.subagentModel }),
        savedPath: draftPath ?? params.scriptPath,
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
      // 服务端先验（引擎构造时仍二次校验，防御纵深）：记录被外力改写（scriptText 与
      // scriptHash 不再自洽）时结构化拒绝，而不是让引擎在 launch 里同步抛错——那会把条目
      // 簿记成 failed 终态，掩盖「记录仍可修复」这个事实。
      const scriptHash = createHash("sha256").update(record.scriptText, "utf8").digest("hex");
      if (record.scriptHash !== undefined && record.scriptHash !== scriptHash) {
        return {
          ok: false,
          reason: "script_mismatch",
          message: `run ${params.runId}'s stored script does not match its recorded hash`,
        };
      }
      // resume 的 pin（Node resumeDynamicWorkflowRun 同一条读）：一次 run 的身份包含它跑在
      // 哪个模型上、被谁绑定过、脚本文件在哪、叫什么、由哪个锚点发起——全部建 run 那一世
      // 写死、本 run 余生不变，resume 从 journal 重读，**永不接受新的**。
      // 修订 run 的 resume：重建导入缓存（Node rebuildImportedCacheForResume 同一条读；
      // **任何失败都只降级、不拒绝 resume**——前驱 journal 是存续依赖，但只是加速结构，
      // 丢了未消费的导入退化成 live 重执行）。
      const importedCache =
        record.resumedFrom === undefined
          ? undefined
          : await rebuildImportedCacheForResume(
              { journal },
              { runId: params.runId, predecessorRunId: record.resumedFrom },
            );
      const resumedSubagentModel = runSubagentModel(journal, params.runId);
      const resumedModelBindings = runModelBindings(journal, params.runId);
      const launched = journal
        .listEvents(params.runId, { types: ["run-launched"], reportItems: { limit: 0 } })
        .at(-1)?.event as { scriptPath?: unknown } | undefined;
      const resumedScriptPath =
        typeof launched?.scriptPath === "string" && launched.scriptPath.length > 0
          ? launched.scriptPath
          : undefined;
      const parentSessionId = record.parentSessionId ?? "";
      const cwd = record.cwd ?? process.cwd();
      // 与 submit 同一条后台执行；引擎构造时看见既有 run 行走 resume 分支（行上的 tool_call_id
      // / name / args 都不会重写——锚点只进 run-launched 的事件头）。
      void launchRun(
        {
          runId: params.runId,
          parentSessionId,
          cwd,
          dbPath: params.dbPath,
          scriptText: record.scriptText,
          args: record.args,
          caps: record.caps ?? undefined,
          ...(resumedSubagentModel === undefined ? {} : { subagentModel: resumedSubagentModel }),
          ...(resumedModelBindings === undefined ? {} : { modelBindings: resumedModelBindings }),
          ...(resumedScriptPath === undefined ? {} : { savedPath: resumedScriptPath }),
          ...(record.name === undefined ? {} : { name: record.name }),
          ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
          ...(importedCache === undefined ? {} : { importedCache }),
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

  interface ScriptAmendParams {
    runId: string;
    predecessorRunId: string;
    dbPath: string;
    scriptText: string;
    cwd: string;
    parentSessionId: string;
    name?: string;
    toolCallId?: string;
    maxConcurrency?: number;
    subagentModel?: string;
    modelBindings?: Record<string, string>;
    scriptPath?: string;
  }

  /**
   * 一次**脚本**修订（工具面 `AmendWorkflow` 的 `port.amend`）：预检前驱 → 编新脚本 →
   * 停下在飞的前驱并等它结算 → 从前驱 journal 构建导入缓存 → 带 lineage 启动后继。
   *
   * 与设置轮 `acceptAmend` 的区别只在来源：那边重跑前驱的存档脚本，这边跑模型刚给的脚本。
   * 两者都**不**继承实参——修订是另一次确认过的执行，实参属于前驱那次 run 的身份。
   */
  async function acceptScriptAmend(params: ScriptAmendParams): Promise<
    | { ok: true; accepted: true; supersededRunId?: string }
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
      if (record.scriptText === undefined || record.scriptText.length === 0) {
        return {
          ok: false,
          reason: "script_missing",
          message: `run ${params.predecessorRunId} has no stored script`,
        };
      }
      // 编不过的修订在停下任何东西之前拒绝（与设置轮同一条顺序：坏脚本不让前驱陪葬）。
      try {
        const program = createWorkflowProgram(params.scriptText);
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

      // 在飞前驱以 `{ superseded }` 停下，并等它自己的结算 promise（不是超时、不是轮询）。
      const live = runs.get(params.predecessorRunId);
      let supersededRunId: string | undefined;
      if (live !== undefined) {
        live.abort.abort({ superseded: params.runId });
        await live.settlement;
        supersededRunId = params.predecessorRunId;
      }
      const settled = journal.getRun(params.predecessorRunId) ?? record;
      const built = await buildImportedCache({ journal }, params.predecessorRunId);
      if (!built.ok) {
        return {
          ok: false,
          reason: "import_failed",
          message: `dynamic workflow amend could not import from run ${params.predecessorRunId} after settlement: ${built.reason}`,
        };
      }
      void launchRun(
        {
          runId: params.runId,
          parentSessionId: params.parentSessionId,
          cwd: params.cwd,
          dbPath: params.dbPath,
          scriptText: params.scriptText,
          // 修订沿用前驱的展示名（Node 的修订路径同一条读法）。
          ...((params.name ?? settled.name) === undefined
            ? {}
            : { name: params.name ?? settled.name }),
          caps: { maxConcurrency: params.maxConcurrency ?? DEFAULT_CONCURRENCY },
          ...(params.subagentModel === undefined
            ? {}
            : { subagentModel: params.subagentModel }),
          ...(params.modelBindings === undefined
            ? {}
            : { modelBindings: params.modelBindings }),
          ...(params.scriptPath === undefined ? {} : { savedPath: params.scriptPath }),
          ...(params.toolCallId === undefined ? {} : { toolCallId: params.toolCallId }),
          resumedFrom: params.predecessorRunId,
          inheritedTokens: settled.spentTokens ?? 0,
          importedCache: built.cache,
        } as Parameters<typeof launchRun>[0],
        request,
        notify,
        runs,
      ).then(({ settlement, notice }) =>
        notify("run/settled", { runId: params.runId, settlement, notice }),
      );
      return {
        ok: true,
        accepted: true,
        ...(supersededRunId === undefined ? {} : { supersededRunId }),
      };
    } finally {
      db.close();
    }
  }

  /** run 的展示标签：name → 脚本首个非空行（≤80）→ runId（Node 的同一条派生链）。 */
  function runLabel(record: {
    runId: string;
    name?: string;
    scriptText?: string;
  }): { label: string; labelSource: "name" | "script" } {
    const name = record.name?.trim();
    if (name !== undefined && name.length > 0) return { label: name, labelSource: "name" };
    for (const line of (record.scriptText ?? "").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        return {
          label: trimmed.length <= 80 ? trimmed : trimmed.slice(0, 80),
          labelSource: "script",
        };
      }
    }
    return { label: record.runId, labelSource: "script" };
  }

  /** 作者工具的宿主：journal 读面 + 已有三条启动/修订/恢复函数。 */
  function authoringHost(dbPath: string, parentSessionId: string) {
    const withJournal = <T>(read: (journal: ReturnType<typeof createDwfJournalStore>) => T): T => {
      const db = openDatabase(dbPath);
      try {
        return read(createDwfJournalStore(db));
      } finally {
        db.close();
      }
    };
    return createAuthoringHost({
      dbPath,
      parentSessionId,
      defaultConcurrency: DEFAULT_CONCURRENCY,
      submit: async (request) => {
        const reply = await acceptSubmit({
          runId: request.runId,
          parentSessionId: request.parentSessionId,
          cwd: request.cwd,
          dbPath,
          scriptText: request.scriptText,
          ...(request.name === undefined ? {} : { name: request.name }),
          ...(request.args === undefined ? {} : { args: request.args }),
          ...(request.maxConcurrency === undefined
            ? {}
            : { caps: { maxConcurrency: request.maxConcurrency } }),
          ...(request.subagentModel === undefined
            ? {}
            : { subagentModel: request.subagentModel }),
          ...(request.modelBindings === undefined
            ? {}
            : { modelBindings: request.modelBindings }),
          ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
          ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
        });
        return reply.ok
          ? { ok: true as const }
          : { ok: false as const, reason: reply.reason, message: reply.message };
      },
      amendScript: async (request) => {
        const reply = await acceptScriptAmend({ ...request, dbPath });
        return reply.ok
          ? {
              ok: true as const,
              ...(reply.supersededRunId === undefined
                ? {}
                : { supersededRunId: reply.supersededRunId }),
            }
          : { ok: false as const, reason: reply.reason, message: reply.message };
      },
      resume: async (runId) => {
        const reply = await acceptResume({ runId, dbPath });
        return reply.ok
          ? { ok: true as const }
          : { ok: false as const, reason: reply.reason, message: reply.message };
      },
      isLive: (runId) => runs.has(runId),
      getScript: async (runId) =>
        withJournal((journal) => journal.getRun(runId)?.scriptText),
      getSnapshot: async (runId): Promise<AuthorRunSnapshot | undefined> =>
        withJournal((journal) => {
          const record = journal.getRun(runId);
          if (record === undefined) return undefined;
          const launched = journal
            .listEvents(runId, { types: ["run-launched"], reportItems: { limit: 0 } })
            .at(-1)?.event as
            | {
                subagentModel?: unknown;
                modelBindings?: unknown;
                scriptPath?: unknown;
              }
            | undefined;
          const bindings =
            launched?.modelBindings !== null &&
            typeof launched?.modelBindings === "object"
              ? (launched.modelBindings as Record<string, string>)
              : undefined;
          const terminal =
            record.status === "completed" ||
            record.status === "errored" ||
            record.status === "stopped";
          return {
            id: runId,
            status:
              record.status === "stopped"
                ? "cancelled"
                : record.status === "errored"
                  ? "failed"
                  : record.status,
            ...(terminal ? { runStatus: record.status } : {}),
            ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
            ...(record.parentSessionId === undefined
              ? {}
              : { parentSessionId: record.parentSessionId }),
            ...(record.name === undefined ? {} : { name: record.name }),
            ...(record.caps.maxConcurrency === DEFAULT_CONCURRENCY
              ? {}
              : { maxConcurrency: record.caps.maxConcurrency }),
            ...(typeof launched?.subagentModel === "string"
              ? { subagentModel: launched.subagentModel }
              : {}),
            ...(bindings === undefined ? {} : { modelBindings: bindings }),
            ...(typeof launched?.scriptPath === "string" &&
            launched.scriptPath.length > 0
              ? { scriptPath: launched.scriptPath }
              : {}),
          };
        }),
      listRuns: async (query): Promise<AuthorListRunsResult> =>
        withJournal((journal) => {
          // `JournalStorePort` 不带枚举面（引擎从不枚举 run）；`SqliteDwfJournalStore`
          // 实现了宿主内省查询，这里按结构调用（与 ListWorkflowRuns 的上游同一份实现）。
          const rows = (
            journal as unknown as {
              listRuns(query: {
                cwd: string;
                limit: number;
                statuses?: readonly string[];
              }): {
                runId: string;
                parentSessionId?: string;
                name?: string;
                scriptText?: string;
                status: string;
                stopReason?: string;
                resumedFrom?: string;
                supersededBy?: string;
                timeCreated: number;
                timeUpdated: number;
                spentTokens: number;
              }[];
            }
          ).listRuns({
            cwd: query.cwd,
            limit: query.limit + 1,
            ...(query.statuses === undefined ? {} : { statuses: query.statuses }),
          });
          const truncated = rows.length > query.limit;
          const items = rows.slice(0, query.limit).map((row) => {
            const owned = row.parentSessionId === parentSessionId;
            const inFlight = row.status === "pending" || row.status === "running";
            return {
              runId: row.runId,
              ...runLabel(row),
              status: row.status,
              ...(row.stopReason === undefined ? {} : { stopReason: row.stopReason }),
              ...(row.resumedFrom === undefined ? {} : { resumedFrom: row.resumedFrom }),
              ...(row.supersededBy === undefined ? {} : { supersededBy: row.supersededBy }),
              ownedByThisSession: owned,
              ...(!inFlight || owned || runs.has(row.runId)
                ? {}
                : { possiblyInterrupted: true }),
              createdAt: row.timeCreated,
              updatedAt: row.timeUpdated,
              spentTokens: row.spentTokens,
            };
          });
          return { runs: items, ...(truncated ? { truncated: true } : {}) };
        }),
    });
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
      // 修订后继的导入缓存（Node 的修订路径同一条构建；同一段代码，两侧才是同一张表）。
      // 前驱已在上面的 `await live.settlement` 里结算——全部会话静默，quietSessions 缺席即
      // 「全部静默」，与重建侧同形。转录存取面缺席（候选照收的降级见文件头注释）。构建失败
      // 是接线故障（预检刚过、前驱已终态），按 Node 的同一条纪律上抛成拒绝，而不是悄悄
      // 让未消费的导入 live 重跑。
      const importBuilt = await buildImportedCache({ journal }, params.predecessorRunId);
      if (!importBuilt.ok) {
        return {
          ok: false,
          reason: "import_failed",
          message: `dynamic workflow amend could not import from run ${params.predecessorRunId} after settlement: ${importBuilt.reason}`,
        };
      }
      const importedCache = importBuilt.cache;
      const parentSessionId = settled.parentSessionId ?? record.parentSessionId ?? "";
      const cwd = settled.cwd ?? record.cwd ?? process.cwd();
      void launchRun(
        {
          runId: params.runId,
          parentSessionId,
          cwd,
          dbPath: params.dbPath,
          scriptText: record.scriptText,
          args: settled.args,
          // 后继沿用前驱的名字（Node 的修订路径同一条：GUI 按「工作流名 = run 名」归属）。
          ...(record.name === undefined ? {} : { name: record.name }),
          caps: { maxConcurrency: nextBound ?? DEFAULT_CONCURRENCY },
          ...(nextModel === undefined ? {} : { subagentModel: nextModel }),
          ...(modelBindings === undefined ? {} : { modelBindings }),
          resumedFrom: params.predecessorRunId,
          inheritedTokens: settled.spentTokens ?? 0,
          importedCache,
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

  interface HolesParams {
    runId: string;
    dbPath: string;
  }

  /**
   * FillWorkflowHole 的确认前读面（Node resolveInput 里那次 `port.getTask` 的窄版）：run 行的
   * 展示元数据 + 留白表。`waiting` 只在**本进程**引擎的停驻表里有它时成立（进程亡故后没有
   * promise 在等，单靠事件会把一个没人问的留白报成在等）；`filled` 来自事件。留白事实的
   * type/line 从 run 行脚本的一次编译里读（无留白到达过的 run 不付这笔编译）。
   */
  async function acceptHoles(params: HolesParams): Promise<
    | {
        ok: true;
        name?: string;
        draftPath?: string;
        status: string;
        stopReason?: string;
        holes: { siteId: string; name: string; type: string; line?: number; waiting: boolean }[];
      }
    | { ok: false; reason: string; message: string }
  > {
    const db = openDatabase(params.dbPath);
    try {
      const journal = createDwfJournalStore(db);
      const record = journal.getRun(params.runId);
      const live = runs.get(params.runId);
      if (record === undefined && live === undefined) {
        return {
          ok: false,
          reason: "run_not_found",
          message: `No run with id ${params.runId}.`,
        };
      }
      // 留白事实表：run 行的（有效）脚本一次编译；没有到达过的留白就不编译（绝大多数 run）。
      const events = journal.listEvents(params.runId, {
        types: ["hole-reached", "hole-filled"],
        reportItems: { limit: 0 },
      });
      let compiled: { siteId: string; name: string; type: string; line: number }[] | undefined;
      if (events.length > 0 && record?.scriptText !== undefined) {
        try {
          compiled = collectSites(createWorkflowProgram(record.scriptText)).holes.map((site) => ({
            siteId: site.id,
            name: site.name ?? site.id,
            type: site.typeText ?? "unknown",
            line: site.loc.line,
          }));
        } catch {
          compiled = undefined; // 读面：脚本编不过时这两项缺席，不抛。
        }
      }
      const bySite = new Map((compiled ?? []).map((hole) => [hole.siteId, hole]));
      const open = new Set(
        (live?.control?.openHoles() ?? []).map((hole) => `${hole.siteId}@${hole.ordinal}`),
      );
      const filled = new Map<string, boolean>();
      const reached: { siteId: string; ordinal: number; name: string }[] = [];
      for (const stored of events) {
        const event = stored.event as {
          type: string;
          instance?: { siteId: string; ordinal: number };
          name?: string;
          siteId?: string;
        };
        if (event.type === "hole-reached" && event.instance !== undefined) {
          reached.push({
            siteId: event.instance.siteId,
            ordinal: event.instance.ordinal,
            name: event.name ?? event.instance.siteId,
          });
        } else if (event.type === "hole-filled" && event.siteId !== undefined) {
          filled.set(event.siteId, true);
        }
      }
      const holes = reached
        .filter((hole) => open.has(`${hole.siteId}@${hole.ordinal}`) || filled.has(hole.siteId))
        .map((hole) => {
          const facts = bySite.get(hole.siteId);
          return {
            siteId: hole.siteId,
            name: hole.name,
            type: facts?.type ?? "unknown",
            ...(facts === undefined ? {} : { line: facts.line }),
            waiting: open.has(`${hole.siteId}@${hole.ordinal}`),
          };
        });
      const launched = journal
        .listEvents(params.runId, { types: ["run-launched"], reportItems: { limit: 0 } })
        .at(-1)?.event as { scriptPath?: unknown } | undefined;
      const draftPath =
        typeof launched?.scriptPath === "string" && launched.scriptPath.length > 0
          ? launched.scriptPath
          : undefined;
      const name = record?.name ?? undefined;
      return {
        ok: true,
        ...(name === undefined ? {} : { name }),
        ...(draftPath === undefined ? {} : { draftPath }),
        status: record?.status ?? "running",
        ...(record?.stopReason === undefined ? {} : { stopReason: record.stopReason }),
        holes,
      };
    } finally {
      db.close();
    }
  }

  interface FillParams {
    runId: string;
    holeId: string;
    body: string;
    dbPath: string;
    /** 补全它的会话，落进 `hole-filled.filledBy`。 */
    parentSessionId?: string;
  }

  /**
   * 一次补全（`FillWorkflowHole` 工具的服务面；bootstrap fillOnce 逐字）。同一个 run 的补全
   * **串行**执行（Node fillQueues 的同一条 bug 根因：一个 run 可以同时停在两处留白，模型会把
   * 两次 FillWorkflowHole 放进同一个并行批；从读脚本到引擎放行之间有 await，第二次调用就会拿
   * 第一次补全之前的文本去拼）。上一次被拒绝（甚至抛错）不阻塞下一次；不同 run 之间互不排队。
   */
  function enqueueFill(params: FillParams): Promise<unknown> {
    const previous = fills.get(params.runId) ?? Promise.resolve();
    const turn = previous.then(
      () => acceptFill(params),
      () => acceptFill(params),
    );
    const settled: Promise<unknown> = turn.then(
      () => undefined,
      () => undefined,
    );
    fills.set(params.runId, settled);
    void settled.then(() => {
      if (fills.get(params.runId) === settled) fills.delete(params.runId);
    });
    return turn;
  }

  async function acceptFill(params: FillParams): Promise<unknown> {
    const { runId, holeId } = params;
    const live = runs.get(runId);
    const db = openDatabase(params.dbPath);
    try {
      const journal = createDwfJournalStore(db);
      const record = journal.getRun(runId);
      if (live === undefined && record === undefined) {
        return { ok: false, reason: "run_not_found", message: `No run with id ${runId}.` };
      }
      // 在飞判定看本进程注册表：journal 说 running 而这里没有它，是别的进程（或死进程）的 run。
      // 停下的 run 指向 ResumeWorkflowRun——resume 会重新到达留白、再问一次。
      if (live === undefined || live.control === undefined) {
        const status = record?.status;
        const hint =
          status === "stopped"
            ? `Run ${runId} is stopped; ResumeWorkflowRun it first, after which the hole asks again.`
            : status === "completed" || status === "errored"
              ? `Run ${runId} has ended (${status}); nothing is waiting.`
              : `Run ${runId} is not in flight in this session.`;
        return { ok: false, reason: "hole_not_waiting", message: hint };
      }

      // run 此刻的脚本（run 行上的就是引擎手里的那份：一次补全会同步换掉它）。在自己轮到时才读
      // ——排在前面的补全已经把它换成了带那个函数体的有效脚本。
      const scriptText = record?.scriptText;
      if (scriptText === undefined || scriptText.length === 0) {
        return {
          ok: false,
          reason: "hole_not_waiting",
          message: `run ${runId} has no stored script`,
        };
      }
      const workflow = createWorkflowProgram(scriptText);
      const before = collectSites(workflow);
      const site = before.holes.find((hole) => hole.id === holeId);
      if (site === undefined) {
        const known = before.holes.map((hole) => `${hole.id} (${hole.name ?? "?"})`).join(", ");
        return {
          ok: false,
          reason: "hole_not_waiting",
          message: `${holeId} is not a hole of run ${runId}${known === "" ? "" : `; its holes are ${known}`}.`,
        };
      }
      if (site.body !== undefined) {
        return {
          ok: false,
          reason: "hole_not_waiting",
          message: `${holeId} of run ${runId} is already filled.`,
        };
      }

      // 拼接 + 与提交同款的分析（9012 与其余 authoring 规则都在里面）。
      const spliced = spliceHoleBody(scriptText, before, holeId, params.body);
      if (spliced === undefined) {
        return {
          ok: false,
          reason: "hole_not_waiting",
          message: `${holeId} of run ${runId} cannot take a body.`,
        };
      }
      const bindings = runModelBindings(journal, runId);
      const analysis = analyzeWorkflowScript(spliced.text);
      const diagnostics = analysis.ok
        ? unboundFillModelDiagnostics(analysis.modelReferences, bindings)
        : analysis.diagnostics;
      if (diagnostics.length > 0) {
        return {
          ok: false,
          reason: "compile_failed",
          message: `The effective script does not compile (${diagnostics.length} diagnostic${
            diagnostics.length === 1 ? "" : "s"
          }); nothing was spliced and the hole is still waiting.`,
          diagnostics: mapFillDiagnostics({
            diagnostics,
            effectiveText: spliced.text,
            body: params.body,
            insertedAtLine: spliced.insertedAtLine,
            insertedLines: spliced.insertedLines,
          }),
        };
      }

      // 稳定性复核在编译产物之前：编译（schema 合成、lowering）对一份 id 会错位的脚本是白付。
      const effective = createWorkflowProgram(spliced.text);
      const after = collectSites(effective);
      const stability = checkSiteStability(
        before,
        after,
        holeId,
        spliced.insertedAtLine,
        spliced.insertedLines,
      );
      if (!stability.ok) {
        return {
          ok: false,
          reason: "fill_ids_unstable",
          message: `The compiled effective script renumbered an existing site (${stability.detail}). This is a host fault, not a problem with the body; the hole is still waiting.`,
        };
      }
      let compiledFill: ReturnType<typeof compileFillProgram>;
      try {
        compiledFill = compileFillProgram(spliced.text, effective, after);
      } catch (error) {
        return {
          ok: false,
          reason: "compile_failed",
          message: `The effective script does not compile: ${
            error instanceof Error ? error.message.slice(0, 2_000) : String(error)
          }`,
        };
      }
      const code = compiledFill.holeBodies[holeId];
      if (code === undefined) {
        // 拼接成功、稳定性通过，lowering 却没给出这处留白的函数体：只可能是分析器与 lowering 的
        // 契约漂移。按宿主故障报，而不是把 undefined 递给引擎。
        return {
          ok: false,
          reason: "fill_ids_unstable",
          message: `Lowering produced no body for ${holeId}; this is a host fault and the hole is still waiting.`,
        };
      }

      // 交给引擎（一个同步步骤：换表、写回有效脚本、记 hole-filled、放行停驻的分支）。没有草稿的
      // run 先铸一份，路径随事件落 journal；引擎随后拒绝（竞态：刚结算 / 没在等）时把这个本次刚铸
      // 的文件删掉——谁都还没见过的文件不在「草稿绝不在模型背后被动」之列。
      const launched = journal
        .listEvents(runId, { types: ["run-launched"], reportItems: { limit: 0 } })
        .at(-1)?.event as { scriptPath?: unknown } | undefined;
      const scriptPath =
        typeof launched?.scriptPath === "string" && launched.scriptPath.length > 0
          ? launched.scriptPath
          : undefined;
      let minted: string | undefined;
      if (scriptPath === undefined) {
        const written = await writeWorkflowDraft({
          cwd: record?.cwd ?? process.cwd(),
          name:
            record?.name ??
            compiledFill.phases.phaseNames[0] ??
            FILL_DRAFT_FALLBACK_NAME,
          source: spliced.text,
        });
        minted = written?.path;
      }
      const result = live.control.fillHole({
        siteId: holeId,
        code,
        script: { text: spliced.text, hash: compiledFill.scriptHash },
        askSpecs: compiledFill.askSpecs,
        sitePhases: compiledFill.sitePhases,
        phaseNames: compiledFill.phases.phaseNames,
        ...(compiledFill.phases.holes.length === 0 ? {} : { holes: compiledFill.phases.holes }),
        ...(params.parentSessionId === undefined ? {} : { filledBy: params.parentSessionId }),
        ...(minted === undefined ? {} : { scriptPath: minted }),
      });
      if (result === undefined || !result.ok) {
        if (minted !== undefined) {
          try {
            await rm(minted, { force: true });
          } catch {
            // 删不掉只算孤儿文件：补全已经照常被拒，这里没有别的话可说。
          }
        }
        return {
          ok: false,
          reason: "hole_not_waiting",
          message:
            result?.reason === "settled"
              ? `Run ${runId} has already settled; nothing is waiting.`
              : `Run ${runId} is not waiting at ${holeId}: it has not reached it yet, or it is already filled.`,
        };
      }

      // 引擎收下了：草稿跟着换（没有草稿的 run 用刚铸的那份；有草稿的**就地**改写，路径不变
      // ——「草稿绝不在模型背后被覆盖」的唯一例外，模型要的正是这次写入）。尽力而为：写不进去
      // 不撤销补全——journal 已经是真相，草稿只是把手。
      const finalPath = minted ?? scriptPath;
      if (minted === undefined && scriptPath !== undefined) {
        try {
          await writeFile(scriptPath, spliced.text, { encoding: "utf8" });
        } catch {
          // 草稿改写失败不撤销补全（journal 是真相）；回话里的路径照旧（文件还在，只是内容旧了）。
        }
      }
      const previousPhases = phaseNamesOf(workflow, before);
      return {
        ok: true,
        phasesAdded: compiledFill.phases.phaseNames.filter((name) => !previousPhases.has(name)),
        ...(finalPath === undefined ? {} : { scriptPath: finalPath }),
        scriptText: spliced.text,
      };
    } finally {
      db.close();
    }
  }

  // ============================================================
  // GUI 中枢的已保存工作流读面（workflows/list / workflows/get；Node 的 listSavedWorkflowsOp /
  // getSavedWorkflowOp 同一契约）。解析器与序列化器只从 @nibi/core 取——这里不解析
  // frontmatter，也不拼 YAML；sidecar 进程的 homedir 与宿主同源（隔离 HOME 由启动方设好），
  // 全局根因此指向同一份。
  // ============================================================
  interface HubListParams {
    workspacePath: string;
    scope?: string;
  }

  async function acceptHubList(params: HubListParams): Promise<unknown> {
    const scope = params.scope === "global" ? "global" : "project";
    // 中枢的 PROJECT 组只列本项目那一份，全局组只列全局那一份——**永远**传定向 scope，绝不走
    // 无向变体（两根 first-wins 会把 global 混进 project 组，把被遮蔽的 global 从全局组里藏掉）。
    const listed = listSavedWorkflows({ cwd: params.workspacePath, scope });
    // 扫过的目录（即使不存在也回）：GUI 的文件监听靠它 watch。
    return {
      workflows: listed.entries,
      invalid: listed.invalid,
      dir: savedWorkflowRoot(params.workspacePath, scope).dir,
    };
  }

  interface HubGetParams {
    workspacePath: string;
    name: string;
    scope?: string;
  }

  async function acceptHubGet(params: HubGetParams): Promise<unknown> {
    const scope = params.scope === "global" ? "global" : "project";
    // 定向 scope：`global` 只查全局根、不做遮蔽——中枢的全局组要看到被项目档遮蔽的那份。
    const resolved = resolveSavedWorkflow({
      cwd: params.workspacePath,
      name: params.name,
      scope,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason,
        ...("detail" in resolved && resolved.detail ? { detail: String(resolved.detail) } : {}),
      };
    }
    return {
      ok: true,
      name: resolved.name,
      path: resolved.path,
      scope: resolved.scope,
      meta: resolved.meta,
      script: resolved.script,
    };
  }

  // ============================================================
  // GUI 中枢的已保存工作流写面（workflows/save / updateMeta / delete / move；Node 的
  // saveSavedWorkflowFromRunOp / updateSavedWorkflowMetaOp / deleteSavedWorkflowOp /
  // moveSavedWorkflowOp 同一契约）。与读面同一条纪律：序列化器、名字规则与类型检查器都从
  // @nibi/core / @nibi/contracts 取，这里不拼 YAML、不重复正则。save 需要 journal 读 run 的
  // scriptText（Node 的同一条理由：要存的是这次 run 实际执行的那一份，调用方手上未必有）。
  // 四个方法都可能撞 fs 错误；这里把意外失败收敛成 `engine_error` 而不是让 promise 拒绝——
  // 拒绝只会变成宿主侧的悬等，业务失败袋（ok:false reason …）才是协议的正常通道。
  // ============================================================
  interface HubSaveParams {
    workspacePath: string;
    runId: string;
    dbPath: string;
    name: string;
    meta: unknown;
    scope?: string;
    overwrite?: boolean;
  }

  /** 诊断回给 GUI 的上界（Node 同值）：弹层里只放得下开头几条。 */
  const SAVE_DIAGNOSTICS_MAX_LINES = 5;
  const SAVE_DIAGNOSTICS_MAX_CHARS = 1_000;

  function boundedDiagnostics(
    diagnostics: readonly { line: number; column: number; message: string }[],
  ): string {
    const text = diagnostics
      .slice(0, SAVE_DIAGNOSTICS_MAX_LINES)
      .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
      .join("\n");
    return text.length > SAVE_DIAGNOSTICS_MAX_CHARS
      ? `${text.slice(0, SAVE_DIAGNOSTICS_MAX_CHARS)}…`
      : text;
  }

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * 协议层已按 shared schema 严格验过 meta；这里再用 contracts 的那份解析一次——「两边漂移」
   * 的追赶闸（Node 同一条）：宁可在这炸成结构化错误，也不写出一个自己读不回来的文件。
   */
  type HubMetaParse =
    | { ok: true; meta: SavedWorkflowMeta }
    | {
        ok: false;
        reply: { ok: false; reason: "engine_error"; message: string };
      };

  function parseHubMeta(meta: unknown): HubMetaParse {
    try {
      return { ok: true, meta: SavedWorkflowMetaSchema.parse(meta) };
    } catch (error) {
      return {
        ok: false,
        reply: {
          ok: false,
          reason: "engine_error",
          message: `saved workflow meta failed the contracts schema: ${describeError(error)}`,
        },
      };
    }
  }

  async function acceptHubSave(params: HubSaveParams): Promise<unknown> {
    const scope = params.scope === "global" ? "global" : "project";
    const cwd = params.workspacePath;
    // 名字先验后拼路径：这条顺序是路径穿越的防线本身（Node 同一条）。
    if (!isValidSavedWorkflowName(params.name)) return { ok: false, reason: "invalid_name" };
    const parsed = parseHubMeta(params.meta);
    if (!parsed.ok) return parsed.reply;
    const meta = parsed.meta;
    const db = openDatabase(params.dbPath);
    try {
      const journal = createDwfJournalStore(db);
      const record = journal.getRun(params.runId);
      if (record === undefined) return { ok: false, reason: "run_not_found" };
      // scriptText 落库始于 workflow-live-run；更早的记录没有可保存的脚本原文（Node 同一条）。
      if (record.scriptText === undefined) return { ok: false, reason: "script_missing" };
      const script = record.scriptText;

      const targetPath = savedWorkflowPath(savedWorkflowRoot(cwd, scope), params.name);
      // 覆盖是用户的决定，不是一次保存的副作用（Node 同一条）。
      if (params.overwrite !== true && savedWorkflowExists({ cwd, name: params.name, scope })) {
        return { ok: false, reason: "target_exists", path: targetPath };
      }

      const analysis = analyzeScript(script);
      if (!analysis.ok) {
        return {
          ok: false,
          reason: "compile_failed",
          path: targetPath,
          detail: boundedDiagnostics(analysis.diagnostics),
        };
      }

      const shadowing = findSavedWorkflowShadowing({ cwd, name: params.name, scope });
      try {
        const written = saveSavedWorkflow({ cwd, name: params.name, meta, script, scope });
        return {
          ok: true,
          name: params.name,
          scope: written.scope,
          path: written.path,
          // 写的那一刻重新判定，不回抄入参（Node 同一条理由）。
          overwritten: written.overwritten,
          ...(shadowing === undefined ? {} : { shadowing }),
        };
      } catch (error) {
        // 写失败（只读挂载、权限）是一条业务分支，不是协议错误：GUI 要把它画在弹层里。
        return { ok: false, reason: "write_error", path: targetPath, detail: describeError(error) };
      }
    } finally {
      db.close();
    }
  }

  interface HubUpdateMetaParams {
    workspacePath: string;
    name: string;
    meta: unknown;
    scope?: string;
  }

  async function acceptHubUpdateMeta(params: HubUpdateMetaParams): Promise<unknown> {
    const scope = params.scope === "global" ? "global" : "project";
    const parsed = parseHubMeta(params.meta);
    if (!parsed.ok) return parsed.reply;
    const meta = parsed.meta;
    const resolved = resolveSavedWorkflow({
      cwd: params.workspacePath,
      name: params.name,
      scope,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        reason: resolved.reason,
        ...("detail" in resolved && resolved.detail ? { detail: String(resolved.detail) } : {}),
      };
    }
    // 只改写文件顶部的元数据：读回当前脚本正文，再整文件覆写为 serialize(newMeta, script)。
    // 读-改-写在同一次调用内完成（Node 同一条，不做三方合并）。
    try {
      await writeFile(resolved.path, serializeSavedWorkflow(meta, resolved.script), "utf8");
    } catch (error) {
      // Node 里这条是协议错误（op 拒绝 → internal error）；这里收敛成 engine_error 袋，
      // 宿主映射回 internal error——同一可观测量，且 promise 不会悬挂。
      return { ok: false, reason: "engine_error", message: describeError(error) };
    }
    return { ok: true, path: resolved.path };
  }

  interface HubDeleteParams {
    workspacePath: string;
    name: string;
    scope?: string;
  }

  async function acceptHubDelete(params: HubDeleteParams): Promise<unknown> {
    const scope = params.scope === "global" ? "global" : "project";
    // 只按名字删：isValidSavedWorkflowName 先于拼路径——路径穿越的防线本身（Node 同一条）。
    if (!isValidSavedWorkflowName(params.name)) return { ok: false, reason: "invalid_name" };
    const targetPath = savedWorkflowPath(savedWorkflowRoot(params.workspacePath, scope), params.name);
    try {
      await unlink(targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "not_found" };
      return { ok: false, reason: "read_error", detail: describeError(error) };
    }
    return { ok: true, path: targetPath };
  }

  interface HubMoveParams {
    workspacePath: string;
    name: string;
  }

  async function acceptHubMove(params: HubMoveParams): Promise<unknown> {
    // 全局根的同名文件搬到 workspace 项目根（只此一向；core 的 moveSavedWorkflow 承载全部规则）。
    const result = moveSavedWorkflow({ cwd: params.workspacePath, name: params.name });
    if (result.ok) return { ok: true, from: result.from, to: result.to };
    // core 的失败分支与协议 result 逐字对齐；path / detail 在场时原样带出（缺席即省键）。
    switch (result.reason) {
      case "invalid_name":
        return { ok: false, reason: "invalid_name", detail: result.detail };
      case "not_found":
        return { ok: false, reason: "not_found" };
      case "target_exists":
        return { ok: false, reason: "target_exists", path: result.path };
      case "read_error":
      case "write_error":
        return { ok: false, reason: result.reason, path: result.path, detail: result.detail };
    }
  }

  // ============================================================
  // 「这次 run 对应哪个已保存工作流」（workflows/forRun；Node findSavedWorkflowForRunOp 同一
  // 契约）。完成卡的「已保存」芯片与「再次运行」都问这一个问题，而答案**推导得来、不记在
  // 卡上**——三规则按序命中即返回（spec 的同一顺序）：对话说的（候选）→ run 跑的（脚本逐字
  // 节相同）→ run 叫的（run 名 = 定义名）。查不到 run 记录时只跳过 2、3（候选仍然算数）。
  // ============================================================
  interface HubForRunParams {
    workspacePath: string;
    runId: string;
    dbPath: string;
    /** scope 是协议层验过的枚举（超集进不来），这里照 Node 的 zod 后形状声明。 */
    candidates?: { name: string; scope?: "project" | "global" }[];
  }

  /** 脚本比对要扫的文件数上界（Node 同值）：异常目录不至于把一次查询变成一次全盘读。 */
  const SCRIPT_MATCH_SCAN_LIMIT = 50;

  /** 解析结果 → 协议 entry（与 `workflows/list` 的行同形，不含脚本正文）。 */
  function hubEntryOf(resolved: {
    name: string;
    path: string;
    scope: string;
    meta: { description: string; whenToUse?: string; args?: Record<string, unknown> };
  }): unknown {
    return {
      name: resolved.name,
      description: resolved.meta.description,
      ...(resolved.meta.whenToUse === undefined ? {} : { whenToUse: resolved.meta.whenToUse }),
      ...(resolved.meta.args === undefined ? {} : { args: resolved.meta.args }),
      scope: resolved.scope,
      path: resolved.path,
    };
  }

  async function acceptHubForRun(params: HubForRunParams): Promise<unknown> {
    const cwd = params.workspacePath;
    const db = openDatabase(params.dbPath);
    try {
      const journal = createDwfJournalStore(db);
      const record = journal.getRun(params.runId);
      // 实参与命中与否无关：它服务的是「再次运行」的实参窗预填，run 在就给。
      const runArgs = record?.args === undefined ? {} : { runArgs: record.args };

      for (const candidate of params.candidates ?? []) {
        if (!isValidSavedWorkflowName(candidate.name)) continue;
        const resolved = resolveSavedWorkflow({
          cwd,
          name: candidate.name,
          ...(candidate.scope === undefined ? {} : { scope: candidate.scope }),
        });
        if (resolved.ok) return { entry: hubEntryOf(resolved), match: "candidate", ...runArgs };
      }

      const script = record?.scriptText;
      if (script !== undefined) {
        // 项目档先于全局档：同名遮蔽的方向就是这个方向，内容相同时也该报本项目那一份。
        for (const scope of ["project", "global"] as const) {
          const listed = listSavedWorkflows({ cwd, scope });
          for (const entry of listed.entries.slice(0, SCRIPT_MATCH_SCAN_LIMIT)) {
            const resolved = resolveSavedWorkflow({ cwd, name: entry.name, scope });
            if (resolved.ok && resolved.script === script) {
              return { entry: hubEntryOf(resolved), match: "script", ...runArgs };
            }
          }
        }
      }

      const name = record?.name;
      if (name !== undefined && isValidSavedWorkflowName(name)) {
        // 不定向：项目档 first-wins，与中枢之外的所有按名查找同规。
        const resolved = resolveSavedWorkflow({ cwd, name });
        if (resolved.ok) return { entry: hubEntryOf(resolved), match: "name", ...runArgs };
      }

      return { ...runArgs };
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
        /** 宿主每轮报的会话消息条数（先数后报）；ask 边界记账的候选值。 */
        messageCount?: number;
      };
      const run = runs.get(params.runId);
      const sink = run?.driver.sink;
      if (!sink) continue;
      // 宿主每轮都带 messageCount（先数后报）；最近一次的值在 node-settled 时补写成边界。
      if (typeof params.messageCount === "number") {
        run.driver.noteCount(params.instance, params.messageCount);
      }
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
    if (message.method === "workflows/list") {
      const id = message.id;
      void acceptHubList(message.params as HubListParams).then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "workflows/get") {
      const id = message.id;
      void acceptHubGet(message.params as HubGetParams).then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "workflows/save") {
      // 写面同规：绝不 await（save 会读 journal、编译脚本并落盘）。
      const id = message.id;
      void acceptHubSave(message.params as HubSaveParams).then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "workflows/updateMeta") {
      const id = message.id;
      void acceptHubUpdateMeta(message.params as HubUpdateMetaParams).then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "workflows/delete") {
      const id = message.id;
      void acceptHubDelete(message.params as HubDeleteParams).then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "workflows/move") {
      const id = message.id;
      void acceptHubMove(message.params as HubMoveParams).then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "workflows/forRun") {
      // 完成卡的推导判定：读 journal（dbPath）+ 现扫两根定义目录，同规不挡读循环。
      const id = message.id;
      void acceptHubForRun(message.params as HubForRunParams).then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "author/prepare" || message.method === "author/execute") {
      // 作者工具的两跳：prepare 在确认窗之前（校验 + 归一化 + 确认门），execute 在批准之后
      // （handler + model 内容）。同一条纪律：绝不 await 挡住读循环。
      const id = message.id;
      const params = message.params as AuthorParams;
      const host = authoringHost(params.dbPath, params.parentSessionId);
      const call =
        message.method === "author/prepare"
          ? host.prepare({
              tool: params.tool,
              input: params.input,
              cwd: params.cwd,
              session: params.session,
              toolCall: params.toolCall,
              hasLoadedSkill: params.hasLoadedSkill,
              models: params.models ?? [],
            })
          : host.execute({
              tool: params.tool,
              input: params.input,
              cwd: params.cwd,
              session: params.session,
              toolCall: params.toolCall,
              hasLoadedSkill: params.hasLoadedSkill,
              models: params.models ?? [],
            });
      void call.then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "holes") {
      // FillWorkflowHole 的确认前读面（run 元数据 + 留白表）。
      const id = message.id;
      void acceptHoles(message.params as HolesParams).then((result) => {
        if (id !== undefined) out({ id, result });
      });
      continue;
    }
    if (message.method === "fill") {
      // 补全会 await 编译与草稿落盘，也绝不挡读循环；同一 run 的补全在 enqueueFill 里串行。
      const id = message.id;
      void enqueueFill(message.params as FillParams).then((result) => {
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
