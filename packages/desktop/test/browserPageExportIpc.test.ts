import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels, type BrowserViewExportPageFormat } from "@nibi/shared";

type IpcHandler = (...args: unknown[]) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  guestRegistry: new Map<number, unknown>(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: h.fromWebContents },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
    on: vi.fn(),
  },
  webContents: { fromId: (id: number) => h.guestRegistry.get(id) },
}));

vi.mock("../src/main/desktopBrowserDataIpc.js", () => ({
  registerBrowserDataIpcHandlers: vi.fn(),
}));

import { BrowserGuestManager } from "../src/main/browserView/browserGuestManager.js";
import { registerBrowserViewIpcHandlers } from "../src/main/desktopBrowserViewIpc.js";

const TAB_ID = "browser:export-tab";
const GUEST_ID = 700;
const WINDOW_ID = 21;
const SENDER_WEB_CONTENTS_ID = 900;
const WORKSPACE_KEY = "workspace:export";
const SESSION_ID = "session-export";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const PDF_BYTES = Buffer.from("%PDF-1.4\nbody\n%%EOF", "utf8");

interface GuestStubOptions {
  type?: string;
  hostWebContentsId?: number;
  capturePage?: () => Promise<{ toPNG(): Buffer }>;
  printToPDF?: (options: {
    printBackground: boolean;
    preferCSSPageSize: boolean;
  }) => Promise<Buffer>;
}

function makeGuest(options: GuestStubOptions = {}) {
  let cdpAttached = false;
  const guest = {
    id: GUEST_ID,
    hostWebContents: {
      id: options.hostWebContentsId ?? SENDER_WEB_CONTENTS_ID,
      getZoomFactor: () => 1,
    },
    getType: () => options.type ?? "webview",
    getZoomFactor: () => 1,
    setZoomFactor: () => {},
    isDestroyed: () => false,
    loadURL: async () => {},
    getURL: () => "https://example.com/report",
    getTitle: () => "Example Report",
    reload: () => {},
    stop: () => {},
    capturePage:
      options.capturePage ??
      (async () => ({
        toPNG: () => PNG_BYTES,
      })),
    printToPDF: options.printToPDF ?? (async () => PDF_BYTES),
    executeJavaScript: async () => ({}),
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
      getAllEntries: () => [],
      getActiveIndex: () => 0,
      restore: async () => {},
    },
    close: () => {},
    isCurrentlyAudible: () => false,
    isBeingCaptured: () => false,
    on: () => {},
    removeListener: () => {},
    once: () => {},
    debugger: {
      isAttached: () => cdpAttached,
      attach: () => {
        cdpAttached = true;
      },
      detach: () => {
        cdpAttached = false;
      },
      sendCommand: async () => ({}),
      on: () => {},
      removeListener: () => {},
    },
    session: {
      on: () => {},
      removeListener: () => {},
    },
  };
  return guest;
}

function makeManager(overrides?: { pageExportTimeoutMs?: number; pageExportMaxBytes?: number }) {
  return new BrowserGuestManager(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      ...(overrides?.pageExportTimeoutMs === undefined
        ? {}
        : { pageExportTimeoutMs: overrides.pageExportTimeoutMs }),
      ...(overrides?.pageExportMaxBytes === undefined
        ? {}
        : { pageExportMaxBytes: overrides.pageExportMaxBytes }),
    },
  );
}

function attachGuest(manager: BrowserGuestManager, guest: ReturnType<typeof makeGuest>) {
  h.guestRegistry.set(GUEST_ID, guest);
  const result = manager.attachGuest(TAB_ID, GUEST_ID, {
    active: true,
    windowId: WINDOW_ID,
    workspaceKey: WORKSPACE_KEY,
    sessionId: SESSION_ID,
  });
  expect(result.ok).toBe(true);
}

function registerExportHandler(manager: BrowserGuestManager) {
  registerBrowserViewIpcHandlers(undefined, undefined, undefined, {}, (payload) =>
    manager.exportPage(payload),
  );
  const handler = h.handlers.get(PlatformChannels.BrowserViewExportPage);
  expect(handler).toBeDefined();
  return handler!;
}

function exportPayload(overrides: Record<string, unknown> = {}) {
  return {
    key: TAB_ID,
    webContentsId: GUEST_ID,
    format: "png",
    ...overrides,
  };
}

function senderEvent(senderWebContentsId = SENDER_WEB_CONTENTS_ID) {
  return { sender: { id: senderWebContentsId } };
}

beforeEach(() => {
  h.handlers.clear();
  h.guestRegistry.clear();
  h.fromWebContents.mockReset();
  h.fromWebContents.mockReturnValue({ id: WINDOW_ID, isDestroyed: () => false });
});

describe("browser page export IPC", () => {
  it("没有可信 sender window 时拒绝导出", async () => {
    const manager = makeManager();
    attachGuest(manager, makeGuest());
    const handler = registerExportHandler(manager);
    h.fromWebContents.mockReturnValue(null);

    await expect(handler(senderEvent(), exportPayload())).resolves.toEqual({
      success: false,
      error: "window_mismatch",
    });
  });

  it("sender window 已销毁或 main 未注册导出实现时拒绝", async () => {
    const manager = makeManager();
    attachGuest(manager, makeGuest());
    const handler = registerExportHandler(manager);
    h.fromWebContents.mockReturnValue({ id: WINDOW_ID, isDestroyed: () => true });
    await expect(handler(senderEvent(), exportPayload())).resolves.toEqual({
      success: false,
      error: "window_mismatch",
    });

    registerBrowserViewIpcHandlers(undefined, undefined, undefined, {});
    h.fromWebContents.mockReturnValue({ id: WINDOW_ID, isDestroyed: () => false });
    const unsupportedHandler = h.handlers.get(PlatformChannels.BrowserViewExportPage)!;
    await expect(unsupportedHandler(senderEvent(), exportPayload())).resolves.toEqual({
      success: false,
      error: "unsupported",
    });
  });

  it("拒绝非法 format / webContentsId / 空 key", async () => {
    const manager = makeManager();
    attachGuest(manager, makeGuest());
    const handler = registerExportHandler(manager);

    await expect(handler(senderEvent(), exportPayload({ format: "webp" }))).rejects.toThrow();
    await expect(handler(senderEvent(), exportPayload({ webContentsId: 0 }))).rejects.toThrow();
    await expect(handler(senderEvent(), exportPayload({ webContentsId: 1.5 }))).rejects.toThrow();
    await expect(handler(senderEvent(), exportPayload({ key: "" }))).rejects.toThrow();
  });

  it("拒绝不是 webview 的 WebContents", async () => {
    const manager = makeManager();
    const guest = makeGuest();
    attachGuest(manager, guest);
    guest.getType = () => "window";
    const handler = registerExportHandler(manager);

    await expect(handler(senderEvent(), exportPayload())).resolves.toEqual({
      success: false,
      error: "not_webview",
    });
  });

  it("拒绝 sender webContents 与 guest hostWebContents 不一致的请求", async () => {
    const manager = makeManager();
    attachGuest(manager, makeGuest({ hostWebContentsId: SENDER_WEB_CONTENTS_ID + 1 }));
    const handler = registerExportHandler(manager);

    await expect(handler(senderEvent(), exportPayload())).resolves.toEqual({
      success: false,
      error: "sender_mismatch",
    });
  });

  it("拒绝跨窗口 / 跨 tab 的 key 与 guest 归属", async () => {
    const manager = makeManager();
    attachGuest(manager, makeGuest());

    await expect(
      manager.exportPage({
        tabId: TAB_ID,
        webContentsId: GUEST_ID,
        format: "png",
        windowId: WINDOW_ID + 1,
        senderWebContentsId: SENDER_WEB_CONTENTS_ID,
      }),
    ).resolves.toEqual({ success: false, error: "not_owner" });

    await expect(
      manager.exportPage({
        tabId: "browser:other-tab",
        webContentsId: GUEST_ID,
        format: "png",
        windowId: WINDOW_ID,
        senderWebContentsId: SENDER_WEB_CONTENTS_ID,
      }),
    ).resolves.toEqual({ success: false, error: "tab_not_found" });
  });

  it("PNG 导出返回当前 viewport 字节", async () => {
    const manager = makeManager();
    const guest = makeGuest();
    attachGuest(manager, guest);
    const handler = registerExportHandler(manager);

    const result = (await handler(senderEvent(), exportPayload())) as {
      success: boolean;
      data?: ArrayBuffer;
      error?: string;
    };

    expect(result.success).toBe(true);
    expect(Buffer.from(result.data!)).toEqual(PNG_BYTES);
  });

  it("PDF 导出使用 printBackground + preferCSSPageSize 并返回字节", async () => {
    const manager = makeManager();
    const printToPDF = vi.fn(async () => PDF_BYTES);
    attachGuest(manager, makeGuest({ printToPDF }));
    const handler = registerExportHandler(manager);

    const result = (await handler(senderEvent(), exportPayload({ format: "pdf" }))) as {
      success: boolean;
      data?: ArrayBuffer;
    };

    expect(result.success).toBe(true);
    expect(Buffer.from(result.data!)).toEqual(PDF_BYTES);
    expect(printToPDF).toHaveBeenCalledWith({
      printBackground: true,
      preferCSSPageSize: true,
    });
  });

  it("loading 中的 guest 返回明确错误而不是空白文件", async () => {
    const manager = makeManager();
    attachGuest(manager, makeGuest());
    expect(manager.getTabOwner(TAB_ID)).toMatchObject({
      windowId: WINDOW_ID,
      workspaceKey: WORKSPACE_KEY,
      sessionId: SESSION_ID,
    });
    await manager.reportResidency({
      tabId: TAB_ID,
      windowId: WINDOW_ID,
      workspaceKey: WORKSPACE_KEY,
      sessionId: SESSION_ID,
      selected: true,
      visible: true,
      currentTask: true,
      loading: true,
    });

    await expect(
      manager.exportPage({
        tabId: TAB_ID,
        webContentsId: GUEST_ID,
        format: "png",
        windowId: WINDOW_ID,
        senderWebContentsId: SENDER_WEB_CONTENTS_ID,
      }),
    ).resolves.toEqual({ success: false, error: "tab_loading" });
  });

  it("超时返回 export_timeout，不悬挂调用方", async () => {
    const manager = makeManager({ pageExportTimeoutMs: 10 });
    attachGuest(
      manager,
      makeGuest({
        capturePage: () => new Promise(() => {}),
      }),
    );
    const handler = registerExportHandler(manager);

    await expect(handler(senderEvent(), exportPayload())).resolves.toEqual({
      success: false,
      error: "export_timeout",
    });
  });

  it("同一 guest 单飞，第二个请求返回 export_in_progress", async () => {
    let resolveCapture!: (value: { toPNG(): Buffer }) => void;
    const manager = makeManager();
    attachGuest(
      manager,
      makeGuest({
        capturePage: () =>
          new Promise((resolve) => {
            resolveCapture = resolve;
          }),
      }),
    );
    const handler = registerExportHandler(manager);

    const first = handler(senderEvent(), exportPayload());
    await expect(handler(senderEvent(), exportPayload())).resolves.toEqual({
      success: false,
      error: "export_in_progress",
    });
    resolveCapture({ toPNG: () => PNG_BYTES });
    const firstResult = (await first) as { success: boolean; data?: ArrayBuffer };
    expect(firstResult.success).toBe(true);
  });

  it("超过大小上限返回 export_too_large", async () => {
    const manager = makeManager({ pageExportMaxBytes: 4 });
    attachGuest(
      manager,
      makeGuest({
        capturePage: async () => ({ toPNG: () => Buffer.alloc(8, 1) }),
      }),
    );
    const handler = registerExportHandler(manager);

    await expect(handler(senderEvent(), exportPayload())).resolves.toEqual({
      success: false,
      error: "export_too_large",
    });
  });

  it("guest 已销毁时返回 guest_unavailable", async () => {
    const manager = makeManager();
    const guest = makeGuest();
    attachGuest(manager, guest);
    guest.isDestroyed = () => true;
    const handler = registerExportHandler(manager);

    await expect(handler(senderEvent(), exportPayload())).resolves.toEqual({
      success: false,
      error: "guest_unavailable",
    });
  });

  it("residency 为 suspended 时返回 tab_suspended", async () => {
    const manager = makeManager();
    attachGuest(manager, makeGuest());
    // suspend 由 renderer shell 与 main 协调；正常路径 guest 已被 shell 替换，
    // 这里直接复用协调器的取消挂起提交构造防御性状态，验证 export 的挂起门禁。
    const coordinator = (
      manager as unknown as {
        residencyCoordinator: {
          commitCancelledSuspend(tabId: string, cancelledGeneration: number): unknown;
        };
      }
    ).residencyCoordinator;
    expect(coordinator.commitCancelledSuspend(TAB_ID, -1)).not.toBeNull();

    await expect(
      manager.exportPage({
        tabId: TAB_ID,
        webContentsId: GUEST_ID,
        format: "png",
        windowId: WINDOW_ID,
        senderWebContentsId: SENDER_WEB_CONTENTS_ID,
      }),
    ).resolves.toEqual({ success: false, error: "tab_suspended" });
  });

  it("导出内容为空时返回 empty_export", async () => {
    const manager = makeManager();
    attachGuest(
      manager,
      makeGuest({
        capturePage: async () => ({ toPNG: () => Buffer.alloc(0) }),
      }),
    );
    const handler = registerExportHandler(manager);

    await expect(handler(senderEvent(), exportPayload())).resolves.toEqual({
      success: false,
      error: "empty_export",
    });
  });

  it("capturePage 失败时返回 export_failed", async () => {
    const manager = makeManager();
    attachGuest(
      manager,
      makeGuest({
        capturePage: async () => {
          throw new Error("guest renderer gone");
        },
      }),
    );
    const handler = registerExportHandler(manager);

    await expect(handler(senderEvent(), exportPayload())).resolves.toEqual({
      success: false,
      error: "export_failed",
    });
  });

  it("manager 直接调用时拒绝非法 format", async () => {
    const manager = makeManager();
    attachGuest(manager, makeGuest());

    await expect(
      manager.exportPage({
        tabId: TAB_ID,
        webContentsId: GUEST_ID,
        format: "webp" as BrowserViewExportPageFormat,
        windowId: WINDOW_ID,
        senderWebContentsId: SENDER_WEB_CONTENTS_ID,
      }),
    ).resolves.toEqual({ success: false, error: "invalid_format" });
  });

  it("webContentsId 属于其他 tab 时按 key/guest 归属拒绝", async () => {
    const manager = makeManager();
    attachGuest(manager, makeGuest());
    const otherGuest = makeGuest();
    otherGuest.id = 701;
    h.guestRegistry.set(701, otherGuest);
    expect(
      manager.attachGuest("browser:export-other", 701, {
        active: true,
        windowId: WINDOW_ID,
        workspaceKey: WORKSPACE_KEY,
        sessionId: SESSION_ID,
      }).ok,
    ).toBe(true);

    await expect(
      manager.exportPage({
        tabId: TAB_ID,
        webContentsId: 701,
        format: "png",
        windowId: WINDOW_ID,
        senderWebContentsId: SENDER_WEB_CONTENTS_ID,
      }),
    ).resolves.toEqual({ success: false, error: "not_owner" });
  });
});
