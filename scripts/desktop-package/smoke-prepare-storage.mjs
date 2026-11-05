#!/usr/bin/env node
/**
 * 打包产物的内核冒烟：对给定内核二进制（打包位次是 `nibi-rs`）跑 `--prepare-storage` 握手。
 *
 * 握手形状照抄桌面宿主的实现（packages/desktop/src/host/database-startup/
 * storagePreparationProcesses.ts 的 runStorageHandshakeLines）：
 *   binary 发 `startup/storagePath` → 我们回 `{"method":"startup/storagePathReady","reuse":false}`
 *   → binary 发 `startup/storageState`（checking/ready 各相）→ binary 发 `startup/storagePrepared`
 *   → 成功退出。phase:"failed" 或 30s 首帧超时 = 失败。
 *
 * 隔离纪律与 kernel-baseline 同一条：五个根变量全改，绝不写真实 ~/.nibi。
 * 用法：node scripts/desktop-package/smoke-prepare-storage.mjs <path-to-kernel-binary>
 * 退出码 0 = 冒烟通过；非 0 = 失败原因在 stderr。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const binary = resolve(process.argv[2] ?? "");
if (!binary) {
  console.error("usage: node smoke-prepare-storage.mjs <path-to-kernel-binary>");
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), "nibi-kernel-smoke-"));
const dataV2 = join(home, ".nibi", "v2");
const workspace = join(home, "workspace");
// spawn 的 cwd 必须真实存在（ENOENT 会指向二进制，误导排障）。
mkdirSync(workspace, { recursive: true });
const child = spawn(binary, ["app-server", "--stdio", "--prepare-storage"], {
  cwd: workspace,
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    NIBI_DATA_BASE_DIR: home,
    NIBI_STORAGE_DIR: join(home, ".nibi"),
    NIBI_SETTINGS_DIR: dataV2,
    NIBI_CREDENTIAL_SECRET: "kernel-package-smoke-fixture-only",
  },
});

const FIRST_FRAME_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 120_000;
let firstFrameTimer = setTimeout(() => fail("first frame timed out"), FIRST_FRAME_TIMEOUT_MS);
const overallTimer = setTimeout(() => fail("smoke exceeded the overall time budget"), OVERALL_TIMEOUT_MS);
let pathReceived = false;

function cleanup() {
  clearTimeout(firstFrameTimer);
  clearTimeout(overallTimer);
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {
    // Windows 上子进程刚退句柄可能还没放干净；临时目录清不掉不影响判定。
  }
}

function fail(reason) {
  console.error(`[smoke-prepare-storage] FAILED: ${reason}`);
  child.kill();
  cleanup();
  process.exit(1);
}

function pass() {
  console.log("[smoke-prepare-storage] OK: the packaged kernel completed the storage handshake");
  child.kill();
  cleanup();
  process.exit(0);
}

child.on("error", (error) => fail(`spawn failed: ${error.message}`));
child.on("exit", (code) => {
  if (code !== null && code !== 0) fail(`kernel exited with code ${code}`);
});

const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  if (line.length > 65_536) fail("oversized control frame");
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return; // 非 JSON 行（日志尾巴）忽略——与宿主同判。
  }
  clearTimeout(firstFrameTimer);
  const method = frame.method;
  if (method === "startup/storagePath") {
    if (pathReceived) fail("duplicate storagePath frame");
    pathReceived = true;
    child.stdin.write(`${JSON.stringify({ method: "startup/storagePathReady", reuse: false })}\n`);
    return;
  }
  if (method === "startup/storagePrepared") {
    if (!pathReceived) fail("storagePrepared before storagePath");
    pass();
    return;
  }
  if (frame.params?.phase === "failed") {
    fail(`kernel reported phase=failed (${frame.params.errorCode ?? "sql_failed"})`);
    return;
  }
  if (frame.params?.phase) {
    console.log(`[smoke-prepare-storage] phase=${frame.params.phase} db=${frame.params.databaseId ?? "?"}`);
  }
});
