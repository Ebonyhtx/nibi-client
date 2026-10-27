import { spawn } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

// 非 CLI 进程（Electron/Host、存储准备 Worker）只加载模块，不拦截原始入口。
// 递归护栏：代理只允许生效一次。NODE_OPTIONS 的清理万一没匹配上（路径 vs file URL、
// 引号形式），被重启的 CLI 仍会加载本模块；没有护栏时每一代都会再 spawn 下一代，
// 实测 Windows 上一个用例能拉出 100+ 个 node 进程并把 Defender 顶到 70% CPU。
const PROXY_GUARD_ENV = "NIBI_SUBAGENT_CONFIG_PROXY_ACTIVE";
if (
  process.argv.includes("app-server") &&
  process.argv.includes("--stdio") &&
  process.env[PROXY_GUARD_ENV] !== "1"
) {
  // 仅由本组 WDIO 预加载的透明 stdio 代理。真实 Host/CLI 完成保存、解析和执行；
  // 故障位于传输边界，不修改业务对象，也不记录其他 RPC 的鉴权或模型凭据。
  const selfPath = fileURLToPath(import.meta.url);
  const selfUrl = pathToFileURL(selfPath).href;
  const preloads = [
    `--import=${JSON.stringify(selfPath)}`,
    `--import=${selfPath}`,
    `--import=${selfUrl}`,
    `--import=${JSON.stringify(selfUrl)}`,
  ];
  let nodeOptions = process.env.NODE_OPTIONS ?? "";
  for (const preload of preloads) nodeOptions = nodeOptions.replace(preload, "");
  const child = spawn(process.execPath, process.argv.slice(1), {
    stdio: ["pipe", "pipe", "inherit"],
    // 只移除当前代理预加载，保留覆盖采集等其他 Node 参数；护栏与删除双保险。
    env: {
      ...process.env,
      [PROXY_GUARD_ENV]: "1",
      NODE_OPTIONS: nodeOptions.trim(),
    },
  });
  const root = process.env.NIBI_E2E_ARTIFACT_DIR;
  const control = join(root, "subagent-config-control.json");
  const log = join(root, `subagent-config-rpc-${child.pid}.jsonl`);
  const pending = new Map();
  let outbound = Promise.resolve(),
    inbound = Promise.resolve();
  const writeLog = (event) =>
    appendFile(
      log,
      JSON.stringify({
        time: Date.now(),
        pid: child.pid,
        hostPid: process.ppid,
        cwd: process.cwd(),
        ...event,
      }) + "\n",
    );
  createInterface({ input: child.stdout }).on("line", (line) => {
    outbound = outbound
      .then(async () => {
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          process.stdout.write(line + "\n");
          return;
        }
        if (frame.method === "subagents/readRuntimeConfig") {
          const state = JSON.parse(await readFile(control, "utf8").catch(() => "{}"));
          const sessionId = frame.params.sessionId;
          const failed = state.failedSessionIds?.includes(sessionId) === true;
          await writeLog({ kind: "read", sessionId, failed });
          // 重载不再阻塞 RPC；关闭用例在测试传输边界保持请求待决，独立验证真实断连取消。
          if (state.heldSessionIds?.includes(sessionId)) {
            await writeLog({ kind: "held", sessionId });
            return;
          }
          if (failed) {
            child.stdin.write(
              JSON.stringify({
                id: frame.id,
                error: { code: -32603, message: "E2E_CONFIG_UNAVAILABLE" },
              }) + "\n",
            );
            return;
          }
          pending.set(frame.id, sessionId);
        }
        process.stdout.write(line + "\n");
      })
      .catch((error) => {
        process.stderr.write(String(error));
        process.exitCode = 1;
        child.kill();
      });
  });
  createInterface({ input: process.stdin })
    .on("line", (line) => {
      inbound = inbound
        .then(async () => {
          const frame = JSON.parse(line);
          if (pending.has(frame.id)) {
            await writeLog({
              kind: "snapshot",
              sessionId: pending.get(frame.id),
              snapshot: frame.result,
              error: frame.error,
            });
            pending.delete(frame.id);
          }
          child.stdin.write(line + "\n");
        })
        .catch((error) => {
          process.stderr.write(String(error));
          process.exitCode = 1;
          child.kill();
        });
    })
    .on("close", () => {
      void inbound.then(() => child.stdin.end());
    });
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => {
    void Promise.all([inbound, outbound]).finally(() => process.exit(code ?? 1));
  });
  // 预加载阶段等待代理子进程退出，不能再次执行当前进程原定的 CLI 入口。
  await new Promise(() => {});
}
