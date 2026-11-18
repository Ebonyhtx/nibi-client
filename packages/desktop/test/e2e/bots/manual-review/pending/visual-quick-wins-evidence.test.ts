/**
 * UI 快赢视觉证据（manual-review / pending）。
 *
 * 目的：只截图 + 测量，不改产品代码，不向外部服务发请求。
 * 运行：
 *   NIBI_E2E_EVIDENCE_DIR=<evidence dir> pnpm --filter @nibi/desktop exec wdio run wdio.conf.ts \
 *     --spec test/e2e/bots/manual-review/pending/visual-quick-wins-evidence.test.ts
 *
 * 覆盖：
 * 1. 设置搜索（结果列表、回车跳转、2 秒高亮）
 * 2. 设置 → 通用：fileTreeHtmlClickOpensBrowser 默认关闭
 * 3. 设置 → 项目管理：行菜单“编辑” → ProjectEditor → 保存后列表刷新
 * 4. 对话列 360px / 侧面板 100%：1440×900 与 1024×700 实际测量
 * 6. 浏览器设备预设 + 窄地址栏（9rem 阈值）与 More 里的站点权限设置
 * 7. 文件树单击 HTML：开关关=源码预览；开=内置浏览器；右键菜单仍可源码预览
 */
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_MORE_BUTTON,
  TID_BROWSER_RESPONSIVE_BUTTON,
  TID_BROWSER_RESPONSIVE_HEIGHT_INPUT,
  TID_BROWSER_RESPONSIVE_TOOLBAR,
  TID_BROWSER_RESPONSIVE_WIDTH_INPUT,
  TID_PREVIEW_PANE,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SIDE_PANE_TOGGLE,
  TID_TASK_SETTINGS_BUTTON,
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON,
  TID_WORKSPACE_FILE_TREE_ROW,
  testId,
} from "@nibi/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  clickTestIdByWebDriver,
  readSettings,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "../../../helpers/desktop-app.js";
import {
  clickCloseButton,
  openFirstBrowserTab,
  readBrowserTabIds,
} from "../../../helpers/browser-side-pane.js";
import { openProjectFileTree } from "../../../helpers/project-sidebar.js";
import { sel } from "../../../helpers/selectors.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

const EVIDENCE_DIR =
  process.env.NIBI_E2E_EVIDENCE_DIR?.trim() ||
  "C:\\Users\\ebony\\.zcode\\v2\\visualizations\\82f99954015178f5bb581d6e0a9014c220cfc1dbb7d87edbaa6cf2a8505fd833\\visual-quick-wins";
const FACTS_FILE = "wdio-facts.json";
const BROWSER_TEST_PAGE =
  "<!doctype html><html><head><meta charset='utf-8'><title>quick-win browser preset</title></head><body><h1>NIBI_QUICK_WIN_BROWSER</h1></body></html>";
let browserTestServer: ReturnType<typeof createServer> | null = null;
let browserTestOrigin = "";
const facts: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    release: process.env.OS ?? "",
    cwd: process.cwd(),
  },
};

async function shot(name: string): Promise<string> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await browser.saveScreenshot(path);
  return path;
}

async function record(key: string, value: unknown): Promise<void> {
  facts[key] = value;
}

async function writeFacts(): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(join(EVIDENCE_DIR, FACTS_FILE), JSON.stringify(facts, null, 2), "utf-8");
}

/** Electron 下 WebDriver setWindowSize 不可用，改经 main 进程设置主窗口尺寸。 */
async function setWindowSize(width: number, height: number): Promise<{
  size: [number, number];
  content: [number, number];
  viewport: [number, number];
  waitedMs: number;
}> {
  const startedAt = Date.now();
  await browser.electron.execute(
    (electron, w, h) => {
      const win = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed(),
      );
      win?.setSize(w, h);
    },
    width,
    height,
  );
  let geometry: { size: [number, number]; content: [number, number] } | null = null;
  await browser.waitUntil(
    async () => {
      geometry = (await browser.electron.execute((electron) => {
        const win = electron.BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
        return win
          ? { size: win.getSize() as [number, number], content: win.getContentSize() as [number, number] }
          : null;
      })) as { size: [number, number]; content: [number, number] } | null;
      const viewport = (await browser.execute(() => [innerWidth, innerHeight])) as [number, number];
      return Boolean(
        geometry &&
        geometry.size[0] === width &&
        geometry.size[1] === height &&
        geometry.content[0] === viewport[0] &&
        geometry.content[1] === viewport[1],
      );
    },
    { timeout: 10_000, interval: 100, timeoutMsg: `窗口尺寸 ${width}x${height} 未收敛` },
  );
  const viewport = (await browser.execute(() => [innerWidth, innerHeight])) as [number, number];
  return {
    size: geometry!.size,
    content: geometry!.content,
    viewport,
    waitedMs: Date.now() - startedAt,
  };
}

async function openSettings(): Promise<void> {
  if (await $(sel(TID_SETTINGS_PAGE)).isDisplayed().catch(() => false)) return;
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 30_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 30_000 });
}

async function clickSettingsSection(sectionId: string): Promise<void> {
  await openSettings();
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, sectionId), {
    timeout: 15_000,
    timeoutMsg: `设置页没有 ${sectionId} 分区入口`,
  });
}

async function closeSettings(): Promise<void> {
  const back = $(sel(TID_SETTINGS_BACK_BUTTON));
  if (await back.isDisplayed().catch(() => false)) {
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 10_000 });
  }
  await $(sel(TID_SETTINGS_PAGE)).waitForDisplayed({ timeout: 10_000, reverse: true });
}

async function readSearchSnapshot(): Promise<{
  count: number;
  titles: string[];
  ids: string[];
}> {
  return browser.execute(() => {
    const results = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="settings-search-result"]'),
    );
    return {
      count: results.length,
      titles: results.map((item) => (item.textContent ?? "").replace(/\s+/gu, " ").trim()),
      ids: results.map((item) => item.dataset.settingsSearchResultId ?? ""),
    };
  });
}

async function typeSettingsSearch(query: string): Promise<void> {
  await setInputValueByTestIdDom("settings-search-input", query, {
    timeout: 15_000,
    timeoutMsg: "设置搜索输入框没有出现",
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expected) =>
          document.querySelector<HTMLInputElement>('[data-testid="settings-search-input"]')
            ?.value === expected,
        query,
      ),
    { timeout: 5_000, interval: 100, timeoutMsg: `设置搜索没有接受查询：${query}` },
  );
}

async function readAddressBarState(): Promise<{
  exists: boolean;
  width: number;
  height: number;
  tabCount: number;
  activeTabIds: string[];
  panelWidth: number;
}> {
  return browser.execute(() => {
    const bar = document.querySelector<HTMLElement>('[data-testid="browser-address-bar"]');
    const rect = bar?.getBoundingClientRect();
    const panel = document.querySelector<HTMLElement>("#browser");
    return {
      exists: Boolean(bar),
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      tabCount: document.querySelectorAll('[data-side-pane-tab-id^="browser:"]').length,
      activeTabIds: Array.from(
        document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id][data-active]"),
      ).map((item) => item.dataset.sidePaneTabId ?? ""),
      panelWidth: panel?.getBoundingClientRect().width ?? 0,
    };
  });
}

async function ensureBrowserTabActive(): Promise<void> {
  let state = await readAddressBarState();
  if (state.exists && state.width > 0) return;
  if (state.tabCount === 0) {
    await openFirstBrowserTab();
  } else {
    await browser.execute(() => {
      const tab = document.querySelector<HTMLElement>('[data-side-pane-tab-id^="browser:"]');
      tab?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      tab?.click();
    });
  }
  try {
    await browser.waitUntil(
      async () => {
        state = await readAddressBarState();
        return state.exists && state.width > 0;
      },
      { timeout: 30_000, interval: 300, timeoutMsg: "浏览器地址栏没有出现" },
    );
  } catch (error) {
    throw new Error(
      `浏览器地址栏没有出现，最后状态: ${JSON.stringify(state)}，正文: ${(
        await browser.execute(() => document.body.innerText)
      )
        .replace(/\s+/gu, " ")
        .slice(0, 500)}`,
      { cause: error },
    );
  }
}

async function navigateBrowserToTestOrigin(): Promise<void> {
  await setInputValueByTestIdDom(TID_BROWSER_ADDRESS_INPUT, browserTestOrigin, {
    timeout: 15_000,
    timeoutMsg: "浏览器地址栏没有出现",
  });
  await browser.execute((addressId) => {
    document.querySelector<HTMLInputElement>(`[data-testid="${addressId}"]`)?.focus();
  }, TID_BROWSER_ADDRESS_INPUT);
  await browser.keys(["Enter"]);
  await browser.waitUntil(
    async () =>
      Boolean(
        await browser.execute(() => {
          const input = document.querySelector<HTMLInputElement>(
            '[data-testid="browser-address-input"]',
          );
          return (
            Boolean(input?.value.includes("127.0.0.1")) &&
            Boolean(document.querySelector('[data-testid="browser-permission-trigger"]'))
          );
        }),
      ),
    { timeout: 30_000, interval: 300, timeoutMsg: "浏览器没有加载本地测试页并建立 origin" },
  );
}

async function closeAllBrowserTabs(): Promise<void> {
  const tabIds = await readBrowserTabIds();
  for (const tabId of tabIds) {
    try {
      await clickCloseButton(tabId);
    } catch {
      // tab 可能已被工作区切换/恢复流程关闭；清理是尽力而为。
    }
  }
  await browser.pause(400);
}

async function ensureSidebarVisible(): Promise<void> {
  const isVisible = async () =>
    Boolean(
      await browser.execute(() => {
        const sidebar = document.querySelector<HTMLElement>('[data-testid="sidebar"]');
        return Boolean(sidebar && sidebar.getBoundingClientRect().width > 100);
      }),
    );
  if (await isVisible()) return;
  await clickTestIdByDom("desktop-top-logo-sidebar-toggle", {
    timeout: 10_000,
    timeoutMsg: "没有找到侧栏展开按钮",
  });
  await browser.waitUntil(isVisible, { timeout: 10_000, timeoutMsg: "侧栏没有展开" });
}

async function pressEnter(): Promise<void> {
  await browser.execute(() => {
    document.querySelector<HTMLInputElement>('[data-testid="settings-search-input"]')?.focus();
  });
  await browser.keys(["Enter"]);
}

async function readHighlightTarget(): Promise<{
  targetId: string | null;
  found: boolean;
  rect: { left: number; top: number; width: number; height: number } | null;
  highlightDurationMs: number;
}> {
  return browser.execute(() => {
    const target = document.querySelector<HTMLElement>(
      '[data-settings-search-highlighted="true"]',
    );
    const targetId = target?.getAttribute("data-settings-search-target") ?? null;
    const rect = target?.getBoundingClientRect();
    return {
      targetId,
      found: Boolean(target),
      rect: rect
        ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        : null,
      highlightDurationMs: 2000,
    };
  });
}

function rectSnapshot(selector: string): Promise<{
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
} | null> {
  return browser.execute((currentSelector) => {
    const element = document.querySelector<HTMLElement>(currentSelector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
  }, selector);
}

async function readLayoutStorage(): Promise<Array<{ key: string; value: string | null }>> {
  return browser.execute(() =>
    Object.keys(localStorage)
      .filter((key) => key.startsWith("react-resizable-panels:"))
      .sort()
      .map((key) => ({ key, value: localStorage.getItem(key) })),
  );
}

async function seedBodyLayout(conversationPercent: number, browserPercent: number): Promise<{
  selectedKey: string;
  previous: string | null;
}> {
  return browser.execute(
    (conversation, panel) => {
      const candidates = Object.keys(localStorage).filter(
        (key) =>
          key.startsWith("react-resizable-panels:workspace-body-layout") ||
          key.includes("workspace-body-layout"),
      );
      const key =
        candidates.find((item) => item.endsWith("conversation-column:browser")) ??
        "react-resizable-panels:workspace-body-layout:conversation-column:browser";
      const previous = localStorage.getItem(key);
      localStorage.setItem(
        key,
        JSON.stringify({
          "conversation-column": conversation,
          browser: panel,
        }),
      );
      return { selectedKey: key, previous };
    },
    conversationPercent,
    browserPercent,
  );
}

async function waitForWorkspaceAfterReload(): Promise<void> {
  await browser.waitUntil(
    async () =>
      browser.execute(() =>
        Boolean(
          document.querySelector('[data-workspace-conversation-frame="true"]') ||
            document.querySelector('[data-testid="task-settings-button"]'),
        ),
      ),
    { timeout: 60_000, interval: 500, timeoutMsg: "刷新后工作区没有恢复" },
  );
}

async function dragSidePaneDividerTo(targetX: number): Promise<void> {
  const handle = $('[data-workspace-side-pane-resize-handle="true"]');
  await handle.waitForDisplayed({ timeout: 10_000, timeoutMsg: "没有找到侧面板拖拽分隔条" });
  const location = await handle.getLocation();
  const size = await handle.getSize();
  const startX = Math.round(location.x + size.width / 2);
  const startY = Math.round(location.y + Math.min(300, size.height / 2));
  await browser.performActions([
    {
      type: "pointer",
      id: "side-pane-drag",
      parameters: { pointerType: "mouse" },
      actions: [
        { type: "pointerMove", x: startX, y: startY, duration: 0 },
        { type: "pointerDown", button: 0 },
        { type: "pointerMove", x: startX + (targetX > startX ? 24 : -24), y: startY, duration: 80 },
        { type: "pointerMove", x: targetX, y: startY, duration: 400 },
        { type: "pointerUp", button: 0 },
      ],
    },
  ]);
  await browser.releaseActions();
  await browser.pause(600);
}

async function ensureSidePaneOpen(): Promise<void> {
  const isVisible = async () =>
    Boolean(
      await browser.execute(() => {
        const panel = document.querySelector<HTMLElement>("#browser");
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        return rect.width > 120 && rect.right <= window.innerWidth + 2;
      }),
    );
  if (await isVisible()) return;
  await clickTestIdByDom(TID_SIDE_PANE_TOGGLE, {
    timeout: 15_000,
    timeoutMsg: "没有找到右侧面板开关",
  });
  await browser.waitUntil(isVisible, { timeout: 15_000, timeoutMsg: "右侧面板没有展开" });
}

async function readSidePaneMetrics(): Promise<Record<string, unknown>> {
  return browser.execute(() => {
    const conversation = document.querySelector<HTMLElement>("#conversation-column");
    const browserPanel = document.querySelector<HTMLElement>("#browser");
    const frame = document.querySelector<HTMLElement>(
      '[data-workspace-conversation-frame="true"]',
    );
    const tabsContent = document.querySelector<HTMLElement>("[data-side-pane-tabs-content]");
    const addressBar = document.querySelector<HTMLElement>('[data-testid="browser-address-bar"]');
    const rect = (element: HTMLElement | null) => {
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        right: value.right,
        width: value.width,
        height: value.height,
      };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      conversationColumn: rect(conversation),
      conversationFrame: rect(frame),
      sidePane: rect(browserPanel),
      sidePaneContent: rect(tabsContent),
      addressBar: rect(addressBar),
      rootFontSizePx: Number.parseFloat(
        window.getComputedStyle(document.documentElement).fontSize,
      ),
    };
  }) as Promise<Record<string, unknown>>;
}

async function setSwitchInTargetRow(targetId: string, checked: boolean): Promise<boolean> {
  return browser.execute(
    (currentTargetId, nextChecked) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>("[data-settings-search-target]"),
      ).find((item) => item.getAttribute("data-settings-search-target") === currentTargetId);
      if (!row) return false;
      const button = row.querySelector<HTMLButtonElement>('button[role="switch"]');
      if (!button) return false;
      const isChecked = button.getAttribute("aria-checked") === "true";
      if (isChecked === nextChecked) return true;
      button.click();
      return true;
    },
    targetId,
    checked,
  );
}

async function readSwitchInTargetRow(targetId: string): Promise<{
  found: boolean;
  checked: boolean | null;
  label: string | null;
}> {
  return browser.execute((currentTargetId) => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>("[data-settings-search-target]"),
    ).find((item) => item.getAttribute("data-settings-search-target") === currentTargetId);
    const button = row?.querySelector<HTMLButtonElement>('button[role="switch"]');
    return {
      found: Boolean(row),
      checked: button ? button.getAttribute("aria-checked") === "true" : null,
      label: button?.getAttribute("aria-label") ?? null,
    };
  }, targetId);
}

async function clickFileTreeRow(path: string): Promise<void> {
  const rowTestId = testId(TID_WORKSPACE_FILE_TREE_ROW, path);
  await browser.waitUntil(
    async () =>
      browser.execute((currentRowTestId) => {
        const row = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (element) => element.dataset.testid === currentRowTestId,
        );
        if (!row) return false;
        row.click();
        return true;
      }, rowTestId),
    { timeout: 15_000, interval: 200, timeoutMsg: `文件树没有可点击行: ${path}` },
  );
}

async function openFileTree(): Promise<void> {
  await ensureSidePaneOpen();
  // 优先复用已打开的 files tab；否则从侧面板 Open Tab 启动器打开“文件”。
  const clickedExisting = await browser.execute(() => {
    const tab = document.querySelector<HTMLElement>('[data-side-pane-tab-id^="file-manager:"]');
    if (!tab) return false;
    tab.click();
    return true;
  });
  if (!clickedExisting) {
    let clickedLauncher = await browser.execute(() => {
      const item = document.querySelector<HTMLElement>('[data-side-pane-open-tab-item="files"]');
      if (!item) return false;
      item.click();
      return true;
    });
    if (!clickedLauncher) {
      await browser.execute(() => {
        document.querySelector<HTMLElement>("[data-side-pane-add-trigger]")?.click();
      });
      await browser.waitUntil(
        () =>
          browser.execute(() =>
            Boolean(document.querySelector('[data-side-pane-open-tab-item="files"]')),
          ),
        { timeout: 10_000, interval: 200, timeoutMsg: "侧面板 Open Tab 里没有“文件”入口" },
      );
      clickedLauncher = await browser.execute(() => {
        const item = document.querySelector<HTMLElement>('[data-side-pane-open-tab-item="files"]');
        if (!item) return false;
        item.click();
        return true;
      });
    }
    if (!clickedLauncher) {
      // 最后兜底：仍走项目行入口（远程项目/旧布局）。
      await openProjectFileTree(DEFAULT_WORKSPACE, { timeout: 20_000 });
    }
  }
  await waitForTestIdByDom(TID_WORKSPACE_FILE_TREE_PANEL, { timeout: 15_000 });
}

/** Radix DropdownMenu trigger 需要 pointerdown + click；用 DOM 手势避开 WebDriver 可点击性抖动。 */
async function clickRadixTriggerByDom(testIdValue: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((currentTestId) => {
        const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
          (item) => item.dataset.testid === currentTestId,
        );
        if (!element) return false;
        const fire = (type: string) => {
          const event =
            type.startsWith("pointer") && typeof PointerEvent !== "undefined"
              ? new PointerEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  button: 0,
                  pointerId: 1,
                  pointerType: "mouse",
                })
              : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
          element.dispatchEvent(event);
        };
        fire("pointerdown");
        fire("mousedown");
        fire("pointerup");
        fire("mouseup");
        fire("click");
        return true;
      }, testIdValue),
    { timeout: 10_000, interval: 100, timeoutMsg: `没有找到 Radix trigger: ${testIdValue}` },
  );
}

async function refreshFileTree(): Promise<void> {
  await clickTestIdByDom(TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON, {
    timeout: 10_000,
    timeoutMsg: "文件树没有刷新按钮",
  });
  await browser.pause(500);
}

describe("UI 快赢视觉证据（真实 Desktop）", () => {
  before(async function () {
    this.timeout(180_000);
    browserTestServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(BROWSER_TEST_PAGE);
    });
    await new Promise<void>((resolve) => browserTestServer!.listen(0, "127.0.0.1", resolve));
    const address = browserTestServer.address();
    if (!address || typeof address === "string") {
      throw new Error("browser test server did not bind a port");
    }
    browserTestOrigin = `http://127.0.0.1:${address.port}`;
    await record("browserTestOrigin", browserTestOrigin);
    await prepareV4ConversationE2E({ skipProvider: true });
    await setWindowSize(1440, 900);
    await mkdir(EVIDENCE_DIR, { recursive: true });
    await record("window", await setWindowSize(1440, 900));
  });

  after(async () => {
    await writeFacts();
    await browser.electron.restoreAllMocks();
    await clearAppData();
    if (browserTestServer) {
      await new Promise<void>((resolve) => browserTestServer!.close(() => resolve()));
    }
  });

  it("SET-01 设置搜索：结果列表、回车跳转与 2 秒高亮", async function () {
    this.timeout(180_000);
    await openSettings();
    await setWindowSize(1440, 900);

    await typeSettingsSearch("字体");
    await waitForTestIdByDom("settings-search-results", { timeout: 10_000 });
    const fontResults = await readSearchSnapshot();
    await shot("01a-settings-search-font-results");
    await record("settingsSearchFont", fontResults);

    await typeSettingsSearch("项目");
    await browser.waitUntil(
      async () => (await readSearchSnapshot()).count > 0,
      { timeout: 10_000, timeoutMsg: "设置搜索“项目”没有结果" },
    );
    const projectResults = await readSearchSnapshot();
    await shot("01b-settings-search-project-results");
    await record("settingsSearchProject", projectResults);

    await typeSettingsSearch("字体");
    await pressEnter();
    await browser.waitUntil(
      async () => (await readHighlightTarget()).found,
      { timeout: 5_000, interval: 50, timeoutMsg: "回车后没有出现设置搜索高亮" },
    );
    const highlight = await readHighlightTarget();
    await shot("01c-settings-search-jump-highlight");
    const targetExists = await browser.execute((targetId) => {
      if (!targetId) return false;
      return Array.from(
        document.querySelectorAll<HTMLElement>("[data-settings-search-target]"),
      ).some((item) => item.getAttribute("data-settings-search-target") === targetId);
    }, highlight.targetId);
    await record("settingsSearchHighlight", { ...highlight, targetExists });
    await record("settingsSearchInputPresent", await $('[data-testid="settings-search"]').isExisting());
  });

  it("SET-02 设置→通用：单击 HTML 用浏览器打开默认关闭", async function () {
    this.timeout(120_000);
    await openSettings();
    await clickSettingsSection("general");
    await typeSettingsSearch("");
    const row = await readSwitchInTargetRow("general.fileTreeHtmlClick");
    await browser.execute(() => {
      const target = Array.from(
        document.querySelectorAll<HTMLElement>("[data-settings-search-target]"),
      ).find(
        (item) =>
          item.getAttribute("data-settings-search-target") === "general.fileTreeHtmlClick",
      );
      target?.scrollIntoView({ block: "center" });
    });
    await browser.pause(300);
    await shot("02-settings-general-html-click-toggle-off");
    const macSmoothingAbsent = await browser.execute(
      () => !document.querySelector('[data-testid="settings-macos-font-smoothing"]'),
    );
    await record("htmlClickToggle", { ...row, macSmoothingRowAbsentOnWindows: macSmoothingAbsent });
    expect(row.found).toBe(true);
    expect(row.checked).toBe(false);
  });

  it("SET-03 项目管理行“编辑”：ProjectEditor 对话框与保存后刷新", async function () {
    this.timeout(180_000);
    await openSettings();
    await clickSettingsSection("projects");
    await waitForTestIdByDom("settings-projects-row-menu", { timeout: 20_000 });
    await $('[data-testid="settings-projects-row-menu"]').moveTo();
    await browser.pause(300);
    await shot("03a-settings-projects-list-before-edit");

    const before = await browser.execute(() => ({
      rowCount: document.querySelectorAll('[data-testid="settings-projects-row-menu"]').length,
      names: Array.from(document.querySelectorAll<HTMLElement>("[data-testid='settings-projects-row-menu']"))
        .map((item) => item.closest("li")?.innerText ?? "")
        .map((text) => text.replace(/\s+/gu, " ").trim()),
    }));
    await clickRadixTriggerByDom("settings-projects-row-menu");
    await clickTestIdByDom("settings-projects-edit-row", { timeout: 15_000 });
    await waitForTestIdByDom("virtual-project-name", { timeout: 15_000 });
    await browser.pause(400);
    await shot("03b-settings-project-editor-dialog");
    const dialog = await browser.execute(() => {
      const name = document.querySelector<HTMLInputElement>('[data-testid="virtual-project-name"]');
      const roots = document.querySelectorAll('[data-testid="virtual-project-root-row"]').length;
      const dialogRoot = name?.closest('[role="dialog"]');
      return {
        title: dialogRoot?.querySelector('[data-slot="dialog-title"], h2')?.textContent?.trim() ?? "",
        nameValue: name?.value ?? null,
        rootRowCount: roots,
        saveButton: Boolean(document.querySelector('[data-testid="virtual-project-save"]')),
      };
    });
    const originalName = (dialog.nameValue ?? "NibiProject").trim();
    const renamed = `${originalName} · E2E 已编辑`;
    await setInputValueByTestIdDom("virtual-project-name", renamed, { timeout: 10_000 });
    await clickTestIdByDom("virtual-project-save", { timeout: 15_000 });
    await $(sel("virtual-project-name")).waitForDisplayed({ timeout: 15_000, reverse: true });
    await browser.waitUntil(
      async () =>
        browser.execute(
          (expected) =>
            Array.from(document.querySelectorAll<HTMLElement>("li")).some((item) =>
              (item.innerText ?? "").includes(expected),
            ),
          renamed,
        ),
      { timeout: 20_000, interval: 250, timeoutMsg: "保存后项目列表没有刷新出新名称" },
    );
    await browser.pause(300);
    await shot("03c-settings-projects-list-after-save");
    const after = await browser.execute(() => ({
      rowCount: document.querySelectorAll('[data-testid="settings-projects-row-menu"]').length,
      names: Array.from(document.querySelectorAll<HTMLElement>("[data-testid='settings-projects-row-menu']"))
        .map((item) => item.closest("li")?.innerText ?? "")
        .map((text) => text.replace(/\s+/gu, " ").trim()),
    }));
    await record("projectEditor", { before, dialog, originalName, renamed, after });
    expect(after.names.some((text) => text.includes(renamed))).toBe(true);

    // 恢复原名称，避免后续按 workspace 路径/项目名定位侧栏项目时被展示名影响。
    await $('[data-testid="settings-projects-row-menu"]').moveTo();
    await clickRadixTriggerByDom("settings-projects-row-menu");
    await clickTestIdByDom("settings-projects-edit-row", { timeout: 15_000 });
    await waitForTestIdByDom("virtual-project-name", { timeout: 15_000 });
    await setInputValueByTestIdDom("virtual-project-name", originalName, { timeout: 10_000 });
    await clickTestIdByDom("virtual-project-save", { timeout: 15_000 });
    await $(sel("virtual-project-name")).waitForDisplayed({ timeout: 15_000, reverse: true });
    await browser.waitUntil(
      async () =>
        browser.execute(
          (expected) =>
            Array.from(document.querySelectorAll<HTMLElement>("li")).some(
              (item) => (item.innerText ?? "").trim().startsWith(expected),
            ),
          originalName,
        ),
      { timeout: 20_000, interval: 250, timeoutMsg: "恢复项目名称后列表没有刷新" },
    );
    await record("projectEditorRestoredName", originalName);
  });

  it("LAYOUT-01 对话列 360px 下限 / 侧面板最大：1440×900 与 1024×700", async function () {
    this.timeout(300_000);
    await closeSettings();
    await setWindowSize(1440, 900);
    await ensureSidePaneOpen();
    await browser.pause(500);
    await shot("04a-layout-1440-default");
    const default1440 = await readSidePaneMetrics();
    const storageBefore = await readLayoutStorage();
    await record("layoutDefault1440", { metrics: default1440, storage: storageBefore });

    // 把分隔条拖到对话列左边界：对话列被 360px 下限夹住，侧面板拿到剩余全部宽度。
    await dragSidePaneDividerTo(272);
    await shot("04b-layout-1440-conversation-min-side-max");
    const conversationMin1440 = await readSidePaneMetrics();
    await record("layoutConversationMin1440", { metrics: conversationMin1440 });

    // 把分隔条拖到窗口最右：侧面板被 240px 下限夹住，对话列拿到最大宽度。
    await dragSidePaneDividerTo(1432);
    await shot("04c-layout-1440-conversation-max-side-min");
    const conversationMax1440 = await readSidePaneMetrics();
    await record("layoutConversationMax1440", { metrics: conversationMax1440 });

    await setWindowSize(1024, 700);
    await ensureSidePaneOpen();
    await browser.pause(500);
    await shot("04d-layout-1024-default");
    const default1024 = await readSidePaneMetrics();
    await record("layoutDefault1024", { metrics: default1024 });

    await dragSidePaneDividerTo(272);
    await shot("04e-layout-1024-conversation-min-side-max");
    const conversationMin1024 = await readSidePaneMetrics();
    await record("layoutConversationMin1024", { metrics: conversationMin1024 });
  });

  it("BROWSER-01 设备预设与窄地址栏（9rem）+ More 站点权限设置", async function () {
    this.timeout(300_000);
    await setWindowSize(1440, 900);
    // 恢复一个可用的常规布局后打开浏览器 tab。
    await seedBodyLayout(52, 48);
    await browser.refresh();
    await waitForWorkspaceAfterReload();
    await ensureSidePaneOpen();
    await ensureBrowserTabActive();
    await navigateBrowserToTestOrigin();
    await browser.pause(1200);
    await clickTestIdByDom(TID_BROWSER_RESPONSIVE_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "没有找到响应式模式按钮",
    });
    await waitForTestIdByDom(TID_BROWSER_RESPONSIVE_TOOLBAR, { timeout: 15_000 });
    await browser.pause(500);
    await shot("06a-browser-responsive-toolbar");

    await clickTestIdByWebDriver("browser-responsive-preset-select", {
      timeout: 10_000,
      timeoutMsg: "没有找到设备预设下拉框",
    });
    await waitForTestIdByDom("browser-responsive-preset-option-phone", { timeout: 10_000 });
    const presets = await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid^="browser-responsive-preset-option-"]'),
      ).map((item) => ({
        testId: item.dataset.testid ?? "",
        text: (item.textContent ?? "").replace(/\s+/gu, " ").trim(),
      })),
    );
    await clickTestIdByWebDriver("browser-responsive-preset-option-phone", { timeout: 10_000 });
    await browser.waitUntil(
      async () =>
        browser.execute(
          (widthId, heightId) => {
            const width = document.querySelector<HTMLInputElement>(
              `[data-testid="${widthId}"]`,
            );
            const height = document.querySelector<HTMLInputElement>(
              `[data-testid="${heightId}"]`,
            );
            return width?.value === "390" && height?.value === "844";
          },
          TID_BROWSER_RESPONSIVE_WIDTH_INPUT,
          TID_BROWSER_RESPONSIVE_HEIGHT_INPUT,
        ),
      { timeout: 10_000, timeoutMsg: "设备预设没有写回 390×844" },
    );
    await browser.pause(600);
    await shot("06c-browser-phone-preset-390x844");
    // 选中“手机”后重新打开下拉：item-aligned 弹层会以当前项对齐，全部预设可见。
    await clickTestIdByWebDriver("browser-responsive-preset-select", { timeout: 10_000 });
    await waitForTestIdByDom("browser-responsive-preset-option-phone", { timeout: 10_000 });
    await browser.pause(300);
    await shot("06b-browser-device-presets-open");
    const phone = await browser.execute(() => ({
      width: document.querySelector<HTMLInputElement>(
        '[data-testid="browser-responsive-width-input"]',
      )?.value,
      height: document.querySelector<HTMLInputElement>(
        '[data-testid="browser-responsive-height-input"]',
      )?.value,
      presetSelect: document.querySelector<HTMLElement>(
        '[data-testid="browser-responsive-preset-select"]',
      )?.textContent,
    }));
    await record("browserPresets", { presets, selectedPhone: phone });
    await browser.execute(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await browser.pause(200);

    // 退出响应式模式，把侧面板压到 ~24%（1440 → 约 280px），验证 <9rem 紧凑地址栏。
    await clickTestIdByDom(TID_BROWSER_RESPONSIVE_BUTTON, { timeout: 10_000 });
    await browser.pause(400);
    await seedBodyLayout(76, 24);
    await browser.refresh();
    await waitForWorkspaceAfterReload();
    await ensureSidePaneOpen();
    await ensureBrowserTabActive();
    // 刷新后浏览器 tab 若回到空白新标签页，重新加载本地测试页，恢复 origin 站点设置入口。
    if (!(await $('[data-testid="browser-permission-trigger"]').isExisting())) {
      await navigateBrowserToTestOrigin();
    }
    await browser.waitUntil(
      async () => {
        const metrics = (await readSidePaneMetrics()) as {
          addressBar?: { width: number };
          sidePane?: { width: number };
        };
        return Boolean(metrics.addressBar && metrics.addressBar.width > 0);
      },
      { timeout: 30_000, interval: 500, timeoutMsg: "窄侧面板下没有出现地址栏" },
    );
    await browser.pause(800);
    const narrow = await readSidePaneMetrics();
    const compact = await browser.execute(() => {
      const addressBar = document.querySelector<HTMLElement>('[data-testid="browser-address-bar"]');
      const rootFont = Number.parseFloat(
        window.getComputedStyle(document.documentElement).fontSize,
      );
      const width = addressBar?.getBoundingClientRect().width ?? 0;
      const siteSettingsEntry = document.querySelector<HTMLElement>(
        '[data-testid="browser-permission-trigger"]',
      );
      const entryVisible = Boolean(
        siteSettingsEntry &&
          siteSettingsEntry.getClientRects().length > 0 &&
          window.getComputedStyle(siteSettingsEntry).display !== "none",
      );
      return {
        addressBarWidth: width,
        rootFontSizePx: rootFont,
        thresholdPx: 9 * rootFont,
        isCompactByModel: width > 0 && width < 9 * rootFont,
        siteSettingsEntryVisible: entryVisible,
      };
    });
    await shot("06d-browser-narrow-address-bar");
    await clickTestIdByWebDriver(TID_BROWSER_MORE_BUTTON, {
      timeout: 10_000,
      timeoutMsg: "没有找到浏览器 More 按钮",
    });
    await waitForTestIdByDom("browser-more-site-settings", { timeout: 10_000 });
    await browser.pause(300);
    await shot("06e-browser-more-site-settings");
    const more = await browser.execute(() => ({
      itemText: document
        .querySelector<HTMLElement>('[data-testid="browser-more-site-settings"]')
        ?.textContent?.replace(/\s+/gu, " ")
        .trim(),
      itemPresent: Boolean(
        document.querySelector('[data-testid="browser-more-site-settings"]'),
      ),
    }));
    await record("browserNarrowAddressBar", { metrics: narrow, compact, more });
    expect(Boolean((compact as { isCompactByModel: boolean }).isCompactByModel)).toBe(true);
    expect((more as { itemPresent: boolean }).itemPresent).toBe(true);
  });

  it("FILE-01 文件树单击 HTML：开关关=源码预览；开=内置浏览器；右键仍可源码预览", async function () {
    this.timeout(300_000);
    const htmlPath = join(DEFAULT_WORKSPACE, "index.html");
    await writeFile(
      htmlPath,
      [
        "<!doctype html>",
        '<html><head><meta charset="utf-8"><title>NIBI quick-win evidence</title></head>',
        "<body><h1>FILE_TREE_HTML_CLICK_EVIDENCE</h1>",
        "<p>Single click should open source preview when the setting is off.</p>",
        "</body></html>",
        "",
      ].join("\n"),
      "utf-8",
    );

    // 回到 1440×900 并把窄侧面板拖回常规宽度；不刷新 renderer，避免浏览器 guest 回载抖动。
    await setWindowSize(1440, 900);
    await ensureSidePaneOpen();
    await dragSidePaneDividerTo(910);
    await closeAllBrowserTabs();
    await ensureSidebarVisible();

    // 关闭设置开关（默认 false；先确保为 false）。
    await openSettings();
    await clickSettingsSection("general");
    await typeSettingsSearch("");
    const row = await readSwitchInTargetRow("general.fileTreeHtmlClick");
    if (row.checked === true) {
      await setSwitchInTargetRow("general.fileTreeHtmlClick", false);
      await browser.waitUntil(
        async () => (await readSwitchInTargetRow("general.fileTreeHtmlClick")).checked === false,
        { timeout: 10_000, timeoutMsg: "HTML 单击开关没有关闭" },
      );
    }
    await closeSettings();

    await setWindowSize(1440, 900);
    await openFileTree();
    await refreshFileTree();
    await clickFileTreeRow(htmlPath);
    await $(sel(TID_PREVIEW_PANE)).waitForDisplayed({ timeout: 20_000 });
    // 代码预览由虚拟化/画布内核渲染，不能用 textContent 判定；以预览面板尺寸、
    // 当前激活的 file-manager tab、且没有 browser tab 作为“走源码预览”的判据。
    await browser.waitUntil(
      async () => {
        const state = await browser.execute((paneId) => {
          const pane = document.querySelector<HTMLElement>(`[data-testid="${paneId}"]`);
          const rect = pane?.getBoundingClientRect();
          const tabs = Array.from(
            document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"),
          ).map((item) => item.dataset.sidePaneTabId ?? "");
          const activeTabs = Array.from(
            document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id][data-active]"),
          ).map((item) => item.dataset.sidePaneTabId ?? "");
          return {
            previewWidth: rect?.width ?? 0,
            previewHeight: rect?.height ?? 0,
            hasFileManagerTab: tabs.some((id) => id.startsWith("file-manager:")),
            hasBrowserTab: tabs.some((id) => id.startsWith("browser:")),
            activeTabs,
          };
        }, TID_PREVIEW_PANE);
        return (
          state.previewWidth > 100 &&
          state.previewHeight > 100 &&
          state.hasFileManagerTab &&
          !state.hasBrowserTab
        );
      },
      { timeout: 20_000, interval: 250, timeoutMsg: "开关关闭时单击 HTML 没有打开源码预览" },
    );
    await browser.pause(400);
    await shot("07a-file-tree-html-click-source-preview");
    const previewState = await browser.execute(() => {
      const pane = document.querySelector<HTMLElement>('[data-testid="preview-pane"]');
      const rect = pane?.getBoundingClientRect();
      return {
        previewVisible: Boolean(pane),
        previewWidth: rect?.width ?? 0,
        previewHeight: rect?.height ?? 0,
        activeTabs: Array.from(
          document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id][data-active]"),
        ).map((item) => item.dataset.sidePaneTabId ?? ""),
        hasFileManagerTab: Boolean(
          document.querySelector('[data-side-pane-tab-id^="file-manager:"]'),
        ),
        browserTabCount: document.querySelectorAll('[data-side-pane-tab-id^="browser:"]').length,
        headerText: document.body.innerText.includes("index.html"),
      };
    });

    // 右键菜单：仍保留源码预览入口与“用内置浏览器打开”。
    const rowTestId = testId(TID_WORKSPACE_FILE_TREE_ROW, htmlPath);
    await browser.execute((currentRowTestId) => {
      const target = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (element) => element.dataset.testid === currentRowTestId,
      );
      if (!target) return;
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: Math.round(rect.left + Math.min(80, rect.width / 2)),
          clientY: Math.round(rect.top + rect.height / 2),
        }),
      );
    }, rowTestId);
    await browser.waitUntil(
      async () =>
        browser.execute(() =>
          Boolean(
            document.querySelector('[role="menu"]') ||
              Array.from(document.querySelectorAll<HTMLElement>("[role=menuitem]")).some((item) =>
                (item.textContent ?? "").includes("用内置浏览器打开"),
              ),
          ),
        ),
      { timeout: 10_000, interval: 200, timeoutMsg: "右键菜单没有出现" },
    );
    await browser.pause(300);
    await shot("07b-file-tree-html-context-menu");
    const contextMenu = await browser.execute(() => ({
      items: Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).map(
        (item) => (item.textContent ?? "").replace(/\s+/gu, " ").trim(),
      ),
      hasOpen: Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).some(
        (item) => (item.textContent ?? "").trim() === "打开",
      ),
      hasOpenInBrowser: Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).some((item) => (item.textContent ?? "").includes("用内置浏览器打开")),
    }));
    // 关闭右键菜单。
    await browser.execute(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await browser.pause(300);

    // 打开设置开关，再单击同一个 HTML。
    await openSettings();
    await clickSettingsSection("general");
    await typeSettingsSearch("");
    await setSwitchInTargetRow("general.fileTreeHtmlClick", true);
    await browser.waitUntil(
      async () => (await readSwitchInTargetRow("general.fileTreeHtmlClick")).checked === true,
      { timeout: 10_000, timeoutMsg: "HTML 单击开关没有打开" },
    );
    const persisted = await readSettings();
    await closeSettings();

    await openFileTree();
    await refreshFileTree();
    await clickFileTreeRow(htmlPath);
    await browser.waitUntil(
      async () => {
        const url = await browser.execute(
          (addressId) =>
            document.querySelector<HTMLInputElement>(`[data-testid="${addressId}"]`)?.value ?? "",
          TID_BROWSER_ADDRESS_INPUT,
        );
        return url.includes("index.html");
      },
      { timeout: 30_000, interval: 500, timeoutMsg: "开关打开后单击 HTML 没有进入内置浏览器" },
    );
    await browser.execute(() => {
      document
        .querySelector<HTMLElement>('[data-side-pane-tab-id^="browser:"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    });
    await browser.pause(800);
    await shot("07c-file-tree-html-click-opens-browser");
    const browserState = await browser.execute((addressId) => ({
      addressValue:
        document.querySelector<HTMLInputElement>(`[data-testid="${addressId}"]`)?.value ?? "",
      browserTabCount: document.querySelectorAll('[data-side-pane-tab-id^="browser:"]').length,
      previewVisible: Boolean(document.querySelector('[data-testid="preview-pane"]')),
    }), TID_BROWSER_ADDRESS_INPUT);
    await record("fileTreeHtmlClick", {
      previewState,
      contextMenu,
      settingPersisted: persisted.fileTreeHtmlClickOpensBrowser === true,
      browserState,
    });
    expect(persisted.fileTreeHtmlClickOpensBrowser).toBe(true);
    expect((browserState as { addressValue: string }).addressValue).toContain("index.html");
  });
});