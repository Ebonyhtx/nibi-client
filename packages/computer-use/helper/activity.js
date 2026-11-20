/**
 * CUA 动作活动上报：Helper → Host 的**纯展示旁路**。
 *
 * 目的：让桌面的「NIBI 正在操作电脑」横幅与 agent 光标浮层不依赖运行时内核（Node/Rust）
 * 的工具事件，而是直接跟随 Helper 真正下发的输入动作。它只用于可视化：
 *   · 绝不能被当成动作成功的证据（成功与否仍只看回执的 action_sent / dispatch_status）；
 *   · 任何发送失败、坐标映射失败都只能退化成"没有提示"，不得影响动作本身。
 *
 * 事件形状（child IPC，protocol 由 main.js 的 send 统一加）：
 *   { type: "cua_activity", active: true, sessionId, action, x?, y?, at }
 *   { type: "cua_activity", active: false, sessionId, action: "idle"|"released"|"stopped", at }
 *
 * 坐标空间：工具契约里的 x/y 是**截图像素坐标**（见 runtime/index.js 的 image_ref 说明）。
 * 最近一次观察带回 windowBounds + screenshotWidth/Height（或 screenshotScale），据此换算成
 * 屏幕坐标；没有观察映射时按原值兜底，让浮层至少落在"用户以为的位置"附近。
 *
 * 从 helper/main.js 拆出（2026-11-14）：这一层是独立的时间语义（空闲 1.5s）与坐标换算，
 * 放在主文件里会让动作分发与展示旁路互相纠缠。
 */

/** Helper 侧空闲判定：最后一次动作后 1.5s 无输入 → 通知宿主收起提示。 */
export const CUA_ACTIVITY_IDLE_MS = 1_500;

const ACTIVITY_MESSAGE_TYPE = "cua_activity";

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function windowKey(value) {
  return value === undefined || value === null || value === "" ? undefined : String(value);
}

/**
 * 记住最近一次观察的「截图像素 ↔ 屏幕坐标」映射。
 *
 * key 用 window_id；没有 window_id 的动作退回最近一次观察的窗口。映射缺失时 resolve 返回
 * 原始 x/y（浮层仍能显示，只是可能偏一点），绝不抛错。
 */
export function createActivityCoordinateLedger() {
  const spaces = new Map();
  let lastWindowId = null;

  function remember(windowId, raw) {
    const id = windowKey(windowId);
    if (!id || !raw || typeof raw !== "object") return;
    const bounds = raw.windowBounds ?? raw.window_bounds ?? raw.bounds;
    if (
      !bounds ||
      finiteNumber(bounds.x) === undefined ||
      finiteNumber(bounds.y) === undefined ||
      !positiveNumber(bounds.width) ||
      !positiveNumber(bounds.height)
    ) {
      return;
    }
    const screenshotWidth = positiveNumber(raw.screenshotWidth ?? raw.screenshot_width);
    const screenshotHeight = positiveNumber(raw.screenshotHeight ?? raw.screenshot_height);
    const scale =
      positiveNumber(raw.screenshotScale ?? raw.screenshot_scale) ??
      (screenshotWidth ? screenshotWidth / bounds.width : 1);
    spaces.set(id, {
      bounds: { x: Number(bounds.x), y: Number(bounds.y) },
      scaleX: scale,
      scaleY: screenshotHeight ? screenshotHeight / bounds.height : scale,
    });
    lastWindowId = id;
  }

  function resolve(method, params) {
    const raw = actionCoordinates(method, params);
    if (!raw) return undefined;
    const id = windowKey(params?.window_id ?? params?.windowId) ?? lastWindowId;
    const space = id ? spaces.get(id) : undefined;
    if (!space) return { x: raw.x, y: raw.y };
    return {
      x: space.bounds.x + raw.x / space.scaleX,
      y: space.bounds.y + raw.y / space.scaleY,
    };
  }

  return { remember, resolve };
}

/** 从动作参数里挑出用于浮层落点的坐标（拖拽用终点，缺失才退回起点）。 */
export function actionCoordinates(method, params) {
  const x = finiteNumber(params?.x);
  const y = finiteNumber(params?.y);
  if (x !== undefined && y !== undefined) return { x, y };
  if (method === "left_click_drag") {
    const toX = finiteNumber(params?.to_x);
    const toY = finiteNumber(params?.to_y);
    if (toX !== undefined && toY !== undefined) return { x: toX, y: toY };
    const fromX = finiteNumber(params?.from_x);
    const fromY = finiteNumber(params?.from_y);
    if (fromX !== undefined && fromY !== undefined) return { x: fromX, y: fromY };
  }
  return undefined;
}

/**
 * 活动上报器。`active(method, params)` 表示"马上要下发一次输入"；`inactive(reason)` 表示
 * 空闲/释放/急停。所有对外副作用都包在 try/catch 里，任何异常都不会反噬动作。
 */
export function createCuaActivity({
  send,
  now = () => Date.now(),
  schedule = setTimeout,
  cancel = clearTimeout,
  idleMs = CUA_ACTIVITY_IDLE_MS,
  coordinates = createActivityCoordinateLedger(),
} = {}) {
  let idleTimer = null;
  let activeSessionId = null;
  let hasActiveEvent = false;
  let disposed = false;

  function publish(message) {
    try {
      send?.(message);
    } catch {
      // 展示旁路的最后一道 fail-open：IPC 断了也不影响输入动作。
    }
  }

  function clearIdleTimer() {
    if (!idleTimer) return;
    try {
      cancel(idleTimer);
    } catch {
      // 计时器已触发/宿主实现异常都不重要。
    }
    idleTimer = null;
  }

  function sendInactive(reason) {
    const sessionId = activeSessionId;
    activeSessionId = null;
    hasActiveEvent = false;
    publish({
      type: ACTIVITY_MESSAGE_TYPE,
      active: false,
      sessionId,
      action: reason,
      at: now(),
    });
  }

  function armIdleTimer() {
    clearIdleTimer();
    try {
      idleTimer = schedule(() => {
        idleTimer = null;
        if (!disposed) sendInactive("idle");
      }, idleMs);
      idleTimer?.unref?.();
    } catch {
      // 计时器建不起来只意味着少一条 inactive；宿主还有 5s 兜底。
      idleTimer = null;
    }
  }

  return {
    /** 动作下发前的活动信号；参数是 Helper 方法名与已解析的 params。 */
    active(method, params) {
      if (disposed) return;
      const sessionId =
        typeof params?.session_id === "string" && params.session_id ? params.session_id : null;
      let point;
      try {
        point = coordinates.resolve(method, params);
      } catch {
        point = undefined;
      }
      activeSessionId = sessionId;
      hasActiveEvent = true;
      publish({
        type: ACTIVITY_MESSAGE_TYPE,
        active: true,
        sessionId,
        action: method,
        ...(point ? { x: point.x, y: point.y } : {}),
        at: now(),
      });
      // 不在下发瞬间起空闲计时：拖拽/长按可能持续数秒，in-flight 不是"空闲"。
      // 由 input-action 在引擎返回（成功或失败）后调用 settled() 再开始 1.5s 计时。
      clearIdleTimer();
    },
    /** 本次工具调用已结束（引擎返回或抛错）：从此刻起 1.5s 无新动作才收起。 */
    settled() {
      if (disposed || !hasActiveEvent) return;
      armIdleTimer();
    },
    /** 空闲/释放/急停时立即收起；重复调用是幂等的。 */
    inactive(reason = "released") {
      if (disposed) return;
      clearIdleTimer();
      sendInactive(reason);
    },
    /** 观察类动作不弹提示，只更新坐标映射。 */
    rememberObservation(windowId, raw) {
      try {
        coordinates.remember(windowId, raw);
      } catch {
        // 坐标映射是锦上添花，失败不影响观察。
      }
    },
    dispose() {
      disposed = true;
      clearIdleTimer();
    },
  };
}
