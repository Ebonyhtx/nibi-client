import { recordArmsCustomEventForE2E } from "@nibi/ui";
import { DesktopCommandIds, buildLocalMediaPreviewUrl, type IPlatformService } from "@nibi/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";
import { createDesktopPluginSandboxPlatform } from "./plugin-sandbox/desktopPluginSandboxPlatform.js";

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    canSelectFilePath: true,
    canOpenLocalFiles: true,
    pluginSandbox: createDesktopPluginSandboxPlatform(),
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.nibi.selectDirectory(),
    selectDirectories: () => window.nibi.selectDirectories(),
    selectFile: () => window.nibi.selectFile(),
    selectFiles: () => window.nibi.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.nibi.createTempTextAttachment(payload),
    materializeWorkflowArtifactFile: (payload) =>
      window.nibi.materializeWorkflowArtifactFile(payload),
    onRemoteConnectionLog: (handler) => window.nibi.onRemoteConnectionLog(handler),
    onRemoteSessionClosed: (handler) => window.nibi.onRemoteSessionClosed(handler),
    // Source 自动重连会替换 logical session；统一由 preload bridge 转发换代事件。
    onRemoteSessionReconnected: (handler) =>
      window.nibi.onRemoteSessionReconnected?.(handler) ?? (() => {}),
    activateOrSetWorkspace: (path) =>
      window.nibi.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.nibi.connectRemote(remoteOptions, requestId, context),
    requestSourceSettingsAttachment: (sourceServerId) =>
      window.nibi.requestSourceSettingsAttachment?.(sourceServerId) ??
      Promise.reject(new Error("Source settings attachment bridge unavailable")),
    cancelPendingRemoteConnection: (requestId) =>
      window.nibi.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    bindRemoteWorkspaceSessionContext: (context) =>
      window.nibi.bindRemoteWorkspaceSessionContext?.(context) ??
      Promise.reject(new Error("Desktop bindRemoteWorkspaceSessionContext bridge unavailable")),
    startWebRemoteControl: (context) => window.nibi.startWebRemoteControl(context),
    stopWebRemoteControl: () => window.nibi.stopWebRemoteControl(),
    getWebRemoteControlStatus: () => window.nibi.getWebRemoteControlStatus(),
    onWebRemoteControlStatusChanged: (handler) =>
      window.nibi.onWebRemoteControlStatusChanged?.(handler) ?? (() => {}),
    disposeRemoteSession: (sessionId) => window.nibi.disposeRemoteSession(sessionId),
    isDockerAvailable: () => window.nibi.isDockerAvailable(),
    listWSLDistros: () => window.nibi.listWSLDistros(),
    listDockerContainers: () => window.nibi.listDockerContainers(),
    listSSHConfigAliases: () => window.nibi.listSSHConfigAliases(),
    loadMcpFromUserDirectory: (payload) => window.nibi.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => window.nibi.saveMcpToUserDirectory(payload),
    migrateLegacyCommonMcp: (payload) => window.nibi.migrateLegacyCommonMcp(payload),
    openExternal: (url) => window.nibi.openExternal(url),
    openFeedback: () => window.nibi.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
    openCommunity: () => window.nibi.executeDesktopCommand(DesktopCommandIds.OpenCommunity),
    canOpenCommunity: (locale) => window.nibi.canOpenCommunity(locale),
    openInFileManager: (path) => window.nibi.openInFileManager(path),
    openExternalFile: (path) => window.nibi.openExternalFile(path),
    openCuaPermissionOnboarding: window.nibi.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.nibi.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.nibi.prepareCuaHelperPermissionDrag
      ? () =>
          window.nibi.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.nibi.startCuaHelperPermissionDrag
      ? () => window.nibi.startCuaHelperPermissionDrag?.()
      : undefined,
    notifyWebRemoteControlAuthStateChanged: (change) =>
      window.nibi.notifyWebRemoteControlAuthStateChanged(change),
    registerOAuthState: (payload) => window.nibi.registerOAuthState(payload),
    onOAuthCallback: (callback) => window.nibi.onOAuthCallback(callback),
    onPaymentCallback: (callback) => window.nibi.onPaymentCallback(callback),
    onShareImport: (callback) => window.nibi.onShareImport?.(callback) ?? (() => {}),
    notifyRendererReady: () => window.nibi.notifyRendererReady(),
    reportTelemetryEvent: (payload) => window.nibi.reportTelemetryEvent(payload),
    reportArmsCustomEvent: (payload) => {
      recordArmsCustomEventForE2E(payload);
      return window.nibi.reportArmsCustomEvent(payload);
    },
    getRendererActionTraceConfig: window.nibi.getRendererActionTraceConfig
      ? () => window.nibi.getRendererActionTraceConfig!()
      : undefined,
    onRendererActionTraceConfigChanged: window.nibi.onRendererActionTraceConfigChanged
      ? (callback) => window.nibi.onRendererActionTraceConfigChanged!(callback)
      : undefined,
    reportLocalTtftBatch: (batch) => window.nibi.reportLocalTtftBatch(batch),
    reportRendererActionTraceBatch: window.nibi.reportRendererActionTraceBatch
      ? (batch) => window.nibi.reportRendererActionTraceBatch!(batch)
      : undefined,
    reportRendererHeapSample: window.nibi.reportRendererHeapSample
      ? (sample) => window.nibi.reportRendererHeapSample!(sample)
      : undefined,
    showTaskNotification: (payload) => window.nibi.showTaskNotification(payload),
    syncWindowTabs: (paths) => window.nibi.syncWindowTabs(paths),
    syncWebRemoteControlWorkspaces: (workspaces) =>
      window.nibi.syncWebRemoteControlWorkspaces?.(workspaces),
    onWebRemoteControlReconnectWorkspace: (handler) =>
      window.nibi.onWebRemoteControlReconnectWorkspace?.(handler) ?? (() => {}),
    syncWindowUnreadCount: (count) => window.nibi.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.nibi.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.nibi.syncAppSettings?.(patch),
    // 桥缺失（旧 preload 升级窗口）时按 supported 兜底，与 Windows 现状一致，设置开关可用。
    getCloseToTrayCapability: () =>
      window.nibi.getCloseToTrayCapability?.() ??
      Promise.resolve({ supported: true, gnomeLikeWithoutTray: false }),
    setShortcutRecordingActive: (active) => window.nibi.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.nibi.onFocusTab(handler),
    onNewTab: (handler) => window.nibi.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.nibi.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.nibi.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onEmbeddedBrowserPermissionPrompt: (handler) =>
      window.nibi.onEmbeddedBrowserPermissionPrompt?.(handler) ?? (() => {}),
    resolveEmbeddedBrowserPermissionPrompt: (request) =>
      window.nibi.resolveEmbeddedBrowserPermissionPrompt?.(request),
    getEmbeddedBrowserSitePermissions: () =>
      window.nibi.getEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    setEmbeddedBrowserSitePermission: (request) =>
      window.nibi.setEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    clearEmbeddedBrowserSitePermissions: () =>
      window.nibi.clearEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    resetEmbeddedBrowserSitePermission: (request) =>
      window.nibi.resetEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.nibi.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.nibi.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.nibi.browserViewScreenshotSurfaceReady?.(payload),
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.nibi.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.nibi.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.nibi.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onOpenFeedbackDialog: (handler) => window.nibi.onOpenFeedbackDialog?.(handler) ?? (() => {}),
    onOpenTicketsPanel: (handler) => window.nibi.onOpenTicketsPanel?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.nibi.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.nibi.getDesktopWindowChromeState
      ? () => window.nibi.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.nibi.onDesktopWindowChromeStateChanged
      ? (handler) => window.nibi.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () => window.nibi.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.nibi.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.nibi.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.nibi.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.nibi.onTaskNotificationClick(handler),
    exportLogs: () => window.nibi.exportLogs(),
    captureWindowScreenshot: () =>
      window.nibi.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.nibi.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.nibi.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) => window.nibi.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.nibi.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.nibi.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.nibi.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.nibi.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.nibi.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.nibi.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.nibi.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getZCodeStdioTapDevState: () =>
      window.nibi.getZCodeStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.nibi.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.nibi.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.nibi.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.nibi.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) => window.nibi.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.nibi.quitAndInstallUpdate(),
    getInstalledEditors: (filePath) => window.nibi.getInstalledEditors(filePath),
    getApplicationIcon: (bundleId) =>
      window.nibi.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.nibi.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.nibi.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.nibi.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.nibi.getSystemLocale?.() ??
      Promise.resolve(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"),
    setTitleBarTheme: (theme) => window.nibi.setTitleBarTheme(theme),
    getDeviceId: () =>
      (window as Window & { __NIBI_DEVICE_ID__?: string }).__NIBI_DEVICE_ID__ ?? "",
  };
}
