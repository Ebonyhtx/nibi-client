import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle } from "electron";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
  },
}));

import {
  createWindowsCuaOperationIndicator,
  cursorWindowBoundsFor,
  type WindowsCuaIndicatorWindowKind,
  type WindowsCuaOperationIndicator,
  type WindowsCuaOperationIndicatorWindow,
} from "../src/main/windowsCuaOperationIndicator.js";
import { cursorLabelBoundsFor } from "../src/main/windowsCuaCursorLabel.js";
import {
  CURSOR_LABEL_HEIGHT,
  CURSOR_LABEL_WIDTH,
  indicatorWindowSize,
} from "../src/main/windowsCuaOperationIndicatorContent.js";

const WORK_AREA: Rectangle = { x: 0, y: 0, width: 1000, height: 800 };

class FakeWindow implements WindowsCuaOperationIndicatorWindow {
  destroyed = false;
  hidden = false;
  shown = false;
  bounds: Rectangle | null = null;
  contentProtection = false;
  ignoreMouse = false;
  moveTopCalls = 0;
  readonly alwaysOnTopLevels: Array<string | undefined> = [];
  readonly scripts: string[] = [];
  readonly closedListeners: Array<() => void> = [];

  readonly webContents = {
    executeJavaScript: vi.fn((code: string) => {
      this.scripts.push(code);
      return Promise.resolve(true);
    }),
  } as unknown as WindowsCuaOperationIndicatorWindow["webContents"];

  constructor(
    readonly options: BrowserWindowConstructorOptions,
    readonly kind: WindowsCuaIndicatorWindowKind,
  ) {}

  destroy(): void {
    this.destroyed = true;
  }
  hide(): void {
    this.hidden = true;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  loadURL(): Promise<void> {
    return Promise.resolve();
  }
  moveTop(): void {
    this.moveTopCalls += 1;
  }
  on(event: "closed", listener: () => void): this {
    if (event === "closed") this.closedListeners.push(listener);
    return this;
  }
  setAlwaysOnTop(_flag: boolean, level?: Parameters<BrowserWindow["setAlwaysOnTop"]>[1]): void {
    this.alwaysOnTopLevels.push(level);
  }
  setBounds(bounds: Rectangle): void {
    this.bounds = { ...bounds };
  }
  setContentProtection(enable: boolean): void {
    this.contentProtection = enable;
  }
  setIgnoreMouseEvents(ignore: boolean): void {
    this.ignoreMouse = ignore;
  }
  showInactive(): void {
    this.hidden = false;
    this.shown = true;
  }
}

const flushMicrotasks = async () => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

interface Harness {
  indicator: WindowsCuaOperationIndicator;
  windows: FakeWindow[];
  banner(): FakeWindow | undefined;
  cursor(): FakeWindow | undefined;
  label(): FakeWindow | undefined;
}

function createHarness(
  options: {
    failIndicatorWindow?: boolean;
    failCursorWindow?: boolean;
    now?: () => number;
    toDipPoint?: (point: { x: number; y: number }) => { x: number; y: number };
  } = {},
): Harness {
  const windows: FakeWindow[] = [];
  const indicator = createWindowsCuaOperationIndicator({
    platform: "win32",
    getLocale: () => "zh-CN",
    logger: { debug: vi.fn(), warn: vi.fn() },
    now: options.now ?? (() => Date.now()),
    toDipPoint: options.toDipPoint ?? ((point) => point),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: WORK_AREA }),
    createWindow: (windowOptions, kind) => {
      if (kind === "indicator" && options.failIndicatorWindow) throw new Error("no indicator");
      if (kind === "cursor" && options.failCursorWindow) throw new Error("no cursor");
      const window = new FakeWindow(windowOptions, kind);
      windows.push(window);
      return window;
    },
  });
  return {
    indicator,
    windows,
    banner: () => windows.find((window) => window.kind === "indicator"),
    cursor: () => windows.find((window) => window.kind === "cursor"),
    label: () => windows.find((window) => window.kind === "label"),
  };
}

const activity = (overrides: object = {}) => ({
  active: true,
  sessionId: "sess-1",
  action: "left_click",
  x: 120,
  y: 240,
  at: 1_700_000_000_000,
  ...overrides,
});

describe("cursorWindowBoundsFor", () => {
  it("把落点夹进工作区并让窗口中心对准落点", () => {
    expect(cursorWindowBoundsFor({ x: 500, y: 400 }, WORK_AREA)).toEqual({
      x: 472,
      y: 372,
      width: 56,
      height: 56,
    });
    expect(cursorWindowBoundsFor({ x: 5000, y: 5000 }, WORK_AREA)).toEqual({
      x: 944,
      y: 744,
      width: 56,
      height: 56,
    });
    expect(cursorWindowBoundsFor({ x: -500, y: -500 }, WORK_AREA)).toEqual({
      x: 0,
      y: 0,
      width: 56,
      height: 56,
    });
  });

  it("工作区比窗口还小时退回工作区中心", () => {
    expect(cursorWindowBoundsFor({ x: 0, y: 0 }, { x: 10, y: 20, width: 10, height: 10 })).toEqual({
      x: -13,
      y: -3,
      width: 56,
      height: 56,
    });
  });
});

describe("cursorLabelBoundsFor", () => {
  it("贴在落点右下方，并整体夹进工作区", () => {
    expect(cursorLabelBoundsFor({ x: 500, y: 400 }, WORK_AREA)).toEqual({
      x: 518,
      y: 418,
      width: CURSOR_LABEL_WIDTH,
      height: CURSOR_LABEL_HEIGHT,
    });
    // 右下越界 → 贴右下边；负坐标 → 贴左上边。
    expect(cursorLabelBoundsFor({ x: 990, y: 790 }, WORK_AREA)).toEqual({
      x: WORK_AREA.width - CURSOR_LABEL_WIDTH,
      y: WORK_AREA.height - CURSOR_LABEL_HEIGHT,
      width: CURSOR_LABEL_WIDTH,
      height: CURSOR_LABEL_HEIGHT,
    });
    expect(cursorLabelBoundsFor({ x: -50, y: -50 }, WORK_AREA)).toEqual({
      x: 0,
      y: 0,
      width: CURSOR_LABEL_WIDTH,
      height: CURSOR_LABEL_HEIGHT,
    });
  });
});

describe("Windows CUA operation indicator activity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("带坐标活动同时显示横幅与光标，光标按工作区夹取", async () => {
    const harness = createHarness();
    harness.indicator.handleActivity({}, activity({ x: 5000, y: 5000 }));
    await flushMicrotasks();

    const banner = harness.banner();
    const cursor = harness.cursor();
    expect(banner).toBeDefined();
    expect(cursor).toBeDefined();
    const bannerSize = indicatorWindowSize("zh-CN");
    expect(banner?.bounds).toEqual({
      width: bannerSize.width,
      height: bannerSize.height,
      x: Math.round((WORK_AREA.width - bannerSize.width) / 2),
      y: 6,
    });
    expect(cursor?.bounds).toEqual({ x: 944, y: 744, width: 56, height: 56 });
    expect(banner?.shown).toBe(true);
    expect(banner?.alwaysOnTopLevels).toContain("screen-saver");
    expect(cursor?.shown).toBe(true);
    expect(cursor?.alwaysOnTopLevels).toContain("pop-up-menu");
    expect(cursor?.ignoreMouse).toBe(true);
    expect(cursor?.options.focusable).toBe(false);
    expect(cursor?.options.show).toBe(false);
    // 光标显示后会把横幅重新抬到最前，避免小窗压住"正在操作"。
    expect(banner?.moveTopCalls).toBeGreaterThan(0);
    expect(cursor?.scripts.some((script) => script.includes('dataset.state="active"'))).toBe(true);
    expect(cursor?.scripts.some((script) => script.includes("dataset.pulse"))).toBe(true);

    harness.indicator.dispose();
  });

  it("原生光标模式：只画说明标签，不画自有光标", async () => {
    const harness = createHarness();
    harness.indicator.handleActivity({}, activity({ nativeCursor: true, summary: "点击「7」" }));
    await flushMicrotasks();

    expect(harness.cursor()).toBeUndefined();
    const label = harness.label();
    expect(label).toBeDefined();
    expect(label?.bounds).toEqual(cursorLabelBoundsFor({ x: 120, y: 240 }, WORK_AREA));
    expect(label?.shown).toBe(true);
    expect(label?.ignoreMouse).toBe(true);
    expect(label?.options.focusable).toBe(false);
    expect(label?.options.show).toBe(false);
    expect(label?.scripts.some((script) => script.includes("点击「7」"))).toBe(true);
    expect(label?.scripts.some((script) => script.includes('dataset.state="active"'))).toBe(true);

    harness.indicator.handleActivity({}, activity({ active: false, action: "idle" }));
    await flushMicrotasks();
    vi.advanceTimersByTime(200);
    expect(label?.hidden).toBe(true);

    harness.indicator.dispose();
  });

  it("原生光标模式但没有摘要：只保留横幅", async () => {
    const harness = createHarness();
    harness.indicator.handleActivity({}, activity({ nativeCursor: true, summary: undefined }));
    await flushMicrotasks();

    expect(harness.label()).toBeUndefined();
    expect(harness.cursor()).toBeUndefined();
    expect(harness.banner()?.shown).toBe(true);

    harness.indicator.dispose();
  });

  it("无坐标活动只显示横幅，不创建光标窗口", async () => {
    const harness = createHarness();
    harness.indicator.handleActivity({}, activity({ x: undefined, y: undefined }));
    await flushMicrotasks();

    expect(harness.banner()?.shown).toBe(true);
    expect(harness.cursor()).toBeUndefined();

    harness.indicator.dispose();
  });

  it("原生像素落点先转 DIP 再夹取", async () => {
    // 200% 缩放：物理 (2000, 1200) → DIP (1000, 600)；x 贴右边缘，y 保持落点。
    const harness = createHarness({ toDipPoint: (point) => ({ x: point.x / 2, y: point.y / 2 }) });
    harness.indicator.handleActivity({}, activity({ x: 2_000, y: 1_200 }));
    await flushMicrotasks();

    expect(harness.cursor()?.bounds).toEqual({ x: 944, y: 572, width: 56, height: 56 });

    harness.indicator.dispose();
  });

  it("inactive / 空闲兜底会淡出横幅与光标", async () => {
    const harness = createHarness();
    const source = {};
    harness.indicator.handleActivity(source, activity());
    await flushMicrotasks();
    harness.indicator.handleActivity(source, activity({ active: false, action: "idle" }));
    await flushMicrotasks();

    vi.advanceTimersByTime(200);
    expect(harness.banner()?.hidden).toBe(true);
    expect(harness.cursor()?.hidden).toBe(true);

    harness.indicator.dispose();
  });

  it("Helper 消息丢失时 5s 兜底也会收起横幅与光标", async () => {
    const harness = createHarness();
    harness.indicator.handleActivity({}, activity());
    await flushMicrotasks();
    expect(harness.banner()?.shown).toBe(true);

    vi.advanceTimersByTime(5_000);
    vi.advanceTimersByTime(200);
    expect(harness.banner()?.hidden).toBe(true);
    expect(harness.cursor()?.hidden).toBe(true);

    harness.indicator.dispose();
  });

  it("光标窗口创建失败不影响横幅与调用方（cosmetic fail-open）", async () => {
    let cursorAttempts = 0;
    let nowMs = 1_000;
    const windows: FakeWindow[] = [];
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const indicator = createWindowsCuaOperationIndicator({
      platform: "win32",
      getLocale: () => "zh-CN",
      logger,
      now: () => nowMs,
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: WORK_AREA }),
      createWindow: (windowOptions, kind) => {
        if (kind === "cursor") {
          cursorAttempts += 1;
          throw new Error("no cursor window");
        }
        const window = new FakeWindow(windowOptions, kind);
        windows.push(window);
        return window;
      },
    });

    expect(() => indicator.handleActivity({}, activity())).not.toThrow();
    await flushMicrotasks();
    expect(windows.find((window) => window.kind === "indicator")?.shown).toBe(true);
    expect(cursorAttempts).toBe(1);

    // 冷却期内不反复重建；超过 5s 后才重试。
    indicator.handleActivity({}, activity());
    await flushMicrotasks();
    expect(cursorAttempts).toBe(1);
    nowMs += 5_000;
    indicator.handleActivity({}, activity());
    await flushMicrotasks();
    expect(cursorAttempts).toBe(2);

    indicator.dispose();
  });

  it("窗口全部创建失败时活动处理也不抛，且不留下可见状态", async () => {
    const harness = createHarness({ failIndicatorWindow: true, failCursorWindow: true });
    expect(() => harness.indicator.handleActivity({}, activity())).not.toThrow();
    await flushMicrotasks();
    expect(harness.windows).toHaveLength(0);
    expect(() => harness.indicator.handleActivity({}, activity({ active: false }))).not.toThrow();
    harness.indicator.dispose();
  });

  it("host 退出（clearSource）会同时收起横幅与光标", async () => {
    const harness = createHarness();
    const source = {};
    harness.indicator.handleActivity(source, activity());
    await flushMicrotasks();
    expect(harness.banner()?.shown).toBe(true);
    expect(harness.cursor()?.shown).toBe(true);

    harness.indicator.clearSource(source);
    vi.advanceTimersByTime(200);
    expect(harness.banner()?.hidden).toBe(true);
    expect(harness.cursor()?.hidden).toBe(true);

    harness.indicator.dispose();
  });

  it("原有 handleState 的显示/隐藏行为不变", async () => {
    const harness = createHarness();
    const source = {};
    const stateEvent = {
      active: true,
      sessionId: "session-1",
      turnId: "turn-1",
      workspacePath: "D:/workspace",
      workspaceIdentity: "ws-1",
    };
    harness.indicator.handleState(source, stateEvent);
    await flushMicrotasks();
    expect(harness.banner()?.shown).toBe(true);
    expect(harness.cursor()).toBeUndefined();

    harness.indicator.handleState(source, { ...stateEvent, active: false });
    vi.advanceTimersByTime(200);
    expect(harness.banner()?.hidden).toBe(true);

    harness.indicator.dispose();
  });

  it("活动中重复坐标会重新脉冲并移动同一个光标窗口", async () => {
    const harness = createHarness();
    const source = {};
    harness.indicator.handleActivity(source, activity({ x: 100, y: 100 }));
    await flushMicrotasks();
    const cursor = harness.cursor();
    expect(cursor?.bounds).toEqual({ x: 72, y: 72, width: 56, height: 56 });
    const pulseCount = cursor?.scripts.filter((script) => script.includes("dataset.pulse")).length;

    harness.indicator.handleActivity(source, activity({ x: 300, y: 300 }));
    await flushMicrotasks();
    expect(harness.windows.filter((window) => window.kind === "cursor")).toHaveLength(1);
    expect(cursor?.bounds).toEqual({ x: 272, y: 272, width: 56, height: 56 });
    expect(
      cursor?.scripts.filter((script) => script.includes("dataset.pulse")).length,
    ).toBeGreaterThan(pulseCount ?? 0);

    harness.indicator.dispose();
  });

  it("隐藏后空闲超过 45 秒会销毁全部浮层窗口并在下次 CUA 活动时重建", async () => {
    const harness = createHarness();
    const source = {};
    // 非原生光标模式创建 banner + cursor；随后切换原生光标摘要同时创建 label
    harness.indicator.handleActivity(source, activity({ x: 120, y: 180 }));
    await flushMicrotasks();
    harness.indicator.handleActivity(
      source,
      activity({ nativeCursor: true, summary: "点击确定", x: 120, y: 180 }),
    );
    await flushMicrotasks();
    const firstBanner = harness.banner()!;
    const firstCursor = harness.cursor()!;
    const firstLabel = harness.label()!;
    expect(firstBanner).toBeDefined();
    expect(firstCursor).toBeDefined();
    expect(firstLabel).toBeDefined();
    expect(firstBanner.destroyed).toBe(false);
    expect(firstCursor.destroyed).toBe(false);
    expect(firstLabel.destroyed).toBe(false);

    harness.indicator.clearSource(source);
    vi.advanceTimersByTime(200);
    expect(firstBanner.hidden).toBe(true);
    expect(firstBanner.destroyed).toBe(false);

    vi.advanceTimersByTime(45_000);
    expect(firstBanner.destroyed).toBe(true);
    expect(firstCursor.destroyed).toBe(true);
    expect(firstLabel.destroyed).toBe(true);

    // 再次活动时重新按需创建新窗口。
    harness.indicator.handleActivity(source, activity({ x: 240, y: 260 }));
    await flushMicrotasks();
    const indicators = harness.windows.filter((w) => w.kind === "indicator");
    expect(indicators).toHaveLength(2);
    const rebuiltBanner = indicators.at(-1);
    expect(rebuiltBanner?.destroyed).toBe(false);
    expect(rebuiltBanner?.shown).toBe(true);

    harness.indicator.dispose();
  });
});
