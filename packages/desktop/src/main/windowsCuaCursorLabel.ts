/**
 * 原生光标旁的操作说明（"点击「7」"）。
 *
 * 为什么单独一个模块：daemon 画的原生 ghost 我们改不了渲染，但 Helper 的活动事件带落点
 * 与一句话摘要；这里用一个无焦点、鼠标穿透的透明窗口把说明贴在落点旁边，得到与 ZCode
 * 同类的"光标 + 说明"。它**不画光标**，只画一行字。
 *
 * 从 windowsCuaOperationIndicator.ts 拆出（2026-11-27）：该文件已到 oxlint 行数上限，
 * 且标签的生命周期（显示/淡出/销毁）与光标是两套独立状态，混在一起只会更难读。
 */
import type { BrowserWindowConstructorOptions, Display, Point, Rectangle } from "electron";
import {
  CURSOR_LABEL_HEIGHT,
  CURSOR_LABEL_WIDTH,
  cursorLabelDataUrl,
} from "./windowsCuaOperationIndicatorContent.js";
import type { WindowsCuaOperationIndicatorWindow } from "./windowsCuaOperationIndicator.js";

const LABEL_FADE_MS = 160;
const LABEL_RETRY_MS = 5_000;
/** 说明的兜底隐藏：Helper 正常会发 inactive；消息丢失时不能让它停在屏幕上。 */
const LABEL_AUTO_HIDE_MS = 5_000;

/**
 * 标签的 bounds：贴在落点右下方（18px 间隙），整体夹进显示器工作区。
 * 与光标窗口不同，它不居中——标签在光标旁边，不能压住落点。
 */
export function cursorLabelBoundsFor(point: Point, workArea: Rectangle): Rectangle {
  const gap = 18;
  const minX = workArea.x;
  const maxX = workArea.x + workArea.width - CURSOR_LABEL_WIDTH;
  const minY = workArea.y;
  const maxY = workArea.y + workArea.height - CURSOR_LABEL_HEIGHT;
  const x = maxX >= minX ? Math.min(Math.max(point.x + gap, minX), maxX) : workArea.x;
  const y = maxY >= minY ? Math.min(Math.max(point.y + gap, minY), maxY) : workArea.y;
  return {
    width: CURSOR_LABEL_WIDTH,
    height: CURSOR_LABEL_HEIGHT,
    x: Math.round(x),
    y: Math.round(y),
  };
}

export interface CursorLabelOverlayLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface CursorLabelOverlayOptions {
  platform?: NodeJS.Platform;
  createWindow: (
    options: BrowserWindowConstructorOptions,
    kind: "label",
  ) => WindowsCuaOperationIndicatorWindow;
  getDisplayNearestPoint: (point: Point) => Pick<Display, "workArea">;
  /** Helper 的落点是原生屏幕像素；Electron 的 bounds 用 DIP。 */
  toDipPoint: (point: Point) => Point;
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule: (timer: ReturnType<typeof setTimeout>) => void;
  now: () => number;
  logger: CursorLabelOverlayLogger;
}

export interface CursorLabelOverlay {
  showAt(point: Point, text: string): void;
  hide(): void;
  ownsWindow(candidate: object): boolean;
  dispose(): void;
}

export const OVERLAY_IDLE_DESTROY_DELAY_MS = 45_000;

/** 为透明置顶浮层提供统一的隐藏后空闲销毁计时器，避免长期驻留 Chromium 渲染进程。 */
export function createOverlayIdleDestroyTimer(
  schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>,
  cancelSchedule: (timer: ReturnType<typeof setTimeout>) => void,
  delayMs = OVERLAY_IDLE_DESTROY_DELAY_MS,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (!timer) return;
    cancelSchedule(timer);
    timer = null;
  };
  const arm = (onExpire: () => void) => {
    cancel();
    timer = schedule(() => {
      timer = null;
      onExpire();
    }, delayMs);
  };
  return { arm, cancel };
}

export function createCursorLabelOverlay(
  options: CursorLabelOverlayOptions,
): CursorLabelOverlay {
  const platform = options.platform ?? process.platform;
  const ownedWindows = new WeakSet<object>();
  let window: WindowsCuaOperationIndicatorWindow | null = null;
  let ready = false;
  let shown = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const idleDestroy = createOverlayIdleDestroyTimer(options.schedule, options.cancelSchedule);
  let failedAt = 0;
  let point: Point | null = null;
  let text = "";
  let desiredVisible = false;
  let disposed = false;

  function cancelHideTimer(): void {
    idleDestroy.cancel();
    if (!hideTimer) return;
    options.cancelSchedule(hideTimer);
    hideTimer = null;
  }

  function discard(target: WindowsCuaOperationIndicatorWindow): void {
    if (window === target) {
      window = null;
      ready = false;
      shown = false;
    }
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (error) {
      options.logger.debug("[cua-cursor-label] failed to discard window", error);
    }
  }

  function setState(
    target: WindowsCuaOperationIndicatorWindow,
    nextState: "active" | "leaving",
  ): void {
    if (target.isDestroyed()) return;
    void target.webContents
      .executeJavaScript(`document.documentElement.dataset.state=${JSON.stringify(nextState)}`)
      .catch((error) => options.logger.debug("[cua-cursor-label] state update failed", error));
  }

  function setText(target: WindowsCuaOperationIndicatorWindow, nextText: string): void {
    if (target.isDestroyed()) return;
    void target.webContents
      .executeJavaScript(
        `(() => { const node = document.getElementById("label"); if (node) node.textContent = ${JSON.stringify(nextText)}; })()`,
      )
      .catch((error) => options.logger.debug("[cua-cursor-label] text update failed", error));
  }

  function ensureWindow(): WindowsCuaOperationIndicatorWindow | null {
    if (disposed || platform !== "win32") return null;
    if (window && !window.isDestroyed()) return window;
    // 失败后冷却重试：显示器/合成器异常时不要在每次动作都重建窗口刷日志。
    if (failedAt > 0 && options.now() - failedAt < LABEL_RETRY_MS) return null;

    let created: WindowsCuaOperationIndicatorWindow | null = null;
    try {
      created = options.createWindow(
        {
          width: CURSOR_LABEL_WIDTH,
          height: CURSOR_LABEL_HEIGHT,
          alwaysOnTop: true,
          focusable: false,
          frame: false,
          hasShadow: false,
          resizable: false,
          show: false,
          skipTaskbar: true,
          transparent: true,
          backgroundColor: "#00000000",
          autoHideMenuBar: true,
          fullscreenable: false,
          maximizable: false,
          minimizable: false,
          movable: false,
          webPreferences: {
            contextIsolation: true,
            devTools: false,
            nodeIntegration: false,
            sandbox: true,
          },
        },
        "label",
      );
      const target = created;
      window = target;
      ready = false;
      shown = false;
      ownedWindows.add(target);
      target.setIgnoreMouseEvents(true);
      target.on("closed", () => {
        if (window === target) {
          window = null;
          ready = false;
          shown = false;
        }
      });
      void target
        .loadURL(cursorLabelDataUrl())
        .then(() => {
          if (disposed || target !== window || target.isDestroyed()) return;
          ready = true;
          failedAt = 0;
          if (!desiredVisible || !point || !text) {
            setState(target, "leaving");
            return;
          }
          setText(target, text);
          present(target);
        })
        .catch((error) => {
          options.logger.warn("[cua-cursor-label] failed to load label content", error);
          if (disposed) return;
          failedAt = options.now();
          discard(target);
        });
      return target;
    } catch (error) {
      options.logger.warn("[cua-cursor-label] failed to create label window", error);
      failedAt = options.now();
      if (created) discard(created);
      return null;
    }
  }

  function present(target: WindowsCuaOperationIndicatorWindow): void {
    if (!point) return;
    const { workArea } = options.getDisplayNearestPoint(point);
    target.setBounds(cursorLabelBoundsFor(point, workArea));
    if (!shown) {
      try {
        target.showInactive();
        target.setAlwaysOnTop(true, "pop-up-menu");
        target.moveTop();
        shown = true;
      } catch (error) {
        options.logger.warn("[cua-cursor-label] failed to show label window", error);
        discard(target);
        return;
      }
    }
    setState(target, "active");
    cancelHideTimer();
    hideTimer = options.schedule(() => {
      hideTimer = null;
      hide();
    }, LABEL_AUTO_HIDE_MS);
  }

  function showAt(nextPoint: Point, nextText: string): void {
    if (disposed) return;
    const trimmed = String(nextText ?? "").trim();
    if (!trimmed) return;
    let dipPoint = nextPoint;
    try {
      dipPoint = options.toDipPoint(nextPoint);
    } catch (error) {
      options.logger.debug("[cua-cursor-label] dip conversion failed", error);
    }
    point = dipPoint;
    text = trimmed;
    desiredVisible = true;
    const target = ensureWindow();
    if (!target || !ready || target.isDestroyed()) return;
    setText(target, text);
    present(target);
  }

  function hide(): void {
    desiredVisible = false;
    cancelHideTimer();
    if (!window || window.isDestroyed()) return;
    const target = window;
    setState(target, "leaving");
    hideTimer = options.schedule(() => {
      hideTimer = null;
      if (disposed || target !== window || target.isDestroyed()) return;
      try {
        target.hide();
        shown = false;
        idleDestroy.arm(() => {
          if (!disposed && !desiredVisible && target === window && !target.isDestroyed()) {
            discard(target);
          }
        });
      } catch (error) {
        options.logger.warn("[cua-cursor-label] hide failed, destroying window", error);
        discard(target);
      }
    }, LABEL_FADE_MS);
  }

  function ownsWindow(candidate: object): boolean {
    return ownedWindows.has(candidate);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    desiredVisible = false;
    cancelHideTimer();
    const target = window;
    window = null;
    ready = false;
    shown = false;
    point = null;
    text = "";
    if (target && !target.isDestroyed()) target.destroy();
  }

  return { showAt, hide, ownsWindow, dispose };
}
