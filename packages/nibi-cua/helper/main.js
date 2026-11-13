/**
 * Helper 入口 —— 上游那份是「ZCode Computer Use.app」（Node SEA，111.7MB，自带 ax_native.node）。
 * 我们这份是同一个位置的自研实现：**只做两件事**——
 *   1. 按宿主契约握手：绑定命名管道/Unix socket 后发 `transport_ready`，引擎就绪后发 `ready`；
 *   2. 在 socket 上服务 NDJSON 请求（`{id, method, params}` → `{ok, result}` / `{ok:false, error}`），
 *      方法名即工具名（见 vendor/freeall12-computer-use/docs/zcode-computer-use.md §3）。
 *
 * 原生能力全部来自引擎适配层（今天 = Cua Driver）。**语义层不在这里**：state_id / 帧台账 /
 * 租约 / 防重放 / kill switch 归运行时（`createComputerUseRuntime`），Helper 只负责"把这一次原生
 * 操作做掉"。这是上游的切分，也是我们保持"引擎可换"的前提。
 *
 * 启动契约（宿主侧见 packages/services/src/cua-permission-broker/windowsCuaDevHelperHost.ts）：
 *   node <this> --socket <pipe-or-sock> --parent-pid <pid>
 *   环境：NIBI_CUA_HELPER_ADDON=<原生件路径>（本实现用它兜底找引擎）、NIBI_CUA_ENGINE_MODULE
 *   通道：process.send({protocol:"nibi-cua-windows-dev/v1", type:...})
 */

import net from "node:net";
import path from "node:path";
import { createCuaDriverEngine, CuaEngineUnavailableError } from "../engine/cua-driver.js";
import { handleRequestLine, resolveStableBrokerSocketPath, serializeResponse } from "../broker.js";
import { createHelperSemantics } from "./semantics.js";
import { assertEngineOk, buildReceipt, observeWindow } from "./observation.js";
import { createInputAction } from "./input-action.js";
import { activateIfEmpty } from "./transparent-activation.js";
import { launchApp } from "./launch-app.js";
import { rememberLaunchAttempt, withinLaunchCooldown } from "./activation-memory.js";

export const CONTROL_PROTOCOL = "nibi-cua-windows-dev/v1";

function parseArgs(argv) {
  const args = { socket: "", parentPid: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--socket") args.socket = argv[index + 1] ?? "";
    else if (token === "--parent-pid") args.parentPid = Number.parseInt(argv[index + 1] ?? "0", 10) || 0;
  }
  return args;
}

function send(message) {
  process.send?.({ protocol: CONTROL_PROTOCOL, ...message });
}

/** 透明激活后的等待与"把窗口弄活"的级联见 transparent-activation.js；
 *  激活记忆（windowMoves / launchAttempts）见 activation-memory.js。 */

/**
 * backend：方法名 → 实现。协议层（解析/派发/拒未知方法）用 broker.js 那套，这里只放业务。
 * 输入输出字段按工具语义（snake_case）——运行时会用它拼模型的观察与动作结果。
 *
 * 语义分工：**跨会话**的租约与 kill switch 在 Helper（单一进程才能仲裁），会话内的
 * 元素/帧台账与等待策略在运行时（见 ../IMPLEMENTATION.md §一）。
 */
export function createHelperBackend(engine, options = {}) {
  const leaseIdleOverride = Number.parseInt(process.env.NIBI_CUA_LEASE_IDLE_MS ?? "", 10);
  const semantics =
    options.semantics ??
    createHelperSemantics(
      Number.isFinite(leaseIdleOverride) && leaseIdleOverride > 0
        ? { leaseIdleMs: leaseIdleOverride }
        : {},
    );
  // 引擎加载状态探针（startHelper 注入）：transport 先于引擎就绪，health 需要能报"引擎还在装"。
  const engineStatus = options.engineStatus;
  /** 引擎的动作工具大多要 pid + window_id 一起给（缺 pid = "Missing required integer field pid"，
   *  实测踩过两次）。这里是**唯一**的 pid 解析入口：显式给就用，否则按 window_id 现查。 */
  const resolvePid = async (params) => {
    if (typeof params?.pid === "number") return params.pid;
    const windowId = params?.window_id ?? params?.windowId;
    if (windowId === undefined || windowId === null) return undefined;
    const listed = await engine.listWindows({});
    const match = (listed?.windows ?? []).find(
      (window) => String(window.windowId ?? window.window_id) === String(windowId),
    );
    return typeof match?.pid === "number" ? match.pid : undefined;
  };

  // 输入类动作的统一包装（kill switch → 租约 → 引擎 → 回执；含 possibly_sent 语义）见 input-action.js。
  const inputAction = createInputAction({ semantics, engine, resolvePid });

  return {
    helper_health: async () => ({
      pid: process.pid,
      bundle_id: `nibi-computer-use-${process.platform}-${process.arch}`,
      engine: engine.kind,
      // transport 先于引擎就绪；health 必须立刻可答（宿主 full health 不该被引擎加载挡住）。
      engine_status: typeof engineStatus === "function" ? engineStatus() : "ready",
      lease: semantics.status().lease?.sessionId ?? null,
      kill_switch: semantics.status().killSwitchLatched,
    }),
    list_apps: async () => assertEngineOk(await engine.listApps(), "list_apps"),
    launch_app: async (params) => {
      return launchApp({
        engine,
        params,
        semantics,
        withinCooldown: withinLaunchCooldown,
        rememberAttempt: rememberLaunchAttempt,
      });
    },
    list_windows: async (params) => {
      const input = params && typeof params === "object" ? params : {};
      return assertEngineOk(
        await engine.listWindows({
          ...(typeof input.pid === "number" ? { pid: input.pid } : {}),
          // 上游 list_windows 只列可见窗口；默认 true，与工具语义一致。
          onScreenOnly: input.on_screen_only === false ? false : true,
        }),
        "list_windows",
      );
    },
    get_app_state: async (params) => {
      const input = params && typeof params === "object" ? params : {};
      const windowId = input.window_id ?? input.windowId;
      if (windowId === undefined) {
        throw Object.assign(new Error("get_app_state 需要 window_id"), { code: "unrecognized_keys" });
      }
      // 引擎的 GetWindowStateInput 要求 pid + windowId（**bigint**）——缺 pid 或类型不对会
      // 直接 DriverError.InvalidArguments（实测踩过：字符串 windowId + 无 pid）。
      let pid = typeof input.pid === "number" ? input.pid : undefined;
      if (pid === undefined) {
        const listed = await engine.listWindows({});
        const match = (listed?.windows ?? []).find(
          (window) => String(window.windowId ?? window.window_id) === String(windowId),
        );
        pid = typeof match?.pid === "number" ? match.pid : undefined;
      }
      if (pid === undefined) {
        throw Object.assign(new Error(`窗口 ${windowId} 找不到对应 pid`), { code: "ELEMENT_UNAVAILABLE" });
      }
      const observeOnce = () => observeWindow(engine, pid, windowId, input);
      let raw = await observeOnce();
      let receipt = buildReceipt(raw, semantics);
      // 透明激活（职责与判据见 helper/transparent-activation.js）：只在**树为空**时激活——
      // 正常观察绝不抢焦点；kill switch 闩锁后不激活。
      if (receipt.elements.length === 0 && !semantics.status().killSwitchLatched) {
        receipt = await activateIfEmpty({
          engine,
          semantics,
          pid,
          windowId,
          input,
          receipt,
          raw,
          observeOnce,
        });
      }
      return receipt;
    },
    // 桌面权限（TCC）是 macOS 的概念；Windows 上引擎不要求授权。
    permission_status: async () => ({
      grant_owner: process.platform === "darwin" ? (process.execPath ?? "") : "",
      accessibility: process.platform === "darwin" ? "unknown" : "granted",
      accessibility_probe_ok: process.platform !== "darwin",
      screen_recording: process.platform === "darwin" ? "unknown" : "granted",
    }),
    request_access: async () => ({
      accessibility: process.platform === "darwin" ? "unknown" : "granted",
      screen_recording: process.platform === "darwin" ? "unknown" : "granted",
      // macOS 的授权引导由桌面主进程做（@trycua/cua-driver/electron 的 requestMacOSPermissions）。
      needs_user_grant: process.platform === "darwin",
    }),
    /** 会话结束释放租约（不是模型工具）：只有持有者能放。 */
    release_input_lease: async (params) => {
      const input = params && typeof params === "object" ? params : {};
      // 宿主侧的 turn 结束收口：force=true 时不校验持有者（宿主的 turn 生命周期是权威信号）。
      if (input.force === true) {
        const previous = semantics.forceReleaseInputLease();
        return { released: true, previous_owner: previous, forced: true };
      }
      const holder = semantics.status().lease?.sessionId ?? null;
      if (!holder || holder === (input.session_id ?? null)) semantics.releaseInputLease();
      return { released: true, previous_owner: holder };
    },
    stop_computer_control: async () => {
      semantics.latchKillSwitch();
      return { stopped: true, action_sent: true, dispatch_status: "sent" };
    },

    left_click: inputAction("left_click", async (params, engineRef) =>
      await engineRef.callTool("click", {
        ...(params.element_token !== undefined ? { element_token: String(params.element_token) } : {}),
        ...(params.x !== undefined && params.y !== undefined ? { x: params.x, y: params.y } : {}),
        ...(params.window_id !== undefined ? { window_id: String(params.window_id) } : {}),
        ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
        // shim 发 mouse_button/click_count/modifiers（复数）；引擎要 button/count/modifier（单数）。
        button: params.mouse_button ?? params.button ?? "left",
        count: typeof params.click_count === "number" ? params.click_count : 1,
        ...(Array.isArray(params.modifiers) ? { modifier: params.modifiers } : {}),
        delivery_mode: params.delivery_mode,
      }),
    ),
    left_click_drag: inputAction("left_click_drag", async (params, engineRef) =>
      await engineRef.callTool("drag", {
        from_x: params.from_x,
        from_y: params.from_y,
        to_x: params.to_x,
        to_y: params.to_y,
        ...(typeof params.duration_ms === "number" ? { duration_ms: params.duration_ms } : {}),
        ...(params.window_id !== undefined ? { window_id: String(params.window_id) } : {}),
        ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
      }),
    ),
    scroll: inputAction("scroll", async (params, engineRef) =>
      await engineRef.callTool("scroll", {
        direction: params.direction,
        ...(typeof params.amount === "number" ? { amount: params.amount } : {}),
        ...(params.element_token !== undefined ? { element_token: String(params.element_token) } : {}),
        ...(params.window_id !== undefined ? { window_id: String(params.window_id) } : {}),
        ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
      }),
    ),
    type: inputAction("type", async (params, engineRef) =>
      await engineRef.callTool("type_text", {
        text: String(params.text ?? ""),
        ...(params.element_token !== undefined ? { element_token: String(params.element_token) } : {}),
        ...(typeof params.x === "number" && typeof params.y === "number" ? { x: params.x, y: params.y } : {}),
        ...(params.window_id !== undefined ? { window_id: String(params.window_id) } : {}),
        ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
      }),
    ),
    key: inputAction("key", async (params, engineRef) => {
      // shim 的 key 工具参数是 {text, repeat, hold_seconds}（product 面），引擎是 press_key{key}。
      // 只认 params.key 时 shim 的 text 会被丢成空键名（真机 2026-10-11："Empty key name"）。
      const raw = String(params.key ?? params.text ?? "").trim();
      if (!raw) {
        throw Object.assign(
          new Error('key 工具需要按键名（key 或 text 字段，如 "6"、"Return"、"ctrl+c"）'),
          { code: "unrecognized_keys" },
        );
      }
      // 路由判据：**键名/组合键**（字母开头：Return/Tab/F1/KP_1…，或带 + 的和弦）走
      // press_key；**其余（数字、符号、裸文本）走 type_text**。引擎的 press_key 把 "*"
      // 当成没带 Shift 的 8（真机 2026-10-11：6*7 落成 687），而 type_text 的字符注入
      // Shift 正确（同一真机探针：type_text("6*7=") → 42）。
      const isKeyName = /^[A-Za-z][A-Za-z0-9_]*$/.test(raw) || (raw.includes("+") && raw.length > 1);
      const repeats = Number.parseInt(params.repeat ?? params.repeats ?? "1", 10) || 1;
      const delivery = { delivery_mode: params.delivery_mode };
      let last;
      if (!isKeyName) {
        // 字符/文本：type_text（Shift 语义正确）。单字符重复 = 重复注入。
        const text = raw.repeat(Math.min(Math.max(repeats, 1), 30));
        last = await engineRef.callTool("type_text", {
          text,
          ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
          ...(params.window_id !== undefined ? { window_id: Number(params.window_id) } : {}),
          ...delivery,
        });
        return { ...(last ?? {}), via: "type_text" };
      }
      for (let attempt = 0; attempt < Math.min(Math.max(repeats, 1), 30); attempt += 1) {
        last = await engineRef.callTool("press_key", {
          key: raw,
          ...(Array.isArray(params.modifiers) ? { modifiers: params.modifiers } : {}),
          // 引擎的 press_key 与其它动作工具一样要 pid（缺了 = Missing required integer field pid）。
          ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
          ...(params.window_id !== undefined ? { window_id: Number(params.window_id) } : {}),
          ...delivery,
        });
      }
      return { ...(last ?? {}), ...(repeats > 1 ? { repeats } : {}), via: "press_key" };
    }),
    // paste：借系统剪贴板 + 触发粘贴键；剪贴板借还（事后还原用户剪贴板）由运行时做。
    paste: inputAction("paste", async (params, engineRef) => {
      const written = await engineRef.callTool("clipboard_write", { text: String(params.text ?? "") });
      const combo = process.platform === "darwin" ? ["cmd", "v"] : ["ctrl", "v"];
      const pasted = await engineRef.callTool("hotkey", {
        keys: combo,
        ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
        ...(params.window_id !== undefined ? { window_id: Number(params.window_id) } : {}),
      });
      return { ...written, ...pasted, paste_combo: combo.join("+") };
    }),
    set_value: inputAction("set_value", async (params, engineRef) =>
      await engineRef.callTool("set_value", {
        element_token: String(params.element_token ?? ""),
        value: String(params.value ?? ""),
        ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
        ...(params.window_id !== undefined ? { window_id: String(params.window_id) } : {}),
      }),
    ),
    /**
     * perform_action：**只认元素广告过的动作**（规格：禁止猜测）。
     * 引擎侧映射（实测过）：无 action 的 click = 默认 invoke；`action:"expand"` 走
     * ExpandCollapse（不支持的元素会 fail closed）；菜单类走专用 `invoke_menu`——
     * 它按标签逐级解析（path 是数组），**不碰像素**，比点坐标稳得多。
     */
    perform_action: inputAction("perform_action", async (params, engineRef) => {
      const action = String(params.action ?? "");
      if (!action) {
        throw Object.assign(new Error("perform_action 需要 action"), { code: "unrecognized_keys" });
      }
      const isMenuPath = /[>›»]|->/.test(action);
      if (isMenuPath) {
        const path = action
          .split(/[>›»]|->/)
          .map((segment) => segment.trim())
          .filter(Boolean);
        if (path.length === 0) {
          throw Object.assign(new Error(`菜单路径解析为空：${action}`), { code: "unrecognized_keys" });
        }
        return await engineRef.callTool("invoke_menu", {
          path,
          ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
          // invoke_menu 的 window_id 要数值（字符串会 "invalid type: string, expected u64"，实测踩过）。
          ...(params.window_id !== undefined ? { window_id: Number(params.window_id) } : {}),
        });
      }
      if (action === "expand") {
        return await engineRef.callTool("click", {
          element_token: String(params.element_token ?? ""),
          action: "expand",
          ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
          ...(params.window_id !== undefined ? { window_id: String(params.window_id) } : {}),
        });
      }
      if (action === "set_value") {
        return await engineRef.callTool("set_value", {
          element_token: String(params.element_token ?? ""),
          value: String(params.value ?? ""),
          ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
        });
      }
      if (["invoke", "select", "press", "click"].includes(action)) {
        // click 省略 action = 默认 invoke（引擎文档原文：Omit for the default invoke）。
        return await engineRef.callTool("click", {
          element_token: String(params.element_token ?? ""),
          ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
          ...(params.window_id !== undefined ? { window_id: String(params.window_id) } : {}),
        });
      }
      throw Object.assign(
        new Error(`引擎没有与动作「${action}」对应的原生原语；可改用 click/set_value，或按「文件(F) > 新建」这种菜单路径调用`),
        { code: "ACTION_UNAVAILABLE" },
      );
    }),
    /**
     * select_text：**引擎没有按文本范围选择的原语**（它的工具面里没有 text-range）。
     * 与其编一个"看着像成功"的假动作，不如明确拒绝并给出替代（规格里也是 fail-closed 优先）。
     */
    select_text: async () => {
      throw Object.assign(
        new Error(
          "本引擎不支持按文本范围选择（无 text-range 原语）；可改用 set_value 覆盖字段，或先 click 定位再用 key 选中",
        ),
        { code: "ACTION_UNAVAILABLE" },
      );
    },
  };
}

function notImplemented() {
  throw Object.assign(new Error("该方法尚未实现（本批交付只读 + 输入，语义类待接线）"), {
    code: "not_implemented",
  });
}

/**
 * 引擎未就绪时的替身：所有方法调用都等真实引擎就绪后转发，`kind` 静态返回适配层名。
 * 存在的原因：transport_ready 必须**先于**引擎就绪发出（宿主给 agent 发凭据的 1s 准入线
 * 只等 transport；冷启动实测引擎加载 ~1.04s，会把启动时自动 spawn 的 agent 永久打成
 * 不可用——差几毫秒输掉竞态）。backend 的方法都假定 engine 已在手，代理把"等引擎"
 * 收敛在一个地方，backend 不感知。引擎加载失败时所有调用按原错误拒绝（fail-closed）。
 */
function createDeferredEngine(enginePromise, kind = "cua-driver") {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "kind") return kind;
        return (...args) =>
          enginePromise.then((engine) => {
            const value = engine[prop];
            return typeof value === "function" ? value.apply(engine, args) : value;
          });
      },
    },
  );
}

function writeResponse(socket, response) {
  socket.write(serializeResponse(response));
}

function handleLine(backend, socket, line) {
  void handleRequestLine(backend, line).then((response) => {
    const request = (() => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })();
    writeResponse(socket, request?.id === undefined ? response : { id: request.id, ...response });
  });
}

export async function startHelper({ socketPath, argv = [], env = process.env } = {}) {
  const args = parseArgs(argv.length > 0 ? argv : process.argv.slice(2));
  // 显式 --socket 优先（宿主总是给）；缺省时回落到**稳定端点**——它与 agent spawn env 里那个
  // 名字一致，所以"懒启动"（agent 先带着名字起来、Helper 后被拉起）也能对上。
  const target = socketPath || args.socket || resolveStableBrokerSocketPath(env);
  if (!target) throw new Error("缺少 --socket（命名管道或 Unix socket 路径）");

  // 引擎异步加载：绑定管道（transport）绝不能被引擎启动挡住。工具调用经 deferred 代理
  // 等引擎；helper_health 立刻可答。
  const enginePromise = createCuaDriverEngine({ env });
  let engineState = "loading";
  const backend = createHelperBackend(createDeferredEngine(enginePromise), {
    engineStatus: () => engineState,
  });

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) handleLine(backend, socket, line);
        index = buffer.indexOf("\n");
      }
    });
    // 单条读写错误不该拖垮整个 transport。
    socket.on("error", () => socket.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(target, () => resolve());
  });

  const address = server.address();
  const boundPath = typeof address === "string" ? address : (address?.path ?? target);
  send({ type: "transport_ready", socketPath: boundPath, pid: process.pid });

  let engine;
  try {
    engine = await enginePromise;
  } catch (error) {
    engineState = "failed";
    const message =
      error instanceof CuaEngineUnavailableError ? error.message : `引擎启动失败：${String(error)}`;
    send({ type: "error", message });
    await new Promise((resolve) => server.close(() => resolve()));
    throw error;
  }
  engineState = "ready";
  const metadata = await engine.metadata?.().catch(() => undefined);
  send({ type: "ready", socketPath: boundPath, pid: process.pid });

  const shutdown = async () => {
    try {
      await engine.close?.();
    } catch {
      // 忽略：进程退出会收尾。
    }
    await new Promise((resolve) => server.close(() => resolve()));
    process.exit(0);
  };
  process.on("message", (message) => {
    if (message?.protocol === CONTROL_PROTOCOL && message.type === "shutdown") void shutdown();
  });
  process.on("disconnect", () => void shutdown());

  return { server, engine, socketPath: boundPath, metadata, shutdown };
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isDirectEntry) {
  void startHelper().catch((error) => {
    process.stderr.write(`cua helper failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
