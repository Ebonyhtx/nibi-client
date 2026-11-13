/**
 * P4 真机验收（可选，默认跳过）：对**我们自己起的记事本**跑一遍"观察 → 打字 → 读回"。
 *
 * 开启：
 *   NIBI_CUA_NATIVE_ACCEPTANCE=1 node --test test/nativeAcceptance.test.mjs --typed
 * 前置：
 *   · 已 `pnpm --filter @nibi/desktop prepare:cua-helper`（生成 <repo>/.staging/tools/cua-helper）
 *   · Windows 上有 notepad.exe
 *
 * 为什么要它：单测用的是假引擎，验证不了"引擎真能把字打进一个真实应用"。
 * 这段跑的是**打包出来的 Helper + 真引擎**，并且只碰我们自己 spawn 的记事本，
 * 不点、不动用户任何窗口；验证方式是**重读 AX 树**看字符是否真在里面（不是看回执自述）。
 */
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
// 只读档用 NIBI_CUA_NATIVE_ACCEPTANCE=1，带打字的那档用 =typed（或加 --typed）。
const ENABLED = Boolean(process.env.NIBI_CUA_NATIVE_ACCEPTANCE || process.argv.includes("--typed"));
const WANTS_TYPED = process.argv.includes("--typed") || process.env.NIBI_CUA_NATIVE_ACCEPTANCE === "typed";

test("真机：记事本 观察 → 打字 → 重读 AX 树验证", { skip: !ENABLED }, async () => {
  const { resolveWindowsCuaRuntime } = await import(
    "../../services/src/cua-permission-broker/windowsCuaDevRuntime.js"
  );
  const { callBrokerMethod, mintBrokerSocketPath } = await import("../broker.js");

  const devRoot = process.env.NIBI_CUA_DEV_ROOT?.trim();
  const resolved = devRoot
    ? await resolveWindowsCuaRuntime({
        platform: "win32",
        arch: process.arch,
        env: { ...process.env, NIBI_CUA_DEV_ROOT: devRoot },
      })
    : await resolveWindowsCuaRuntime({
        platform: "win32",
        arch: process.arch,
        resourcesPath: join(REPO_ROOT, ".staging"),
        electronVersion: JSON.parse(
          readFileSync(join(REPO_ROOT, "node_modules/electron/package.json"), "utf8"),
        ).version,
      });

  const socketPath = mintBrokerSocketPath();
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NIBI_CUA_HELPER_ADDON: resolved.addonPath,
  };
  // 不给 NIBI_CUA_ENGINE_MODULE：逼 helper 按包内相对路径解析引擎（打包态的解析顺序）。
  delete env.NIBI_CUA_ENGINE_MODULE;
  const helper = fork(resolved.entryPath, ["--socket", socketPath, "--parent-pid", String(process.pid)], {
    cwd: resolved.root,
    env,
    execPath: resolved.command,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  helper.stderr?.on("data", (chunk) => process.stderr.write(String(chunk).slice(0, 400)));

  let ready = false;
  helper.on("message", (message) => {
    if (message?.type === "transport_ready") ready = true;
  });
  const deadline = Date.now() + 20_000;
  while (!ready && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(ready, "Helper 应在 20s 内握手");

  const call = (method, params) =>
    callBrokerMethod({ socketPath, method, params, timeoutMs: 30_000 });

  const notepad = spawn("notepad.exe", []);
  try {
    let window;
    for (let attempt = 0; attempt < 20 && !window; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const listed = await call("list_windows", { pid: notepad.pid });
      window = listed?.windows?.[0];
    }
    assert.ok(window, "应能找到我们起的记事本窗口");
    const windowId = String(window.windowId ?? window.window_id);

    const state = await call("get_app_state", { window_id: windowId });
    assert.ok(state.elements.length > 0, "AX 树不该是空的");
    assert.ok(
      state.elements.some((element) => typeof element.token === "string"),
      "元素必须带 token（没有它就只能退化成坐标点击）",
    );

    if (!WANTS_TYPED) return; // 只读档到此为止

    const editable = state.elements.find((element) => element.editable === true);
    assert.ok(editable, "应能找到可编辑元素");
    const text = `NIBI CUA ${Date.now()}`;
    const receipt = await call("type", {
      text,
      element_token: editable.token,
      window_id: windowId,
      session_id: "sess-acceptance",
    });
    assert.notEqual(receipt.dispatch_status, "possibly_sent", `打字不该走到 possibly_sent：${receipt.text ?? ""}`);

    const after = await call("get_app_state", { window_id: windowId });
    assert.ok(
      String(after.text).includes(text.slice(-6)),
      `重读 AX 树应能看到刚打的字；回执=${JSON.stringify(receipt).slice(0, 200)}`,
    );
  } finally {
    notepad.kill();
    helper.send({ protocol: "nibi-cua-windows-dev/v1", type: "shutdown" });
    await Promise.race([once(helper, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (helper.exitCode === null) helper.kill();
  }
});
