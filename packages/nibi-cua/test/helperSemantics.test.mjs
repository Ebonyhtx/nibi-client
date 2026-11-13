/**
 * Helper 侧语义测试（离线，假引擎）：租约、kill switch、possibly_sent、观察收据。
 * 这些语义是**跨会话**的，所以放在 Helper（单一进程仲裁）——见 ../helper/semantics.js。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { callBrokerMethod, CuaHelperError } from "../broker.js";
import { FAKE_ENGINE, startHelper, stopHelper } from "./helper-harness.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO_ENGINE = join(HERE, "fake-cua-driver-echo.mjs");
const ACTIVATE_ENGINE = join(HERE, "fake-cua-driver-activate.mjs");
const UWP_ENGINE = join(HERE, "fake-cua-driver-uwp.mjs");

import { normalizeObservation } from "../helper/semantics.js";

async function withHelper(run, env = {}) {
  const handle = await startHelper({ engineModule: FAKE_ENGINE, env });
  try {
    await run(handle);
  } finally {
    await stopHelper(handle);
    assert.ok(
      handle.child.exitCode === 0 || handle.child.exitCode === null || handle.child.signalCode === "SIGTERM",
      `Helper 不该异常退出：code=${handle.child.exitCode} stderr=${handle.stderr()}`,
    );
  }
}

const call = (handle, method, params) =>
  callBrokerMethod({ socketPath: handle.socketPath, method, params });

test("观察收据：state_id + 规范化元素表 + 树文本", async () => {
  await withHelper(async (handle) => {
    const state = await call(handle, "get_app_state", { window_id: "771" });
    assert.match(state.state_id, /^st-/);
    assert.equal(state.elements.length, 2);
    assert.equal(state.elements[0].kind, "text_input");
    assert.equal(state.elements[0].editable, true);
    assert.deepEqual(state.elements[1].actions, ["AXPress"]);
    assert.match(state.text, /1\s+text_input\s+标题/s);
    const second = await call(handle, "get_app_state", { window_id: "771" });
    assert.notEqual(second.state_id, state.state_id, "每次观察应铸新 state_id");
  });
});

test("租约：第二个会话要输入 → CONTROLLER_BUSY（永不重试，带 owner）", async () => {
  await withHelper(async (handle) => {
    await call(handle, "left_click", { element_token: "1", session_id: "s-A" });
    await assert.rejects(
      () => call(handle, "left_click", { element_token: "1", session_id: "s-B" }),
      (error) =>
        error instanceof CuaHelperError &&
        error.code === "CONTROLLER_BUSY" &&
        error.details?.owner === "s-A",
    );
    // 同一会话继续操作不受影响。
    const again = await call(handle, "left_click", { element_token: "2", session_id: "s-A" });
    assert.equal(again.dispatch_status, "sent");
  });
});

test("kill switch：闩锁后输入 fail-hard，request_access 与自身豁免", async () => {
  await withHelper(async (handle) => {
    const stopped = await call(handle, "stop_computer_control", {});
    assert.equal(stopped.stopped, true);
    await assert.rejects(
      () => call(handle, "left_click", { element_token: "1", session_id: "s-A" }),
      (error) => error instanceof CuaHelperError && error.code === "CONTROL_STOPPED",
    );
    // 两处豁免：权限查询照常。
    const access = await call(handle, "request_access", {});
    assert.equal(access.needs_user_grant, process.platform === "darwin");
  });
});

test("possibly_sent：结果不明时回执标 possibly_sent，且不抛（由 SDK 转成 actionSent）", async () => {
  await withHelper(
    async (handle) => {
      const receipt = await call(handle, "left_click", { element_token: "1", session_id: "s-A" });
      assert.equal(receipt.action_sent, true);
      assert.equal(receipt.dispatch_status, "possibly_sent");
      assert.match(receipt.message, /先观察/);
    },
    { FAKE_CUA_AMBIGUOUS_TOOL: "click" },
  );
});

test("观察收据带 app 字段 + snapshotId 映射 frame_id（shim 绑定面的硬要求）", () => {
  const receipt = normalizeObservation(
    {
      appName: "计算器",
      pid: 157440,
      windowId: "4787282",
      snapshotId: "snap-1",
      screenshotWidth: 640,
      screenshotHeight: 480,
      elements: [{ role: "Button", label: "六", elementToken: "s1:3", actions: ["invoke"] }],
    },
    "st-x",
  );
  assert.deepEqual(receipt.app, { name: "计算器", pid: 157440 });
  assert.equal(receipt.frame_id, "snap-1", "真引擎的 snapshotId 就是帧权威");
  assert.equal(receipt.window.window_id, "4787282");
  assert.equal(receipt.elements[0].token, "s1:3");
});

test("透明激活：空树 → bring_to_front → 重观察", async () => {
  const handle = await startHelper({
    engineModule: ACTIVATE_ENGINE,
    env: { NIBI_CUA_ACTIVATE_SETTLE_MS: "10" },
  });
  try {
    const state = await callBrokerMethod({
      socketPath: handle.socketPath,
      method: "get_app_state",
      params: { window_id: "771" },
    });
    assert.equal(state.elements.length, 1, "激活后元素树出现");
    assert.equal(state.activated, true);
    assert.match(state.text, /transparent-activation/);
  } finally {
    await stopHelper(handle);
  }
});

test("激活记忆：第二次观察旧窗口直接切新窗口，绝不重复 launch（防连开窗口）", async () => {
  const handle = await startHelper({
    engineModule: UWP_ENGINE,
    env: { NIBI_CUA_ACTIVATE_SETTLE_MS: "10" },
  });
  try {
    const callHere = (method, params) =>
      callBrokerMethod({ socketPath: handle.socketPath, method, params });
    const first = await callHere("get_app_state", { window_id: "771" });
    assert.equal(first.window.window_id, "999");
    assert.equal(first.activated, true);
    // 第二次：走激活记忆直切——假引擎里第二次 launch 会直接报错，若级联复发这里立刻炸。
    const second = await callHere("get_app_state", { window_id: "771" });
    assert.equal(second.window.window_id, "999");
    assert.equal(second.elements.length, 1);
    assert.match(second.text, /此前已被激活替换/);
    assert.equal(second.activated, undefined, "记忆直切不算新激活");
  } finally {
    await stopHelper(handle);
  }
});

test("force 释放：宿主 turn 结束可无条件收回租约（下一会话立刻能接手）", async () => {
  const handle = await startHelper({ engineModule: ECHO_ENGINE });
  try {
    const callHere = (method, params) =>
      callBrokerMethod({ socketPath: handle.socketPath, method, params });
    // A 会话拿租约（模拟"算出 42 后任务结束，但会话没显式关闭"）。
    await callHere("left_click", { element_token: "se:2", pid: 1001, window_id: "771", session_id: "sess-A" });
    assert.equal((await callHere("helper_health", {})).lease, "sess-A");
    // 宿主 turn 结束 → force 释放（不校验持有者）。
    const released = await callHere("release_input_lease", { force: true });
    assert.equal(released.released, true);
    assert.equal(released.previous_owner, "sess-A");
    assert.equal(released.forced, true);
    assert.equal((await callHere("helper_health", {})).lease, null, "force 后租约必须清空");
    // B 会话立刻能操控（不被 CONTROLLER_BUSY 挡）。
    const takeover = await callHere("left_click", {
      element_token: "se:2", pid: 1001, window_id: "771", session_id: "sess-B",
    });
    assert.equal(takeover.dispatch_status, "sent", "下一会话必须能立刻接手");
    // 非 force 时仍按原语义（不匹配持有者不释放）。
    const noop = await callHere("release_input_lease", { session_id: "sess-C" });
    assert.equal(noop.previous_owner, "sess-B", "非 force 且持有者不匹配时不动租约");
    assert.equal((await callHere("helper_health", {})).lease, "sess-B");
  } finally {
    await stopHelper(handle);
  }
});

test("租约空闲过期：残留租约不再永久锁死后续会话（真机事故回归）", async () => {
  // 压缩空闲超时到 150ms，模拟"会话异常退出留下租约"。
  const handle = await startHelper({
    engineModule: ECHO_ENGINE,
    env: { NIBI_CUA_LEASE_IDLE_MS: "150" },
  });
  try {
    const callHere = (method, params) =>
      callBrokerMethod({ socketPath: handle.socketPath, method, params });
    // A 会话拿租约后**不再有任何动作**（模拟崩溃/被遗忘）。
    await callHere("left_click", { element_token: "se:2", pid: 1001, window_id: "771", session_id: "s-stale" });
    const busy = await callHere("helper_health", {});
    assert.equal(busy.lease, "s-stale", "刚拿到的租约应生效");
    // 等过空闲窗口：B 会话应能接管，而不是被 CONTROLLER_BUSY 永久挡住。
    await new Promise((resolve) => setTimeout(resolve, 260));
    const takeover = await callHere("left_click", {
      element_token: "se:2", pid: 1001, window_id: "771", session_id: "s-next",
    });
    assert.equal(takeover.dispatch_status, "sent", "空闲过期后新会话必须能接管");
    const after = await callHere("helper_health", {});
    assert.equal(after.lease, "s-next");
  } finally {
    await stopHelper(handle);
  }
});

test("key 接受 shim 的 text 参数名；空键名明确拒绝（Empty key name 的根因）", async () => {
  const handle = await startHelper({ engineModule: ECHO_ENGINE });
  try {
    const callHere = (method, params) =>
      callBrokerMethod({ socketPath: handle.socketPath, method, params });
    const viaText = await callHere("key", { text: "6", pid: 1001, window_id: "771", session_id: "s-A" });
    assert.equal(viaText.structured.args.text, "6", "shim 发 text，helper 要接住（字符路由给 type_text）");
    await assert.rejects(
      () => callHere("key", { session_id: "s-A" }),
      (error) => /按键名/.test(error.message),
    );
  } finally {
    await stopHelper(handle);
  }
});

test("key 路由：可打印字符走 type_text（Shift 正确）、键名/和弦走 press_key（687 的根因）", async () => {
  const handle = await startHelper({ engineModule: ECHO_ENGINE });
  try {
    const callHere = (method, params) =>
      callBrokerMethod({ socketPath: handle.socketPath, method, params });
    const star = await callHere("key", { text: "*", pid: 1001, window_id: "771", session_id: "s-A" });
    assert.equal(star.structured.echo, "type_text", "符号字符不能走 press_key（引擎会把 * 当 8）");
    assert.equal(star.structured.args.text, "*");
    assert.equal(star.via, "type_text");
    const digit = await callHere("key", { text: "6", pid: 1001, window_id: "771", session_id: "s-A" });
    assert.equal(digit.structured.echo, "type_text", "数字也走 type_text（同样受 Shift 缺陷保护）");
    for (const keyName of ["Return", "Tab", "F1", "KP_1", "ctrl+c", "Shift_L+Insert"]) {
      const keyed = await callHere("key", { text: keyName, pid: 1001, window_id: "771", session_id: "s-A" });
      assert.equal(keyed.structured.echo, "press_key", `键名 ${keyName} 走 press_key`);
    }
  } finally {
    await stopHelper(handle);
  }
});


test("输入默认 foreground 交付（上游产品策略 background=false）；显式 background 尊重", async () => {
  const handle = await startHelper({ engineModule: ECHO_ENGINE });
  try {
    const callHere = (method, params) =>
      callBrokerMethod({ socketPath: handle.socketPath, method, params });
    const clicked = await callHere("left_click", {
      element_token: "se:2", pid: 1001, window_id: "771", session_id: "s-A",
    });
    // 真机实证：background=UIA Invoke 对后台 WinUI 窗口空转；foreground 由引擎前置+注入。
    assert.equal(clicked.structured.args.delivery_mode, "foreground");
    assert.equal(clicked.structured.args.button, "left");
    assert.equal(clicked.structured.args.count, 1);
    const rightDouble = await callHere("left_click", {
      element_token: "se:2", pid: 1001, window_id: "771", session_id: "s-A",
      mouse_button: "right", click_count: 2, modifiers: ["ctrl"],
    });
    assert.equal(rightDouble.structured.args.button, "right", "shim 的 mouse_button 要映射到引擎 button");
    assert.equal(rightDouble.structured.args.count, 2);
    assert.deepEqual(rightDouble.structured.args.modifier, ["ctrl"], "click 用单数 modifier");
    const background = await callHere("left_click", {
      element_token: "se:2", pid: 1001, window_id: "771", session_id: "s-A",
      delivery_mode: "background",
    });
    assert.equal(
      background.structured.args.delivery_mode, "background",
      "显式 background 不覆盖（调用方的后台意图）",
    );
  } finally {
    await stopHelper(handle);
  }
});

test("透明激活第二级：bring_to_front 无效 → 按标题 launch_app → 跟随新窗口", async () => {
  const handle = await startHelper({
    engineModule: UWP_ENGINE,
    env: { NIBI_CUA_ACTIVATE_SETTLE_MS: "10" },
  });
  try {
    const state = await callBrokerMethod({
      socketPath: handle.socketPath,
      method: "get_app_state",
      params: { window_id: "771" },
    });
    // 771 的树永远为空（真身在新窗口）；helper 必须自己跟过去。
    assert.equal(state.window.window_id, "999", "激活后要切换到新窗口");
    assert.equal(state.window.pid, 64992);
    assert.equal(state.elements.length, 1);
    assert.equal(state.activated, true);
    assert.match(state.text, /999/, "要告诉模型窗口已切换");
  } finally {
    await stopHelper(handle);
  }
});

test("透明激活：kill switch 闩锁后连『带到前台』也停（全新 helper 验证）", async () => {
  const handle = await startHelper({
    engineModule: ACTIVATE_ENGINE,
    env: { NIBI_CUA_ACTIVATE_SETTLE_MS: "10" },
  });
  try {
    const callHere = (method, params) =>
      callBrokerMethod({ socketPath: handle.socketPath, method, params });
    await callHere("stop_computer_control", {});
    const stopped = await callHere("get_app_state", { window_id: "771" });
    // 若激活被误放行，假引擎会翻到"已激活"并返回 1 个元素——0 就是没激活的铁证。
    assert.equal(stopped.elements.length, 0, "闩锁后不激活，空树照实返回");
    assert.equal(stopped.activated, undefined);
    assert.doesNotMatch(stopped.text, /transparent-activation/);
  } finally {
    await stopHelper(handle);
  }
});

test("key 把 pid/window_id 透传给引擎（真机缺陷回归：按键全被拒的根因）", async () => {
  const handle = await startHelper({ engineModule: ECHO_ENGINE });
  try {
    const callEcho = (method, params) =>
      callBrokerMethod({ socketPath: handle.socketPath, method, params });
    // 显式 pid + 字符串 window_id（产品层是字符串，引擎要数值——helper 负责转换）。
    const explicit = await callEcho("key", {
      key: "Return",
      pid: 157440,
      window_id: "4787282",
      session_id: "s-A",
    });
    assert.equal(explicit.structured.echo, "press_key");
    assert.equal(explicit.structured.args.pid, 157440);
    assert.equal(explicit.structured.args.window_id, 4787282);
    assert.equal(explicit.structured.args.key, "Return");

    // 不带 pid：按 window_id 反查（resolvePid 唯一入口）。
    const inferred = await callEcho("key", { key: "Tab", window_id: "771", session_id: "s-A" });
    assert.equal(inferred.structured.echo, "press_key");
    assert.equal(inferred.structured.args.pid, 1001);
  } finally {
    await stopHelper(handle);
  }
});

test("helper_health 报告引擎与租约状态", async () => {
  await withHelper(async (handle) => {
    await call(handle, "left_click", { element_token: "1", session_id: "s-A" });
    const health = await call(handle, "helper_health", {});
    assert.equal(health.engine, "cua-driver");
    assert.equal(health.lease, "s-A");
    assert.equal(health.kill_switch, false);
  });
});
