import {
  DEFAULT_WORKSPACE,
  clearAppData,
  switchToWorkspaceRendererWindow,
  waitForDefaultWorkspaceReady,
  waitForWorkspaceApp,
} from "../../../helpers/desktop-app.js";
import { reloadElectronSessionSafely } from "../../../helpers/e2e-electron-reload.js";
import {
  capturePluginManualReview,
  getPluginList,
  getPluginOverview,
  requirePluginManualReview,
} from "../../../helpers/plugin-management-lifecycle.js";
import {
  PLUGIN_UI_VIEW_ID,
  PLUGIN_UI_VIEW_SURFACE_ID,
  armPluginUiView,
  seedPluginUiViewPlugin,
} from "../../../helpers/plugin-ui-view-fixture.js";
import {
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";

const SPEC_TIMEOUT_MS = 240_000;
const EXTENSION_OPEN_TIMEOUT_MS = 90_000;

interface SessionStoreBridge {
  getState(): {
    getWorkspaceState(workspacePath: string): { activeTaskId: string | null };
  };
}

describe("PLM-UI-VIEW nibi.ui.view extension panel E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("重启后通过插件设置激活扩展，并在活跃任务上打开 plugin-ui 侧栏面板", async function () {
    this.timeout(SPEC_TIMEOUT_MS);
    requirePluginManualReview();

    // 1. 旧 Electron 进程完全退出、启动屏障确认后，再写 seed。这是 helper 约定的
    // “无并发 writer”窗口：fixture/配置/同意文件会原样进入随后的冷启动 Host。
    let settingsPath = "";
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: async () => {
        settingsPath = (await seedPluginUiViewPlugin()).settingsPath;
      },
    });
    expect(settingsPath.length).toBeGreaterThan(0);

    // 2. 新 Host 恢复默认工作区；显式切回工作区 renderer，避免停在 chrome-error
    // 过渡 target 上继续找会话。切换失败时由下面的 waitForWorkspaceApp 给出权威诊断。
    await waitForDefaultWorkspaceReady(60_000);
    await switchToWorkspaceRendererWindow(DEFAULT_WORKSPACE, 30_000).catch(() => undefined);
    await waitForWorkspaceApp(DEFAULT_WORKSPACE, 60_000);

    // 3. 扩展面板只能挂到活跃会话：renderer 在没有 activeTaskId 时会丢弃 openView。
    // 先发送一条真实消息建立任务，再等 store 的 activeTaskId 落到该 task 上。
    await prepareV4ConversationE2E();
    await sendV4Prompt("Reply with ok.");
    const created = await waitForV4Pane(
      (snapshot) => Boolean(snapshot.sessionId && snapshot.sessionId !== "draft"),
      "发送首条消息后没有建立真实任务",
      90_000,
    );
    const activeTaskId = await waitForActiveTaskId(DEFAULT_WORKSPACE, 30_000);
    expect(activeTaskId).toBe(created.sessionId);

    // 4. 触发 Host 的懒激活。插件必须被发现、启用，且清单里的 surface 已被解析；
    // 否则 openView 会以 capability_unavailable 或 surface 缺失被丢弃。
    const overview = await getPluginOverview();
    const list = await getPluginList();
    const plugin = list.plugins.find((candidate) => candidate.id === PLUGIN_UI_VIEW_ID);
    if (!plugin) {
      throw new Error(
        [
          `seeded plugin was not discovered: ${PLUGIN_UI_VIEW_ID}`,
          `list diagnostics: ${JSON.stringify(list.diagnostics)}`,
          `overview diagnostics: ${JSON.stringify(overview.diagnostics)}`,
        ].join("\n"),
      );
    }
    expect(plugin.enabled).toBe(true);
    expect(plugin.hasCodeRuntime).toBe(true);
    expect(
      plugin.uiSurfaces?.some((surface) => surface.id === PLUGIN_UI_VIEW_SURFACE_ID),
    ).toBe(true);
    // 两个能力都不需要敏感授权；它们必须已持久化为 granted，否则扩展的 settings.get /
    // ui.openView 会被 Host 以 "Capability is not granted" 拒绝。
    expect(plugin.capabilities?.granted.map((grant) => grant.id)).toEqual(
      expect.arrayContaining(["nibi.settings.own", "nibi.ui.view"]),
    );

    // 5. 翻转插件自己的设置文件；扩展的 250ms 轮询读到 armed 后只调用一次
    // nibi.ui.openView("panel")，Host 事件再经 renderer bridge 打开侧栏 tab。
    await armPluginUiView(settingsPath);
    await waitForPluginUiViewPanel(EXTENSION_OPEN_TIMEOUT_MS);
    // webview 只在 resources/read 成功、沙箱注册完成后才挂到 DOM：这是 MCP 握手
    // 与面板资源的第二层证据，不只是“tab 出现了”。
    await browser.$('[data-testid="plugin-ui-webview"]').waitForExist({ timeout: 60_000 });
    // 页面里的 window.nibi.ready() 完成 ui/initialize；phase=running 证明宿主与沙箱
    // 已经握手成功，而不只是侧栏多了一个 tab。
    await browser.waitUntil(
      () =>
        browser.execute((surfaceId) => {
          const card = document.querySelector<HTMLElement>(
            `[data-plugin-ui-surface-id="${surfaceId}"] [data-testid="plugin-ui-card"]`,
          );
          return card?.dataset.pluginUiPhase === "running";
        }, PLUGIN_UI_VIEW_SURFACE_ID),
      { timeout: 60_000, timeoutMsg: "plugin-ui 面板没有完成 MCP Apps 握手" },
    );

    await capturePluginManualReview("PLM-UI-VIEW", "extension-surface-open");
  });
});

async function waitForActiveTaskId(workspacePath: string, timeout: number): Promise<string> {
  let latest: string | null = null;
  await browser.waitUntil(
    async () => {
      latest = (await browser.execute((path) => {
        const store = (
          window as Window & {
            __nibiSessionStoreE2E?: SessionStoreBridge;
          }
        ).__nibiSessionStoreE2E;
        return store?.getState().getWorkspaceState(path).activeTaskId ?? null;
      }, workspacePath)) as string | null;
      return typeof latest === "string" && latest.length > 0;
    },
    { timeout, timeoutMsg: "真实任务建立后 activeTaskId 仍为空" },
  );
  if (!latest) throw new Error("activeTaskId 没有在超时前写入 session store");
  return latest;
}

async function waitForPluginUiViewPanel(timeout: number): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((surfaceId) => {
        const tab = document.querySelector<HTMLElement>('[data-side-pane-tab-id^="plugin-ui:"]');
        if (!tab) return false;
        if (tab.dataset.state !== "active") return false;
        if (!(tab.dataset.sidePaneTabId ?? "").endsWith(`:surface:${surfaceId}`)) return false;
        return Boolean(
          document.querySelector(
            `[data-plugin-ui-surface-id="${surfaceId}"] [data-testid="plugin-ui-card"]`,
          ),
        );
      }, PLUGIN_UI_VIEW_SURFACE_ID),
    {
      timeout,
      timeoutMsg: `扩展 openView 没有打开激活的 plugin-ui 侧栏面板: surface=${PLUGIN_UI_VIEW_SURFACE_ID}`,
    },
  );
}
