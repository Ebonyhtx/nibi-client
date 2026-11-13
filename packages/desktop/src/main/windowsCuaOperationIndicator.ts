import { BrowserWindow, screen } from "electron";
import type { BrowserWindowConstructorOptions, Display, Point, Rectangle } from "electron";
import type { CuaActivityEvent, HostCuaOperationStateResponse, Locale } from "@nibi/shared";
import {
  CURSOR_OVERLAY_SIZE,
  cursorOverlayDataUrl,
  INDICATOR_CARD_TOP_OFFSET,
  INDICATOR_SHADOW_INSET,
  indicatorDataUrl,
  indicatorWindowSize,
} from "./windowsCuaOperationIndicatorContent.js";

const HIDE_ANIMATION_MS = 120;
/**
 * 兜底隐藏时限。主导隐藏的是 turn 终态 / session 关闭 / runtime 不可用 / workspace 销毁
 * 这几条显式清除路径，这个计时器只在它们全部失约时收场，保证浮层不会无限期停留。
 *
 * 取 30s 而不是更短：CUA 事实现在按 cell 上报（每个 node_repl cell 一次），同一 turn 内
 * 后续 cell 会刷新计时器，但单个 cell 本身可以跑很久，10s 会让浮层在操作中途熄灭。
 */
const AUTO_HIDE_MS = 30_000;
const CREATE_RETRY_MS = 250;
/**
 * 活动驱动的兜底隐藏。Helper 正常会在最后一次动作后 1.5s 发 `active:false`；这个 5s
 * 计时器只处理消息丢失/Helper 崩溃，避免横幅与光标永远停在屏幕上。
 */
const ACTIVITY_AUTO_HIDE_MS = 5_000;
const CURSOR_FADE_MS = 160;
const CURSOR_RETRY_MS = 5_000;
/** 活动键与 turn 键共存于同一聚合表：前缀带 NUL，保证不会和 workspace 路径撞键。 */
const ACTIVITY_KEY_PREFIX = "\0activity\0";

export type WindowsCuaIndicatorWindowKind = "indicator" | "cursor";

/**
 * 光标窗口的 bounds：把落点夹进显示器工作区，并让窗口中心对准落点。
 * 工作区比窗口还小时退回工作区中心，避免负尺寸/漂出屏幕。
 */
export function cursorWindowBoundsFor(point: Point, workArea: Rectangle): Rectangle {
  const half = CURSOR_OVERLAY_SIZE / 2;
  const minX = workArea.x + half;
  const maxX = workArea.x + workArea.width - half;
  const minY = workArea.y + half;
  const maxY = workArea.y + workArea.height - half;
  const centerX =
    maxX >= minX ? Math.min(Math.max(point.x, minX), maxX) : workArea.x + workArea.width / 2;
  const centerY =
    maxY >= minY ? Math.min(Math.max(point.y, minY), maxY) : workArea.y + workArea.height / 2;
  return {
    width: CURSOR_OVERLAY_SIZE,
    height: CURSOR_OVERLAY_SIZE,
    x: Math.round(centerX - half),
    y: Math.round(centerY - half),
  };
}

export interface WindowsCuaOperationIndicatorWindow {
  readonly webContents: Pick<BrowserWindow["webContents"], "executeJavaScript">;
  destroy(): void;
  hide(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  moveTop(): void;
  on(event: "closed", listener: () => void): this;
  setAlwaysOnTop(flag: boolean, level?: Parameters<BrowserWindow["setAlwaysOnTop"]>[1]): void;
  setBounds(bounds: Rectangle): void;
  setContentProtection(enable: boolean): void;
  setIgnoreMouseEvents(ignore: boolean): void;
  showInactive(): void;
}

export interface WindowsCuaOperationIndicator {
  handleState(source: object, event: HostCuaOperationStateResponse): void;
  /**
   * Helper 的真实输入活动。与 handleState 共用同一个横幅窗口与聚合状态，并驱动自有
   * 光标浮层；不依赖 Node/Rust 内核的 turn 事件。纯展示，失败静默。
   */
  handleActivity(source: object, event: CuaActivityEvent): void;
  clearSource(source: object): void;
  ownsWindow(candidate: object): boolean;
  refreshContent(): void;
  dispose(): void;
}

interface IndicatorLogger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

interface WindowsCuaOperationIndicatorOptions {
  platform?: NodeJS.Platform;
  getLocale: () => Locale;
  logger: IndicatorLogger;
  createWindow?: (
    options: BrowserWindowConstructorOptions,
    kind: WindowsCuaIndicatorWindowKind,
  ) => WindowsCuaOperationIndicatorWindow;
  getCursorScreenPoint?: () => Point;
  getDisplayNearestPoint?: (point: Point) => Pick<Display, "workArea">;
  /** Helper 的落点是原生屏幕像素；Windows 下转成 Electron 的 DIP。 */
  toDipPoint?: (point: Point) => Point;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancelSchedule?: (timer: ReturnType<typeof setTimeout>) => void;
  now?: () => number;
}

export function createWindowsCuaOperationIndicator(
  options: WindowsCuaOperationIndicatorOptions,
): WindowsCuaOperationIndicator {
  const platform = options.platform ?? process.platform;
  const createWindow =
    options.createWindow ??
    ((windowOptions: BrowserWindowConstructorOptions, _kind: WindowsCuaIndicatorWindowKind) =>
      new BrowserWindow(windowOptions) as WindowsCuaOperationIndicatorWindow);
  const getCursorScreenPoint =
    options.getCursorScreenPoint ?? (() => screen.getCursorScreenPoint());
  const getDisplayNearestPoint =
    options.getDisplayNearestPoint ?? ((point: Point) => screen.getDisplayNearestPoint(point));
  const toDipPoint =
    options.toDipPoint ??
    ((point: Point) =>
      typeof screen.screenToDipPoint === "function" ? screen.screenToDipPoint(point) : point);
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? ((timer) => clearTimeout(timer));
  const now = options.now ?? (() => Date.now());

  const activeTurnKeysBySource = new Map<object, Set<string>>();
  const ownedWindows = new WeakSet<object>();
  const failedWindows = new WeakSet<object>();
  let window: WindowsCuaOperationIndicatorWindow | null = null;
  let windowReady = false;
  let windowShown = false;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  const autoHideTimersBySource = new Map<object, Map<string, ReturnType<typeof setTimeout>>>();
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let setupRetryAvailable = false;
  let disposed = false;
  // 自有光标浮层（与横幅窗口分开）：只由带屏幕坐标的 activity 驱动。
  let cursorWindow: WindowsCuaOperationIndicatorWindow | null = null;
  let cursorReady = false;
  let cursorShown = false;
  let cursorHideTimer: ReturnType<typeof setTimeout> | null = null;
  let cursorFailedAt = 0;
  let cursorPoint: Point | null = null;
  /** 当前是否仍希望光标可见；load 完成前到达的 inactive 不能把它亮出来。 */
  let cursorDesiredVisible = false;

  function hasActiveTurns(): boolean {
    for (const keys of activeTurnKeysBySource.values()) {
      if (keys.size > 0) return true;
    }
    return false;
  }

  function isActivityKey(key: string): boolean {
    return key.startsWith(ACTIVITY_KEY_PREFIX);
  }

  function hasActiveActivities(): boolean {
    for (const keys of activeTurnKeysBySource.values()) {
      for (const key of keys) if (isActivityKey(key)) return true;
    }
    return false;
  }

  function activityKey(event: CuaActivityEvent): string {
    return `${ACTIVITY_KEY_PREFIX}${event.sessionId ?? ""}`;
  }

  function keyFor(event: HostCuaOperationStateResponse): string {
    const workspaceKey = event.workspaceIdentity?.trim() || event.workspacePath;
    return `${workspaceKey}\0${event.sessionId}\0${event.turnId}`;
  }

  function setDocumentState(nextState: "active" | "leaving"): void {
    if (!window || window.isDestroyed()) return;
    void window.webContents
      .executeJavaScript(`document.documentElement.dataset.state=${JSON.stringify(nextState)}`)
      .catch((error) =>
        options.logger.debug("[cua-operation-indicator] state update failed", error),
      );
  }

  function setCursorState(
    target: WindowsCuaOperationIndicatorWindow,
    nextState: "active" | "leaving",
  ): void {
    if (target.isDestroyed()) return;
    void target.webContents
      .executeJavaScript(`document.documentElement.dataset.state=${JSON.stringify(nextState)}`)
      .catch((error) => options.logger.debug("[cua-cursor-overlay] state update failed", error));
  }

  /** 重新触发 CSS 落点涟漪：先置 0 再强制回流，否则重复点击时动画不会重播。 */
  function pulseCursor(target: WindowsCuaOperationIndicatorWindow): void {
    if (target.isDestroyed()) return;
    void target.webContents
      .executeJavaScript(
        '(() => { const root = document.documentElement; root.dataset.pulse = "0"; void root.offsetWidth; root.dataset.pulse = "1"; })()',
      )
      .catch((error) => options.logger.debug("[cua-cursor-overlay] pulse failed", error));
  }

  function cancelPendingHide(): void {
    if (!hideTimer) return;
    cancelSchedule(hideTimer);
    hideTimer = null;
  }

  function cancelAutoHide(source: object, key: string): void {
    const timers = autoHideTimersBySource.get(source);
    const timer = timers?.get(key);
    if (!timer) return;
    cancelSchedule(timer);
    timers?.delete(key);
    if (timers?.size === 0) autoHideTimersBySource.delete(source);
  }

  function scheduleAutoHide(source: object, key: string, delayMs = AUTO_HIDE_MS): void {
    cancelAutoHide(source, key);
    const timers = autoHideTimersBySource.get(source) ?? new Map();
    autoHideTimersBySource.set(source, timers);
    let timer: ReturnType<typeof setTimeout>;
    timer = schedule(() => {
      const currentTimers = autoHideTimersBySource.get(source);
      if (currentTimers?.get(key) !== timer) return;
      currentTimers.delete(key);
      if (currentTimers.size === 0) autoHideTimersBySource.delete(source);

      const sourceKeys = activeTurnKeysBySource.get(source);
      if (!sourceKeys?.delete(key)) return;
      if (sourceKeys.size === 0) activeTurnKeysBySource.delete(source);
      // 安全计时器是 fail-hidden 边界：即使 runtime 没有补发 inactive，也不能让
      // 原生浮层无限期可见；后续 CUA tool-started 会重新建立该键并重新计时。
      if (isActivityKey(key) && !hasActiveActivities()) beginCursorHide();
      if (!hasActiveTurns()) beginHide();
    }, delayMs);
    timers.set(key, timer);
  }

  function scheduleSetupRetry(): void {
    if (!setupRetryAvailable || !hasActiveTurns() || reconcileTimer) return;
    setupRetryAvailable = false;
    reconcileTimer = schedule(() => {
      reconcileTimer = null;
      ensureWindow();
    }, CREATE_RETRY_MS);
  }

  function discardFailedWindow(target: WindowsCuaOperationIndicatorWindow): void {
    failedWindows.add(target);
    if (window === target) {
      window = null;
      windowReady = false;
      windowShown = false;
    }
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (destroyError) {
      options.logger.debug(
        "[cua-operation-indicator] failed to discard partial window",
        destroyError,
      );
    }
  }

  function positionWindow(target: WindowsCuaOperationIndicatorWindow): void {
    const { width, height } = indicatorWindowSize(options.getLocale());
    const point = getCursorScreenPoint();
    const { workArea } = getDisplayNearestPoint(point);
    target.setBounds({
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + INDICATOR_CARD_TOP_OFFSET - INDICATOR_SHADOW_INSET.top),
    });
  }

  function handleLoadFailure(target: WindowsCuaOperationIndicatorWindow, error: unknown): void {
    options.logger.warn("[cua-operation-indicator] failed to load window content", error);
    if (disposed || target !== window) return;
    discardFailedWindow(target);
    scheduleSetupRetry();
  }

  function showWindowOnTop(target: WindowsCuaOperationIndicatorWindow): void {
    target.showInactive();
    // Windows 隐藏透明窗口后可能清除 WS_EX_TOPMOST；showInactive 只恢复可见性，
    // 不会恢复原生 Z-order，因此每次显示后都必须重新声明层级并移到该层级最前方。
    target.setAlwaysOnTop(true, "screen-saver");
    target.moveTop();
  }

  function cancelCursorHideTimer(): void {
    if (!cursorHideTimer) return;
    cancelSchedule(cursorHideTimer);
    cursorHideTimer = null;
  }

  function discardCursorWindow(target: WindowsCuaOperationIndicatorWindow): void {
    if (cursorWindow === target) {
      cursorWindow = null;
      cursorReady = false;
      cursorShown = false;
    }
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (error) {
      options.logger.debug("[cua-cursor-overlay] failed to discard window", error);
    }
  }

  function handleCursorLoadFailure(
    target: WindowsCuaOperationIndicatorWindow,
    error: unknown,
  ): void {
    options.logger.warn("[cua-cursor-overlay] failed to load cursor content", error);
    if (disposed) return;
    cursorFailedAt = now();
    discardCursorWindow(target);
  }

  function ensureCursorWindow(): WindowsCuaOperationIndicatorWindow | null {
    if (disposed || platform !== "win32") return null;
    if (cursorWindow && !cursorWindow.isDestroyed()) return cursorWindow;
    // 失败后冷却重试：显示器/合成器异常时不要在每次点击都重建窗口刷日志。
    if (cursorFailedAt > 0 && now() - cursorFailedAt < CURSOR_RETRY_MS) return null;

    let created: WindowsCuaOperationIndicatorWindow | null = null;
    try {
      created = createWindow(
        {
          width: CURSOR_OVERLAY_SIZE,
          height: CURSOR_OVERLAY_SIZE,
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
        "cursor",
      );
      const target = created;
      cursorWindow = target;
      cursorReady = false;
      cursorShown = false;
      ownedWindows.add(target);
      target.setIgnoreMouseEvents(true);
      target.on("closed", () => {
        if (cursorWindow === target) {
          cursorWindow = null;
          cursorReady = false;
          cursorShown = false;
        }
      });
      void target
        .loadURL(cursorOverlayDataUrl())
        .then(() => {
          if (disposed || target !== cursorWindow || target.isDestroyed()) return;
          cursorReady = true;
          cursorFailedAt = 0;
          if (!cursorDesiredVisible || !cursorPoint) {
            setCursorState(target, "leaving");
            return;
          }
          presentCursorWindow(target);
        })
        .catch((error) => handleCursorLoadFailure(target, error));
      return target;
    } catch (error) {
      options.logger.warn("[cua-cursor-overlay] failed to create cursor window", error);
      cursorFailedAt = now();
      if (created) discardCursorWindow(created);
      return null;
    }
  }

  function presentCursorWindow(target: WindowsCuaOperationIndicatorWindow): void {
    if (!cursorPoint) return;
    const { workArea } = getDisplayNearestPoint(cursorPoint);
    target.setBounds(cursorWindowBoundsFor(cursorPoint, workArea));
    cancelCursorHideTimer();
    if (!cursorShown) {
      try {
        // 光标窗口用较低的 topmost 层级；Windows 上再靠展示后的 moveTop 把横幅抬高兜底。
        target.showInactive();
        target.setAlwaysOnTop(true, "pop-up-menu");
        target.moveTop();
        cursorShown = true;
      } catch (error) {
        options.logger.warn("[cua-cursor-overlay] failed to show cursor window", error);
        discardCursorWindow(target);
        return;
      }
    }
    setCursorState(target, "active");
    pulseCursor(target);
    // Windows 的 topmost 窗口之间没有可靠层级：光标刚 moveTop 过，横幅可能被小窗
    // 压住。每次显示光标后把已显示的横幅重新抬到最前，确保"正在操作"文案始终可读。
    if (window && !window.isDestroyed() && windowShown) {
      try {
        window.setAlwaysOnTop(true, "screen-saver");
        window.moveTop();
      } catch (error) {
        options.logger.debug("[cua-operation-indicator] failed to raise banner", error);
      }
    }
  }

  /** 带坐标的 activity：移动/点亮光标；窗口不可用时只影响这个浮层。 */
  function showCursorAt(point: Point): void {
    // Helper 的 x/y 是原生屏幕像素；Electron 的 setBounds/getDisplayNearestPoint 用 DIP。
    let dipPoint = point;
    try {
      dipPoint = toDipPoint(point);
    } catch (error) {
      options.logger.debug("[cua-cursor-overlay] dip conversion failed", error);
    }
    cursorPoint = dipPoint;
    cursorDesiredVisible = true;
    const target = ensureCursorWindow();
    if (!target || !cursorReady || target.isDestroyed()) return;
    presentCursorWindow(target);
  }

  /**
   * 淡出光标。`desiredVisible` 先置 false，保证 load 中的窗口不会在淡出后又被点亮。
   * 隐藏失败时直接销毁：拉丝状残留比没有浮层更糟。
   */
  function beginCursorHide(): void {
    cursorDesiredVisible = false;
    if (!cursorWindow || cursorWindow.isDestroyed() || cursorHideTimer) return;
    const target = cursorWindow;
    setCursorState(target, "leaving");
    cursorHideTimer = schedule(() => {
      cursorHideTimer = null;
      if (disposed || target !== cursorWindow || target.isDestroyed()) return;
      try {
        target.hide();
        cursorShown = false;
      } catch (error) {
        options.logger.warn("[cua-cursor-overlay] hide failed, destroying window", error);
        discardCursorWindow(target);
      }
    }, CURSOR_FADE_MS);
  }

  function loadContent(target: WindowsCuaOperationIndicatorWindow): void {
    try {
      positionWindow(target);
      void target
        .loadURL(indicatorDataUrl(options.getLocale()))
        .then(() => {
          if (disposed || target !== window || target.isDestroyed()) return;
          windowReady = true;
          setupRetryAvailable = false;
          if (!hasActiveTurns()) {
            // refreshContent 可能发生在窗口已经隐藏之后；HTML 默认是 active，必须在
            // 无活跃 turn 时显式恢复离场状态，避免后续错误 show() 暴露假提示。
            setDocumentState("leaving");
            return;
          }
          positionWindow(target);
          showWindowOnTop(target);
          windowShown = true;
          setDocumentState("active");
        })
        .catch((error) => handleLoadFailure(target, error));
    } catch (error) {
      handleLoadFailure(target, error);
    }
  }

  function ensureWindow(repositionExisting = false): void {
    if (disposed || platform !== "win32" || !hasActiveTurns()) return;
    cancelPendingHide();
    if (window && !window.isDestroyed()) {
      if (repositionExisting) positionWindow(window);
      setDocumentState("active");
      // 根因：退场只隐藏而不销毁窗口；后续 turn 复用时必须重新显示已加载的窗口。
      if (windowReady && !windowShown) {
        showWindowOnTop(window);
        windowShown = true;
      }
      if (windowReady) setupRetryAvailable = false;
      return;
    }

    let created: WindowsCuaOperationIndicatorWindow | null = null;
    try {
      const { width, height } = indicatorWindowSize(options.getLocale());
      created = createWindow(
        {
          width,
          height,
          alwaysOnTop: true,
          focusable: false,
          frame: false,
          // 旧窗口只给 CSS shadow 留 1px 透明边，并叠加默认 DWM 矩形阴影，
          // 导致圆角阴影被裁成硬边和灰带；扩大透明画布后由 CSS 独占阴影。
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
        "indicator",
      );
      window = created;
      windowReady = false;
      windowShown = false;
      ownedWindows.add(created);
      created.setIgnoreMouseEvents(true);
      created.setContentProtection(true);
      created.on("closed", () => {
        const failedDuringSetup = failedWindows.delete(created as object);
        if (window === created) {
          window = null;
          windowReady = false;
          windowShown = false;
        }
        if (failedDuringSetup || disposed || !hasActiveTurns() || reconcileTimer) return;
        // 原因：系统意外关闭窗口时 Host 的 turn 仍然活跃，必须主动重建，不能等下一条状态。
        setupRetryAvailable = true;
        reconcileTimer = schedule(() => {
          reconcileTimer = null;
          ensureWindow();
        }, 0);
      });
      loadContent(created);
    } catch (error) {
      options.logger.warn("[cua-operation-indicator] failed to create secure window", error);
      if (created) discardFailedWindow(created);
      scheduleSetupRetry();
    }
  }

  function hideOrDestroy(target: WindowsCuaOperationIndicatorWindow): void {
    try {
      target.hide();
      windowShown = false;
      return;
    } catch (error) {
      // 关闭是这个浮层的安全底线：它在声称"NIBI 正在操作电脑"，隐藏失败就等于向用户
      // 撒谎。hide() 抛错时降级为销毁窗口——下一个 CUA cell 会由 ensureWindow 重建。
      options.logger.warn("[cua-operation-indicator] hide failed, destroying window", error);
    }
    if (window === target) {
      window = null;
      windowReady = false;
    }
    windowShown = false;
    try {
      if (!target.isDestroyed()) target.destroy();
    } catch (destroyError) {
      options.logger.warn(
        "[cua-operation-indicator] destroy after failed hide failed",
        destroyError,
      );
    }
  }

  function beginHide(): void {
    setupRetryAvailable = false;
    if (!window || window.isDestroyed() || hideTimer) return;
    setDocumentState("leaving");
    const target = window;
    hideTimer = schedule(() => {
      hideTimer = null;
      if (!disposed && !hasActiveTurns() && target === window && !target.isDestroyed()) {
        hideOrDestroy(target);
      }
    }, HIDE_ANIMATION_MS);
  }

  function handleState(source: object, event: HostCuaOperationStateResponse): void {
    if (disposed || platform !== "win32") return;
    const key = keyFor(event);
    const sourceKeys = activeTurnKeysBySource.get(source);
    if (event.active) {
      if (sourceKeys?.has(key)) {
        cancelPendingHide();
        scheduleAutoHide(source, key);
        ensureWindow();
        return;
      }
      const wasActive = hasActiveTurns();
      if (!wasActive) setupRetryAvailable = true;
      const nextKeys = sourceKeys ?? new Set<string>();
      nextKeys.add(key);
      activeTurnKeysBySource.set(source, nextKeys);
      scheduleAutoHide(source, key);
      // 只有 aggregate 从空变为非空时按当前鼠标显示器重定位，避免并行 source 让窗口跳动。
      ensureWindow(!wasActive);
      return;
    }
    if (!sourceKeys?.delete(key)) return;
    cancelAutoHide(source, key);
    if (sourceKeys.size === 0) activeTurnKeysBySource.delete(source);
    if (!hasActiveTurns()) beginHide();
  }

  function removeActivityKeys(source: object, sessionId: string | null): boolean {
    const sourceKeys = activeTurnKeysBySource.get(source);
    if (!sourceKeys) return false;
    let removed = false;
    for (const key of Array.from(sourceKeys)) {
      if (!isActivityKey(key)) continue;
      if (sessionId !== null && key !== `${ACTIVITY_KEY_PREFIX}${sessionId}`) continue;
      sourceKeys.delete(key);
      cancelAutoHide(source, key);
      removed = true;
    }
    if (sourceKeys.size === 0) activeTurnKeysBySource.delete(source);
    return removed;
  }

  /**
   * Helper 活动入口：与 handleState 共用横幅窗口、聚合状态与 30s 安全计时器。
   *
   * Rust 内核下没有 CUA turn 事件，但只要 Helper 真的下发输入，这里就会点亮提示；
   * Node 内核下两条路径同时存在时也只是重复刷新同一个键窗口。所有失败都只记 debug，
   * 绝不把异常抛回 host 消息循环（cosmetic fail-open）。
   */
  function handleActivity(source: object, event: CuaActivityEvent): void {
    if (disposed || platform !== "win32") return;
    try {
      if (event.active) {
        const key = activityKey(event);
        const sourceKeys = activeTurnKeysBySource.get(source);
        const wasActive = hasActiveTurns();
        if (!wasActive) setupRetryAvailable = true;
        const nextKeys = sourceKeys ?? new Set<string>();
        nextKeys.add(key);
        activeTurnKeysBySource.set(source, nextKeys);
        cancelPendingHide();
        // Helper 正常会在 1.5s 后补 inactive；5s 是消息丢失/进程崩溃时的 fail-hidden。
        scheduleAutoHide(source, key, ACTIVITY_AUTO_HIDE_MS);
        // 只有聚合从空变非空时按当前鼠标显示器重定位，避免并行 source 让横幅跳动。
        ensureWindow(!wasActive);
        if (
          typeof event.x === "number" &&
          typeof event.y === "number" &&
          Number.isFinite(event.x) &&
          Number.isFinite(event.y)
        ) {
          showCursorAt({ x: event.x, y: event.y });
        }
        return;
      }
      const removed = removeActivityKeys(source, event.sessionId ?? null);
      // 光标只属于"刚才那次输入"：即使该 source 从未登记（Helper 重启/消息丢失），
      // inactive 也必须让它淡出，不能停在屏幕上。
      if (!hasActiveActivities()) beginCursorHide();
      if (removed && !hasActiveTurns()) beginHide();
    } catch (error) {
      options.logger.debug("[cua-operation-indicator] activity handling failed", error);
    }
  }

  function clearSource(source: object): void {
    if (disposed || platform !== "win32") return;
    const sourceKeys = activeTurnKeysBySource.get(source);
    if (!sourceKeys) return;
    const hadActivity = [...sourceKeys].some(isActivityKey);
    activeTurnKeysBySource.delete(source);
    const timers = autoHideTimersBySource.get(source);
    for (const key of timers ? [...timers.keys()] : []) {
      cancelAutoHide(source, key);
    }
    if (hadActivity && !hasActiveActivities()) beginCursorHide();
    if (!hasActiveTurns()) beginHide();
  }

  function refreshContent(): void {
    if (disposed || platform !== "win32" || !window || window.isDestroyed()) return;
    if (hasActiveTurns()) setupRetryAvailable = true;
    loadContent(window);
  }

  function ownsWindow(candidate: object): boolean {
    return ownedWindows.has(candidate);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    setupRetryAvailable = false;
    activeTurnKeysBySource.clear();
    for (const [source, timers] of autoHideTimersBySource) {
      for (const timer of timers.values()) cancelSchedule(timer);
      autoHideTimersBySource.delete(source);
    }
    cancelPendingHide();
    if (reconcileTimer) {
      cancelSchedule(reconcileTimer);
      reconcileTimer = null;
    }
    cancelCursorHideTimer();
    cursorDesiredVisible = false;
    const cursorTarget = cursorWindow;
    cursorWindow = null;
    cursorReady = false;
    cursorShown = false;
    cursorPoint = null;
    if (cursorTarget && !cursorTarget.isDestroyed()) cursorTarget.destroy();
    const target = window;
    window = null;
    windowReady = false;
    windowShown = false;
    if (target && !target.isDestroyed()) target.destroy();
  }

  return { handleState, handleActivity, clearSource, ownsWindow, refreshContent, dispose };
}
