/**
 * DWF 引擎门禁（路线 C）：同一 driver 的两个内核各跑 `create,dwfEngine`，逐字段比较。
 *
 *   NIBI_DWF_ENGINE_CMD='{"command":"node","args":["<repo>/apps/zcode-cli/packages/cli/dist/nibi.cjs","__nibi-dwf-engine"]}' \
 *     node scripts/kernel-baseline/check-dwf-engine.mjs
 *
 * Rust 侧需要 `NIBI_DWF_ENGINE_CMD`（没有它三条 DWF 命令回 capabilityUnsupported）；Node 侧忽略它。
 * 前提：`cargo build -p rust-cli` 与 `pnpm --filter @nibi/cli build`。
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const driver = resolve(here, "drive-rust-app-server.mjs");

const REQUIRED = [
  "dwfStartStatus",
  "dwfStartRunPrefix",
  "dwfStartToolCall",
  "dwfMissingStatus",
  "dwfMissingCode",
  "dwfRunStatus",
  "dwfRunParent",
  "dwfHoldStart",
  "dwfResumeLiveCode",
  "dwfCancelStatus",
  "dwfResumeStatus",
  "dwfResumeCode",
  "dwfResumedStatus",
  "dwfAmendStart",
  "dwfAmendRetuneStatus",
  "dwfAmendRetuneSameRun",
  "dwfAmendRetuneCaps",
  "dwfAmendStatus",
  "dwfAmendChangedRun",
  "dwfAmendSuperseded",
  "dwfAmendOldStop",
  "dwfAmendLineage",
  "dwfAmendStoredModel",
  "dwfAmendCompleted",
  "dwfAmendActorModel",
  // 脚本点名的模型绑定（launch.md「Models the script names」）：launch 时解成规范串落
  // run-launched，actor 的选型按它（persona 点名 > run 级），修订沿用同名绑定。
  "dwfBindingsLaunch",
  "dwfBindingsActorModel",
  "dwfBindingsAmend",
  // 控制轮（中枢启动轮 + 修订成功后父会话里的 controlOnly 记录）：句面、元数据与冷恢复键。
  "dwfLaunchTurnText",
  "dwfLaunchTurnMeta",
  "dwfSettingsTurnCount",
  "dwfSettingsTurnRetuneInPlace",
  "dwfSettingsTurnRetuneMeta",
  "dwfSettingsTurnName",
  "dwfSettingsTurnAmendModel",
  "dwfSettingsTurnAmendSupersedes",
  "dwfSettingsTurnAmendMeta",
  "dwfSettingsTurnSource",
  // 活投影的 controlOnly 面：中枢启动/设置轮的轮头与输入行都是 workflowLaunch origin +
  // executionKind=controlOnly + 元数据上行，收口不带 activeMs（Node product-projection 同形）。
  "dwfControlRows",
  "dwfControlRowShape",
  // 终态通知的模型面文本 + 记录级 originMeta（run/settled → 父会话）：归一后的长度/指纹
  // 互比（system-reminder 包装与每内核现铸的 uuid 归一），逐字节对齐由它钉住。
  "dwfNoticeText",
  // 后台通知轮的轮头面（escalation 的后台通知在父会话开的 model-only 轮）：轮头
  // origin=backgroundResult、executionKind=agent（Node turnHeaderOrigin("background_task")）。
  "dwfNoticeRow",
  // escalation manifest 的判别分支：升级通知记录的 originMeta.workflowNotification
  // （kind/qid/actor/question 与信封同源，qid uuid 段归一）——Node notifyEscalationRaised 同形。
  "dwfEscalateMeta",
  // 留白到达的通知链：`<workflow-hole>` 信封的文本指纹（uuid/墙钟/工作区路径归一）与
  // originMeta 的 kind:"hole" manifest（Node notifyHoleReached 同形）。
  "dwfHoleNotice",
  "dwfHoleMeta",
  // 留白补全（FillWorkflowHole 的工具面）：通知轮里读技能 → 交函数体 → 放行停驻分支 → run
  // 跑到 completed。补全回话的指纹、fill 文件逐字节、草稿就地改写、journal 双轨（hole-filled
  // 的 filledAt/filledBy/scriptPath）、run 行与终态通知。
  "dwfHoleFill",
  "dwfHoleFillFile",
  "dwfHoleDraftRewritten",
  "dwfHoleJournal",
  "dwfHoleRunRow",
  "dwfHoleSettled",
  // NIBI 协议中枢（workflows/runs，Node listSavedWorkflowRunsOp 同一契约）：页数与顺序、
  // 名字过滤（holeprobe）、截断（多取一条判 truncated）与参数违规 -32602。
  "dwfRunsCount",
  "dwfRunsOrder",
  "dwfRunsNamed",
  "dwfRunsTruncated",
  "dwfRunsInvalid",
  // resume 的模型 pin：修订把 subagentModel 写进 run-launched，取消再恢复之后 actor 仍跑在
  // pin 住的模型上（无 persona 点名的 fixture——run 级模型是唯一选型来源，掉回会话默认即
  // pin 丢失）。
  "dwfPinStart",
  "dwfPinAmend",
  "dwfPinCancel",
  "dwfPinResume",
  "dwfPinResumedActor",
  "dwfPinResumed",
  "dwfPinStored",
  // ask 边界记账（导入链第一环）：完结的 ask 节点带 messageBoundary。
  "dwfImportBoundary",
  "dwfEscalateStart",
  "dwfEscalateStatus",
  "dwfEscalateRaised",
  "dwfEscalateQidPrefix",
  "dwfEscalateResolved",
  "dwfEscalateAnswered",
  // journal 双轨（dwf_event 里的升级事件）：事件流、载荷形状、问答配对与答案。
  "dwfEscalateJournalTypes",
  "dwfEscalateJournalRaisedShape",
  "dwfEscalateJournalRaisedQuestion",
  "dwfEscalateJournalQidPrefix",
  "dwfEscalateJournalOrderOk",
  "dwfEscalateJournalAnswer",
  // run 详情工具（GetWorkflowRun，升级文案引用的查询兜底）：状态、摘要、用量、归属、
  // 待答区缺席与 run_not_found。
  "dwfRunToolStatus",
  "dwfRunToolCompletedSummary",
  "dwfRunToolUsage",
  "dwfRunToolOwned",
  "dwfRunToolAmendable",
  "dwfRunToolPendingAbsent",
  "dwfRunToolLogTailShape",
  "dwfRunToolNotFound",
  // 情势截面（health / phases / subagents）与产物清单：块存在性、行形状与 journal 对账。
  "dwfRunToolHealth",
  "dwfRunToolSubagentRow",
  "dwfRunToolSubagentTokens",
  "dwfRunToolPhases",
  "dwfRunToolArtifacts",
];

function run(kernel) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [driver, `--kernel=${kernel}`, "--phases=create,dwfEngine,dwfResume,dwfAmend,dwfEscalate,dwfHole,dwfRuns,dwfResumePin"],
      { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      const line = stdout
        .split(/\r?\n/)
        .find((candidate) => candidate.startsWith("RESULT:"));
      if (!line) {
        rejectRun(
          new Error(
            `${kernel} driver produced no RESULT (exit ${code})\nstdout tail:\n${stdout.split(/\r?\n/).slice(-6).join("\n")}\nstderr tail:\n${stderr.split(/\r?\n/).slice(-6).join("\n")}`,
          ),
        );
        return;
      }
      resolveRun(JSON.parse(line.slice("RESULT:".length)));
    });
  });
}

// 串行跑两个驱动：并行时各自的会话轮调度互相争 CPU，探针的轮询窗口（30s 级）偶发超时
// （dwfRunTool 的 GetWorkflowRun 探针两次在 node 侧被拖爆）。DWF 门禁一次几分钟，串行更稳。
const rust = await run("rust");
const node = await run("node");
let failed = false;
for (const field of REQUIRED) {
  const left = rust.checks?.[field] ?? null;
  const right = node.checks?.[field] ?? null;
  const ok = left === right;
  if (!ok) failed = true;
  console.log(
    `${field.padEnd(28)} | ${String(left).padEnd(28)} | ${String(right).padEnd(28)} | ${ok ? "match" : "DIFF"}`,
  );
}
console.log(`RESULT: ${failed ? "FAILED" : "OK"} (${REQUIRED.length} DWF fields)`);
process.exit(failed ? 1 : 0);
