/**
 * Helper 冷启动竞态的回归测试：transport_ready 必须**先于**引擎就绪。
 *
 * 背景（2026-10-11 实测）：宿主给 agent 发 broker 凭据的准入线是 1s，只等 transport；
 * 引擎加载实测 ~1.04s —— 先加载引擎后绑管道的旧实现让启动时自动 spawn 的 agent
 * 差几毫秒输掉竞态，带着 BROKER_UNAVAILABLE 环境变量被永久禁用（复用进程的
 * 后续 turn 全部 "Computer Use is unavailable"）。修复后 helper 先绑管道再加载引擎，
 * 这组测试把该顺序钉死。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { callBrokerMethod, mintEphemeralBrokerSocketPath } from "../broker.js";
import { startHelper, stopHelper } from "./helper-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LAZY_ENGINE = join(HERE, "fake-cua-driver-lazy.mjs");

const waitForMessageType = (handle, type, timeoutMs = 15_000) => {
  const existing = handle.messages.find((message) => message?.type === type);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs);
    handle.child.on("message", (message) => {
      if (message?.type === type) {
        clearTimeout(timer);
        resolve(message);
      }
    });
  });
};

test("冷启动：transport_ready 先于引擎就绪，health 立即可答，工具调用等引擎", async () => {
  const handle = await startHelper({
    engineModule: LAZY_ENGINE,
    env: { FAKE_ENGINE_DELAY_MS: "1200" },
  });
  try {
    // harness 在 transport_ready 才 resolve —— 能走到这里本身就说明 transport 已到。
    // helper_health 不能被引擎加载挡住：此刻引擎还在"加载"。
    const health = await callBrokerMethod({ socketPath: handle.socketPath, method: "helper_health" });
    assert.equal(health.pid, handle.child.pid);
    assert.equal(health.engine_status, "loading", "引擎未就绪时 health 要如实报告 loading");

    // 引擎未就绪就发起的工具调用：deferred 代理等引擎，最终成功（不假装成功也不误报不可用）。
    const pendingApps = callBrokerMethod({ socketPath: handle.socketPath, method: "list_apps" });
    const readyMessage = await waitForMessageType(handle, "ready");
    assert.equal(readyMessage.type, "ready", "引擎就绪后要补发 full ready 握手");
    const apps = await pendingApps;
    assert.equal(apps.apps[0]?.name, "LazyApp");
  } finally {
    await stopHelper(handle);
  }
});

test("冷启动失败：先 transport_ready 再报 error（宿主能拿到诊断而不是 malformed）", async () => {
  const handle = await startHelper({
    engineModule: LAZY_ENGINE,
    env: { FAKE_ENGINE_FAIL: "1" },
  });
  try {
    // transport 已到（harness resolve）；错误在引擎加载失败后到达。
    const error = await waitForMessageType(handle, "error");
    assert.match(error.message, /FAKE_ENGINE_FAIL/);
  } finally {
    await stopHelper(handle);
  }
});

test("临时端点仍与稳定端点不同（并发隔离不回归）", () => {
  assert.notEqual(mintEphemeralBrokerSocketPath(), mintEphemeralBrokerSocketPath());
});
