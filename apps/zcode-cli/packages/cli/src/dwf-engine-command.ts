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
 *                   `{id, method:"cancel", params:{runId}}`
 *   engine → 宿主：`actor/create`（建 actor 子会话，回 `{session:{id}}`）
 *                   `world/read`（files.glob/read/grep，回结果）
 *                   `ask/start` / `ask/verdict` / `ask/cancel` / `run/event`（通知）
 *   宿主 → engine：`{method:"ask/reply", params:{runId, instance, kind:"submit"|"text"|"fail", payload/text}}`
 *
 * 不变式：读循环绝不 `await` 一个 run——run 期间的 RPC 响应也走这条 stdin，阻塞读循环会死锁。
 */
import { DatabaseSync } from "node:sqlite";

import { createDwfJournalStore } from "@nibi/adapters/storage";
import { resolveSavedWorkflow, validateWorkflowArgs } from "@nibi/core";
import {
  buildAskSpecs,
  collectDiagnostics,
  collectSites,
  createWorkflowProgram,
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

function askSpecsFor(scriptText: string): Map<string, AskSpec> {
  const workflow = createWorkflowProgram(scriptText);
  const table = collectSites(workflow);
  const { schemas } = synthesizeAskSchemas(workflow, table);
  return buildAskSpecs(table, schemas);
}

/** 一次 run 的后台执行（受理/恢复共用）：开 journal、建 driver、跑引擎、发 run/settled。 */
function launchRun(
  params: {
    runId: string;
    parentSessionId: string;
    cwd: string;
    dbPath: string;
    scriptText: string;
    args: Record<string, unknown>;
    caps: { maxConcurrency?: number };
  },
  request: (method: string, params: unknown) => Promise<unknown>,
  notify: (method: string, params: unknown) => void,
  runs: Map<string, { driver: RemoteDriver; abort: AbortController; db: DatabaseSync }>,
): Promise<RunSettlement> {
  const db = new DatabaseSync(params.dbPath);
  const journal = createDwfJournalStore(db);
  const driver = new RemoteDriver(params.runId, journal, request, notify);
  const abort = new AbortController();
  runs.set(params.runId, { driver, abort, db });
  const settlement = runWorkflowScript({
    scriptText: params.scriptText,
    cwd: params.cwd,
    runId: params.runId,
    parentSessionId: params.parentSessionId,
    args: params.args,
    caps: { maxConcurrency: params.caps.maxConcurrency ?? 4 },
    askSpecs: askSpecsFor(params.scriptText),
    validate: validateFn,
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
    .finally(() => {
      runs.delete(params.runId);
      db.close();
    });
  return settlement as Promise<RunSettlement>;
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
  | { ok: true; accepted: true }
  | { ok: false; reason: string; message: string };

/** driver：引擎的手，每一下都伸回宿主。 */
class RemoteDriver {
  readonly journal: JournalStorePort;
  sink: WorkflowSink | undefined;
  private readonly runId: string;
  private readonly request: (method: string, params: unknown) => Promise<unknown>;
  private readonly notify: (method: string, params: unknown) => void;

  constructor(
    runId: string,
    journal: JournalStorePort,
    request: (method: string, params: unknown) => Promise<unknown>,
    notify: (method: string, params: unknown) => void,
  ) {
    this.runId = runId;
    this.journal = journal;
    this.request = request;
    this.notify = notify;
  }

  attach(sink: WorkflowSink): void {
    this.sink = sink;
  }

  async createActorSession(
    actor: { siteId: string; ordinal: number },
    persona: PersonaSpec,
  ): Promise<SessionRef> {
    const reply = (await this.request("actor/create", {
      runId: this.runId,
      actor,
      persona,
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
    this.notify("run/event", { runId: this.runId, type: event.type });
  }
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
  const runs = new Map<
    string,
    { driver: RemoteDriver; abort: AbortController; db: DatabaseSync }
  >();

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

    // 受理之后在后台跑；结算以 `run/settled` 通知宿主。
    void launchRun(
      {
        runId: params.runId,
        parentSessionId: params.parentSessionId,
        cwd: params.cwd,
        dbPath: params.dbPath,
        scriptText,
        args: args ?? {},
        caps: params.caps ?? { maxConcurrency: 4 },
      },
      request,
      notify,
      runs,
    ).then((settlement) => notify("run/settled", { runId: params.runId, settlement }));
    return { ok: true, accepted: true };
  }

  /** 一次 resume 的受理：只认可恢复集（`stopped` 且非 `superseded`），从 journal 取脚本与实参。 */
  async function acceptResume(params: { runId: string; dbPath: string }): Promise<
    | { ok: true; accepted: true; parentSessionId: string; cwd: string }
    | { ok: false; reason: string; message: string }
  > {
    const db = new DatabaseSync(params.dbPath);
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
      ).then((settlement) => notify("run/settled", { runId: params.runId, settlement }));
      return { ok: true, accepted: true, parentSessionId, cwd };
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
    if (message.method === "cancel") {
      const params = message.params as { runId: string };
      runs.get(params.runId)?.abort.abort();
      continue;
    }
  }
  return 0;
}
