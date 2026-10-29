import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlatformChannels } from "@nibi/shared";

type IpcHandler = (...args: unknown[]) => unknown;
type RemoteIpcOptions = Parameters<
  typeof import("../src/main/desktopMainIpcRemote.js").registerRemoteIpcHandlers
>[0];

const h = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, IpcHandler>(),
  fromWebContents: vi.fn(),
  registerWebRemoteControlIpcHandlers: vi.fn(),
  shellOpenExternal: vi.fn(),
  shellOpenPath: vi.fn(),
  configureRemoteUsageArmsTelemetry: vi.fn(),
  reportRemoteConnectResultToArms: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    on: vi.fn(),
    isPackaged: true,
  },
  BrowserWindow: {
    fromWebContents: h.fromWebContents,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => h.handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => h.listeners.set(channel, handler)),
  },
  shell: {
    openExternal: h.shellOpenExternal,
    openPath: h.shellOpenPath,
  },
}));

vi.mock("../src/main/desktopNotifications.js", () => ({
  dispatchTaskNotification: vi.fn(),
}));

vi.mock("../src/main/desktopOAuthDeepLink.js", () => ({
  clearOAuthRoutesForWindow: vi.fn(),
  deliverPendingDeepLink: vi.fn(() => false),
  parseOAuthStateRegistration: vi.fn(),
  registerOAuthState: vi.fn(),
}));

vi.mock("../src/main/desktopArmsCustomEvent.js", () => ({
  createFinalArmsCustomEventE2EController: vi.fn(),
  dispatchFinalArmsCustomEvent: vi.fn(),
}));

vi.mock("../src/main/desktopWebRemoteControlIpc.js", () => ({
  registerWebRemoteControlIpcHandlers: h.registerWebRemoteControlIpcHandlers,
}));

vi.mock("../src/main/desktopRemoteUsageArmsTelemetry.js", () => ({
  configureRemoteUsageArmsTelemetry: h.configureRemoteUsageArmsTelemetry,
  reportRemoteConnectResultToArms: h.reportRemoteConnectResultToArms,
}));

function createOptions(): RemoteIpcOptions {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    appTelemetryRuntime: {
      onRendererReady: vi.fn(),
      syncRendererContext: vi.fn(),
      onOAuthCallbackHandled: vi.fn(),
    },
    appTelemetryCore: {
      reportEvent: vi.fn(async () => {}),
    },
    reportRemoteUsageEvent: vi.fn(),
    armsCustomContext: {
      deviceMid: "device-mid",
      platform: "darwin",
      appVersion: "1.0.0",
      armsEnv: "local",
    },
    webRemoteControlManager: {
      authorizeStart: vi.fn(),
      startAuthorized: vi.fn(),
      resetPairingAuthorized: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn(),
    },
    createRemoteWorkspaceSession: vi.fn(async () => "remote-session-1"),
    disposeRemoteWorkspaceSession: vi.fn(),
    cancelPendingRemoteWorkspaceSessionsForWindow: vi.fn(),
    bindRemoteWorkspaceSessionContext: vi.fn(),
    confirmRendererAttachmentReady: vi.fn(),
    getRemoteConnectionStats: vi.fn(() => ({
      activeSessionCount: 0,
      activeTargetCount: 0,
    })),
    isDockerDaemonAvailable: vi.fn(async () => true),
    listAvailableWSLDistros: vi.fn(async () => []),
    listAvailableDockerContainers: vi.fn(async () => []),
    listSSHConfigAliases: vi.fn(async () => []),
  };
}

async function registerOpenExternalListener() {
  const { registerRemoteIpcHandlers } = await import("../src/main/desktopMainIpcRemote.js");
  const options = createOptions();
  registerRemoteIpcHandlers(options);
  const listener = h.listeners.get(PlatformChannels.OpenExternal);
  expect(listener).toBeDefined();
  return { listener: listener!, options };
}

describe("OpenExternal 协议分流", () => {
  beforeEach(() => {
    h.handlers.clear();
    h.listeners.clear();
    h.fromWebContents.mockReset();
    h.shellOpenExternal.mockReset().mockResolvedValue(undefined);
    h.shellOpenPath.mockReset().mockResolvedValue("");
  });

  it("http/https 仍走 shell.openExternal", async () => {
    const { listener } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };

    listener({ sender }, "https://example.com/docs");

    await vi.waitFor(() => expect(h.shellOpenExternal).toHaveBeenCalledTimes(1));
    expect(h.shellOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
    expect(h.shellOpenPath).not.toHaveBeenCalled();
  });

  it("file URL 被通用通道拒绝，本地文件只走 OpenExternalFile 专用通道", async () => {
    const { listener, options } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };

    listener({ sender }, "file:///tmp/page%20one.html#section");

    await vi.waitFor(() => expect(options.logger.warn).toHaveBeenCalledTimes(1));
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
    expect(h.shellOpenPath).not.toHaveBeenCalled();

    const openFile = h.handlers.get(PlatformChannels.OpenExternalFile);
    expect(openFile).toBeDefined();
    await expect(openFile!({}, "C:\\tmp\\report page.html")).resolves.toEqual({ success: true });
    expect(h.shellOpenPath).toHaveBeenCalledWith(expect.stringContaining("report page.html"));
  });

  it("javascript/data/无法解析的字符串都不会交给系统", async () => {
    const { listener, options } = await registerOpenExternalListener();
    const sender = { getURL: vi.fn(() => "about:blank") };

    listener({ sender }, "javascript:alert(1)");
    listener({ sender }, "data:text/html,hello");
    listener({ sender }, "not a url");

    await vi.waitFor(() => expect(options.logger.warn).toHaveBeenCalledTimes(3));
    expect(h.shellOpenExternal).not.toHaveBeenCalled();
    expect(h.shellOpenPath).not.toHaveBeenCalled();
  });
});
