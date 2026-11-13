/**
 * P4b 真机验收（可选，默认跳过）：三个"必须真机才认"的判据，全部走**运行时**那一层
 * （`createComputerUseRuntime`，也就是模型真正看到的面）。
 *
 *   NIBI_CUA_NATIVE_ACCEPTANCE=1 node --import tsx --test test/nativeAcceptanceP4b.test.mjs
 *
 * 1. **经典闭环**：Windows 计算器 6×7 = 42（观察 → 打字 → 回车 → 重读界面确认）。
 * 2. **出错不骗人**：伪造帧号 / 越界索引 → 结构化拒绝（isError + 码），不能出现"已发送"形状。
 * 3. **kill switch 跨会话真闩锁**：闩锁后另一会话输入被拒，且重读界面确认**真的没变**。
 *
 * 只碰我们自己 spawn 的进程（记事本/计算器），不动用户任何窗口。
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
const ENABLED = Boolean(process.env.NIBI_CUA_NATIVE_ACCEPTANCE || process.argv.includes("--p4b"));
const NL = String.fromCharCode(10);
const CONTEXT = (sessionId) => ({ sessionId, runtimeScope: "main", workspaceKey: "ws" });

async function startStack() {
  const { resolveWindowsCuaRuntime } = await import(
    "../../services/src/cua-permission-broker/windowsCuaDevRuntime.js"
  );
  const { mintBrokerSocketPath } = await import("../broker.js");
  const { createComputerUseRuntime } = await import("../runtime/index.js");
  const resolved = await resolveWindowsCuaRuntime({
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
  delete env.NIBI_CUA_ENGINE_MODULE;
  const helper = fork(
    resolved.entryPath,
    ["--socket", socketPath, "--parent-pid", String(process.pid)],
    { cwd: resolved.root, env, execPath: resolved.command, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  helper.stderr?.on("data", (chunk) => process.stderr.write(String(chunk).slice(0, 400)));
  let ready = false;
  helper.on("message", (message) => {
    if (message?.type === "transport_ready") ready = true;
  });
  const deadline = Date.now() + 20_000;
  while (!ready && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(ready, "Helper 应在 20s 内握手");

  const runtime = createComputerUseRuntime({
    brokerSocketPath: socketPath,
    ensureBrokerAvailable: async () => {},
  });
  return {
    invoke: (toolName, args, sessionId) =>
      runtime.execute({ toolName, arguments: args, context: CONTEXT(sessionId) }),
    /** 与插件 SDK 同一套读法：先看 structuredContent，再从文本块里抠 JSON。 */
    receipt: (envelope) => {
      if (envelope?.structuredContent && typeof envelope.structuredContent === "object") {
        return envelope.structuredContent;
      }
      for (const block of envelope?.content ?? []) {
        try {
          const parsed = JSON.parse(block.text);
          if (parsed && typeof parsed === "object") return parsed;
        } catch {
          continue;
        }
      }
      return {};
    },
    stop: async () => {
      helper.send({ protocol: "nibi-cua-windows-dev/v1", type: "shutdown" });
      await Promise.race([once(helper, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (helper.exitCode === null) helper.kill();
    },
  };
}

async function findWindow(stack, predicate, attempts = 24) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const listed = stack.receipt(await stack.invoke("list_windows", {}, "probe-list"));
    const match = (listed?.windows ?? []).find(predicate);
    if (match) return match;
  }
  return undefined;
}

const observe = async (stack, windowId, sessionId) =>
  stack.receipt(await stack.invoke("get_app_state", { window_id: String(windowId) }, sessionId));

function treeLines(state, max = 20) {
  return String(state?.text ?? "")
    .split("\n")
    .slice(0, max)
    .join("\n");
}

test("经典闭环：计算器 6×7=42", { skip: !ENABLED }, async () => {
  const stack = await startStack();
  const calc = spawn("calc.exe", []);
  const session = "p4b-calc";
  try {
    const window = await findWindow(
      stack,
      (item) =>
        String(item.appName ?? "").toLowerCase().includes("calc") ||
        /计算|Calc/i.test(String(item.title ?? "")),
    );
    assert.ok(window, "应能找到计算器窗口");
    const windowId = String(window.windowId ?? window.window_id);

    let state = await observe(stack, windowId, session);
    assert.ok(state.elements.length > 0, "计算器 AX 树不该是空的");

    // 计算器是**中文本地化**的按钮标签，且显示区不是文本框（实测：打字进去没用）——
    // 所以按标签找到按钮再点它。标签匹配同时兼容中英（换语言/换版本不会立刻红）。
    const byLabel = (pattern) => state.elements.find((element) => pattern.test(String(element.name ?? "")));
    const plan = [
      ["六", /^(六|6)$/],
      ["乘以", /乘以|\*|×/],
      ["七", /^(七|7)$/],
      ["等于", /等于|^=$/],
    ];
    for (const [label, pattern] of plan) {
      const button = byLabel(pattern);
      assert.ok(button, `应能找到按钮「${label}」；树：${NL}${treeLines(state)}`);
      const receipt = stack.receipt(await stack.invoke("left_click", { element_index: button.index }, session));
      assert.equal(receipt.isError ?? false, false, `点「${label}」被拒：${JSON.stringify(receipt).slice(0, 200)}`);
      state = await observe(stack, windowId, session);
    }

    // 重读界面确认结果（显示区是名为「显示为 0」的 Text；不信回执自述）
    const readDisplay = (snapshot) =>
      snapshot.elements.find((element) => /显示为|Display is/.test(String(element.name ?? "")))?.name ?? "";
    let display = readDisplay(state);
    let answer = /42/.test(display);
    for (let attempt = 0; attempt < 10 && !answer; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      state = await observe(stack, windowId, session);
      display = readDisplay(state);
      answer = /42/.test(display);
    }
    if (!answer) console.error(`最终树：${NL}${treeLines(state)}`);
    assert.ok(answer, `显示区应显示 42，实际=${JSON.stringify(display)}`);
  } finally {
    calc.kill();
    await stack.stop();
  }
});

test("出错不骗人：伪造帧号 / 越界索引 → 结构化拒绝", { skip: !ENABLED }, async () => {
  const stack = await startStack();
  const notepad = spawn("notepad.exe", []);
  const session = "p4b-refusal";
  try {
    const window = await findWindow(stack, (item) => item.pid === notepad.pid);
    assert.ok(window, "应能找到记事本窗口");
    const windowId = String(window.windowId ?? window.window_id);
    await observe(stack, windowId, session);

    const bogusFrame = await stack.invoke("left_click", { x: 10, y: 20, frame_id: "no-such-frame" }, session);
    assert.equal(bogusFrame.isError, true, "伪造帧号必须被拒");
    assert.equal(stack.receipt(bogusFrame).code, "STALE_STATE");

    const missingElement = await stack.invoke("left_click", { element_index: 999 }, session);
    assert.equal(missingElement.isError, true, "越界索引必须被拒");
    assert.equal(stack.receipt(missingElement).code, "ELEMENT_UNAVAILABLE");
    assert.notEqual(stack.receipt(missingElement).dispatch_status, "sent", "被拒绝的动作不能标成已发送");
  } finally {
    notepad.kill();
    await stack.stop();
  }
});

test("kill switch 跨会话真闩锁：另一会话被拒且界面真的没变", { skip: !ENABLED }, async () => {
  const stack = await startStack();
  const notepad = spawn("notepad.exe", []);
  const sessionA = "p4b-A";
  const sessionB = "p4b-B";
  try {
    const window = await findWindow(stack, (item) => item.pid === notepad.pid);
    assert.ok(window, "应能找到记事本窗口");
    const windowId = String(window.windowId ?? window.window_id);
    const before = await observe(stack, windowId, sessionA);
    const editable = before.elements.find((element) => element.editable === true);
    assert.ok(editable, "应能找到可编辑元素");

    const stopped = stack.receipt(await stack.invoke("stop_computer_control", {}, sessionA));
    assert.equal(stopped.stopped, true);

    // 会话内台账与跨会话闩锁是两道独立的闸：B 也要先观察，才会走到 kill switch 那一步
    // （否则先撞自己的 STALE_STATE —— 离线测试里同一条规律）。
    const editableForB = (await observe(stack, windowId, sessionB)).elements.find(
      (element) => element.editable === true,
    );
    assert.ok(editableForB, "B 会话应也能观察");
    const blocked = await stack.invoke("type", { text: "SHOULD-NOT-APPEAR", element_index: editableForB.index }, sessionB);
    assert.equal(blocked.isError, true, "闩锁后输入必须被拒");
    assert.equal(stack.receipt(blocked).code, "CONTROL_STOPPED", "错误码应是 CONTROL_STOPPED");

    const access = await stack.invoke("request_access", {}, sessionA);
    assert.equal(access.isError ?? false, false, "request_access 是豁免项，应仍可用");

    const after = await observe(stack, windowId, sessionB);
    assert.equal(
      String(after.text).includes("SHOULD-NOT-APPEAR"),
      false,
      "被拒绝的打字不能真的落进界面（重读验证）",
    );
  } finally {
    notepad.kill();
    await stack.stop();
  }
});

test("perform_action：菜单路径开新标签页 + 未广告的动作明确拒", { skip: !ENABLED }, async () => {
  const stack = await startStack();
  const notepad = spawn("notepad.exe", []);
  const session = "p4b-action";
  try {
    const window = await findWindow(stack, (item) => item.pid === notepad.pid);
    assert.ok(window, "应能找到记事本窗口");
    const windowId = String(window.windowId ?? window.window_id);
    const before = await observe(stack, windowId, session);
    const windowsBefore = (await stack.receipt(await stack.invoke("list_windows", { pid: notepad.pid }, session))).windows?.length ?? 0;
    const textBefore = String(before.text ?? "");

    // 菜单路径（引擎的 invoke_menu：按标签逐级解析，不碰像素）
    const invoked = stack.receipt(
      await stack.invoke("perform_action", { action: "文件(F) > 新建", window_id: windowId }, session),
    );
    assert.equal(invoked.isError ?? false, false, `菜单路径被拒：${JSON.stringify(invoked).slice(0, 240)}`);

    // "新建"在记事本里的表现形式随版本/平台变（新标签页 / 新窗口 / 标题变化）——
    // 判据取"有可观察变化"：窗口数变了，或同一窗口的树变了。
    let changed = false;
    let after = before;
    for (let attempt = 0; attempt < 10 && !changed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const windowsAfter =
        (await stack.receipt(await stack.invoke("list_windows", { pid: notepad.pid }, session))).windows?.length ?? 0;
      after = await observe(stack, windowId, session);
      changed = windowsAfter !== windowsBefore || String(after.text ?? "") !== textBefore;
    }
    if (!changed) {
      console.error("窗口数 before/after：" + windowsBefore);
      console.error("树（after）：" + NL + treeLines(after, 30));
    }
    assert.ok(changed, "「文件(F) > 新建」应产生可观察变化（新窗口或树变化）");

    // 未广告的动作必须被拒（规格：只认元素广告过的名字，禁止猜测）
    const bogus = await stack.invoke(
      "perform_action",
      { element_index: 1, action: "definitely-not-advertised" },
      session,
    );
    assert.equal(bogus.isError, true, "未广告的动作必须被拒");
    assert.equal(stack.receipt(bogus).code, "ACTION_UNAVAILABLE");
  } finally {
    notepad.kill();
    await stack.stop();
  }
});

test("select_text：引擎无文本范围原语 → 诚实拒绝并给替代", { skip: !ENABLED }, async () => {
  const stack = await startStack();
  const notepad = spawn("notepad.exe", []);
  const session = "p4b-select";
  try {
    const window = await findWindow(stack, (item) => item.pid === notepad.pid);
    assert.ok(window, "应能找到记事本窗口");
    const windowId = String(window.windowId ?? window.window_id);
    const state = await observe(stack, windowId, session);
    const editable = state.elements.find((element) => element.editable === true);
    assert.ok(editable, "应能找到可编辑元素");

    const envelope = await stack.invoke(
      "select_text",
      { element_index: editable.index, text_range: [0, 2] },
      session,
    );
    assert.equal(envelope.isError, true, "select_text 必须明确拒绝（不假装成功）");
    assert.equal(stack.receipt(envelope).code, "ACTION_UNAVAILABLE");
    assert.match(String(stack.receipt(envelope).message ?? ""), /set_value|click/);
  } finally {
    notepad.kill();
    await stack.stop();
  }
});
