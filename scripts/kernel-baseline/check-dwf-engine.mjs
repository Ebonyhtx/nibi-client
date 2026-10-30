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
];

function run(kernel) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      [driver, `--kernel=${kernel}`, "--phases=create,dwfEngine,dwfResume,dwfAmend,dwfEscalate"],
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

const [rust, node] = await Promise.all([run("rust"), run("node")]);
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
