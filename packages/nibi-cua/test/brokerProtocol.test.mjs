/**
 * broker 协议 + Helper 链路的测试。
 *
 * 离线部分（默认跑）：协议函数单测 + **整条链路**（真的 fork Helper、真的绑命名管道、
 * 真的走 NDJSON），引擎换成 fake-cua-driver.mjs，所以不依赖任何原生件。
 * 真机部分（NIBI_CUA_ENGINE_SMOKE=1 时跑）：引擎换成真 `@trycua/cua-driver`
 * （用 NIBI_CUA_ENGINE_MODULE 指向其 entry），验证我们在本机真能列出应用/窗口。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BROKER_METHODS,
  callBrokerMethod,
  mintEphemeralBrokerSocketPath,
  CuaHelperError,
  dispatchRequest,
  isBrokerMethod,
  isReadOnlyBrokerMethod,
  mintBrokerSocketPath,
  resolveBrokerSocketPath,
  parseRequestLine,
  probeHelperHealth,
  serializeResponse,
} from "../broker.js";

import { FAKE_ENGINE, startHelper, stopHelper } from "./helper-harness.mjs";

test("协议：请求行解析只认合法形态", () => {
  assert.deepEqual(parseRequestLine('{"id":"a","method":"list_apps"}'), {
    id: "a",
    method: "list_apps",
  });
  assert.equal(parseRequestLine("not json"), undefined);
  assert.equal(parseRequestLine('{"id":"a"}'), undefined, "缺 method 要拒");
  assert.equal(parseRequestLine(""), undefined);
});

test("协议：dispatch 未声明的方法明确拒（fail-closed）", async () => {
  const backend = { list_apps: async () => ({ apps: [] }) };
  assert.deepEqual(await dispatchRequest(backend, { method: "list_apps" }), {
    ok: true,
    result: { apps: [] },
  });
  await assert.rejects(
    () => dispatchRequest(backend, { method: "left_click", params: {} }),
    (error) => error instanceof CuaHelperError && error.code === "unrecognized_method",
  );
});

test("协议：方法表与只读集", () => {
  assert.ok(BROKER_METHODS.includes("get_app_state"));
  assert.equal(isBrokerMethod("list_apps"), true);
  assert.equal(isBrokerMethod("not_a_method"), false);
  assert.equal(isReadOnlyBrokerMethod("list_windows"), true);
  assert.equal(isReadOnlyBrokerMethod("left_click"), false);
});

test("协议：端点是**稳定**的，且按数据根隔离", () => {
  const first = mintBrokerSocketPath({ env: {} });
  const second = resolveBrokerSocketPath({ env: {} });
  assert.equal(first, second, "铸造与解析必须给同一个名字（懒启动链靠它对齐）");
  assert.match(first, /nibi-cua-helper-(default|[0-9a-f]{8})/, "名字要带实例指纹（default = 默认数据根）");

  const devA = mintBrokerSocketPath({ env: { NIBI_STORAGE_DIR: "X:/x/dev-a" } });
  const devB = mintBrokerSocketPath({ env: { NIBI_STORAGE_DIR: "X:/x/dev-b" } });
  assert.notEqual(devA, devB, "不同数据根必须不同端点（隔离）");

  const ephemeral = mintEphemeralBrokerSocketPath();
  assert.notEqual(ephemeral, first, "临时端点不能等于稳定端点（测试并发靠它）");
});

test("协议：端点指纹对未折叠路径归一化（启动器拼出 plugins\\.. 段也能对上）", () => {
  const dotted = resolveBrokerSocketPath({
    env: { NIBI_STORAGE_DIR: "C:\\workspace\\plugins\\..\\.nibi-desktop-dev" },
  });
  const folded = resolveBrokerSocketPath({ env: { NIBI_STORAGE_DIR: "C:\\workspace\\.nibi-desktop-dev" } });
  assert.equal(dotted, folded, "归一化前后必须哈希出同一个名字，否则懒启动回落链会分叉");
});


test("整条链路（假引擎）：握手 → 只读工具 → 未实现的方法明确拒", async () => {
  const handle = await startHelper({ engineModule: FAKE_ENGINE });
  try {
    const health = await probeHelperHealth(handle.socketPath, { timeoutMs: 5000 });
    assert.equal(health.pid, handle.child.pid);

    const apps = await callBrokerMethod({ socketPath: handle.socketPath, method: "list_apps" });
    assert.equal(apps.apps.length, 2);
    assert.equal(apps.apps[1].name, "Calculator");

    const windows = await callBrokerMethod({
      socketPath: handle.socketPath,
      method: "list_windows",
      params: { pid: 1001 },
    });
    assert.equal(windows.windows.length, 1);
    assert.equal(windows.windows[0].title, "备忘录");

    const state = await callBrokerMethod({
      socketPath: handle.socketPath,
      method: "get_app_state",
      params: { window_id: "771" },
    });
    assert.equal(state.elements.length, 2);
    assert.match(state.text, /text_input/);

    const permission = await callBrokerMethod({
      socketPath: handle.socketPath,
      method: "permission_status",
    });
    assert.equal(permission.accessibility, process.platform === "darwin" ? "unknown" : "granted");

    // 输入工具已接线：回执带 action_sent/dispatch_status。
    const click = await callBrokerMethod({
      socketPath: handle.socketPath,
      method: "left_click",
      params: { element_token: "1", session_id: "s-1" },
    });
    assert.equal(click.action_sent, true);
    assert.equal(click.dispatch_status, "sent");

    // perform_action 已接线：没给 action 就明确拒（fail-closed，不猜）。
    await assert.rejects(
      () => callBrokerMethod({ socketPath: handle.socketPath, method: "perform_action", params: {} }),
      (error) => error instanceof CuaHelperError && error.code === "unrecognized_keys",
    );
    // select_text：引擎没有文本范围原语 → 诚实拒绝并给替代，而不是编一个假成功。
    await assert.rejects(
      () => callBrokerMethod({ socketPath: handle.socketPath, method: "select_text", params: {} }),
      (error) => error instanceof CuaHelperError && error.code === "ACTION_UNAVAILABLE",
    );

    assert.ok(
      handle.messages.some((message) => message?.type === "ready"),
      "引擎就绪后要补一条 ready",
    );
  } finally {
    await stopHelper(handle);
    assert.ok(
      handle.child.exitCode === 0 || handle.child.exitCode === null || handle.child.signalCode === "SIGTERM",
      `Helper 不该异常退出：code=${handle.child.exitCode} signal=${handle.child.signalCode} stderr=${handle.stderr()}`,
    );
  }
});

test("连不上的端点 → BrokerError（不可用），不是静默成功", async () => {
  const socketPath = mintEphemeralBrokerSocketPath();
  await assert.rejects(
    () => callBrokerMethod({ socketPath, method: "list_apps", timeoutMs: 1500 }),
    (error) => error?.code === "unavailable" || error?.code === "timeout",
  );
});

// 真机冒烟：需要本机装好 @trycua/cua-driver，并用 NIBI_CUA_ENGINE_MODULE 指向其 entry。
const smokeModule = process.env.NIBI_CUA_ENGINE_SMOKE ? process.env.NIBI_CUA_ENGINE_MODULE : "";
test("真机冒烟（可选）：真引擎能列出本机应用与窗口", { skip: !smokeModule }, async () => {
  const handle = await startHelper({ engineModule: smokeModule });
  try {
    const apps = await callBrokerMethod({ socketPath: handle.socketPath, method: "list_apps" });
    assert.ok(apps.apps.length > 0, "至少要列出一个运行中的应用");
    const windows = await callBrokerMethod({ socketPath: handle.socketPath, method: "list_windows" });
    assert.ok(Array.isArray(windows.windows));
  } finally {
    await stopHelper(handle);
    assert.ok(
      handle.child.exitCode === 0 || handle.child.exitCode === null || handle.child.signalCode === "SIGTERM",
      `Helper 不该异常退出：code=${handle.child.exitCode} signal=${handle.child.signalCode} stderr=${handle.stderr()}`,
    );
  }
});
