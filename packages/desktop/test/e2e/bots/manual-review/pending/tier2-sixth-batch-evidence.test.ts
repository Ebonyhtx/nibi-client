/**
 * Tier 2 第六批 UI 视觉证据（manual-review / pending）。
 *
 * 目的：真实 Electron Desktop + 隔离 HOME + replay 上游，逐项截图并记录 DOM 事实：
 * 1. U28 窄屏设置页：390x800 下读取设置页/导航的 compact-web 类与横向滚动事实；
 *    桌面 renderer 带 platform-windows-desktop，compact-web 按 spec 不生效，因此额外在
 *    同一 renderer 里临时移除平台类模拟手机 Web（明确标注模拟），再截两行导航。
 * 2. U27 图片预览操作条：真实 Markdown 图片 → 预览 → 操作条；点击“复制”并记录 toast。
 * 3. U30 跨会话来源：固定 sessionId 的 Seed 会话通过真实 SendToSession 投递到目标会话，
 *    截图“From session …”；再移除来源目录项，验证不可达时不可点。
 * 4. U06 受管 worktree：隔离 workspace 做 git init + commit，新任务页截图 Worktree 开关/
 *    分支选择；项目菜单打开 Worktrees 对话框。能力不满足时如实跳过。
 * 5. U08 设计工具栏：本地 HTML + 设计模式，截图工具栏（面板/方案/翻页）与检查器
 *    undo/redo/截图入口；guest 点选不可驱动时记录限制。
 * 6. U22 Runtime 退出横幅（尽力而为）：结束 app 进程树里的 Rust app-server，等待横幅；
 *    无法复现时记录限制并跑对应单测作为补充证据。
 *
 * 运行（必须在仓库根目录）：
 *   NIBI_E2E_HOME_DIR=<isolated home> \
 *   NIBI_E2E_EVIDENCE_DIR=<evidence dir> \
 *   E2E_PROVIDER_HTTP_MODE=replay \
 *   E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,\
 * packages/desktop/test/e2e/fixtures/upstream/tier2-sixth-batch.json \
 *   pnpm --filter @nibi/desktop exec wdio run wdio.conf.ts \
 *     --spec test/e2e/bots/manual-review/pending/tier2-sixth-batch-evidence.test.ts
 *
 * fixture 说明：新增 `test/e2e/fixtures/upstream/tier2-sixth-batch.json`（U27 图片回复与
 * U30 SendToSession 工具调用）；种子会话/PNG/Git 工作区由
 * `test/e2e/helpers/tier2-sixth-batch.ts` 在 Electron 退出后写入隔离 HOME。
 */
/* eslint-disable max-lines -- 单文件承载六块互不相关证据的定位、截图与事实记录，拆开会让 pending 证据入口漂移。 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  TID_BROWSER_ADDRESS_INPUT,
  TID_BROWSER_DESIGN_BUTTON,
  TID_BROWSER_DESIGN_CAPTURE_ELEMENT,
  TID_BROWSER_DESIGN_ELEMENT,
  TID_BROWSER_DESIGN_INSPECTOR,
  TID_BROWSER_DESIGN_INSPECTOR_CLOSE,
  TID_BROWSER_DESIGN_PANEL_BUTTON,
  TID_BROWSER_DESIGN_REDO,
  TID_BROWSER_DESIGN_SLIDE_COUNTER,
  TID_BROWSER_DESIGN_SLIDE_NEXT,
  TID_BROWSER_DESIGN_SLIDE_PREV,
  TID_BROWSER_DESIGN_TOOLBAR,
  TID_BROWSER_DESIGN_UNDO,
  TID_BROWSER_DESIGN_VARIANT_SELECT,
  TID_GIT_PANE,
  TID_GIT_TOGGLE,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SIDE_PANE_TOGGLE,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_AGENT_RUNTIME_EXIT_BANNER,
  TID_V4_AGENT_RUNTIME_EXIT_DISMISS,
  TID_V4_SESSION_PANE,
  TID_V4_SESSION_SOURCE_HINT,
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_REFRESH_BUTTON,
  TID_WORKSPACE_FILE_TREE_ROW,
  testId,
} from "@nibi/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "../../../helpers/desktop-app.js";
import { readBrowserTabIds } from "../../../helpers/browser-side-pane.js";
import { reloadElectronSessionSafely } from "../../../helpers/e2e-electron-reload.js";
import {
  openProjectMenuAction,
  startDraftFromProject,
  waitForTaskRowInProject,
} from "../../../helpers/project-sidebar.js";
import {
  V4_MAIN_PANE_ID,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  switchV4Mode,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";
import {
  killAgentRuntimeProcesses,
  readPluginSeedState,
  readSixthBatchGitWorkspace,
  seedSixthBatchSessions,
  SIXTH_BATCH_DESIGN_FILENAME,
  SIXTH_BATCH_MISSING_SESSION_ID,
  SIXTH_BATCH_SOURCE_MISSING_MARKER,
  SIXTH_BATCH_SOURCE_REACHABLE_MARKER,
  SIXTH_BATCH_SOURCE_SESSION_ID,
  SIXTH_BATCH_SOURCE_TITLE,
  SIXTH_BATCH_TARGET_SESSION_ID,
  writeSixthBatchImage,
} from "../../../helpers/tier2-sixth-batch.js";

const EVIDENCE_DIR =
  process.env.NIBI_E2E_EVIDENCE_DIR?.trim() ||
  join(process.cwd(), ".e2e-artifacts", "tier2-sixth-batch");
const E2E_HOME_DIR = process.env.NIBI_E2E_HOME_DIR?.trim();
if (!E2E_HOME_DIR) {
  throw new Error("NIBI_E2E_HOME_DIR missing; run through the isolated WDIO harness");
}
const FACTS_FILE = "wdio-facts.json";
const LOCALE = "en-US";
const PANE_SELECTOR = `[data-testid="${testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID)}"]`;
const TIMELINE_SELECTOR = `${PANE_SELECTOR} [data-testid="v4-timeline"]`;
const SETTINGS_PAGE_SELECTOR = `[data-testid="${TID_SETTINGS_PAGE}"]`;
const DESIGN_HTML_PATH = join(DEFAULT_WORKSPACE, SIXTH_BATCH_DESIGN_FILENAME);
const SOURCE_HINT_SELECTOR = `[data-testid="${TID_V4_SESSION_SOURCE_HINT}"]`;
const RUNTIME_EXIT_BANNER_SELECTOR = `[data-testid="${TID_V4_AGENT_RUNTIME_EXIT_BANNER}"]`;

const IMAGE_PROMPT = "E2E_TIER2_SIXTH_IMAGE: Reply with the image reference only.";

const priorFacts = readPriorFacts();
const facts: Record<string, unknown> = {
  ...priorFacts,
  generatedAt: new Date().toISOString(),
  host: { platform: process.platform, cwd: process.cwd(), home: E2E_HOME_DIR },
  e2eHomeDir: E2E_HOME_DIR,
  evidenceDir: EVIDENCE_DIR,
  screenshots: Array.isArray(priorFacts.screenshots) ? [...priorFacts.screenshots] : [],
  results:
    priorFacts.results && typeof priorFacts.results === "object"
      ? { ...(priorFacts.results as Record<string, unknown>) }
      : {},
};

function readPriorFacts(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(join(EVIDENCE_DIR, FACTS_FILE), "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function pushScreenshot(path: string): void {
  const screenshots = facts.screenshots as string[];
  if (!screenshots.includes(path)) screenshots.push(path);
}

function record(key: string, value: unknown): void {
  facts[key] = value;
}

function recordResult(scenario: string, value: unknown): void {
  (facts.results as Record<string, unknown>)[scenario] = value;
}

async function shot(name: string): Promise<string> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await browser.saveScreenshot(path);
  pushScreenshot(path);
  return path;
}

interface ClipRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

async function readRect(selector: string): Promise<ClipRect | null> {
  return browser.execute((currentSelector) => {
    const element = document.querySelector<HTMLElement>(currentSelector);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      height: Math.ceil(rect.height),
      width: Math.ceil(rect.width),
      x: Math.floor(rect.left),
      y: Math.floor(rect.top),
    };
  }, selector);
}

function clampClip(rect: ClipRect, viewport: { height: number; width: number }): ClipRect {
  const x = Math.max(0, Math.min(rect.x, viewport.width - 1));
  const y = Math.max(0, Math.min(rect.y, viewport.height - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(rect.width, viewport.width - x)),
    height: Math.max(1, Math.min(rect.height, viewport.height - y)),
  };
}

/** 只截局部关键窗口；clip 失败时如实记录，不静默改为全屏。 */
async function shotClip(
  name: string,
  rect: ClipRect,
  options: { padding?: number; maxHeight?: number } = {},
): Promise<string | null> {
  const viewport = (await browser.execute(() => ({
    height: window.innerHeight,
    width: window.innerWidth,
  }))) as { height: number; width: number };
  const padding = options.padding ?? 0;
  const clip = clampClip(
    {
      height: Math.min(rect.height + padding * 2, options.maxHeight ?? rect.height + padding * 2),
      width: rect.width + padding * 2,
      x: rect.x - padding,
      y: rect.y - padding,
    },
    viewport,
  );
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.png`);
  try {
    // WebDriver Classic 的 saveScreenshot 不支持 clip；用 Electron webContents.capturePage
    // 直接取局部像素，既满足“只截关键窗口”，也不依赖 CDP。
    const base64 = (await browser.electron.execute(async (electron, currentClip) => {
      const win = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed(),
      );
      if (!win) return null;
      const image = await win.webContents.capturePage({
        height: currentClip.height,
        width: currentClip.width,
        x: currentClip.x,
        y: currentClip.y,
      });
      return image.toPNG().toString("base64");
    }, clip)) as string | null;
    if (!base64) {
      record(`clips.${name}`, { clip, error: "no-window", mode: "clip-failed" });
      return null;
    }
    await writeFile(path, Buffer.from(base64, "base64"));
    pushScreenshot(path);
    record(`clips.${name}`, clip);
    return path;
  } catch (error) {
    record(`clips.${name}`, {
      clip,
      error: error instanceof Error ? error.message : String(error),
      mode: "clip-failed",
    });
    return null;
  }
}

async function readUnionRect(selectors: string[], padding = 0): Promise<ClipRect | null> {
  return browser.execute((currentSelectors, currentPadding) => {
    const rects = currentSelectors
      .map((selector) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect())
      .filter((rect): rect is DOMRect => Boolean(rect && rect.width > 0 && rect.height > 0));
    if (rects.length === 0) return null;
    const left = Math.min(...rects.map((rect) => rect.left)) - currentPadding;
    const top = Math.min(...rects.map((rect) => rect.top)) - currentPadding;
    const right = Math.max(...rects.map((rect) => rect.right)) + currentPadding;
    const bottom = Math.max(...rects.map((rect) => rect.bottom)) + currentPadding;
    return {
      height: Math.ceil(bottom - top),
      width: Math.ceil(right - left),
      x: Math.floor(left),
      y: Math.floor(top),
    };
  }, selectors, padding);
}

async function setEnglishLocale(): Promise<void> {
  await browser.execute((locale) => {
    (
      window as Window & {
        __testActions?: { setLocale(value: string): void };
      }
    ).__testActions?.setLocale(locale);
  }, LOCALE);
  await browser.waitUntil(
    async () => (await browser.execute(() => document.documentElement.lang)) === LOCALE,
    { timeout: 15_000, timeoutMsg: `界面语言没有切到 ${LOCALE}` },
  );
}

interface WindowGeometry {
  minimum: [number, number];
  size: [number, number];
}

/** Electron 下 WebDriver setWindowSize 不可用；这里同时降低 minWidth（390 < 480）以便 390px 证据成立。 */
async function setMainWindowSize(
  width: number,
  height: number,
): Promise<WindowGeometry | null> {
  const original = (await browser.electron.execute((electron) => {
    const win = electron.BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    return win
      ? {
          minimum: win.getMinimumSize() as [number, number],
          size: win.getSize() as [number, number],
        }
      : null;
  })) as WindowGeometry | null;
  await browser.electron.execute(
    (electron, w, h) => {
      const win = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed(),
      );
      win?.setMinimumSize(200, 200);
      win?.setContentSize(w, h);
    },
    width,
    height,
  );
  try {
    await browser.waitUntil(
      async () => {
        const viewport = (await browser.execute(() => [innerWidth, innerHeight])) as [
          number,
          number,
        ];
        return viewport[0] === width && viewport[1] === height;
      },
      { timeout: 10_000, interval: 100, timeoutMsg: `窗口尺寸 ${width}x${height} 未收敛` },
    );
  } catch (error) {
    record("window.sizeError", error instanceof Error ? error.message : String(error));
  }
  return original;
}

async function restoreMainWindowSize(original: WindowGeometry | null): Promise<void> {
  if (!original) return;
  await browser.electron.execute((electron, minimum, size) => {
    const win = electron.BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    win?.setMinimumSize(minimum[0], minimum[1]);
    win?.setContentSize(size[0], size[1]);
  }, original.minimum, original.size);
  await browser.pause(250);
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
  await browser.waitUntil(async () => !(await isTestIdPresent(TID_SETTINGS_PAGE)), {
    timeout: 10_000,
    interval: 100,
    timeoutMsg: "设置页没有关闭",
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

async function readSwitchInTargetRow(targetId: string): Promise<{
  found: boolean;
  checked: boolean | null;
}> {
  return browser.execute((currentTargetId) => {
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-settings-search-target]"))
      .find((item) => item.getAttribute("data-settings-search-target") === currentTargetId);
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
      const row = Array.from(document.querySelectorAll<HTMLElement>("[data-settings-search-target]"))
        .find((item) => item.getAttribute("data-settings-search-target") === currentTargetId);
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
      throw new Error("没有找到文件树入口");
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

async function readBrowserAddress(): Promise<string> {
  return browser.execute(
    (selector) => document.querySelector<HTMLInputElement>(selector)?.value ?? "",
    `[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`,
  );
}

async function waitForBrowserAddressContaining(fragment: string): Promise<string> {
  let address = "";
  await browser.waitUntil(
    async () => {
      address = await readBrowserAddress();
      return address.includes(fragment);
    },
    { timeout: 30_000, interval: 250, timeoutMsg: `内置浏览器地址没有包含 ${fragment}` },
  );
  return address;
}

async function activateBrowserTab(): Promise<void> {
  await browser.execute(() => {
    document
      .querySelector<HTMLElement>('[data-side-pane-tab-id^="browser:"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const tab = document.querySelector<HTMLElement>('[data-side-pane-tab-id^="browser:"]');
        return Boolean(tab?.hasAttribute("data-active"));
      }),
    { timeout: 15_000, interval: 200, timeoutMsg: "浏览器 tab 没有激活" },
  );
}

function readSettingsNarrowFacts(): Promise<Record<string, unknown>> {
  return browser.execute((pageSelector) => {
    const page = document.querySelector<HTMLElement>(pageSelector);
    const nav = page?.querySelector<HTMLElement>("nav");
    const list = nav?.firstElementChild as HTMLElement | null;
    if (!page || !nav || !list) return { found: false };
    const pageStyle = getComputedStyle(page);
    const navStyle = getComputedStyle(nav);
    const listStyle = getComputedStyle(list);
    const pageRect = page.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    return {
      found: true,
      viewport: { height: innerHeight, width: innerWidth },
      htmlClass: document.documentElement.className,
      pageClass: page.className,
      pageGridColumns: pageStyle.gridTemplateColumns,
      pageGridRows: pageStyle.gridTemplateRows,
      pageHeight: Math.round(pageRect.height),
      pageWidth: Math.round(pageRect.width),
      navClass: nav.className,
      navClientWidth: nav.clientWidth,
      navHasHorizontalOverflow: nav.scrollWidth > nav.clientWidth + 1,
      navOverflowX: navStyle.overflowX,
      navOverflowY: navStyle.overflowY,
      navScrollWidth: nav.scrollWidth,
      listDisplay: listStyle.display,
      listFlexDirection: listStyle.flexDirection,
      navHeight: Math.round(navRect.height),
      sectionIds: Array.from(
        nav.querySelectorAll<HTMLElement>("[data-settings-section-nav]"),
      ).map((item) => item.getAttribute("data-settings-section-nav")),
    };
  }, SETTINGS_PAGE_SELECTOR);
}

async function hideDesktopPlatformClass(): Promise<string> {
  const original = (await browser.execute(() => document.documentElement.className)) as string;
  await browser.execute(() => {
    document.documentElement.classList.remove(
      "platform-mac-desktop",
      "platform-windows-desktop",
      "platform-linux-desktop",
    );
  });
  await browser.pause(150);
  return original;
}

async function restoreHtmlClass(original: string): Promise<void> {
  await browser.execute((className) => {
    document.documentElement.className = className;
  }, original);
  await browser.pause(150);
}

interface PreviewActionSnapshot {
  action: string | null;
  ariaLabel: string | null;
  disabled: boolean;
  title: string | null;
}

function readImagePreviewSnapshot(): Promise<{
  present: boolean;
  containerClass: string | null;
  containerTop: string | null;
  containerRight: string | null;
  actions: PreviewActionSnapshot[];
  dialog: { height: number; width: number; x: number; y: number } | null;
}> {
  return browser.execute(() => {
    const container = document.querySelector<HTMLElement>("[data-image-preview-actions]");
    const dialog = container?.closest<HTMLElement>('[role="dialog"]');
    const dialogRect = dialog?.getBoundingClientRect();
    const containerStyle = container ? getComputedStyle(container) : null;
    const directActions = container
      ? Array.from(container.children).flatMap((child) => {
          if (child instanceof HTMLElement && child.dataset.imagePreviewAction) {
            return [child];
          }
          return Array.from(
            child.querySelectorAll<HTMLElement>("[data-image-preview-action]"),
          );
        })
      : [];
    return {
      present: Boolean(container),
      containerClass: container?.className ?? null,
      containerTop: containerStyle?.top ?? null,
      containerRight: containerStyle?.right ?? null,
      actions: directActions.map((element) => ({
        action: element.dataset.imagePreviewAction ?? null,
        ariaLabel: element.getAttribute("aria-label"),
        disabled: element instanceof HTMLButtonElement ? element.disabled : false,
        title: element.getAttribute("title"),
      })),
      dialog: dialogRect
        ? {
            height: Math.round(dialogRect.height),
            width: Math.round(dialogRect.width),
            x: Math.round(dialogRect.left),
            y: Math.round(dialogRect.top),
          }
        : null,
    };
  });
}

function readToastText(): Promise<string> {
  return browser.execute(() => {
    const host = document.getElementById("nibi-toast-host");
    return (host?.innerText ?? "").replace(/\s+/gu, " ").trim();
  });
}

interface UserRowDebugSnapshot {
  rowId: string | null;
  text: string;
  source: unknown;
  origin: string | null;
  originMeta: unknown;
  sourceMarker: string | null;
}

/** 诊断用：通过 React fiber 读取 canonical row，确认 source 是否真的到达 renderer。 */
function readUserRowDebug(): Promise<UserRowDebugSnapshot[]> {
  return browser.execute(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-row-id]")).filter(
      (element) => element.classList.contains("group/user-row"),
    );
    return rows.map((element) => {
      type FiberLike = {
        memoizedProps?: { row?: Record<string, unknown> };
        return?: FiberLike | null;
      };
      const fiberKey = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
      let fiber = fiberKey
        ? ((element as unknown as Record<string, FiberLike>)[fiberKey] ?? null)
        : null;
      while (fiber && !fiber.memoizedProps?.row) fiber = fiber.return ?? null;
      const row = fiber?.memoizedProps?.row;
      return {
        rowId: element.getAttribute("data-row-id"),
        text: (element.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 300),
        source: row?.source ?? null,
        origin: typeof row?.origin === "string" ? row.origin : null,
        originMeta: row?.originMeta ?? null,
        sourceMarker:
          element
            .querySelector<HTMLElement>("[data-v4-user-input-source]")
            ?.getAttribute("data-v4-user-input-source") ?? null,
      };
    });
  });
}

interface SessionSourceHintSnapshot {
  present: boolean;
  text: string | null;
  sourceKind: string | null;
  navigable: string | null;
  childTag: string | null;
  childTitle: string | null;
  rowText: string | null;
  hintHtml: string | null;
  hintRect: ClipRect | null;
  bodyInnerTextHasId: boolean;
}

function readSessionSourceHints(sourceSessionId: string): Promise<SessionSourceHintSnapshot[]> {
  return browser.execute((selector, sessionId) => {
    return Array.from(document.querySelectorAll<HTMLElement>(selector)).map((hint) => {
      const row = hint.closest<HTMLElement>("[data-row-id]");
      const rect = hint.getBoundingClientRect();
      const child = hint.firstElementChild as HTMLElement | null;
      return {
        present: true,
        text: (hint.innerText ?? "").replace(/\s+/gu, " ").trim(),
        sourceKind: hint.getAttribute("data-v4-user-input-source"),
        navigable: hint.getAttribute("data-source-session-navigable"),
        childTag: child?.tagName ?? null,
        childTitle: child?.getAttribute("title") ?? null,
        rowText: row ? (row.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 800) : null,
        hintHtml: hint.outerHTML,
        hintRect: {
          height: Math.ceil(rect.height),
          width: Math.ceil(rect.width),
          x: Math.floor(rect.left),
          y: Math.floor(rect.top),
        },
        bodyInnerTextHasId: (document.body.innerText ?? "").includes(sessionId),
      };
    });
  }, SOURCE_HINT_SELECTOR, sourceSessionId);
}

interface DesignToolbarSnapshot {
  present: boolean;
  text: string | null;
  panelPressed: string | null;
  variantValue: string | null;
  variantText: string | null;
  slideCounter: string | null;
  slidePrevDisabled: boolean | null;
  slideNextDisabled: boolean | null;
}

function readDesignToolbar(): Promise<DesignToolbarSnapshot> {
  return browser.execute((selectors) => {
    const toolbar = document.querySelector<HTMLElement>(selectors.toolbar);
    const panel = toolbar?.querySelector<HTMLButtonElement>(selectors.panel);
    const variant = toolbar?.querySelector<HTMLElement>(selectors.variant);
    const counter = toolbar?.querySelector<HTMLElement>(selectors.counter);
    const prev = toolbar?.querySelector<HTMLButtonElement>(selectors.prev);
    const next = toolbar?.querySelector<HTMLButtonElement>(selectors.next);
    return {
      present: Boolean(toolbar),
      text: (toolbar?.innerText ?? "").replace(/\s+/gu, " ").trim(),
      panelPressed: panel?.getAttribute("aria-pressed") ?? null,
      variantValue: variant?.getAttribute("data-value") ?? variant?.textContent?.trim() ?? null,
      variantText: variant?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
      slideCounter: counter?.textContent?.trim() ?? null,
      slidePrevDisabled: prev?.disabled ?? null,
      slideNextDisabled: next?.disabled ?? null,
    };
  }, {
    toolbar: `[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`,
    panel: `[data-testid="${TID_BROWSER_DESIGN_PANEL_BUTTON}"]`,
    variant: `[data-testid="${TID_BROWSER_DESIGN_VARIANT_SELECT}"]`,
    counter: `[data-testid="${TID_BROWSER_DESIGN_SLIDE_COUNTER}"]`,
    prev: `[data-testid="${TID_BROWSER_DESIGN_SLIDE_PREV}"]`,
    next: `[data-testid="${TID_BROWSER_DESIGN_SLIDE_NEXT}"]`,
  });
}

function readDesignInspector(): Promise<{
  present: boolean;
  selectedCount: number;
  elementText: string | null;
  textInputValue: string | null;
  undoPresent: boolean;
  redoPresent: boolean;
  capturePresent: boolean;
  closePresent: boolean;
}> {
  return browser.execute((selectors) => {
    const root = document.querySelector<HTMLElement>(selectors.inspector);
    return {
      present: Boolean(root),
      selectedCount: Number(root?.getAttribute("data-selected-count") ?? 0),
      elementText:
        root?.querySelector<HTMLElement>(selectors.element)?.textContent?.trim() ?? null,
      textInputValue:
        root?.querySelector<HTMLInputElement>(selectors.textInput)?.value ?? null,
      undoPresent: Boolean(root?.querySelector(`[data-testid="${selectors.undo}"]`)),
      redoPresent: Boolean(root?.querySelector(`[data-testid="${selectors.redo}"]`)),
      capturePresent: Boolean(root?.querySelector(`[data-testid="${selectors.capture}"]`)),
      closePresent: Boolean(root?.querySelector(`[data-testid="${selectors.close}"]`)),
    };
  }, {
    inspector: `[data-testid="${TID_BROWSER_DESIGN_INSPECTOR}"]`,
    element: `[data-testid="${TID_BROWSER_DESIGN_ELEMENT}"]`,
    textInput: '[data-testid="browser-design-text-input"]',
    undo: TID_BROWSER_DESIGN_UNDO,
    redo: TID_BROWSER_DESIGN_REDO,
    capture: TID_BROWSER_DESIGN_CAPTURE_ELEMENT,
    close: TID_BROWSER_DESIGN_INSPECTOR_CLOSE,
  });
}

async function readGuestDesignState(): Promise<Record<string, unknown>> {
  return (await browser.electron.execute(async (electron, needle) => {
    const guest = electron.webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().includes(needle));
    if (!guest) {
      return { found: false, url: "", runtimeInstalled: false, headingText: null };
    }
    const state = (await guest.executeJavaScript(
      "({ runtime: Boolean(window.__nibiDesignRuntime), heading: document.querySelector('h1')?.textContent ?? null })",
    )) as { runtime: boolean; heading: string | null };
    return {
      found: true,
      guestId: guest.id,
      headingText: state.heading,
      runtimeInstalled: state.runtime,
      url: guest.getURL(),
    };
  }, SIXTH_BATCH_DESIGN_FILENAME)) as Record<string, unknown>;
}

async function clickGuestDesignSelection(selector: string): Promise<string> {
  return (await browser.electron.execute(async (electron, needle, targetSelector) => {
    const guest = electron.webContents
      .getAllWebContents()
      .find((contents) => contents.getURL().includes(needle));
    if (!guest) return "guest-missing";
    return (await guest.executeJavaScript(
      `(() => {
        const element = document.querySelector(${JSON.stringify(targetSelector)});
        if (!element) return "element-missing";
        element.click();
        return "clicked";
      })()`,
    )) as string;
  }, SIXTH_BATCH_DESIGN_FILENAME, selector)) as string;
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
  }, `[data-testid="${TID_BROWSER_DESIGN_BUTTON}"]`);
}

const DESIGN_PLUGIN_ID = "design@nibi-official";
const DESIGN_PLUGIN_REQUIRED_SELECTOR = '[data-testid="browser-design-plugin-required"]';

/** U08：确认门 → 设置页 Plugins → 打开 Design 内置插件；只走真实 UI。 */
async function enableDesignPluginViaSettings(): Promise<Record<string, unknown>> {
  const rowSelector = `[data-testid="plugin-settings-plugin-row"][data-plugin-id="${DESIGN_PLUGIN_ID}"]`;
  await closeSettingsIfOpen();
  await openSettings();
  await clickSettingsSection("plugin");
  const rowAppeared = await browser
    .waitUntil(
      () => browser.execute((selector) => Boolean(document.querySelector(selector)), rowSelector),
      { timeout: 30_000, interval: 300, timeoutMsg: "设置页 Plugins 没有列出 Design 内置插件" },
    )
    .then(() => true)
    .catch(() => false);
  if (!rowAppeared) {
    return { rowAppeared: false };
  }
  const before = await browser.execute((selector) => {
    const row = document.querySelector<HTMLElement>(selector);
    const toggle = row?.querySelector<HTMLElement>(
      '[data-testid="plugin-settings-enabled-switch"]',
    );
    return {
      checked: toggle?.getAttribute("aria-checked") ?? null,
      text: (row?.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 400),
    };
  }, rowSelector);
  if (before.checked !== "true") {
    await browser.execute((selector) => {
      document
        .querySelector<HTMLElement>(selector)
        ?.querySelector<HTMLElement>('[data-testid="plugin-settings-enabled-switch"]')
        ?.click();
    }, rowSelector);
    await browser.waitUntil(
      () =>
        browser.execute(
          (selector) =>
            document
              .querySelector<HTMLElement>(selector)
              ?.querySelector('[data-testid="plugin-settings-enabled-switch"]')
              ?.getAttribute("aria-checked") === "true",
          rowSelector,
        ),
      { timeout: 30_000, interval: 300, timeoutMsg: "Design 插件开关没有切到 enabled" },
    );
  }
  const after = await browser.execute((selector) => {
    const row = document.querySelector<HTMLElement>(selector);
    return {
      checked:
        row
          ?.querySelector('[data-testid="plugin-settings-enabled-switch"]')
          ?.getAttribute("aria-checked") ?? null,
      text: (row?.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 400),
    };
  }, rowSelector);
  return { after, before, rowAppeared: true };
}

async function waitForV4Idle(timeoutMsg: string, timeout = 180_000): Promise<void> {
  await waitForV4Pane((snapshot) => !snapshot.canStop, timeoutMsg, timeout);
}

/**
 * 切到 full access 会先挂风险确认弹窗；不确认则整页被 Radix modal 的 inert 遮罩盖住。
 * 与 tier2-ui-batch 证据走同一条真实确认路径。
 */
async function confirmFullAccessDialogIfPresent(): Promise<boolean> {
  const dialogSelector = '[data-testid="full-access-mode-confirm-dialog"]';
  const appeared = await browser
    .waitUntil(
      () =>
        browser.execute(
          (selector) => Boolean(document.querySelector(selector)),
          dialogSelector,
        ),
      { timeout: 10_000, interval: 200, timeoutMsg: "full access 确认弹窗没有出现" },
    )
    .then(() => true)
    .catch(() => false);
  if (!appeared) return false;
  await browser.execute((selector) => {
    document.querySelector<HTMLElement>(`${selector} [role="checkbox"]`)?.click();
  }, dialogSelector);
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector) =>
          document
            .querySelector(`${selector} [role="checkbox"]`)
            ?.getAttribute("aria-checked") === "true",
        dialogSelector,
      ),
    { timeout: 10_000, interval: 100, timeoutMsg: "full access 风险勾选没有生效" },
  );
  const confirmed = await browser.execute((selector) => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(`${selector} button`),
    );
    const confirm = buttons.at(-1);
    if (!confirm || confirm.disabled) return false;
    confirm.click();
    return true;
  }, dialogSelector);
  if (confirmed) {
    await browser.waitUntil(
      () =>
        browser.execute((selector) => !document.querySelector(selector), dialogSelector),
      { timeout: 15_000, interval: 200, timeoutMsg: "full access 确认弹窗没有关闭" },
    );
  }
  return confirmed;
}

async function waitForTimelineImageLoaded(timeout = 60_000): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((timelineSelector) => {
        const trigger = document.querySelector<HTMLElement>(
          `${timelineSelector} [data-markdown-image-trigger]`,
        );
        const image = trigger?.querySelector<HTMLImageElement>("img[data-markdown-image]");
        return Boolean(image && image.complete && image.naturalWidth > 0);
      }, TIMELINE_SELECTOR),
    { timeout, interval: 250, timeoutMsg: "时间线没有加载出 Markdown 图片" },
  );
}

function readWorktreeEligibilityDebug(): Promise<Record<string, unknown>> {
  return browser.execute((workspacePath) => {
    const state = (
      window as Window & {
        __nibiSessionStoreE2E?: {
          getState(): {
            getWorkspaceState(
              path: string,
              identity?: string,
            ): { draftProjectId?: string | null; draftWorktree?: unknown } | undefined;
          };
        };
      }
    ).__nibiSessionStoreE2E
      ?.getState()
      .getWorkspaceState(workspacePath);
    const actionTrigger = document.querySelector<HTMLElement>(
      '[data-testid="git-action-trigger"]',
    );
    return {
      branchTriggerText: actionTrigger?.innerText?.replace(/\s+/gu, " ").trim() ?? null,
      draftProjectId: state?.draftProjectId ?? null,
      draftWorktree: state?.draftWorktree ?? null,
      gitPanePresent: Boolean(document.querySelector('[data-testid="git-pane"]')),
      workspacePath,
    };
  }, DEFAULT_WORKSPACE);
}

async function openProjectWorktreesDialog(): Promise<void> {
  await openProjectMenuAction(DEFAULT_WORKSPACE, "worktrees", { timeout: 30_000 });
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
        return Boolean(dialog && (dialog.innerText ?? "").includes("Worktrees"));
      }),
    { timeout: 20_000, interval: 200, timeoutMsg: "项目菜单没有打开 Worktrees 对话框" },
  );
}

async function runU22UnitEvidence(): Promise<Record<string, unknown>> {
  const repoRoot = resolve(process.cwd(), "../..");
  const vitest = resolve(repoRoot, "node_modules/vitest/vitest.mjs");
  const files = [
    resolve(repoRoot, "packages/ui/test/agentRuntimeExitBanner.test.ts"),
    resolve(repoRoot, "packages/ui/test/agentRuntimeExitNotice.test.ts"),
    resolve(repoRoot, "packages/services/test/nibiAgentProcessManager.test.ts"),
  ];
  try {
    const result = await promisify(execFile)(
      process.execPath,
      [vitest, "run", ...files],
      { cwd: repoRoot, encoding: "utf-8", timeout: 300_000, env: process.env },
    );
    return {
      command: `${process.execPath} ${vitest} run ${files.map((file) => file.replace(repoRoot, ".")).join(" ")}`,
      exitCode: 0,
      stderrTail: result.stderr.slice(-1500),
      stdoutTail: result.stdout.slice(-2000),
    };
  } catch (error) {
    const current = error as { code?: number; stderr?: string; stdout?: string };
    return {
      command: `${process.execPath} ${vitest} run ${files.map((file) => file.replace(repoRoot, ".")).join(" ")}`,
      exitCode: current.code ?? -1,
      stderrTail: (current.stderr ?? "").slice(-1500),
      stdoutTail: (current.stdout ?? "").slice(-2000),
    };
  }
}

describe("Tier 2 第六批视觉证据（真实 Desktop）", () => {
  before(async function () {
    this.timeout(600_000);
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const providerId = process.env.E2E_PROVIDER_ID?.trim() || "e2e-upstream";
    const modelId = process.env.E2E_PROVIDER_MODEL?.trim() || "deepseek-v4-flash";
    const thoughtLevel = process.env.E2E_PROVIDER_THOUGHT_LEVEL?.trim() || undefined;
    record("fixture.provider", { modelId, providerId, thoughtLevel: thoughtLevel ?? null });
    // 种子必须落在 Electron 完全退出后：任务索引由 Host 打开，运行中写入会被覆盖。
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: async () => {
        await seedSixthBatchSessions({
          e2eHomeDir: E2E_HOME_DIR,
          modelId,
          providerId,
          thoughtLevel,
          workspacePath: DEFAULT_WORKSPACE,
        });
        const imagePath = await writeSixthBatchImage(DEFAULT_WORKSPACE);
        record("fixture.image", { path: imagePath });
        record("fixture.git", readSixthBatchGitWorkspace(DEFAULT_WORKSPACE));
        record("fixture.sessions", {
          source: { id: SIXTH_BATCH_SOURCE_SESSION_ID, title: SIXTH_BATCH_SOURCE_TITLE },
          target: { id: SIXTH_BATCH_TARGET_SESSION_ID },
        });
      },
    });
    await prepareV4ConversationE2E();
    await setEnglishLocale();
    await setMainWindowSize(1280, 900);
  });

  afterEach(async () => {
    await writeFactsToDisk();
  });

  after(async () => {
    await writeFactsToDisk();
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  async function writeFactsToDisk(): Promise<void> {
    await mkdir(EVIDENCE_DIR, { recursive: true });
    await writeFile(join(EVIDENCE_DIR, FACTS_FILE), JSON.stringify(facts, null, 2), "utf-8");
  }

  it("U28 窄屏设置页：compact-web 两行导航与横向滚动事实", async function () {
    this.timeout(240_000);
    const originalWindow = await setMainWindowSize(390, 800);
    try {
      await openSettings();
      await clickSettingsSection("general");
      await typeSettingsSearch("");
      await browser.waitUntil(
        () =>
          browser.execute((selector) => {
            const nav = document.querySelector<HTMLElement>(`${selector} nav`);
            return Boolean(nav && nav.getBoundingClientRect().width > 0);
          }, SETTINGS_PAGE_SELECTOR),
        { timeout: 15_000, interval: 200, timeoutMsg: "设置页导航没有渲染" },
      );
      const desktopFacts = await readSettingsNarrowFacts();
      record("u28.desktopNarrow", desktopFacts);
      const pageRect = await readRect(SETTINGS_PAGE_SELECTOR);
      record("u28.desktopNarrowScreenshot", pageRect ? await shotClip("01-u28-settings-narrow-390x800", pageRect, { maxHeight: 460 }) : null);
      const desktopGridColumns = String(
        (desktopFacts as { pageGridColumns?: string }).pageGridColumns ?? "",
      );
      expect(desktopGridColumns.trim().split(/\s+/u).length).toBeGreaterThanOrEqual(2);

      // 桌面 renderer 带 platform-windows-desktop，compact-web 的根条件按 spec 不会命中。
      // 这里临时移除平台类，在同一 Electron renderer 里模拟手机 Web 的 390px 条件。
      const originalHtmlClass = await hideDesktopPlatformClass();
      let compactFacts: Record<string, unknown> = {};
      let emulatedShot: string | null = null;
      try {
        await browser.waitUntil(
          async () => {
            compactFacts = await readSettingsNarrowFacts();
            const rows = String(
              (compactFacts as { pageGridRows?: string }).pageGridRows ?? "",
            )
              .trim()
              .split(/\s+/u);
            const columns = String(
              (compactFacts as { pageGridColumns?: string }).pageGridColumns ?? "",
            )
              .trim()
              .split(/\s+/u);
            return rows.length >= 2 && columns.length === 1;
          },
          { timeout: 10_000, interval: 200, timeoutMsg: "移除平台类后 compact-web 两行布局没有生效" },
        );
        const emulatedRect = await readRect(SETTINGS_PAGE_SELECTOR);
        emulatedShot = emulatedRect
          ? await shotClip("01b-u28-settings-compact-web-emulated", emulatedRect, { maxHeight: 460 })
          : null;
      } finally {
        await restoreHtmlClass(originalHtmlClass);
      }
      record("u28.mobileWebEmulation", {
        note: "platform class removed at runtime only to exercise the mobile-Web port; not a native mobile device",
        facts: compactFacts,
      });
      const emulatedFacts = compactFacts as {
        navHasHorizontalOverflow?: boolean;
        navOverflowX?: string;
        navOverflowY?: string;
        pageGridColumns?: string;
        pageGridRows?: string;
      };
      expect(String(emulatedFacts.pageGridRows ?? "").trim().split(/\s+/u).length).toBeGreaterThanOrEqual(2);
      expect(String(emulatedFacts.pageGridColumns ?? "").trim().split(/\s+/u).length).toBe(1);
      expect(emulatedFacts.navOverflowY).toBe("hidden");
      expect(emulatedFacts.navHasHorizontalOverflow).toBe(true);
      recordResult("u28", {
        compactAppliedOnRealDesktop: false,
        compactAppliedWhenPlatformClassRemoved: true,
        emulatedScreenshot: emulatedShot,
        emulatedViewport: "390x800",
        realDesktopScreenshot: facts["u28.desktopNarrowScreenshot"] ?? null,
        restoredTo: "1280x900",
      });
      await closeSettingsIfOpen();
    } finally {
      await restoreMainWindowSize(originalWindow);
      await setMainWindowSize(1280, 900);
    }
  });

  it("U06 受管 worktree：新任务页开关/分支选择与项目菜单 Worktrees", async function () {
    this.timeout(240_000);
    await setMainWindowSize(1280, 900);
    // U28 失败时设置页可能仍占着主视图；先回到工作区再操作项目行。
    await closeSettingsIfOpen();
    await ensureSidebarVisible();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    record("u06.gitStateBeforePane", await readWorktreeEligibilityDebug());
    try {
      // Git summary 只在 workspace 变化 / Git 面板打开 / 显式刷新时重拉；尽力打开一次
      // Git 面板，让新初始化的隔离仓库进入 App 的 gitState。入口缺席不阻断证据。
      await clickTestIdByDom(TID_GIT_TOGGLE, {
        timeout: 10_000,
        timeoutMsg: "没有找到 Git 面板入口",
      });
      await waitForTestIdByDom(TID_GIT_PANE, { timeout: 15_000 });
      await browser.pause(1_000);
      record("u06.gitPaneOpened", true);
    } catch (error) {
      record("u06.gitPaneOpened", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    record("u06.gitStateAfterPane", await readWorktreeEligibilityDebug());
    const toggleVisible = await browser
      .waitUntil(
        () =>
          browser.execute(
            (selector) => Boolean(document.querySelector(selector)),
            `[data-testid="worktree-toggle"]`,
          ),
        { timeout: 45_000, interval: 300, timeoutMsg: "新任务页没有出现 Worktree 开关" },
      )
      .then(() => true)
      .catch(() => false);
    if (!toggleVisible) {
      const projectMenuFacts = await browser.execute(() => ({
        menuPresent: Boolean(
          document.querySelector('[data-testid="virtual-project-worktrees"]'),
        ),
      }));
      recordResult("u06", {
        debug: await readWorktreeEligibilityDebug(),
        mode: "skipped",
        projectMenu: projectMenuFacts,
        reason:
          "worktree toggle not rendered within 45s (requires local Git repository + worktreeCwd capability); no fake entry captured",
      });
      return;
    }
    const toggleState = await browser.execute(() => {
      const toggle = document.querySelector<HTMLElement>('[data-testid="worktree-toggle"]');
      return {
        checked: toggle?.getAttribute("aria-checked") ?? null,
        present: Boolean(toggle),
      };
    });
    if ((toggleState as { checked: string | null }).checked !== "true") {
      await browser.execute(() => {
        document.querySelector<HTMLElement>('[data-testid="worktree-toggle"]')?.click();
      });
    }
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const toggle = document.querySelector<HTMLElement>('[data-testid="worktree-toggle"]');
          return (
            toggle?.getAttribute("aria-checked") === "true" &&
            Boolean(document.querySelector('[data-testid="worktree-branch-picker"]'))
          );
        }),
      { timeout: 15_000, interval: 200, timeoutMsg: "Worktree 开关没有切换出分支选择" },
    );
    const composerFacts = await browser.execute(() => {
      const toggle = document.querySelector<HTMLElement>('[data-testid="worktree-toggle"]');
      const branch = document.querySelector<HTMLElement>('[data-testid="worktree-branch-picker"]');
      return {
        branchText: branch?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
        toggleChecked: toggle?.getAttribute("aria-checked") ?? null,
        toggleLabel: toggle?.closest("label")?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
      };
    });
    const composerRect = await readUnionRect(
      ['[data-testid="worktree-toggle"]', '[data-testid="worktree-branch-picker"]'],
      16,
    );
    const toggleShot = composerRect
      ? await shotClip("02-u06-worktree-toggle-branch", composerRect, { maxHeight: 140 })
      : null;
    record("u06.composer", { ...composerFacts, screenshot: toggleShot });
    if (!composerFacts.branchText) {
      throw new Error("Worktree 开关已勾选但没有出现分支选择");
    }

    let dialogShot: string | null = null;
    let dialogFacts: Record<string, unknown> = {};
    try {
      await openProjectWorktreesDialog();
      dialogFacts = await browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
        return {
          text: (dialog?.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 1500),
          title:
            dialog
              ?.querySelector<HTMLElement>('[data-slot="dialog-title"]')
              ?.textContent?.trim() ?? null,
        };
      });
      const dialogRect = await readRect('[data-slot="dialog-content"]');
      dialogShot = dialogRect
        ? await shotClip("02b-u06-worktrees-dialog", dialogRect, { padding: 8 })
        : null;
      await browser.keys(["Escape"]);
      await browser.pause(300);
    } catch (error) {
      dialogFacts = {
        error: error instanceof Error ? error.message : String(error),
        reason: "project menu did not expose a Worktrees dialog; entry requires local Host access",
      };
    }
    record("u06.dialog", { ...dialogFacts, screenshot: dialogShot });
    recordResult("u06", {
      dialogScreenshot: dialogShot,
      mode: "captured",
      screenshot: toggleShot,
      toggle: composerFacts,
    });
  });

  it("U27 图片预览操作条：真实图片打开预览并点击复制", async function () {
    this.timeout(300_000);
    await waitForTaskRowInProject(SIXTH_BATCH_SOURCE_SESSION_ID, DEFAULT_WORKSPACE);
    await selectV4TaskById(SIXTH_BATCH_SOURCE_SESSION_ID);
    await switchV4Mode("yolo");
    const fullAccessConfirmed = await confirmFullAccessDialogIfPresent();
    record("u27.fullAccessConfirmed", fullAccessConfirmed);
    await browser.pause(500);
    await sendV4PromptAndWaitAccepted(
      IMAGE_PROMPT,
      "E2E_TIER2_SIXTH_IMAGE",
      "U27 图片 prompt 没有被接受",
      120_000,
    );
    await waitForTimelineImageLoaded(120_000);
    await waitForV4Idle("U27 图片回合没有结束", 120_000);
    const imageTrigger = await $(`${TIMELINE_SELECTOR} [data-markdown-image-trigger]`);
    await imageTrigger.waitForDisplayed({ timeout: 30_000, timeoutMsg: "图片缩略图没有显示" });
    await browser.execute((timelineSelector) => {
      document
        .querySelector<HTMLElement>(`${timelineSelector} [data-markdown-image-trigger]`)
        ?.scrollIntoView({ block: "center" });
    }, TIMELINE_SELECTOR);
    await imageTrigger.click();
    await browser.waitUntil(
      () =>
        browser.execute(() => Boolean(document.querySelector("[data-image-preview-actions]"))),
      { timeout: 20_000, interval: 200, timeoutMsg: "点击图片后没有打开预览操作条" },
    );
    const preview = await readImagePreviewSnapshot();
    const actionNames = preview.actions.map((action) => action.action);
    record("u27.preview", preview);
    expect(actionNames).toContain("more");
    expect(actionNames).toContain("saveAs");
    expect(actionNames).toContain("copy");
    expect(actionNames).toContain("add");
    expect(actionNames).toContain("draw");
    const windowsAvoidanceClass =
      "platform-windows-desktop:top-[calc(env(titlebar-area-height,48px)_+_0.5rem)]";
    const containerClass = preview.containerClass ?? "";
    record("u27.windowControlAvoidance", {
      classMentionsWindowsTop: containerClass.includes(windowsAvoidanceClass),
      containerClass,
      containerRight: preview.containerRight,
      containerTop: preview.containerTop,
      platformWindowsDesktop: (await browser.execute(() => document.documentElement.classList.contains("platform-windows-desktop"))) as boolean,
    });
    // 点击缩略图后 WebDriver 指针仍停在触发行上，会把行 hover 卡带进截图；
    // 显式派发 leave 并把指针移出内容区，再取“图片主体 + 操作条”的预览区域。
    await browser.execute(() => {
      document.querySelectorAll<HTMLElement>("[data-row-id]").forEach((row) => {
        row.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
        row.dispatchEvent(new PointerEvent("pointerleave", { bubbles: true }));
      });
    });
    await browser
      .action("pointer")
      .move({ x: 1400, y: 880 })
      .perform()
      .catch(() => undefined);
    await browser.pause(1_200);
    const previewRect = await readUnionRect(
      ['[data-image-preview-actions]', '[role="dialog"] img'],
      24,
    );
    const previewShot = previewRect
      ? await shotClip("03-u27-image-preview-actions", previewRect, { maxHeight: 780 })
      : null;
    record("u27.screenshot", previewShot);

    let copyResult: Record<string, unknown> = { clicked: false };
    try {
      const copyButton = await $(`[data-image-preview-action="copy"]`);
      await copyButton.waitForDisplayed({ timeout: 10_000, timeoutMsg: "复制按钮不可见" });
      await copyButton.click();
      copyResult = { clicked: true };
    } catch (error) {
      copyResult = {
        clicked: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    let toast = "";
    try {
      await browser.waitUntil(
        async () => {
          toast = await readToastText();
          return toast.length > 0;
        },
        { timeout: 15_000, interval: 200, timeoutMsg: "复制后没有出现 toast" },
      );
    } catch {
      toast = await readToastText();
    }
    const toastRect = await readRect("#nibi-toast-host > *");
    const toastShot = toastRect
      ? await shotClip("03b-u27-image-copy-toast", toastRect, { padding: 6 })
      : null;
    record("u27.copy", { ...copyResult, toast, toastScreenshot: toastShot });
    await browser.keys(["Escape"]);
    await browser.waitUntil(
      () => browser.execute(() => !document.querySelector("[data-image-preview-actions]")),
      { timeout: 10_000, interval: 200, timeoutMsg: "预览没有关闭" },
    );
    expect(preview.dialog?.width ?? 0).toBeGreaterThan(200);
    expect(preview.actions.length).toBeGreaterThanOrEqual(4);
    recordResult("u27", {
      actions: preview.actions,
      copy: { ...copyResult, toast },
      mode: "captured",
      screenshot: previewShot,
      windowControlAvoidance: facts["u27.windowControlAvoidance"],
    });
  });

  it("U30 跨会话来源：From session 提示、可点/不可点与不泄露 sessionId", async function () {
    this.timeout(180_000);
    // 两条来源 row 由隔离 HOME 的 CLI transcript 预置，走 Rust 冷加载把
    // metadata.conversationInputIntent.source 投到 userInput row，不伪造 DOM。
    await waitForTaskRowInProject(SIXTH_BATCH_TARGET_SESSION_ID, DEFAULT_WORKSPACE);
    await selectV4TaskById(SIXTH_BATCH_TARGET_SESSION_ID);
    await waitForV4TimelineContaining(SIXTH_BATCH_SOURCE_REACHABLE_MARKER, 120_000);
    await waitForV4TimelineContaining(SIXTH_BATCH_SOURCE_MISSING_MARKER, 120_000);
    await waitForV4Idle("U30 目标会话没有结束", 60_000);
    record("u30.targetUserRows", await readUserRowDebug());
    await browser.waitUntil(
      async () => {
        const hints = await readSessionSourceHints(SIXTH_BATCH_SOURCE_SESSION_ID);
        return hints.length >= 2;
      },
      { timeout: 60_000, interval: 250, timeoutMsg: "目标会话没有出现两条跨会话来源提示" },
    );
    const hints = await readSessionSourceHints(SIXTH_BATCH_SOURCE_SESSION_ID);
    record("u30.hints", hints);
    const reachable = hints.find((hint) =>
      (hint.rowText ?? "").includes(SIXTH_BATCH_SOURCE_REACHABLE_MARKER),
    );
    const unreachable = hints.find((hint) =>
      (hint.rowText ?? "").includes(SIXTH_BATCH_SOURCE_MISSING_MARKER),
    );
    expect(reachable).toBeTruthy();
    expect(unreachable).toBeTruthy();
    expect(reachable!.text).toBe(`From session ${SIXTH_BATCH_SOURCE_TITLE}`);
    expect(reachable!.sourceKind).toBe("session");
    expect(reachable!.navigable).toBe("true");
    expect(reachable!.childTag).toBe("BUTTON");
    expect(reachable!.hintHtml ?? "").not.toContain(SIXTH_BATCH_SOURCE_SESSION_ID);
    expect(reachable!.bodyInnerTextHasId).toBe(false);
    expect(unreachable!.text).toBe("From session another session");
    expect(unreachable!.navigable).toBe("false");
    expect(unreachable!.childTag).toBe("SPAN");
    expect(unreachable!.childTitle).toBe("The source session was deleted or is unavailable");
    expect(unreachable!.hintHtml ?? "").not.toContain(SIXTH_BATCH_MISSING_SESSION_ID);
    expect(unreachable!.bodyInnerTextHasId).toBe(false);

    async function captureHint(name: string, marker: string) {
      await browser.execute((selector, needle) => {
        const row = Array.from(document.querySelectorAll<HTMLElement>(selector))
          .map((hint) => hint.closest<HTMLElement>("[data-row-id]"))
          .find((candidate) => (candidate?.innerText ?? "").includes(needle));
        row?.scrollIntoView({ block: "center" });
      }, SOURCE_HINT_SELECTOR, marker);
      await browser.pause(400);
      const rect = await browser.execute(
        (selector, needle) => {
          const row = Array.from(document.querySelectorAll<HTMLElement>(selector))
            .map((hint) => hint.closest<HTMLElement>("[data-row-id]"))
            .find((candidate) => (candidate?.innerText ?? "").includes(needle));
          if (!row) return null;
          const rowRect = row.getBoundingClientRect();
          return {
            height: Math.min(240, Math.ceil(rowRect.height)),
            width: Math.ceil(rowRect.width),
            x: Math.floor(rowRect.left),
            y: Math.floor(rowRect.top),
          };
        },
        SOURCE_HINT_SELECTOR,
        marker,
      );
      return rect ? await shotClip(name, rect, { padding: 8 }) : null;
    }
    const reachableShot = await captureHint(
      "04-u30-cross-session-source",
      SIXTH_BATCH_SOURCE_REACHABLE_MARKER,
    );
    const unreachableShot = await captureHint(
      "04b-u30-cross-session-source-unreachable",
      SIXTH_BATCH_SOURCE_MISSING_MARKER,
    );
    record("u30.reachableScreenshot", reachableShot);
    record("u30.unreachableScreenshot", unreachableShot);
    recordResult("u30", {
      mode: "reachable+unreachable",
      reachable: {
        navigable: reachable!.navigable,
        screenshot: reachableShot,
        text: reachable!.text,
      },
      unreachable: {
        navigable: unreachable!.navigable,
        screenshot: unreachableShot,
        text: unreachable!.text,
        tooltip: unreachable!.childTitle,
      },
    });
  });

  it("U08 设计工具栏：面板/方案/翻页 + undo/redo/截图入口", async function () {
    this.timeout(300_000);
    record("u08.pluginSeed", readPluginSeedState(E2E_HOME_DIR));
    const html = [
      "<!doctype html>",
      '<html lang="en" data-nibi-design>',
      "<head>",
      '<meta charset="utf-8">',
      "<title>NIBI sixth batch design evidence</title>",
      "<style>:root { --brand: #112233; --accent: #ff8800; } h1 { color: #112233; font-size: 32px; }</style>",
      "</head>",
      "<body>",
      '<div data-variant="compact"><h1 id="hero">SIXTH_DESIGN_BEFORE</h1></div>',
      '<div data-variant="wide"><h1 id="hero-wide">SIXTH_DESIGN_WIDE</h1></div>',
      '<section class="slide">Slide one</section>',
      '<section class="slide">Slide two</section>',
      "<p>Design toolbar evidence paragraph.</p>",
      "</body>",
      "</html>",
      "",
    ].join("\n");
    await mkdir(DEFAULT_WORKSPACE, { recursive: true });
    await writeFile(DESIGN_HTML_PATH, html, "utf-8");
    record("u08.sourceFile", { path: DESIGN_HTML_PATH });

    await closeSettingsIfOpen();
    await setMainWindowSize(1440, 900);
    await ensureSidebarVisible();
    await ensureSidePaneOpen();
    await openSettings();
    await clickSettingsSection("general");
    await typeSettingsSearch("");
    const toggle = await readSwitchInTargetRow("general.fileTreeHtmlClick");
    if (toggle.checked !== true) {
      await setSwitchInTargetRow("general.fileTreeHtmlClick", true);
      await browser.waitUntil(
        async () => (await readSwitchInTargetRow("general.fileTreeHtmlClick")).checked === true,
        { timeout: 10_000, interval: 200, timeoutMsg: "HTML 单击开关没有打开" },
      );
    }
    await closeSettingsIfOpen();
    await openFileTree();
    await refreshFileTree();
    await clickFileTreeRow(DESIGN_HTML_PATH);
    const address = await waitForBrowserAddressContaining(SIXTH_BATCH_DESIGN_FILENAME);
    await activateBrowserTab();
    await browser.waitUntil(
      async () => {
        const state = await readDesignButtonState();
        return state.present && state.disabled === false;
      },
      { timeout: 30_000, interval: 250, timeoutMsg: "浏览器就绪后设计模式按钮仍不可用" },
    );
    let designPluginStatus: Record<string, unknown> = {};
    try {
      designPluginStatus = (await browser.executeAsync(
        (
          workspacePath: string,
          done: (result: { ok: boolean; error?: string; value?: unknown }) => void,
        ) => {
          const action = (
            window as Window & {
              __testActions?: {
                listPlugins?: (params: { workspacePath: string }) => Promise<unknown>;
              };
            }
          ).__testActions?.listPlugins;
          if (!action) {
            done({ ok: false, error: "listPlugins missing" });
            return;
          }
          Promise.resolve(action({ workspacePath })).then(
            (value) => done({ ok: true, value }),
            (error: unknown) =>
              done({ ok: false, error: error instanceof Error ? error.message : String(error) }),
          );
        },
        DEFAULT_WORKSPACE,
      )) as { ok: boolean; error?: string; value?: unknown };
    } catch (error) {
      designPluginStatus = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    record("u08.plugins", designPluginStatus);
    record("u08.pluginSeedAfterProbe", readPluginSeedState(E2E_HOME_DIR));
    await clickTestIdByDom(TID_BROWSER_DESIGN_BUTTON, {
      timeout: 15_000,
      timeoutMsg: "设计模式按钮不可点击",
    });
    // 设计按钮只进入点选模式；工具栏随设计稿页出现，检查器要等面板开关或首次选中。
    let toolbarAppeared = await waitForTestIdByDom(TID_BROWSER_DESIGN_TOOLBAR, {
      timeout: 12_000,
      timeoutMsg: "设计模式没有出现工具栏（可能 Design 插件未启用）",
    })
      .then(() => true)
      .catch(() => false);
    let pluginDialogFacts: Record<string, unknown> | null = null;
    let pluginEnableFacts: Record<string, unknown> | null = null;
    if (!toolbarAppeared) {
      const dialogAppeared = await waitForTestIdByDom(DESIGN_PLUGIN_REQUIRED_SELECTOR, {
        timeout: 6_000,
        timeoutMsg: "没有出现 Design 插件确认门",
      })
        .then(() => true)
        .catch(() => false);
      if (dialogAppeared) {
        pluginDialogFacts = await browser.execute((selector) => {
          const dialog = document.querySelector<HTMLElement>(selector);
          return {
            text: (dialog?.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 1200),
          };
        }, DESIGN_PLUGIN_REQUIRED_SELECTOR);
        const dialogRect = await readRect(DESIGN_PLUGIN_REQUIRED_SELECTOR);
        const dialogShot = dialogRect
          ? await shotClip("05-u08-design-plugin-required", dialogRect, { padding: 10 })
          : null;
        record("u08.pluginDialog", { ...pluginDialogFacts, screenshot: dialogShot });
        await browser.keys(["Escape"]);
        await browser.pause(400);
        pluginEnableFacts = await enableDesignPluginViaSettings();
        record("u08.pluginEnable", pluginEnableFacts);
        await closeSettingsIfOpen();
        await ensureSidePaneOpen();
        await activateBrowserTab();
        await clickTestIdByDom(TID_BROWSER_DESIGN_BUTTON, {
          timeout: 15_000,
          timeoutMsg: "启用 Design 插件后设计模式按钮不可点击",
        });
        toolbarAppeared = await waitForTestIdByDom(TID_BROWSER_DESIGN_TOOLBAR, {
          timeout: 20_000,
          timeoutMsg: "启用 Design 插件后仍没有工具栏",
        })
          .then(() => true)
          .catch(() => false);
      }
    }
    if (!toolbarAppeared) {
      const toastText = await readToastText();
      const designButton = await readDesignButtonState();
      const buttonRect = await readUnionRect(
        [
          `[data-testid="${TID_BROWSER_DESIGN_BUTTON}"]`,
          `[data-testid="${TID_BROWSER_ADDRESS_INPUT}"]`,
        ],
        24,
      );
      const unavailableShot = buttonRect
        ? await shotClip("05-u08-design-toolbar-unavailable", buttonRect, { maxHeight: 180 })
        : null;
      const toastRect = await readRect("#nibi-toast-host > *");
      const toastShot = toastRect
        ? await shotClip("05b-u08-design-plugin-check-toast", toastRect, { padding: 6 })
        : null;
      const limitation = {
        designButton,
        designHtmlOpened: address,
        pluginDialog: pluginDialogFacts,
        pluginEnable: pluginEnableFacts,
        pluginList: designPluginStatus,
        reason:
          "Design toolbar did not render even after the plugin-required path; see pluginDialog/pluginEnable for the real blocker. No fake design-mode DOM was produced.",
        toast: toastText,
        toastScreenshot: toastShot,
        unavailableScreenshot: unavailableShot,
      };
      record("u08.limitation", limitation);
      recordResult("u08", { ...limitation, mode: "limitation" });
      return;
    }
    // 插件列表首轮可能仍在加载，第一次点击 Design 被门禁吞掉；工具栏出现后再补一次进入点选。
    if (!(await isTestIdPresent(TID_BROWSER_DESIGN_PANEL_BUTTON))) {
      await clickTestIdByDom(TID_BROWSER_DESIGN_BUTTON, {
        timeout: 10_000,
        timeoutMsg: "设计模式按钮第二次不可点击",
      });
      await browser.waitUntil(
        async () => isTestIdPresent(TID_BROWSER_DESIGN_PANEL_BUTTON),
        { timeout: 15_000, interval: 250, timeoutMsg: "设计模式没有进入点选态" },
      );
    }
    if (!(await isTestIdPresent(TID_BROWSER_DESIGN_INSPECTOR))) {
      await clickTestIdByDom(TID_BROWSER_DESIGN_PANEL_BUTTON, {
        timeout: 10_000,
        timeoutMsg: "设计工具栏没有面板开关",
      });
    }
    await waitForTestIdByDom(TID_BROWSER_DESIGN_INSPECTOR, { timeout: 20_000 });
    await browser.waitUntil(
      async () => (await readGuestDesignState()).runtimeInstalled === true,
      { timeout: 30_000, interval: 250, timeoutMsg: "设计运行时没有注入 guest 页面" },
    );
    const toolbarIdle = await readDesignToolbar();
    const inspectorIdle = await readDesignInspector();
    const guestIdle = await readGuestDesignState();
    record("u08.idle", {
      address,
      browserTabs: await readBrowserTabIds(),
      designButton: await readDesignButtonState(),
      guest: guestIdle,
      inspector: inspectorIdle,
      toolbar: toolbarIdle,
    });

    const clipRect = await readUnionRect(
      [
        `[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`,
        `[data-testid="${TID_BROWSER_DESIGN_INSPECTOR}"]`,
      ],
      12,
    );
    const toolbarShot = clipRect
      ? await shotClip("05-u08-design-toolbar-and-inspector", clipRect, { maxHeight: 720 })
      : await shot("05-u08-design-toolbar-and-inspector-fallback");

    const clickResult = await clickGuestDesignSelection("h1#hero");
    let selected = false;
    try {
      await browser.waitUntil(
        async () => {
          const state = await readDesignInspector();
          return state.selectedCount === 1;
        },
        { timeout: 15_000, interval: 250, timeoutMsg: "guest 点选没有进入检查器" },
      );
      selected = true;
    } catch {
      selected = false;
    }
    let selectedShot: string | null = null;
    let inspectorSelected = inspectorIdle;
    if (selected) {
      inspectorSelected = await readDesignInspector();
      const selectedRect = await readUnionRect(
        [
          `[data-testid="${TID_BROWSER_DESIGN_TOOLBAR}"]`,
          `[data-testid="${TID_BROWSER_DESIGN_INSPECTOR}"]`,
        ],
        12,
      );
      selectedShot = selectedRect
        ? await shotClip("05b-u08-design-inspector-selected", selectedRect, { maxHeight: 720 })
        : null;
    }
    record("u08.selection", {
      clickResult,
      driven: selected,
      inspector: inspectorSelected,
      screenshot: selectedShot,
    });
    recordResult("u08", {
      address,
      guest: guestIdle,
      mode: selected ? "toolbar+inspector+selection" : "toolbar+inspector (guest selection not driven)",
      selectionDriven: selected,
      screenshot: toolbarShot,
      selectedScreenshot: selectedShot,
      toolbar: toolbarIdle,
    });
    if (!selected) {
      record("u08.limitation", {
        reason: "guest webContents executeJavaScript click did not reach the design inspector",
        clickResult,
      });
    }
    // 工具栏必须在设计稿页 + Design 插件启用时出现；不可见时把实际 DOM 事实留在 facts 里。
    expect(toolbarIdle.present || inspectorIdle.present).toBe(true);
  });

  it("U22 Runtime 意外退出横幅（尽力而为）", async function () {
    this.timeout(300_000);
    await waitForTaskRowInProject(SIXTH_BATCH_TARGET_SESSION_ID, DEFAULT_WORKSPACE);
    await selectV4TaskById(SIXTH_BATCH_TARGET_SESSION_ID);
    await waitForV4Idle("U22 目标会话没有进入 idle", 60_000);
    const mainPid = (await browser.electron.execute(() => process.pid)) as number;
    let runtimeTargets: unknown[] = [];
    try {
      runtimeTargets = killAgentRuntimeProcesses(mainPid) as unknown[];
    } catch (error) {
      record("u22.killError", error instanceof Error ? error.message : String(error));
    }
    record("u22.killed", runtimeTargets);
    let banner = false;
    try {
      await browser.waitUntil(
        () =>
          browser.execute(
            (selector) => Boolean(document.querySelector(selector)),
            RUNTIME_EXIT_BANNER_SELECTOR,
          ),
        { timeout: 45_000, interval: 250, timeoutMsg: "结束 runtime 后没有出现退出横幅" },
      );
      banner = true;
    } catch {
      banner = false;
    }
    if (banner) {
      const bannerFacts = await browser.execute((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        return {
          category: element?.getAttribute("data-exit-category") ?? null,
          dismissPresent: Boolean(
            element?.querySelector<HTMLElement>('[data-testid="v4-agent-runtime-exit-dismiss"]'),
          ),
          role: element?.getAttribute("role") ?? null,
          text: (element?.innerText ?? "").replace(/\s+/gu, " ").trim(),
        };
      }, RUNTIME_EXIT_BANNER_SELECTOR);
      const bannerRect = await readRect(RUNTIME_EXIT_BANNER_SELECTOR);
      const bannerShot = bannerRect
        ? await shotClip("06-u22-runtime-exit-banner", bannerRect, { padding: 8 })
        : null;
      record("u22.banner", { ...bannerFacts, screenshot: bannerShot });
      if (bannerFacts.dismissPresent) {
        await clickTestIdByDom(TID_V4_AGENT_RUNTIME_EXIT_DISMISS, {
          timeout: 10_000,
          timeoutMsg: "退出横幅没有忽略按钮",
        });
        await browser.waitUntil(
          () =>
            browser.execute(
              (selector) => !document.querySelector(selector),
              RUNTIME_EXIT_BANNER_SELECTOR,
            ),
          { timeout: 10_000, interval: 200, timeoutMsg: "忽略后退出横幅没有消失" },
        );
        record("u22.dismissed", true);
      }
      recordResult("u22", {
        banner: bannerFacts,
        killed: runtimeTargets,
        mode: "reproduced",
        screenshot: bannerShot,
      });
      expect(bannerFacts.text.length).toBeGreaterThan(0);
      expect(bannerFacts.role).toBe("status");
    } else {
      const unitEvidence = await runU22UnitEvidence();
      record("u22.limitation", {
        killed: runtimeTargets,
        reason:
          "Harness could not observe the renderer banner within 45s after killing the Rust app-server; unit evidence recorded instead.",
        unitEvidence,
      });
      recordResult("u22", {
        killed: runtimeTargets,
        limitation: "banner not reproduced",
        mode: "limitation",
        unitEvidence,
      });
    }
  });
});