/**
 * 引擎的 daemon 分支：daemon 优先、失败回退、收尾，以及 nativeCursor 的诚实上报。
 *
 * 为什么单独钉：ghost 只由 daemon 画（进程内 SDK 在 Windows 上不建 overlay 窗口），
 * 而宿主靠 `nativeCursor` 决定"要不要再叠自己的光标"——这个布尔值错了就会出现两个光标，
 * 或者一个都没有。这些判据不依赖真机与真引擎。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createCuaDriverEngine, resolveDaemonPath } from "../engine/cua-driver.js";
import { state } from "./fixtures/fake-daemon-module.mjs";

const moduleUrl = new URL("./fixtures/fake-daemon-module.mjs", import.meta.url).href;

function resetState() {
  state.hostStarts = 0;
  state.hostStops = 0;
  state.connects = [];
  state.shutdowns = 0;
  state.toolCalls = [];
  state.failStart = false;
  state.daemonUnavailable = false;
  state.embeddedUnavailable = false;
}

test("daemon 起来时：走 daemon、nativeCursor=true、收尾同时关 driver 与 host", async () => {
  resetState();
  const engine = await createCuaDriverEngine({ moduleUrl, daemonPath: "C:\\fake\\cua-driver.exe" });
  assert.equal(engine.engineMode, "daemon");
  assert.equal(engine.nativeCursor, true);
  assert.equal(state.hostStarts, 1);
  assert.deepEqual(state.connects, ["\\\\.\\pipe\\fake-cua-daemon"]);

  await engine.callTool("click", { x: 10, y: 20, window_id: 1, pid: 2 });
  const cursorSession = state.toolCalls.find(
    (call) => call.name === "set_agent_cursor_enabled",
  )?.args.session;
  assert.equal(typeof cursorSession, "string");
  const clickCall = state.toolCalls.find((call) => call.name === "click");
  assert.equal(clickCall?.args.session, cursorSession, "cursor 动作必须带上 overlay 会话");

  await engine.close();
  assert.equal(state.shutdowns, 1, "先关 driver");
  assert.equal(state.hostStops, 1, "再停 daemon");
});

test("daemon 起不来时回退进程内引擎：动作照旧、nativeCursor=false、不残留 host", async () => {
  resetState();
  state.failStart = true;
  const engine = await createCuaDriverEngine({ moduleUrl, daemonPath: "C:\\fake\\cua-driver.exe" });
  assert.equal(engine.engineMode, "embedded");
  assert.equal(engine.nativeCursor, false);
  assert.equal(state.hostStops, 1, "失败的 host 必须 stop，不能留半启动进程");

  const windows = await engine.listWindows();
  assert.deepEqual(windows, { windows: [] });
  await engine.close();
  assert.equal(state.hostStops, 1, "embedded 模式不得再 stop 一次");
});

test("daemon 连上了但不可用：同样回退（isAvailable=false 不能当成功）", async () => {
  resetState();
  state.daemonUnavailable = true;
  const engine = await createCuaDriverEngine({ moduleUrl, daemonPath: "C:\\fake\\cua-driver.exe" });
  assert.equal(engine.engineMode, "embedded");
  assert.equal(engine.nativeCursor, false);
  assert.equal(state.hostStops, 1);
});

test("没有 daemon 可执行文件时不尝试拉起（清单/暂存缺件时的常态）", async () => {
  resetState();
  const engine = await createCuaDriverEngine({ moduleUrl, daemonPath: "" });
  assert.equal(engine.engineMode, "embedded");
  assert.equal(state.hostStarts, 0);
  assert.equal(state.connects.length, 0);
});

test("disableDaemon：显式要求进程内引擎（测试/救援开关）", async () => {
  resetState();
  const engine = await createCuaDriverEngine({
    moduleUrl,
    daemonPath: "C:\\fake\\cua-driver.exe",
    disableDaemon: true,
  });
  assert.equal(engine.engineMode, "embedded");
  assert.equal(state.hostStarts, 0);
});

test("resolveDaemonPath：显式环境变量优先，找不到就返回 undefined", () => {
  assert.equal(
    resolveDaemonPath({ NIBI_CUA_DRIVER_DAEMON: "D:\\x\\cua-driver.exe" }, undefined),
    "D:\\x\\cua-driver.exe",
  );
  // 包根下没有 bin/cua-driver.exe 时必须返回 undefined（不是猜一个路径）。
  const missing = resolveDaemonPath({}, new URL("file:///D:/definitely-missing-package/"));
  assert.equal(missing, undefined);
});
