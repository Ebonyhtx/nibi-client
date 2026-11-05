/**
 * 冷恢复门禁（v4 subscribe 的恢复提示）：两段式，先建会话、再用**新进程**订阅持久化会话。
 *
 *   node scripts/kernel-baseline/check-cold-resume.mjs
 *
 * 每段都跑 Rust 与 Node 两个内核：
 *   1) `--keep` 正常跑完整阶段（会话必须干净收尾，进程被中途杀掉会留下未结束的回合）；
 *   2) 用第一段打印的 home 与会话 ID 起新进程，subscribe 带 `additionalDirectories` 与
 *      `resumeThoughtLevel`，再发一条输入：必须产生**新的**模型请求，且环境段里有恢复时新加的目录
 *      （只出现在 subscribe 参数里，只能来自冷恢复提示）。
 *
 * 前提：`cargo build -p rust-cli` 产出 `kernel/target/debug/nibi-rs.exe`，
 * 且 `apps/zcode-cli/packages/cli/dist/nibi.cjs` 已构建。
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const driver = resolve(here, "drive-rust-app-server.mjs");

function run(args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [driver, ...args], {
      cwd: repo,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      const lines = stdout.split(/\r?\n/);
      const result = lines.find((line) => line.startsWith("RESULT:"));
      const session = lines.find((line) => line.startsWith("createSession: "));
      const home = lines.find((line) => line.startsWith("home: "));
      if (code !== 0 || !result) {
        rejectRun(
          new Error(
            `driver ${args.join(" ")} failed (exit ${code})\nstdout tail:\n${lines.slice(-8).join("\n")}\nstderr tail:\n${stderr.split(/\r?\n/).slice(-8).join("\n")}`,
          ),
        );
        return;
      }
      resolveRun({
        checks: JSON.parse(result.slice("RESULT:".length)).checks ?? {},
        sessionId: session?.slice("createSession: ".length).trim(),
        home: home?.slice("home: ".length).trim(),
      });
    });
  });
}

async function probe(kernel) {
  const created = await run([`--kernel=${kernel}`, "--keep"]);
  if (!created.sessionId || !created.home) {
    throw new Error(`${kernel}: create run printed no session id or home`);
  }
  const resumed = await run([
    `--kernel=${kernel}`,
    `--resume=${created.sessionId}`,
    `--home=${created.home}`,
  ]);
  return { created, resumed };
}

const [rust, node] = await Promise.all([probe("rust"), probe("node")]);

const fields = ["resumeReplied", "resumeAdditionalDir"];
const rows = [];
let failed = false;
for (const field of fields) {
  const left = rust.resumed.checks?.[field] ?? null;
  const right = node.resumed.checks?.[field] ?? null;
  const ok = left === right && left === true;
  if (!ok) failed = true;
  rows.push({ field, rust: left, node: right, ok });
}

console.log("field                     | rust                           | node                           | verdict");
console.log("--------------------------+--------------------------------+--------------------------------+--------");
for (const row of rows) {
  console.log(
    `${row.field.padEnd(25)} | ${String(row.rust).padEnd(30)} | ${String(row.node).padEnd(30)} | ${row.ok ? "match" : "MISMATCH"}`,
  );
}
console.log("");
console.log(`sessions: rust=${rust.created.sessionId} node=${node.created.sessionId}`);
console.log("");
console.log(failed ? "RESULT: MISMATCH" : "RESULT: OK (cold resume restores subscribe hints on both kernels)");
if (failed) process.exitCode = 1;
