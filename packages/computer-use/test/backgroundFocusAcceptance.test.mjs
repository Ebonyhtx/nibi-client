/**
 * 真机焦点验收（可选，默认跳过）：**后台输入不能抢走用户的前台窗口**。
 *
 *   NIBI_CUA_NATIVE_ACCEPTANCE=1 node --import tsx --test test/backgroundFocusAcceptance.test.mjs
 *
 * 前置：`pnpm --filter @nibi/desktop prepare:cua-helper`（与 nativeAcceptance 相同）。
 *
 * 判据（只碰我们自己拉起的记事本）：
 *   1. 记录当前前台窗口 HWND + 进程 + 真实鼠标位置；
 *   2. 用 Helper 的 launch_app **默认模式**拉起 notepad.exe（不带 activate/start_minimized）；
 *   3. 再记录前台——必须还是原来那个窗口/进程（默认 open_application 不激活）；
 *   4. 带截图观察编辑元素，用 **默认 background** 坐标点击把内部焦点放进 Edit；
 *   5. 重新观察后用 **默认 background** 的 `type` 打字；
 *   6. 全程前台窗口/进程与真实鼠标位置不得变化，且重读 AX 树能看到刚打的字
 *      （内容真的变了，不是回执自述）。
 *
 * 为什么用 PowerShell：Windows 没有 Node 内置的 GetForegroundWindow；这里只读前台
 * HWND/进程，不调用 SetForegroundWindow，不改任何用户窗口。鼠标位置用引擎自己的
 * 只读 `get_cursor_position` 读（避免另起进程扰动目标窗口焦点）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const ENABLED = Boolean(
  process.env.NIBI_CUA_NATIVE_ACCEPTANCE || process.argv.includes("--background-focus"),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const FOREGROUND_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class NibiForeground {",
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
  "}",
  "'@",
  "$h = [NibiForeground]::GetForegroundWindow()",
  "$processId = [uint32]0",
  "[NibiForeground]::GetWindowThreadProcessId($h, [ref]$processId) | Out-Null",
  "$p = Get-Process -Id $processId -ErrorAction SilentlyContinue",
  '$name = if ($p) { $p.ProcessName } else { "" }',
  'Write-Output ("{0} {1} {2}" -f $h.ToInt64(), $processId, $name)',
].join("\n");

function readForeground() {
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", FOREGROUND_SCRIPT],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  const [hwnd, pid, name = ""] = output.split(/\s+/);
  return { hwnd: Number(hwnd) || 0, pid: Number(pid) || 0, name };
}

/**
 * 前台验收按**进程**判定：用户在同一进程内切换窗口（例如两个 Chrome 窗口）不算被抢；
 * HWND 只进错误信息，避免把用户的窗口切换误判成引擎抢焦点。
 */
function assertSameForeground(after, before, label) {
  assert.equal(
    after.pid,
    before.pid,
    `${label}：前台进程不得变化（before=${JSON.stringify(before)} after=${JSON.stringify(after)}）`,
  );
  assert.equal(
    after.name,
    before.name,
    `${label}：前台进程名不得变化（before=${JSON.stringify(before)} after=${JSON.stringify(after)}）`,
  );
}

/**
 * 用引擎自己的只读 `get_cursor_position` 读真实鼠标（不用 PowerShell：启动进程本身
 * 可能扰动目标窗口的内部焦点，反而让后台输入失败）。
 */
async function createCursorReader() {
  const { CuaDriver, uniffiInitAsync } = await import("@trycua/cua-driver");
  await uniffiInitAsync?.();
  const driver = CuaDriver.create({ claudeCodeCompatibility: false });
  return {
    async read() {
      const result = await driver.callTool("get_cursor_position", "{}");
      if (result?.isError === true) {
        throw new Error(`get_cursor_position 失败：${result.text ?? result.errorCode ?? "unknown"}`);
      }
      const point = JSON.parse(String(result?.structuredJson ?? "{}"));
      return { x: Number(point.x) || 0, y: Number(point.y) || 0 };
    },
    async close() {
      try {
        await driver.shutdown?.();
      } catch {
        // 进程退出会收尾。
      }
    },
  };
}

/**
 * 在动作期间检查真实鼠标没有位移。先做一次 150ms 空闲采样：用户自己正在动鼠标时
 * 跳过本轮断言（否则会把用户的鼠标移动误判成引擎抢指针）。用户空闲时才断言。
 */
async function withCursorCheck(action, label, readCursor) {
  const before = await readCursor();
  await sleep(150);
  const stable = await readCursor();
  if (before.x !== stable.x || before.y !== stable.y) {
    return await action();
  }
  const result = await action();
  const after = await readCursor();
  if (after.x === stable.x && after.y === stable.y) return result;
  // 真实鼠标可能被用户本人在动作期间移动：再采样一次，仍在移动就判为外部移动，
  // 不把用户的手抖记到引擎头上；只有“一次跳到新位置后停住”才判引擎移动了指针。
  await sleep(150);
  const afterAgain = await readCursor();
  if (afterAgain.x !== after.x || afterAgain.y !== after.y) {
    console.error(`${label}：检测到持续的外部鼠标移动，跳过本轮指针断言`);
    return result;
  }
  assert.deepEqual(after, stable, `${label}不得移动真实鼠标（agent cursor overlay 不得退化成真实指针）`);
  return result;
}

function notepadPids() {
  const output = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "(Get-Process notepad -ErrorAction SilentlyContinue).Id"],
    { encoding: "utf8", windowsHide: true },
  ).trim();
  return new Set(
    output
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  );
}

async function startStack() {
  const { resolveWindowsCuaRuntime } = await import(
    "../../services/src/cua-permission-broker/windowsCuaDevRuntime.js"
  );
  const { mintBrokerSocketPath } = await import("../broker.js");
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
  // 与 nativeAcceptance 同口径：不给 NIBI_CUA_ENGINE_MODULE，逼 Helper 按包内相对路径找引擎。
  delete env.NIBI_CUA_ENGINE_MODULE;
  const helper = fork(
    resolved.entryPath,
    ["--socket", socketPath, "--parent-pid", String(process.pid)],
    {
      cwd: resolved.root,
      env,
      execPath: resolved.command,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  helper.stderr?.on("data", (chunk) => process.stderr.write(String(chunk).slice(0, 400)));

  let ready = false;
  helper.on("message", (message) => {
    if (message?.type === "transport_ready") ready = true;
  });
  const deadline = Date.now() + 20_000;
  while (!ready && Date.now() < deadline) await sleep(200);
  assert.ok(ready, "Helper 应在 20s 内握手");

  const { callBrokerMethod } = await import("../broker.js");
  return {
    call: (method, params) =>
      callBrokerMethod({ socketPath, method, params, timeoutMs: 30_000 }),
    stop: async () => {
      if (helper.connected) {
        try {
          helper.send({ protocol: "nibi-cua-windows-dev/v1", type: "shutdown" });
        } catch {
          // 通道已断：下面按退出码兜底。
        }
      }
      await Promise.race([once(helper, "exit"), sleep(5000)]);
      if (helper.exitCode === null) helper.kill();
    },
  };
}

async function findWindow(stack, pid, attempts = 40) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const listed = await stack.call("list_windows", { pid, on_screen_only: false });
    const window = (listed?.windows ?? []).find((item) => Number(item.pid) === Number(pid));
    if (window) return window;
    await sleep(250);
  }
  return undefined;
}

/**
 * 取一个窗口内截图像素坐标。引擎的 `frame` 是**屏幕**坐标，`screenshot_frame` 才是
 * 位图坐标；没有 screenshot_frame 时用 window.bounds + 截图尺寸换算。
 */
function screenshotPoint(element, window, state) {
  // 往里放 200px：贴边点击可能落在非客户区/边框上，焦点进不了 Edit。
  const inset = (size) => Math.min(200, Math.max(20, size / 2));
  const shot = element?.screenshot_frame;
  if (shot && typeof shot.x === "number" && typeof shot.y === "number") {
    return {
      x: shot.x + inset(shot.w),
      y: shot.y + inset(shot.h),
    };
  }
  const frame = element?.frame;
  const bounds = window?.bounds;
  if (!frame || !bounds) return undefined;
  const scaleX =
    typeof state?.screenshot_width === "number" && bounds.width > 0
      ? state.screenshot_width / bounds.width
      : 1;
  const scaleY =
    typeof state?.screenshot_height === "number" && bounds.height > 0
      ? state.screenshot_height / bounds.height
      : 1;
  return {
    x: (frame.x - bounds.x + inset(frame.w)) * scaleX,
    y: (frame.y - bounds.y + inset(frame.h)) * scaleY,
  };
}

test(
  "真机焦点：launch_app 默认不激活，后台 type 不抢前台且内容真的变化",
  { skip: !ENABLED || process.platform !== "win32" },
  async () => {
    const notepadPath = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "notepad.exe");
    assert.ok(existsSync(notepadPath), `找不到 ${notepadPath}`);

    const foregroundBefore = readForeground();
    const notepadsBefore = notepadPids();
    const stack = await startStack();
    const cursorReader = await createCursorReader();
    let notepadPid = 0;
    try {
      // Helper spawn 本身也不能抢前台（windowsHide + 无 UI）。
      const foregroundAfterHelper = readForeground();
      assertSameForeground(foregroundAfterHelper, foregroundBefore, "Helper 启动不得改变前台");

      // 默认模式拉起：不传 activate / start_minimized，验证 launch_app 的默认非激活语义。
      const launched = await stack.call("launch_app", { path: notepadPath });
      assert.equal(launched?.launched, true, `launch_app 应成功：${JSON.stringify(launched).slice(0, 300)}`);
      const structured = launched?.structured ?? {};
      notepadPid =
        typeof structured.pid === "number"
          ? structured.pid
          : typeof launched?.pid === "number"
            ? launched.pid
            : 0;
      if (!notepadPid) {
        // 引擎没给 pid 时，只认启动前后新增的 notepad 进程（绝不碰用户已有窗口）。
        for (let attempt = 0; attempt < 20 && !notepadPid; attempt += 1) {
          const fresh = [...notepadPids()].find((pid) => !notepadsBefore.has(pid));
          if (fresh) notepadPid = fresh;
          else await sleep(250);
        }
      }
      assert.ok(notepadPid > 0, "应能确定我们拉起的记事本 pid");

      const foregroundAfterLaunch = readForeground();
      assertSameForeground(foregroundAfterLaunch, foregroundBefore, "launch_app 默认模式不得抢前台");
      assert.notEqual(foregroundAfterLaunch.pid, notepadPid, "前台不得被我们拉起的记事本抢走");

      const window = await findWindow(stack, notepadPid);
      assert.ok(window, "应能找到我们拉起的记事本窗口");
      const windowId = String(window.windowId ?? window.window_id);
      const sessionId = "sess-background-focus";

      // 先带截图观察：坐标动作必须绑这次捕获（否则引擎按帧新鲜度拒绝）。
      const state = await stack.call("get_app_state", {
        window_id: windowId,
        pid: notepadPid,
        include_screenshot: true,
      });
      const editable = (state?.elements ?? []).find((element) => element.editable === true);
      assert.ok(
        editable,
        `记事本应有可编辑元素；树：${String(state?.text ?? "").slice(0, 800)}`,
      );
      assert.ok(
        typeof state?.screenshot_width === "number" && typeof state?.screenshot_height === "number",
        `带截图观察应给出截图尺寸：${JSON.stringify(Object.keys(state ?? {}))}`,
      );
      const point = screenshotPoint(editable, window, state);
      assert.ok(point, "应从元素 frame + window bounds 换算出截图坐标");

      // 后台点击：把输入焦点放进记事本的 Edit（不激活窗口）。这是后续 PostMessage
      // 打字能落地的前提；点完要重新观察拿新 token。
      const click = await withCursorCheck(
        () =>
          stack.call("left_click", {
            x: point.x,
            y: point.y,
            window_id: windowId,
            pid: notepadPid,
            session_id: sessionId,
          }),
        "后台点击",
        cursorReader.read,
      );
      assert.equal(click?.delivery_mode, "background", "默认点击交付必须是 background");
      assert.notEqual(
        click?.dispatch_status,
        "possibly_sent",
        `点击不该走到 possibly_sent：${String(click?.text ?? "")}`,
      );
      const foregroundAfterClick = readForeground();
      assertSameForeground(foregroundAfterClick, foregroundBefore, "后台点击不得抢前台");
      assert.notEqual(foregroundAfterClick.pid, notepadPid, "前台不得被我们拉起的记事本抢走");

      await sleep(300);
      const beforeType = await stack.call("get_app_state", { window_id: windowId, pid: notepadPid });
      const freshEditable = (beforeType?.elements ?? []).find((element) => element.editable === true);
      assert.ok(freshEditable?.token, "点击后重新观察应拿到新鲜可编辑元素");

      const marker = `NIBI-BG-${Date.now()}`;
      const receipt = await withCursorCheck(
        () =>
          stack.call("type", {
            text: marker,
            element_token: freshEditable.token,
            window_id: windowId,
            pid: notepadPid,
            session_id: sessionId,
          }),
        "后台输入",
        cursorReader.read,
      );
      assert.notEqual(
        receipt?.dispatch_status,
        "possibly_sent",
        `打字不该走到 possibly_sent：${String(receipt?.text ?? "")}`,
      );
      assert.equal(receipt?.delivery_mode, "background", "默认交付必须是 background");

      const foregroundAfterInput = readForeground();
      assertSameForeground(foregroundAfterInput, foregroundBefore, "后台输入不得抢前台");
      assert.notEqual(foregroundAfterInput.pid, notepadPid, "前台不得被我们拉起的记事本抢走");

      let after = beforeType;
      let changed = false;
      for (let attempt = 0; attempt < 12 && !changed; attempt += 1) {
        await sleep(300);
        after = await stack.call("get_app_state", { window_id: windowId, pid: notepadPid });
        changed = String(after?.text ?? "").includes(marker.slice(-6));
      }
      assert.ok(
        changed,
        `重读 AX 树应看到刚打的字（${marker}）；树：${String(after?.text ?? "").slice(0, 1200)}`,
      );
    } finally {
      if (notepadPid > 0) {
        try {
          execFileSync("taskkill.exe", ["/PID", String(notepadPid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
        } catch {
          // 可能已经退出。
        }
      }
      await cursorReader.close();
      await stack.stop();
    }
  },
);
