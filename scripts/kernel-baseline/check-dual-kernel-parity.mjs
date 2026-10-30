/**
 * 双内核对拍门禁：同一 driver 分别驱动 Rust 与 Node app-server，逐字段比较。
 *
 *   node scripts/kernel-baseline/check-dual-kernel-parity.mjs
 *
 * 必需字段（任一不同 → exit 1）：
 *   createSessionPrefix、sendTextStatus、renameStatus、
 *   switchModelChangeStatus、switchModelNoopStatus、switchModelNoopCode、
 *   switchModeChangeStatus、switchModeSameStatus、forkChildPrefix、
 *   editStatus、retryStatus、cancelStatus、cancelCode、
 *   mcpToolOffered、mcpOfferedInFirstRequest、mcpToolCalled、mcpToolResult、
 *   attachmentStatus、attachmentCode、attachmentRowRefs、additionalDirInPrompt、
 *   queueEnqueued、queueEditStatus、queueReorderStatus、queueDeleteStatus、
 *   queueDeleteMissingStatus、queueDeleteMissingCode、queueAutoDrainStatus、
 *   queuePromoteStatus、queuePromotedInRequest、feedbackStatus、snoozeStatus、
 *   goalSetStatus、goalPauseStatus、goalResumeStatus、
 *   sideSessionStatus、sideSessionChildPrefix、sideSessionDistinct
 *
 * 已知差异（只报告，不判失败）：
 *   - attachmentReplayed：本地路径图片，Rust 读文件并内联进请求；Node 在 OpenAI-compatible
 *     的本地路径分支降级成 `[Attached <mime>: <path>]` 文本（artifact URI 形态才回读 data URL）。
 *   - metrics：provider 请求数/帧数/通知数（Node 多标题与遥测通知）。
 *
 * 前提：`cargo build -p rust-cli` 产出 kernel/target/debug/zcode-rs.exe，
 * 且 apps/zcode-cli/packages/cli/dist/nibi.cjs 已构建。
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const driver = resolve(here, "drive-rust-app-server.mjs");

const REQUIRED = [
  "createSessionPrefix",
  "sendTextStatus",
  "renameStatus",
  "switchModelChangeStatus",
  "switchModelNoopStatus",
  "switchModelNoopCode",
  "switchModeChangeStatus",
  "switchModeSameStatus",
  "forkChildPrefix",
  "editStatus",
  "retryStatus",
  "cancelStatus",
  "cancelCode",
  "mcpToolOffered",
  "mcpOfferedInFirstRequest",
  "mcpToolCalled",
  "mcpToolResult",
  "attachmentStatus",
  "attachmentCode",
  "attachmentRowRefs",
  "additionalDirInPrompt",
  "queueEnqueued",
  "queueEditStatus",
  "queueReorderStatus",
  "queueDeleteStatus",
  "queueDeleteMissingStatus",
  "queueDeleteMissingCode",
  "queueAutoDrainStatus",
  "queuePromoteStatus",
  "queuePromotedInRequest",
  "feedbackStatus",
  "snoozeStatus",
  "goalSetStatus",
  "goalPauseStatus",
  "goalResumeStatus",
  "sideSessionStatus",
  "sideSessionChildPrefix",
  "sideSessionDistinct",
  "hookAdmissionPending",
  "hookReviewRequestStatus",
  "hookReviewInteractionKind",
  "hookReviewGeneration",
  "hookReviewHookCount",
  "hookReviewPendingCount",
  "hookReviewEventCount",
  "hookReviewItemType",
  "hookReviewItemMode",
  "hookReviewItemTrust",
  "hookReviewItemDisplayName",
  "hookReviewWarning",
  "hookReviewSourcePath",
  "hookReviewRespondStatus",
  "hookReviewSettled",
  "hookAdmissionCleared",
  "hookTrustRecordDigest",
  "hookTrustRecordIdentity",
  "hookReviewRevokeStatus",
  "hookAdmissionRestored",
  "hookToggleStatus",
  "hookToggleConfigEnabled",
  "hookToggleGeneration",
  "hookToggleConfiguredEnabled",
  "hookToggleRestored",
];
const KNOWN_DIFFERENT = ["attachmentReplayed"];

function run(kernel) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [driver, `--kernel=${kernel}`], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
            `${kernel} driver produced no RESULT (exit ${code})\nstdout tail:\n${stdout.split(/\r?\n/).slice(-8).join("\n")}\nstderr tail:\n${stderr.split(/\r?\n/).slice(-8).join("\n")}`,
          ),
        );
        return;
      }
      try {
        resolveRun(JSON.parse(line.slice("RESULT:".length)));
      } catch (error) {
        rejectRun(new Error(`${kernel} RESULT is not JSON: ${error}`));
      }
    });
  });
}

const [rust, node] = await Promise.all([run("rust"), run("node")]);
const rows = [];
let failed = false;

for (const field of REQUIRED) {
  const left = rust.checks?.[field] ?? null;
  const right = node.checks?.[field] ?? null;
  const ok = left === right;
  if (!ok) failed = true;
  rows.push({ field, rust: left, node: right, ok, known: false });
}
for (const field of KNOWN_DIFFERENT) {
  rows.push({
    field,
    rust: rust.checks?.[field] ?? null,
    node: node.checks?.[field] ?? null,
    ok: true,
    known: true,
  });
}

console.log("field                          | rust                           | node                           | verdict");
console.log("-------------------------------+--------------------------------+--------------------------------+--------");
for (const row of rows) {
  const verdict = row.known ? "known-diff" : row.ok ? "match" : "MISMATCH";
  console.log(
    `${row.field.padEnd(30)} | ${String(row.rust).padEnd(30)} | ${String(row.node).padEnd(30)} | ${verdict}`,
  );
}
console.log("");
console.log(
  `metrics: rust=${JSON.stringify(rust.metrics)} node=${JSON.stringify(node.metrics)}`,
);
console.log(`startup: rust=${rust.checks?.startupMs ?? "?"}ms node=${node.checks?.startupMs ?? "?"}ms`);
console.log("");
console.log(
  failed
    ? "RESULT: MISMATCH"
    : `RESULT: OK (${REQUIRED.length} required fields match; model-side attachment rendering is a known difference)`,
);
if (failed) process.exitCode = 1;
