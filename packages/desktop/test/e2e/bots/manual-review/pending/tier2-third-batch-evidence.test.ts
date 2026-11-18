/**
 * Tier 2 第三批视觉证据（manual-review / pending）。
 *
 * 目的：只截图 + 测量，不改产品代码，不向外部服务发请求。
 * 覆盖：
 * 1. 设置 → 通用 → 界面语言：五种语言 + 系统默认，选 ja-JP 后界面变日语，再恢复 en-US。
 * 2. 设置 → 数据同步：真实入口/弹窗/最小化状态条；没有配置同步设备时只记录诚实的空态。
 * 3. 文件树单击本地 HTML → 内置浏览器 → 设计模式检查器；在 guest webContents 里真实点选
 *    h1，改文字并保存，然后读源文件确认写回。guest 点选无法驱动时记录限制，不伪造保存。
 *
 * 运行：
 *   NIBI_E2E_EVIDENCE_DIR=<evidence dir> E2E_PROVIDER_HTTP_MODE=replay \
 *   E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
 *   pnpm --filter @nibi/desktop exec wdio run wdio.conf.ts \
 *     --spec test/e2e/bots/manual-review/pending/tier2-third-batch-evidence.test.ts
 */
/* eslint-disable max-lines -- 单文件承载三块互不相关证据的定位与事实记录，拆开会让 pending 证据入口漂移。 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_DESIGN_BUTTON,
  TID_BROWSER_DESIGN_ELEMENT,
  TID_BROWSER_DESIGN_INSPECTOR,
  TID_BROWSER_DESIGN_INSPECTOR_CLOSE,
  TID_BROWSER_DESIGN_SAVE_STATUS,
  TID_BROWSER_DESIGN_SOURCE_STATUS,
  TID_BROWSER_DESIGN_STYLE_PROPERTY,
  TID_BROWSER_DESIGN_TEXT_INPUT,
  TID_BROWSER_DESIGN_VARIABLE_SELECT,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_LOCALE_SELECT_ITEM,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
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
import { readBrowserTabIds } from "../../../helpers/browser-side-pane.js";
import { openProjectFileTree } from "../../../helpers/project-sidebar.js";
import { prepareV4ConversationE2E } from "../../../helpers/v4-conversation.js";

const EVIDENCE_DIR =
  process.env.NIBI_E2E_EVIDENCE_DIR?.trim() ||
  join(process.cwd(), ".e2e-artifacts", "tier2-third-batch");
const FACTS_FILE = "wdio-facts.json";
const SUPPORTED_LOCALE_PREFERENCES = [
  "system",
  "zh-CN",
  "en-US",
  "ja-JP",
  "ru-RU",
  "ko-KR",
] as const;
const DESIGN_HTML_PATH = join(DEFAULT_WORKSPACE, "design-evidence.html");
const DESIGN_TEXT_BEFORE = "NIBI_DESIGN_BEFORE_E2E";
const DESIGN_TEXT_AFTER = "NIBI_DESIGN_AFTER_E2E";
const SELECTORS = {
  settingsPage: `[data-testid="${TID_SETTINGS_PAGE}"]`,
  settingsBack: `[data-testid="${TID_SETTINGS_BACK_BUTTON}"]`,
  settingsSearchInput: '[data-testid="settings-search-input"]',
  localeTrigger: `[data-testid="${TID_SETTINGS_LOCALE_SELECT_TRIGGER}"]`,
  localeItem: (preference: string) =>
    `[data-testid="${testId(TID_SETTINGS_LOCALE_SELECT_ITEM, preference)}"]`,
  dataSyncEntryOpen: '[data-testid="settings-data-sync-entry-open"]',
  dataSyncEmpty: '[data-testid="settings-data-sync-empty"]',
  dataSyncDialog: '[data-testid="data-sync-dialog"]',
  dataSyncMinimize: '[data-testid="data-sync-minimize"]',
  dataSyncMinimizedProgress: '[data-testid="data-sync-minimized-progress"]',
  dataSyncDialogClose: '[data-testid="data-sync-dialog"] [data-slot="dialog-close"]',
  browserAddress: `[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`,
  browserTab: '[data-side-pane-tab-id^="browser:"]',
  designButton: `[data-testid="${TID_BROWSER_DESIGN_BUTTON}"]`,
  designInspector: `[data-testid="${TID_BROWSER_DESIGN_INSPECTOR}"]`,
  designElement: `[data-testid="${TID_BROWSER_DESIGN_ELEMENT}"]`,
  designTextInput: `[data-testid="${TID_BROWSER_DESIGN_TEXT_INPUT}"]`,
  designSaveStatus: `[data-testid="${TID_BROWSER_DESIGN_SAVE_STATUS}"]`,
  designSourceStatus: `[data-testid="${TID_BROWSER_DESIGN_SOURCE_STATUS}"]`,
  designStyleProperty: `[data-testid="${TID_BROWSER_DESIGN_STYLE_PROPERTY}"]`,
  designVariableSelect: `[data-testid="${TID_BROWSER_DESIGN_VARIABLE_SELECT}"]`,
  designInspectorClose: `[data-testid="${TID_BROWSER_DESIGN_INSPECTOR_CLOSE}"]`,
  fileTreePanel: `[data-testid="${TID_WORKSPACE_FILE_TREE_PANEL}"]`,
  fileTreeRefresh: `[data-testid="${TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON}"]`,
  sidebar: '[data-testid="sidebar"]',
} as const;

const facts: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  host: {
    platform: process.platform,
    release: process.env.OS ?? "",
    cwd: process.cwd(),
  },
  selectors: SELECTORS,
  screenshots: [] as string[],
};

function record(key: string, value: unknown): void {
  facts[key] = value;
}

async function shot(name: string): Promise<string> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await browser.saveScreenshot(path);
  (facts.screenshots as string[]).push(path);
  return path;
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
}> {
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
          ? {
              size: win.getSize() as [number, number],
              content: win.getContentSize() as [number, number],
            }
          : null;
      })) as { size: [number, number]; content: [number, number] } | null;
      const viewport = (await browser.execute(() => [innerWidth, innerHeight])) as [
        number,
        number,
      ];
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
  return { size: geometry!.size, content: geometry!.content, viewport };
}

async function isTestIdPresent(testIdValue: string): Promise<boolean> {
  return Boolean(
    await browser.execute(
      (value) =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).some(
          (element) => element.dataset.testid === value,
        ),
      testIdValue,
    ),
  );
}

async function openSettings(): Promise<void> {
  if (await isTestIdPresent(TID_SETTINGS_PAGE)) return;
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON, {
    timeout: 30_000,
    timeoutMsg: "没有找到设置入口按钮",
  });
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 30_000 });
}

async function clickSettingsSection(sectionId: string): Promise<void> {
  await openSettings();
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, sectionId), {
    timeout: 15_000,
    timeoutMsg: `设置页没有 ${sectionId} 分区入口`,
  });
}

async function closeSettingsIfOpen(): Promise<void> {
  if (!(await isTestIdPresent(TID_SETTINGS_PAGE))) return;
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON, { timeout: 10_000 });
  await browser.waitUntil(
    async () => !(await isTestIdPresent(TID_SETTINGS_PAGE)),
    { timeout: 10_000, interval: 100, timeoutMsg: "设置页没有关闭" },
  );
}

async function typeSettingsSearch(query: string): Promise<void> {
  await setInputValueByTestIdDom("settings-search-input", query, {
    timeout: 15_000,
    timeoutMsg: "设置搜索输入框没有出现",
  });
  await browser.waitUntil(
    async () =>
      browser.execute(
        (expected, selector) =>
          document.querySelector<HTMLInputElement>(selector)?.value === expected,
        query,
        SELECTORS.settingsSearchInput,
      ),
    { timeout: 5_000, interval: 100, timeoutMsg: `设置搜索没有接受查询：${query}` },
  );
}

async function readSwitchInTargetRow(targetId: string): Promise<{
  found: boolean;
  checked: boolean | null;
}> {
  return browser.execute((currentTargetId) => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>("[data-settings-search-target]"),
    ).find((item) => item.getAttribute("data-settings-search-target") === currentTargetId);
    const button = row?.querySelector<HTMLButtonElement>('button[role="switch"]');
    return {
      found: Boolean(row),
      checked: button ? button.getAttribute("aria-checked") === "true" : null,
    };
  }, targetId);
}

async function setSwitchInTargetRow(targetId: string, checked: boolean): Promise<boolean> {
  return browser.execute(
    (currentTargetId, nextChecked) => {
      const row = Array.from(
        document.querySelectorAll<HTMLElement>("[data-settings-search-target]"),
      ).find((item) => item.getAttribute("data-settings-search-target") === currentTargetId);
      const button = row?.querySelector<HTMLButtonElement>('button[role="switch"]');
      if (!button) return false;
      if ((button.getAttribute("aria-checked") === "true") !== nextChecked) button.click();
      return true;
    },
    targetId,
    checked,
  );
}

async function ensureSidebarVisible(): Promise<void> {
  const isVisible = async () =>
    Boolean(
      await browser.execute((selector) => {
        const sidebar = document.querySelector<HTMLElement>(selector);
        return Boolean(sidebar && sidebar.getBoundingClientRect().width > 100);
      }, SELECTORS.sidebar),
    );
  if (await isVisible()) return;
  await clickTestIdByDom("desktop-top-logo-sidebar-toggle", {
    timeout: 10_000,
    timeoutMsg: "没有找到侧栏展开按钮",
  });
  await browser.waitUntil(isVisible, { timeout: 10_000, timeoutMsg: "侧栏没有展开" });
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
      await openProjectFileTree(DEFAULT_WORKSPACE, { timeout: 20_000 });
    }
  }
  await waitForTestIdByDom(TID_WORKSPACE_FILE_TREE_PANEL, { timeout: 15_000 });
}

async function refreshFileTree(): Promise<void> {
  await clickTestIdByDom(TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON, {
    timeout: 10_000,
    timeoutMsg: "文件树没有刷新按钮",
  });
}

async function readBrowserAddress(): Promise<string> {
  return browser.execute(
    (selector) => document.querySelector<HTMLInputElement>(selector)?.value ?? "",
    SELECTORS.browserAddress,
  );
}

async function waitForBrowserAddressContaining(fragment: string): Promise<string> {
  let address = "";
  await browser.waitUntil(
    async () => {
      address = await readBrowserAddress();
      return address.includes(fragment);
    },
    {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: `内置浏览器地址没有包含 ${fragment}`,
    },
  );
  return address;
}

async function activateBrowserTab(): Promise<void> {
  await browser.execute((selector) => {
    document
      .querySelector<HTMLElement>(selector)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  }, SELECTORS.browserTab);
  await browser.waitUntil(
    async () =>
      browser.execute((selector) => {
        const tab = document.querySelector<HTMLElement>(selector);
        return Boolean(tab?.hasAttribute("data-active"));
      }, SELECTORS.browserTab),
    { timeout: 15_000, interval: 200, timeoutMsg: "浏览器 tab 没有激活" },
  );
}

function readUiSnapshot(): Promise<{
  lang: string;
  bodyText: string;
  sectionNav: Array<{ id: string; text: string }>;
  localeTriggerText: string | null;
}> {
  return browser.execute(
    (triggerSelector) => ({
      lang: document.documentElement.lang,
      bodyText: (document.body.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 1500),
      sectionNav: Array.from(
        document.querySelectorAll<HTMLElement>("[data-settings-section-nav]"),
      ).map((element) => ({
        id: element.getAttribute("data-settings-section-nav") ?? "",
        text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
      })),
      localeTriggerText:
        document.querySelector<HTMLElement>(triggerSelector)?.textContent?.replace(/\s+/gu, " ").trim() ??
        null,
    }),
    SELECTORS.localeTrigger,
  );
}

async function readLocaleOptions(): Promise<
  Array<{ preference: string; text: string; lang: string | null; state: string | null }>
> {
  return browser.execute((prefix) =>
    Array.from(document.querySelectorAll<HTMLElement>(`[data-testid^="${prefix}"]`)).map(
      (element) => ({
        preference: (element.dataset.testid ?? "").slice(prefix.length),
        text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
        lang: element.getAttribute("lang"),
        state: element.getAttribute("data-state"),
      }),
    ),
  `${TID_SETTINGS_LOCALE_SELECT_ITEM}-`);
}

async function openLocalePicker(): Promise<void> {
  await clickTestIdByWebDriver(TID_SETTINGS_LOCALE_SELECT_TRIGGER, {
    timeout: 15_000,
    timeoutMsg: "界面语言下拉触发器没有出现",
  });
  await waitForTestIdByDom(testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "system"), {
    timeout: 10_000,
  });
}

async function selectLocalePreference(preference: (typeof SUPPORTED_LOCALE_PREFERENCES)[number]) {
  // 菜单可能因上一次失败仍开着：先直接点目标项，不存在再打开触发器。
  if (!(await isTestIdPresent(testId(TID_SETTINGS_LOCALE_SELECT_ITEM, preference)))) {
    await openLocalePicker();
  }
  await clickTestIdByDom(testId(TID_SETTINGS_LOCALE_SELECT_ITEM, preference), {
    timeout: 10_000,
    timeoutMsg: `界面语言下拉项没有出现: ${preference}`,
  });
}

async function waitForLocalePersisted(preference: string): Promise<Record<string, unknown>> {
  let snapshot: Record<string, unknown> = {};
  await browser.waitUntil(
    async () => {
      snapshot = (await readSettings()) as Record<string, unknown>;
      return snapshot.uiLocalePreference === preference;
    },
    {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: `语言偏好 ${preference} 没有写入设置`,
    },
  );
  return snapshot;
}

async function restoreEnglishLocaleBestEffort(): Promise<void> {
  try {
    await openSettings();
    await clickSettingsSection("general");
    await selectLocalePreference("en-US");
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.lang)) === "en-US",
      { timeout: 15_000, interval: 200, timeoutMsg: "恢复 en-US 后界面语言没有切回" },
    );
    record("locale.restore", { preference: "en-US", restored: true });
  } catch (error) {
    record("locale.restore", {
      preference: "en-US",
      restored: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function readDataSyncSectionState(): Promise<{
  entryPresent: boolean;
  entryOpenPresent: boolean;
  entryText: string | null;
  emptyPresent: boolean;
  emptyText: string | null;
  sectionText: string;
}> {
  return browser.execute((selectors) => {
    const read = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      return element ? (element.textContent ?? "").replace(/\s+/gu, " ").trim() : null;
    };
    return {
      entryPresent: Boolean(document.querySelector(selectors.entry)),
      entryOpenPresent: Boolean(document.querySelector(selectors.open)),
      entryText: read(selectors.entry),
      emptyPresent: Boolean(document.querySelector(selectors.empty)),
      emptyText: read(selectors.empty),
      sectionText: (document.body.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 1500),
    };
  }, {
    entry: '[data-testid="settings-data-sync-entry"]',
    open: SELECTORS.dataSyncEntryOpen,
    empty: SELECTORS.dataSyncEmpty,
  });
}

function readDataSyncDialogState(): Promise<{
  present: boolean;
  title: string | null;
  text: string;
  tabs: string[];
  deviceText: string | null;
}> {
  return browser.execute((selector) => {
    const root = document.querySelector<HTMLElement>(selector);
    return {
      present: Boolean(root),
      title:
        root?.querySelector<HTMLElement>('[data-slot="dialog-title"]')?.textContent?.trim() ??
        null,
      text: (root?.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 1800),
      tabs: Array.from(
        root?.querySelectorAll<HTMLElement>('[data-testid^="settings-data-sync-category-tab-"]') ??
          [],
      ).map((element) => (element.textContent ?? "").replace(/\s+/gu, " ").trim()),
      deviceText:
        root?.querySelector<HTMLElement>('[data-testid="settings-data-sync-device-select"]')
          ?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
    };
  }, SELECTORS.dataSyncDialog);
}

function readMinimizedProgressState(): Promise<{
  present: boolean;
  text: string | null;
  statusText: string | null;
  ariaLabel: string | null;
  rect: { width: number; height: number } | null;
}> {
  return browser.execute((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    const rect = element?.getBoundingClientRect();
    return {
      present: Boolean(element),
      text: element ? (element.textContent ?? "").replace(/\s+/gu, " ").trim() : null,
      statusText:
        element?.querySelector<HTMLElement>('[role="status"]')?.textContent?.trim() ?? null,
      ariaLabel: element?.getAttribute("aria-label") ?? null,
      rect: rect ? { width: rect.width, height: rect.height } : null,
    };
  }, SELECTORS.dataSyncMinimizedProgress);
}

function readDesignButtonState(): Promise<{
  present: boolean;
  disabled: boolean | null;
  pressed: string | null;
  label: string | null;
}> {
  return browser.execute((selector) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    return {
      present: Boolean(button),
      disabled: button?.disabled ?? null,
      pressed: button?.getAttribute("aria-pressed") ?? null,
      label: button?.getAttribute("aria-label") ?? null,
    };
  }, SELECTORS.designButton);
}

function readDesignInspectorState(): Promise<{
  present: boolean;
  selectedCount: number;
  elementText: string | null;
  inspectorText: string;
  sourceStatus: string | null;
  saveState: string | null;
  saveText: string | null;
  textInput: { present: boolean; value: string | null; disabled: boolean | null } | null;
  styleProperty: string | null;
  variables: string[];
}> {
  return browser.execute((selectors) => {
    const root = document.querySelector<HTMLElement>(selectors.inspector);
    const input = root?.querySelector<HTMLInputElement>(selectors.textInput);
    const save = root?.querySelector<HTMLElement>(selectors.saveStatus);
    return {
      present: Boolean(root),
      selectedCount: Number(root?.getAttribute("data-selected-count") ?? 0),
      elementText:
        root?.querySelector<HTMLElement>(selectors.element)?.textContent?.trim() ?? null,
      inspectorText: (root?.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 1500),
      sourceStatus:
        root?.querySelector<HTMLElement>(selectors.sourceStatus)?.textContent?.trim() ?? null,
      saveState: save?.getAttribute("data-state") ?? null,
      saveText: save?.textContent?.trim() ?? null,
      textInput: input
        ? { present: true, value: input.value, disabled: input.disabled }
        : null,
      styleProperty:
        root?.querySelector<HTMLSelectElement>(selectors.styleProperty)?.value ?? null,
      variables: Array.from(
        root?.querySelectorAll<HTMLSelectElement>(selectors.variableSelect + " option") ?? [],
      ).map((option) => (option.textContent ?? "").trim()),
    };
  }, {
    inspector: SELECTORS.designInspector,
    element: SELECTORS.designElement,
    textInput: SELECTORS.designTextInput,
    sourceStatus: SELECTORS.designSourceStatus,
    saveStatus: SELECTORS.designSaveStatus,
    styleProperty: SELECTORS.designStyleProperty,
    variableSelect: SELECTORS.designVariableSelect,
  });
}

interface GuestDesignState {
  found: boolean;
  guestId: number | null;
  url: string;
  runtimeInstalled: boolean;
  headingText: string | null;
  selectionSupported: boolean;
}

async function readGuestDesignState(): Promise<GuestDesignState> {
  return (await browser.electron.execute(async (electron, needle) => {
    const guest = electron.webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().includes(needle));
    if (!guest) {
      return {
        found: false,
        guestId: null,
        url: "",
        runtimeInstalled: false,
        headingText: null,
        selectionSupported: false,
      };
    }
    const state = (await guest.executeJavaScript(
      "({ runtime: Boolean(window.__nibiDesignRuntime), heading: document.querySelector('h1')?.textContent ?? null })",
    )) as { runtime: boolean; heading: string | null };
    return {
      found: true,
      guestId: guest.id,
      url: guest.getURL(),
      runtimeInstalled: state.runtime,
      headingText: state.heading,
      selectionSupported: typeof guest.executeJavaScript === "function",
    };
  }, "design-evidence.html")) as GuestDesignState;
}

async function clickGuestDesignSelection(selector: string): Promise<string> {
  return (await browser.electron.execute(async (electron, needle, targetSelector) => {
    const guest = electron.webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().includes(needle));
    if (!guest) return "guest-missing";
    const result = (await guest.executeJavaScript(
      `(() => {
        const element = document.querySelector(${JSON.stringify(targetSelector)});
        if (!element) return "element-missing";
        element.click();
        return "clicked";
      })()`,
    )) as string;
    return result;
  }, "design-evidence.html", selector)) as string;
}

async function readDesignFontSize(selector: string): Promise<string | null> {
  return (await browser.electron.execute(async (electron, needle, targetSelector) => {
    const guest = electron.webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().includes(needle));
    if (!guest) return null;
    return (await guest.executeJavaScript(
      `(() => {
        const element = document.querySelector(${JSON.stringify(targetSelector)});
        return element ? getComputedStyle(element).fontSize : null;
      })()`,
    )) as string | null;
  }, "design-evidence.html", selector)) as string | null;
}

describe("Tier 2 第三批视觉证据（真实 Desktop）", () => {
  before(async function () {
    this.timeout(180_000);
    await prepareV4ConversationE2E({ skipProvider: true });
    const geometry = await setWindowSize(1440, 900);
    record("window", geometry);
    await mkdir(EVIDENCE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await writeFacts();
  });

  after(async () => {
    await writeFacts();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("LOCALE-01 界面语言：六个选项、ja-JP 日语界面、恢复 en-US", async function () {
    this.timeout(240_000);
    await setWindowSize(1440, 900);
    await openSettings();
    await clickSettingsSection("general");
    await typeSettingsSearch("");

    const settingsBefore = (await readSettings()) as Record<string, unknown>;
    const originalPreference =
      (settingsBefore.uiLocalePreference as string | undefined) ??
      (settingsBefore.localePreference as string | undefined) ??
      "system";
    record("locale.before", {
      preferred: originalPreference,
      uiLocale: settingsBefore.uiLocale ?? null,
      uiLocalePreference: settingsBefore.uiLocalePreference ?? null,
      locale: settingsBefore.locale ?? null,
      localePreference: settingsBefore.localePreference ?? null,
      ui: await readUiSnapshot(),
    });

    try {
      await openLocalePicker();
      const options = await readLocaleOptions();
      await shot("01a-language-picker-options");
      record("locale.options", { optionCount: options.length, options });
      const preferences = options.map((option) => option.preference).sort();
      expect(preferences).toEqual([...SUPPORTED_LOCALE_PREFERENCES].sort());
      expect(options.find((option) => option.preference === "ja-JP")?.text).toBe("日本語");

      await clickTestIdByDom(testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "ja-JP"), {
        timeout: 10_000,
        timeoutMsg: "界面语言下拉项没有出现: ja-JP",
      });
      await browser.waitUntil(
        async () => (await browser.execute(() => document.documentElement.lang)) === "ja-JP",
        { timeout: 15_000, interval: 200, timeoutMsg: "选择 ja-JP 后 document.lang 没有变化" },
      );
      await browser.waitUntil(
        async () => {
          const snapshot = await readUiSnapshot();
          return (
            snapshot.bodyText.includes("言語") &&
            snapshot.bodyText.includes("アプリケーション UI の表示言語を選択します。") &&
            snapshot.sectionNav.some((item) => item.id === "general" && item.text === "一般")
          );
        },
        { timeout: 15_000, interval: 200, timeoutMsg: "选择 ja-JP 后设置页没有显示日语" },
      );
      const japanese = await readUiSnapshot();
      const persistedJapanese = await waitForLocalePersisted("ja-JP");
      await shot("01b-settings-japanese");
      record("locale.japanese", {
        ui: japanese,
        persisted: {
          uiLocale: persistedJapanese.uiLocale ?? null,
          uiLocalePreference: persistedJapanese.uiLocalePreference ?? null,
          locale: persistedJapanese.locale ?? null,
          localePreference: persistedJapanese.localePreference ?? null,
        },
      });
      expect(japanese.lang).toBe("ja-JP");
      expect(japanese.localeTriggerText).toBe("日本語");
      expect(japanese.sectionNav.some((item) => item.text === "一般")).toBe(true);
      expect(persistedJapanese.uiLocale).toBe("ja-JP");
    } finally {
      await restoreEnglishLocaleBestEffort();
    }

    const restored = await readUiSnapshot();
    await clickSettingsSection("general");
    await shot("01c-settings-restored-en-us");
    record("locale.restored", {
      ui: restored,
      persisted: (await readSettings()) as Record<string, unknown>,
    });
    expect(restored.lang).toBe("en-US");
  });

  it("SYNC-01 数据同步：入口、弹窗、最小化状态条与恢复；无设备时记录空态", async function () {
    this.timeout(180_000);
    await setWindowSize(1440, 900);
    await openSettings();
    await clickSettingsSection("dataSync");
    await browser.waitUntil(
      async () =>
        Boolean(
          await browser.execute((selectors) => {
            return Boolean(
              document.querySelector(selectors.open) ||
                document.querySelector(selectors.empty) ||
                document.querySelector(selectors.entry),
            );
          }, {
            open: SELECTORS.dataSyncEntryOpen,
            empty: SELECTORS.dataSyncEmpty,
            entry: '[data-testid="settings-data-sync-entry"]',
          }),
        ),
      { timeout: 20_000, interval: 250, timeoutMsg: "数据同步分区没有渲染入口或空态" },
    );
    const section = await readDataSyncSectionState();
    await shot("02a-data-sync-section");
    record("dataSync.section", section);

    if (!section.entryOpenPresent) {
      // 没有在线 Source 设备时产品只显示空态，不伪造一次同步。
      expect(section.emptyPresent).toBe(true);
      record("dataSync.result", {
        mode: "empty",
        reason: "no online source device configured",
        emptyText: section.emptyText,
      });
      return;
    }

    await clickTestIdByDom("settings-data-sync-entry-open", {
      timeout: 15_000,
      timeoutMsg: "数据同步入口按钮不可点击",
    });
    await waitForTestIdByDom("data-sync-dialog", { timeout: 20_000 });
    const dialog = await readDataSyncDialogState();
    await shot("02b-data-sync-dialog");
    record("dataSync.dialog", dialog);
    expect(dialog.present).toBe(true);
    expect(dialog.title?.length ?? 0).toBeGreaterThan(0);

    await clickTestIdByDom("data-sync-minimize", {
      timeout: 15_000,
      timeoutMsg: "数据同步弹窗没有最小化按钮",
    });
    await browser.waitUntil(
      async () =>
        Boolean(
          await browser.execute((selectors) => {
            const dialogElement = document.querySelector(selectors.dialog);
            const bar = document.querySelector(selectors.bar);
            return !dialogElement && Boolean(bar);
          }, {
            dialog: SELECTORS.dataSyncDialog,
            bar: SELECTORS.dataSyncMinimizedProgress,
          }),
        ),
      { timeout: 15_000, interval: 200, timeoutMsg: "最小化后没有出现状态条" },
    );
    const minimized = await readMinimizedProgressState();
    await shot("02c-data-sync-minimized");
    record("dataSync.minimized", minimized);
    expect(minimized.present).toBe(true);
    expect(minimized.statusText?.length ?? 0).toBeGreaterThan(0);
    expect(minimized.rect?.width ?? 0).toBeGreaterThan(100);

    await clickTestIdByDom("data-sync-minimized-progress", {
      timeout: 15_000,
      timeoutMsg: "最小化状态条不可点击",
    });
    await waitForTestIdByDom("data-sync-dialog", { timeout: 15_000 });
    const restored = await readDataSyncDialogState();
    await shot("02d-data-sync-restored");
    record("dataSync.restored", restored);
    expect(restored.present).toBe(true);

    const closeClicked = await browser.execute((selector) => {
      const close = document.querySelector<HTMLElement>(selector);
      if (!close) return false;
      close.click();
      return true;
    }, SELECTORS.dataSyncDialogClose);
    if (closeClicked) {
      await browser.waitUntil(
        async () => !(await isTestIdPresent("data-sync-dialog")),
        { timeout: 15_000, interval: 200, timeoutMsg: "数据同步弹窗没有关闭" },
      );
    }
    record("dataSync.result", {
      mode: "dialog",
      closed: closeClicked,
      minimizedStatus: minimized.statusText,
    });
    await closeSettingsIfOpen();
  });

  it("DESIGN-01 设计模式：本地 HTML、检查器、guest 点选、改文字并写回源文件", async function () {
    this.timeout(300_000);
    const html = [
      "<!doctype html>",
      '<html lang="en">',
      "<head>",
      '<meta charset="utf-8">',
      "<title>NIBI design mode evidence</title>",
      "<style>:root { --brand: #112233; } h1 { color: #112233; font-size: 32px; }</style>",
      "</head>",
      "<body>",
      `<h1 id="hero">${DESIGN_TEXT_BEFORE}</h1>`,
      "<p>Design mode evidence paragraph.</p>",
      "</body>",
      "</html>",
      "",
    ].join("\n");
    await mkdir(DEFAULT_WORKSPACE, { recursive: true });
    await writeFile(DESIGN_HTML_PATH, html, "utf-8");
    record("designMode.sourceFile", { path: DESIGN_HTML_PATH, before: DESIGN_TEXT_BEFORE });

    await closeSettingsIfOpen();
    await setWindowSize(1440, 900);
    await ensureSidebarVisible();
    await ensureSidePaneOpen();

    // 打开“文件树单击 HTML 用浏览器打开”，让单击走真实的内置浏览器入口。
    await openSettings();
    await clickSettingsSection("general");
    await typeSettingsSearch("");
    const toggle = await readSwitchInTargetRow("general.fileTreeHtmlClick");
    if (toggle.checked !== true) {
      await setSwitchInTargetRow("general.fileTreeHtmlClick", true);
      await browser.waitUntil(
        async () =>
          (await readSwitchInTargetRow("general.fileTreeHtmlClick")).checked === true,
        { timeout: 10_000, interval: 200, timeoutMsg: "HTML 单击开关没有打开" },
      );
    }
    const persisted = (await readSettings()) as Record<string, unknown>;
    if (persisted.fileTreeHtmlClickOpensBrowser !== true) {
      await browser.waitUntil(
        async () =>
          ((await readSettings()) as Record<string, unknown>).fileTreeHtmlClickOpensBrowser ===
          true,
        { timeout: 15_000, interval: 250, timeoutMsg: "HTML 单击开关没有持久化" },
      );
    }
    record("designMode.setting", {
      checked: (await readSwitchInTargetRow("general.fileTreeHtmlClick")).checked,
      fileTreeHtmlClickOpensBrowser:
        ((await readSettings()) as Record<string, unknown>).fileTreeHtmlClickOpensBrowser === true,
    });
    expect(
      ((await readSettings()) as Record<string, unknown>).fileTreeHtmlClickOpensBrowser,
    ).toBe(true);
    await closeSettingsIfOpen();

    await openFileTree();
    await refreshFileTree();
    await clickFileTreeRow(DESIGN_HTML_PATH);
    const address = await waitForBrowserAddressContaining("design-evidence.html");
    await activateBrowserTab();
    await browser.waitUntil(
      async () => {
        const state = await readDesignButtonState();
        return state.present && state.disabled === false;
      },
      { timeout: 30_000, interval: 250, timeoutMsg: "浏览器就绪后设计模式按钮仍不可用" },
    );
    await shot("03a-design-file-opened-in-browser");
    const buttonBefore = await readDesignButtonState();
    record("designMode.browser", {
      address,
      tabs: await readBrowserTabIds(),
      designButtonBefore: buttonBefore,
    });

    await clickTestIdByDom(TID_BROWSER_DESIGN_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "设计模式按钮不可点击",
    });
    await waitForTestIdByDom(TID_BROWSER_DESIGN_INSPECTOR, { timeout: 20_000 });
    let guestState = await readGuestDesignState();
    await browser.waitUntil(
      async () => {
        guestState = await readGuestDesignState();
        return guestState.found && guestState.runtimeInstalled;
      },
      { timeout: 30_000, interval: 250, timeoutMsg: "设计运行时没有注入 guest 页面" },
    );
    const inspectorIdle = await readDesignInspectorState();
    record("designMode.inspector", {
      button: await readDesignButtonState(),
      guest: guestState,
      idle: inspectorIdle,
    });
    await shot("03b-design-inspector-open");

    const clickResult = await clickGuestDesignSelection("h1#hero");
    let selection = await readDesignInspectorState();
    let selected = selection.selectedCount === 1;
    if (!selected) {
      try {
        await browser.waitUntil(
          async () => {
            selection = await readDesignInspectorState();
            return selection.selectedCount === 1;
          },
          { timeout: 15_000, interval: 250, timeoutMsg: "guest 点选没有进入检查器" },
        );
        selected = true;
      } catch {
        selected = false;
      }
    }
    guestState = await readGuestDesignState();
    record("designMode.selection", {
      clickResult,
      driven: selected,
      inspector: selection,
      guest: guestState,
    });

    if (!selected) {
      // guest 点选无法可靠驱动时只记录限制，不伪造一次保存。
      record("designMode.result", {
        mode: "selection-not-driven",
        clickResult,
        limitation:
          "guest webContents executeJavaScript click did not reach the design inspector; toggle + inspector captured only",
      });
      await shot("03c-design-inspector-selection-unavailable");
      await browser.execute((selector) => {
        document.querySelector<HTMLElement>(selector)?.click();
      }, SELECTORS.designInspectorClose);
      return;
    }

    await browser.waitUntil(
      async () => {
        const state = await readDesignInspectorState();
        return Boolean(state.textInput?.present && state.textInput.disabled === false);
      },
      { timeout: 20_000, interval: 250, timeoutMsg: "检查器文字输入框没有进入可编辑状态" },
    );
    await shot("03d-design-element-selected");
    const selectionSnapshot = await readDesignInspectorState();
    const beforeFontSize = await readDesignFontSize("h1#hero");
    record("designMode.selection.selected", {
      inspector: selectionSnapshot,
      guestHeading: guestState.headingText,
      fontBefore: beforeFontSize,
    });
    expect(selectionSnapshot.elementText).toBe("h1");
    expect(selectionSnapshot.textInput?.value).toBe(DESIGN_TEXT_BEFORE);

    await setInputValueByTestIdDom(TID_BROWSER_DESIGN_TEXT_INPUT, DESIGN_TEXT_AFTER, {
      timeout: 10_000,
      timeoutMsg: "检查器文字输入框没有接受新文字",
    });
    await browser.keys(["Enter"]);
    await browser.waitUntil(
      async () => {
        const state = await readDesignInspectorState();
        return state.saveState === "saved" || state.saveState === "error";
      },
      { timeout: 30_000, interval: 250, timeoutMsg: "文字保存没有进入 saved/error 状态" },
    );
    const savedState = await readDesignInspectorState();
    const sourceAfter = await readFile(DESIGN_HTML_PATH, "utf-8");
    const guestAfter = await readGuestDesignState();
    await shot("03e-design-text-saved");
    record("designMode.save", {
      state: savedState,
      guestAfter,
      sourceContainsBefore: sourceAfter.includes(DESIGN_TEXT_BEFORE),
      sourceContainsAfter: sourceAfter.includes(DESIGN_TEXT_AFTER),
      sourceExcerpt: sourceAfter.split(/\r?\n/u).find((line) => line.includes("<h1")) ?? null,
    });
    record("designMode.sourceFile", {
      path: DESIGN_HTML_PATH,
      before: DESIGN_TEXT_BEFORE,
      after: DESIGN_TEXT_AFTER,
      sourceContainsAfter: sourceAfter.includes(DESIGN_TEXT_AFTER),
      sourceContainsBefore: sourceAfter.includes(DESIGN_TEXT_BEFORE),
    });
    expect(savedState.saveState).toBe("saved");
    expect(sourceAfter).toContain(DESIGN_TEXT_AFTER);
    expect(sourceAfter).not.toContain(DESIGN_TEXT_BEFORE);
    expect(guestAfter.headingText).toBe(DESIGN_TEXT_AFTER);
    record("designMode.result", {
      mode: "saved",
      savedText: DESIGN_TEXT_AFTER,
      sourceFile: DESIGN_HTML_PATH,
    });
  });
});