/**
 * 活动上报（Helper → Host 的纯展示旁路）测试。
 *
 * 覆盖三层：
 *   1. 纯函数：拖拽坐标选终点、观察映射把截图像素换算成屏幕坐标；
 *   2. 上报器：active 事件形状、1.5s 空闲 inactive、发送失败不抛；
 *   3. 真 Helper + 假引擎：click 会发 activity，release/stop 立即发 inactive，空闲会发 inactive。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { callBrokerMethod } from "../broker.js";
import {
  CUA_ACTIVITY_IDLE_MS,
  actionCoordinates,
  createActivityCoordinateLedger,
  createCuaActivity,
} from "../helper/activity.js";
import { startHelper, stopHelper } from "./helper-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ECHO_ENGINE = join(HERE, "fake-cua-driver-echo.mjs");

const call = (handle, method, params) =>
  callBrokerMethod({ socketPath: handle.socketPath, method, params });

/** 轮询 harness 收集的消息，避免"先检查再挂监听"之间漏掉已入队事件。 */
async function waitForActivity(handle, predicate, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = handle.messages.find(
      (message) => message?.type === "cua_activity" && predicate(message),
    );
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const seen = handle.messages.filter((message) => message?.type === "cua_activity");
  throw new Error(`等待 cua_activity 超时；已收到：${JSON.stringify(seen)}`);
}

test("拖拽坐标取终点，缺失时退回起点", () => {
  assert.deepEqual(
    actionCoordinates("left_click_drag", { from_x: 10, from_y: 20, to_x: 300, to_y: 400 }),
    { x: 300, y: 400 },
  );
  assert.deepEqual(actionCoordinates("left_click_drag", { from_x: 10, from_y: 20 }), {
    x: 10,
    y: 20,
  });
  assert.equal(actionCoordinates("scroll", { direction: "down" }), undefined);
  assert.deepEqual(actionCoordinates("left_click", { x: 1, y: 2 }), { x: 1, y: 2 });
});

test("观察映射：截图像素 → 屏幕坐标；无映射时原值兜底", () => {
  const ledger = createActivityCoordinateLedger();
  ledger.remember("771", {
    windowBounds: { x: 47, y: 32, width: 1202, height: 934 },
    screenshotWidth: 1216,
    screenshotHeight: 941,
  });
  const mapped = ledger.resolve("left_click", { window_id: "771", x: 608, y: 470.5 });
  // 608 / (1216/1202) = 601；470.5 / (941/934) = 467。
  assert.ok(Math.abs(mapped.x - 648) < 1, `x=${mapped.x}`);
  assert.ok(Math.abs(mapped.y - 499) < 1, `y=${mapped.y}`);

  const raw = ledger.resolve("left_click", { window_id: "999", x: 11, y: 22 });
  assert.deepEqual(raw, { x: 11, y: 22 });
});

test("上报器：active 事件形状、1.5s 空闲 inactive、发送失败不抛", () => {
  const sent = [];
  const scheduled = [];
  const activity = createCuaActivity({
    send: (message) => sent.push(message),
    now: () => 1234,
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return { id: scheduled.length };
    },
    cancel: () => {},
    coordinates: { resolve: () => ({ x: 10, y: 20 }) },
  });

  activity.active("left_click", { session_id: "s-1" });
  assert.deepEqual(sent[0], {
    type: "cua_activity",
    active: true,
    sessionId: "s-1",
    action: "left_click",
    x: 10,
    y: 20,
    at: 1234,
  });
  assert.equal(scheduled.length, 0, "下发瞬间不启动空闲计时（长动作不算空闲）");

  activity.settled();
  assert.equal(scheduled[0].delayMs, CUA_ACTIVITY_IDLE_MS);

  scheduled[0].callback();
  assert.deepEqual(sent[1], {
    type: "cua_activity",
    active: false,
    sessionId: "s-1",
    action: "idle",
    at: 1234,
  });

  const exploding = createCuaActivity({
    send: () => {
      throw new Error("ipc closed");
    },
    schedule: () => ({ id: 1 }),
    cancel: () => {},
  });
  assert.doesNotThrow(() => exploding.active("type", {}));
  assert.doesNotThrow(() => exploding.inactive("released"));
});

test("没有 session_id 的动作也会在 settled 后启动空闲计时", () => {
  let delayMs;
  const activity = createCuaActivity({
    send: () => {},
    schedule: (_callback, delay) => {
      delayMs = delay;
      return { id: 1 };
    },
    cancel: () => {},
    coordinates: { resolve: () => undefined },
  });
  activity.active("key", {});
  assert.equal(delayMs, undefined, "active 本身不启动计时");
  activity.settled();
  assert.equal(delayMs, CUA_ACTIVITY_IDLE_MS);
});

test("真 Helper：click 发带坐标 activity；release/stop 立即发 inactive", async () => {
  const handle = await startHelper({ engineModule: ECHO_ENGINE });
  try {
    // 先观察，让活动层拿到 windowBounds + screenshot 尺寸的映射。
    const observed = await call(handle, "get_app_state", { window_id: "771", pid: 1001 });
    assert.equal(observed.elements.length, 2);

    await call(handle, "left_click", {
      x: 608,
      y: 470.5,
      window_id: "771",
      pid: 1001,
      session_id: "sess-activity",
    });
    const active = await waitForActivity(handle, (message) => message.active === true);
    assert.equal(active.action, "left_click");
    assert.equal(active.sessionId, "sess-activity");
    assert.equal(typeof active.at, "number");
    assert.ok(Math.abs(active.x - 648) < 1, `映射后的 x=${active.x}`);
    assert.ok(Math.abs(active.y - 499) < 1, `映射后的 y=${active.y}`);

    await call(handle, "release_input_lease", { force: true });
    const released = await waitForActivity(
      handle,
      (message) => message.active === false && message.action === "released",
    );
    assert.equal(released.sessionId, "sess-activity");

    await call(handle, "left_click", {
      x: 10,
      y: 20,
      window_id: "771",
      pid: 1001,
      session_id: "sess-stop",
    });
    await waitForActivity(
      handle,
      (message) => message.active === true && message.sessionId === "sess-stop",
    );
    await call(handle, "stop_computer_control", {});
    const stopped = await waitForActivity(
      handle,
      (message) => message.active === false && message.action === "stopped",
    );
    assert.equal(stopped.sessionId, "sess-stop");
  } finally {
    await stopHelper(handle);
  }
});

test("真 Helper：动作后 1.5s 空闲发 inactive（idle）", async () => {
  const handle = await startHelper({ engineModule: ECHO_ENGINE });
  try {
    await call(handle, "type", {
      text: "42",
      element_token: "se:1",
      pid: 1001,
      window_id: "771",
      session_id: "sess-idle",
    });
    const active = await waitForActivity(handle, (message) => message.active === true);
    assert.equal(active.action, "type");
    const idle = await waitForActivity(
      handle,
      (message) => message.active === false && message.action === "idle",
      4_000,
    );
    assert.equal(idle.sessionId, "sess-idle");
  } finally {
    await stopHelper(handle);
  }
});
