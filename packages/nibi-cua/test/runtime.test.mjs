/**
 * 运行时侧语义测试（离线，假引擎 + 真 Helper + 真命名管道）。
 * 覆盖：MCP 信封形状、元素索引台账（STALE_STATE / ELEMENT_UNAVAILABLE）、帧台账
 * （隐式绑定 / 过期）、等待收敛与 effect_evidence、子代理禁用、kill switch 透传、
 * possibly_sent 不等待不重试、closeSession 释放租约。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { probeHelperHealth } from "../broker.js";
import { createComputerUseRuntime } from "../runtime/index.js";
import { FAKE_ENGINE, startHelper, stopHelper } from "./helper-harness.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ECHO_ENGINE = join(dirname(fileURLToPath(import.meta.url)), "fake-cua-driver-echo.mjs");

const CONTEXT = {
  sessionId: "sess-test",
  runtimeScope: "main",
  workspaceKey: "ws",
};

function textOf(envelope) {
  return (envelope?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function receiptOf(envelope) {
  const structured = envelope?.structuredContent;
  if (structured && typeof structured === "object") return structured;
  for (const block of envelope?.content ?? []) {
    try {
      const parsed = JSON.parse(block.text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      continue;
    }
  }
  return {};
}

async function withRuntime(run, env = {}) {
  const handle = await startHelper({ engineModule: FAKE_ENGINE, env });
  // 等 full ready（transport_ready 后还有一段"broker 未受理"窗口，真 CUA_NOT_READY；
  // 等不到就轮询 health——否则高负载下测试会间歇性撞上不可受理窗口）。
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await probeHelperHealth(handle.socketPath, { timeoutMs: 500 });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const runtime = createComputerUseRuntime({
    brokerSocketPath: handle.socketPath,
    ensureBrokerAvailable: async () => {},
  });
  try {
    await run(runtime);
  } finally {
    await runtime.dispose();
    await stopHelper(handle);
    assert.ok(
      handle.child.exitCode === 0 || handle.child.exitCode === null || handle.child.signalCode === "SIGTERM",
      `Helper 不该异常退出：code=${handle.child.exitCode} stderr=${handle.stderr()}`,
    );
  }
}

test("观察：树文本块 + 结构化收据（state_id/elements）", async () => {
  await withRuntime(async (runtime) => {
    const envelope = await runtime.execute({
      toolName: "get_app_state",
      arguments: { window_id: "771" },
      context: CONTEXT,
    });
    assert.equal(envelope.isError, undefined);
    const receipt = receiptOf(envelope);
    assert.match(receipt.state_id, /^st-/);
    assert.equal(receipt.elements.length, 2);
    assert.match(textOf(envelope), /1\s+text_input\s+标题/s);
  });
});

test("元素索引：先观察再点；没有观察 → STALE_STATE；索引不在台账 → ELEMENT_UNAVAILABLE", async () => {
  await withRuntime(async (runtime) => {
    const before = await runtime.execute({
      toolName: "left_click",
      arguments: { element_index: 1, window_id: "771" },
      context: CONTEXT,
    });
    assert.equal(receiptOf(before).code, "STALE_STATE", "没观察过就按索引操作要拒");

    await runtime.execute({
      toolName: "get_app_state",
      arguments: { window_id: "771" },
      context: CONTEXT,
    });
    const click = await runtime.execute({
      toolName: "left_click",
      arguments: { element_index: 2, window_id: "771" },
      context: CONTEXT,
    });
    const receipt = receiptOf(click);
    assert.equal(receipt.action_sent, true);
    assert.equal(receipt.dispatch_status, "sent");
    assert.equal(receipt.state_sync_status, "settled");
    assert.ok(["changed", "unchanged"].includes(receipt.effect_evidence));
    assert.match(receipt.base_state_id, /^st-/);

    const missing = await runtime.execute({
      toolName: "left_click",
      arguments: { element_index: 99, window_id: "771" },
      context: CONTEXT,
    });
    assert.equal(receiptOf(missing).code, "ELEMENT_UNAVAILABLE");
  });
});

test("帧台账：坐标动作要新鲜帧；隐式绑最新帧；伪造帧号 → STALE_STATE", async () => {
  await withRuntime(async (runtime) => {
    const noFrame = await runtime.execute({
      toolName: "left_click",
      arguments: { x: 10, y: 20, window_id: "771" },
      context: CONTEXT,
    });
    assert.equal(receiptOf(noFrame).code, "STALE_STATE", "没有帧时坐标动作要拒（action_sent=false）");

    // 带截图观察一次 → 铸帧（假引擎的 getWindowState 会回 frame_id）。
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { window_id: "771", include_screenshot: true },
      context: CONTEXT,
    });
    const implicit = await runtime.execute({
      toolName: "left_click",
      arguments: { x: 10, y: 20, window_id: "771" },
      context: CONTEXT,
    });
    assert.equal(receiptOf(implicit).dispatch_status, "sent", "坐标动作应隐式绑最新帧");

    const bogus = await runtime.execute({
      toolName: "left_click",
      arguments: { x: 10, y: 20, frame_id: "frame-does-not-exist", window_id: "771" },
      context: CONTEXT,
    });
    assert.equal(receiptOf(bogus).code, "STALE_STATE");
  });
});

test("子代理禁用：subagent 上下文一律拒", async () => {
  await withRuntime(async (runtime) => {
    const envelope = await runtime.execute({
      toolName: "list_apps",
      arguments: {},
      context: { ...CONTEXT, runtimeScope: "subagent" },
    });
    assert.equal(envelope.isError, true);
    assert.equal(receiptOf(envelope).code, "SUBAGENT_NOT_ALLOWED");
  });
});

test("kill switch 透传：闩锁后输入报 CONTROL_STOPPED，request_access 仍可用", async () => {
  await withRuntime(async (runtime) => {
    await runtime.execute({ toolName: "get_app_state", arguments: { window_id: "771" }, context: CONTEXT });
    await runtime.execute({ toolName: "stop_computer_control", arguments: {}, context: CONTEXT });
    const blocked = await runtime.execute({
      toolName: "left_click",
      arguments: { element_index: 1, window_id: "771" },
      context: CONTEXT,
    });
    assert.equal(receiptOf(blocked).code, "CONTROL_STOPPED");
    const access = await runtime.execute({ toolName: "request_access", arguments: {}, context: CONTEXT });
    assert.equal(access.isError, undefined);
  });
});

test("possibly_sent：不等待、不重试，回执带 dispatch_status 交给 SDK", async () => {
  await withRuntime(
    async (runtime) => {
      await runtime.execute({ toolName: "get_app_state", arguments: { window_id: "771" }, context: CONTEXT });
      const envelope = await runtime.execute({
        toolName: "left_click",
        arguments: { element_index: 1, window_id: "771" },
        context: CONTEXT,
      });
      const receipt = receiptOf(envelope);
      assert.equal(receipt.dispatch_status, "possibly_sent");
      assert.equal(receipt.state_sync_status, "unknown", "possibly_sent 时不去等收敛");
    },
    { FAKE_CUA_AMBIGUOUS_TOOL: "click" },
  );
});

test("closeSession 释放租约（下一个会话才能拿输入权）", async () => {
  await withRuntime(async (runtime) => {
    const first = { ...CONTEXT, sessionId: "s-A" };
    const second = { ...CONTEXT, sessionId: "s-B" };
    await runtime.execute({ toolName: "get_app_state", arguments: { window_id: "771" }, context: first });
    await runtime.execute({ toolName: "left_click", arguments: { element_index: 1, window_id: "771" }, context: first });
    // 会话内台账与跨会话租约是两道独立的闸：B 也要先观察，才会走到租约那一步。
    await runtime.execute({ toolName: "get_app_state", arguments: { window_id: "771" }, context: second });
    const busy = await runtime.execute({
      toolName: "left_click",
      arguments: { element_index: 1, window_id: "771" },
      context: second,
    });
    assert.equal(receiptOf(busy).code, "CONTROLLER_BUSY");
    assert.equal(receiptOf(busy).details?.owner, "s-A");

    await runtime.closeSession(first);
    await runtime.execute({ toolName: "get_app_state", arguments: { window_id: "771" }, context: second });
    const after = await runtime.execute({
      toolName: "left_click",
      arguments: { element_index: 1, window_id: "771" },
      context: second,
    });
    assert.equal(receiptOf(after).dispatch_status, "sent", "释放租约后另一个会话应能输入");
  });
});

test("带截图观察 → image_ref 四键固定文本块（坐标动作靠它绑帧）", async () => {
  await withRuntime(async (runtime) => {
    const envelope = await runtime.execute({
      toolName: "get_app_state",
      arguments: { window_id: "771", include_screenshot: true },
      context: CONTEXT,
    });
    const blocks = (envelope?.content ?? []).filter((block) => block?.type === "text");
    assert.equal(blocks.length, 3, "观察应有：树文本 + 收据 + image_ref 三块");
    const imageRef = JSON.parse(blocks[2].text);
    assert.deepEqual(Object.keys(imageRef).sort(), ["actionable", "frame_id", "height", "note", "width"]);
    assert.equal(imageRef.actionable, true);
    assert.equal(imageRef.width, 800);
    assert.equal(imageRef.height, 600);
    assert.match(String(imageRef.frame_id), /^frame-/);
  });
});

test("不带截图 → 不发 image_ref 块（别编帧）", async () => {
  await withRuntime(async (runtime) => {
    const envelope = await runtime.execute({
      toolName: "get_app_state",
      arguments: { window_id: "771" },
      context: CONTEXT,
    });
    const blocks = (envelope?.content ?? []).filter((block) => block?.type === "text");
    assert.equal(blocks.length, 2, "不带截图时只有树文本 + 收据");
  });
});

test("绑定面 app_ref：pid / window_id / name / 裸字符串(bundle_id) 都能解析", async () => {
  await withRuntime(async (runtime) => {
    // {pid}：解析到该 pid 的主窗口。
    const byPid = receiptOf(await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { pid: 1001 } },
      context: CONTEXT,
    }));
    assert.equal(byPid.window?.pid, 1001);

    // {window_id}：直通。
    const byWindow = receiptOf(await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { window_id: "771" } },
      context: CONTEXT,
    }));
    assert.equal(byWindow.window?.window_id, "771");

    // {name}：包含匹配（"计算器" ⊂ "Windows 计算器" 这类真实形态）。
    const byName = receiptOf(await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { name: "note" } },
      context: CONTEXT,
    }));
    assert.equal(byName.window?.pid, 1001);
    const byExact = receiptOf(await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { name: "Notes" } },
      context: CONTEXT,
    }));
    assert.equal(byExact.window?.pid, 1001, "完整应用名（精确形态）也要匹配");

    // 裸字符串按 bundle_id 语义（shim 的既定约定）。
    const byBundle = receiptOf(await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: "com.fake.notes" },
      context: CONTEXT,
    }));
    assert.equal(byBundle.window?.pid, 1001);

    // 查无此 app：fail-closed（错误信封），错误要说清是谁没匹配上。
    const missing = await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { name: "不存在" } },
      context: CONTEXT,
    });
    assert.equal(missing.isError, true);
    assert.match(String(receiptOf(missing).message ?? ""), /不存在/);
  });
});

test("截图回流：image 块进 content；base64 不进收据；image_ref 仍绑帧", async () => {
  await withRuntime(async (runtime) => {
    const envelope = await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { window_id: "771" }, include_screenshot: true },
      context: CONTEXT,
    });
    const imageBlocks = (envelope.content ?? []).filter(
      (block) => block?.type === "image" && typeof block.data === "string",
    );
    assert.equal(imageBlocks.length, 1, "SDK 的 imageBytesOf 只认 content 里的 image 块");
    assert.equal(imageBlocks[0].data, "ZmFrZS1wbmc=");
    assert.equal(imageBlocks[0].mimeType, "image/png");
    // 收据（structuredContent 与 JSON 文本块两处同形）不带 base64。
    const receipt = receiptOf(envelope);
    assert.equal(receipt.screenshot, undefined);
    assert.equal(receipt.screenshot_width, 800);
    // image_ref 文本块还在（坐标动作绑帧靠它）。
    const imageRefBlock = (envelope.content ?? []).find(
      (block) => block?.type === "text" && /frame_id/.test(block.text) && /坐标动作/.test(block.text),
    );
    assert.ok(imageRefBlock, "image_ref 四键块必须存在");
  });
});

test("target 统一参数解包：索引 / token / [x,y] 都能落到 helper（两种标识都被拒的根因）", async () => {
  await withRuntime(async (runtime) => {
    // 先观察（台账有元素），再用 shim 的三种 target 形态点击。
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { window_id: "771" },
      context: CONTEXT,
    });
    const byIndex = receiptOf(await runtime.execute({
      toolName: "left_click",
      arguments: { target: 2, session_id: CONTEXT.sessionId },
      context: CONTEXT,
    }));
    assert.equal(byIndex.structured.args.element_token, "2", "数字 target=元素索引");
    // shim 的 bindTarget 产物形态：{type:"element", index} —— 键名是 index 不是 element_index。
    const byBoundShape = receiptOf(await runtime.execute({
      toolName: "left_click",
      arguments: { target: { type: "element", index: 1 }, session_id: CONTEXT.sessionId },
      context: CONTEXT,
    }));
    assert.equal(byBoundShape.structured.args.element_token, "1", "bindTarget 的 {type,index} 形态要解包");
    // 坐标形态带嵌套 frame_id：要透传（引擎的隐式绑帧依赖它）。
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { window_id: "771", include_screenshot: true },
      context: CONTEXT,
    });
    const frame = receiptOf(await runtime.execute({
      toolName: "get_app_state",
      arguments: { window_id: "771", include_screenshot: true },
      context: CONTEXT,
    }));
    const frameId = frame.frame_id;
    const byCoordShape = receiptOf(await runtime.execute({
      toolName: "left_click",
      arguments: {
        target: { type: "coordinate", frame_id: frameId, x: 30, y: 40 },
        session_id: CONTEXT.sessionId,
      },
      context: CONTEXT,
    }));
    assert.equal(byCoordShape.structured.args.x, 30);
    assert.equal(byCoordShape.structured.args.y, 40);
    const byToken = receiptOf(await runtime.execute({
      toolName: "left_click",
      arguments: { target: "se:2", session_id: CONTEXT.sessionId },
      context: CONTEXT,
    }));
    assert.equal(byToken.structured.args.element_token, "se:2", "字符串 target=元素 token 直通");
    // 坐标 target 走帧绑定：没有新鲜帧时运行时抛 STALE_STATE，能派发即证明绑定通过了。
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { window_id: "771", include_screenshot: true },
      context: CONTEXT,
    });
    const byCoords = receiptOf(await runtime.execute({
      toolName: "left_click",
      arguments: { target: [120, 80], session_id: CONTEXT.sessionId },
      context: CONTEXT,
    }));
    assert.equal(byCoords.structured.args.x, 120);
    assert.equal(byCoords.structured.args.y, 80);
  });
});

test("后台交付无效时给升级提示（不自动重试，避免双触发）", async () => {
  await withRuntime(async (runtime) => {
    await runtime.execute({
      toolName: "get_app_state",
      arguments: { window_id: "771" },
      context: CONTEXT,
    });
    // FAKE 引擎每次观察都返回同一棵树 → effect_evidence 必为 unchanged。
    const receipt = receiptOf(await runtime.execute({
      toolName: "left_click",
      arguments: { element_token: "se:2", delivery_mode: "background", session_id: CONTEXT.sessionId },
      context: CONTEXT,
    }));
    assert.equal(receipt.delivery_mode, "background");
    assert.equal(receipt.effect_evidence, "unchanged");
    assert.match(String(receipt.text ?? ""), /effect-unchanged/, "要写明补救（显式 foreground 重试）");
    // 不传 delivery_mode 也是 background（默认后台优先），不能偷偷前台化。
    const defaulted = receiptOf(await runtime.execute({
      toolName: "left_click",
      arguments: { element_token: "se:2", session_id: CONTEXT.sessionId },
      context: CONTEXT,
    }));
    assert.equal(defaulted.delivery_mode, "background", "默认交付必须是 background");
    assert.match(String(defaulted.text ?? ""), /effect-unchanged/);
    // 只有显式 foreground 才不提示。
    const fg = receiptOf(await runtime.execute({
      toolName: "left_click",
      arguments: { element_token: "se:2", delivery_mode: "foreground", session_id: CONTEXT.sessionId },
      context: CONTEXT,
    }));
    assert.equal(fg.delivery_mode, "foreground");
    assert.doesNotMatch(String(fg.text ?? ""), /effect-unchanged/);
  });
});

test("UWP 跨 pid 绑定：注册条目 pid=0 → launch_path 拉起 → 按窗口增量绑到 AFH 窗口", async () => {
  const handle = await startHelper({
    engineModule: ECHO_ENGINE,
    env: { FAKE_UWP_MODE: "1", NIBI_CUA_ACTIVATE_SETTLE_MS: "10" },
  });
  const runtime = createComputerUseRuntime({
    brokerSocketPath: handle.socketPath,
    ensureBrokerAvailable: async () => {},
  });
  try {
    const envelope = await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { name: "记事本" } },
      context: CONTEXT,
    });
    const receipt = receiptOf(envelope);
    // 真窗口挂在 ApplicationFrameHost（pid 4242）上，不是注册条目的 pid=0。
    assert.equal(receipt.window?.pid, 4242, "UWP 要绑到承载窗口（AFH）的 pid");
    assert.equal(receipt.window?.window_id, "9001");
  } finally {
    await runtime.dispose();
    await stopHelper(handle);
  }
});

test("UWP 已运行：list_apps 只剩注册条目时，直接绑既有窗口（不再重复拉起）", async () => {
  const handle = await startHelper({
    engineModule: ECHO_ENGINE,
    env: { FAKE_UWP_MODE: "1", FAKE_UWP_ALREADY_RUNNING: "1", NIBI_CUA_ACTIVATE_SETTLE_MS: "10" },
  });
  const runtime = createComputerUseRuntime({
    brokerSocketPath: handle.socketPath,
    ensureBrokerAvailable: async () => {},
  });
  try {
    const receipt = receiptOf(await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { name: "记事本" } },
      context: CONTEXT,
    }));
    assert.equal(receipt.window?.window_id, "9001", "已运行的 UWP 要直接绑既有窗口");
    assert.equal(receipt.window?.pid, 4242);
  } finally {
    await runtime.dispose();
    await stopHelper(handle);
  }
});

test("系统壳拒绝：锁屏窗口绝不被绑成目标（唯一新窗口兜底的事故回归）", async () => {
  const handle = await startHelper({
    engineModule: ECHO_ENGINE,
    env: { FAKE_UWP_MODE: "1", FAKE_UWP_SHELL_FRESH: "1", NIBI_CUA_ACTIVATE_SETTLE_MS: "10" },
  });
  const runtime = createComputerUseRuntime({
    brokerSocketPath: handle.socketPath,
    ensureBrokerAvailable: async () => {},
  });
  try {
    const receipt = receiptOf(await runtime.execute({
      toolName: "get_app_state",
      arguments: { app_ref: { name: "记事本" } },
      context: CONTEXT,
    }));
    // 假引擎在这个模式下：新窗口只有锁屏（标题无"记事本"证据）——必须**不绑**它。
    assert.notEqual(receipt.window?.window_id, "6666", "锁屏窗口绝不能成为绑定目标");
  } finally {
    await runtime.dispose();
    await stopHelper(handle);
  }
});
