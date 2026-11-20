/**
 * 2026-11-20 parity batch evidence（manual-review / pending）。
 *
 * 真实 Electron Desktop + 隔离 HOME + replay 上游，逐项截取“pane 裁剪”而不是整屏：
 * A. 设置搜索：动态工作流 → 行为与工具；提示音 → 通知声音；证书 → 自定义证书。
 *    记录结果行标题/分区/目标，并验证跳转后的 data-settings-search-highlighted 高亮。
 * B. 子智能体表情：replay 一个前台 general-purpose Agent；在同一个 running 窗口里截取
 *    Agent 工具卡、右上状态面板 running 行、右侧 subagent tab 三处 data-face-state 与机身色。
 * C. 文件动作：文件树打开 README.md 预览 → 头部 Open ▾；文件树行右键与消息文件链接右键
 *    的另存为/在文件夹中显示；记录平台能力布尔值。
 * D. 重启任务：任务标题旁 More 菜单里的 Restart task；replay 下点击并记录 pending/恢复事实。
 * E. 图片文件引用：CLI transcript 种入一条带图片文件引用的已发送用户消息，点击
 *    data-image-file-mention 打开共享图片预览对话框并截图。
 * F. 插件：记录“全部更新（N）”按钮是否存在；隔离 HOME 没有可更新插件时如实记录。
 *
 * 运行（仓库根目录；与 settings-parity/六批同一隔离 HOME 合同）：
 *   NIBI_E2E_HOME_DIR=<isolated home> \
 *   NIBI_E2E_EVIDENCE_DIR=packages/desktop/.e2e-artifacts/parity-batch-20261120 \
 *   E2E_PROVIDER_HTTP_MODE=replay \
 *   E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,\
 * packages/desktop/test/e2e/fixtures/upstream/parity-batch-20261120.json \
 *   NIBI_BUNDLED_AGENT_RESOURCE_DIR=D:\NIBI\NIBI-Client\apps\nibi-cli \
 *   pnpm --filter @nibi/desktop exec wdio run wdio.conf.ts \
 *     --spec test/e2e/bots/manual-review/pending/parity-batch-20261120-evidence.test.ts
 *
 * 种子：复用 `helpers/tier2-sixth-batch.ts:seedSixthBatchSessions`（U30 同一条 CLI transcript
 * 落库路径），随后向目标会话追加一条带 `conversationInputIntent` 的图片文件引用用户消息和
 * 一条带 Markdown 文件链接的助手消息；没有任何 DOM 伪造。
 */
/* eslint-disable max-lines -- 单文件承载 A-F 六块互不相关证据的定位、截图与事实记录，拆开会让 pending 证据入口漂移。 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TID_CHAT_SUMMARY_PANEL,
  TID_PREVIEW_PANE,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SIDE_PANE_TOGGLE,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_SESSION_PANE,
  TID_V4_TIMELINE,
  TID_WORKSPACE_FILE_TREE_PANEL,
  TID_WORKSPACE_FILE_TREE_ROW,
  TID_WORKSPACE_MORE_BUTTON,
  testId,
} from "@nibi/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "../../../helpers/desktop-app.js";
import { reloadElectronSessionSafely } from "../../../helpers/e2e-electron-reload.js";
import {
  openProjectFileTree,
  startDraftFromProject,
  waitForTaskRowInProject,
} from "../../../helpers/project-sidebar.js";
import {
  readPluginSeedState,
  seedSixthBatchSessions,
  SIXTH_BATCH_TARGET_SESSION_ID,
  writeSixthBatchImage,
} from "../../../helpers/tier2-sixth-batch.js";
import {
  V4_MAIN_PANE_ID,
  getV4ConfigProjection,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  switchV4Mode,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const EVIDENCE_DIR =
  process.env.NIBI_E2E_EVIDENCE_DIR?.trim() ||
  join(process.cwd(), ".e2e-artifacts", "parity-batch-20261120");
const E2E_HOME_DIR = process.env.NIBI_E2E_HOME_DIR?.trim();
if (!E2E_HOME_DIR) {
  throw new Error("NIBI_E2E_HOME_DIR missing; run through the isolated WDIO harness");
}

const FACTS_FILE = "wdio-facts.json";
const LOCALE = "en-US";
const SETTINGS_PAGE_SELECTOR = `[data-testid="${TID_SETTINGS_PAGE}"]`;
const SETTINGS_MAIN_SELECTOR = `${SETTINGS_PAGE_SELECTOR} main`;
const PANE_SELECTOR = `[data-testid="${testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID)}"]`;
const TIMELINE_SELECTOR = `${PANE_SELECTOR} [data-testid="${TID_V4_TIMELINE}"]`;

const PARITY_SESSION_ID = SIXTH_BATCH_TARGET_SESSION_ID;
const PARITY_IMAGE_FILENAME = "sixth-batch-image.png";
const PARITY_FILE_FILENAME = "README.md";
const PARITY_IMAGE_MARKER = "E2E_PARITY_BATCH_IMAGE";
const PARITY_FILE_MARKER = "E2E_PARITY_BATCH_FILE_LINK";
const PARITY_TURN_ID = "turn_parity_batch_transcript";
const AGENT_PARENT_MARKER = "E2E_PARITY_BATCH_AGENT";
const AGENT_PARENT_ACK = "E2E_PARITY_BATCH_PARENT_ACK";
const AGENT_PARENT_DONE = "E2E_PARITY_BATCH_PARENT_DONE";

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

interface ClipRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

async function shotClip(
  name: string,
  rect: ClipRect,
  options: { maxHeight?: number; padding?: number } = {},
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
    // WebDriver Classic saveScreenshot has no clip; capturePage keeps the artifact to the
    // requested pane instead of the whole window.
    const base64 = (await browser.electron.execute(async (electron, currentClip) => {
      const win = electron.BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
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

async function readUnionRect(selectors: string[], padding = 0): Promise<ClipRect | null> {
  return browser.execute(
    (currentSelectors, currentPadding) => {
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
    },
    selectors,
    padding,
  );
}

function colorToHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const hex = trimmed.match(/^#([0-9a-f]{6})$/iu);
  if (hex?.[1]) return `#${hex[1].toLowerCase()}`;
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/iu);
  if (!rgb?.[1] || !rgb[2] || !rgb[3]) return null;
  return `#${[rgb[1], rgb[2], rgb[3]]
    .map((channel) => Number(channel).toString(16).padStart(2, "0"))
    .join("")}`;
}

async function setRendererLocale(locale: string): Promise<void> {
  await browser.execute((value) => {
    (
      window as Window & {
        __testActions?: { setLocale(value: string): void };
      }
    ).__testActions?.setLocale(value);
  }, locale);
  await browser.waitUntil(
    async () => (await browser.execute(() => document.documentElement.lang)) === locale,
    { timeout: 15_000, timeoutMsg: `界面语言没有切到 ${locale}` },
  );
}

interface WindowGeometry {
  minimum: [number, number];
  size: [number, number];
}

async function setMainWindowSize(width: number, height: number): Promise<WindowGeometry | null> {
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
      const win = electron.BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      win?.setMinimumSize(200, 200);
      win?.setContentSize(w, h);
    },
    width,
    height,
  );
  await browser.waitUntil(
    async () => {
      const viewport = (await browser.execute(() => [innerWidth, innerHeight])) as [number, number];
      return viewport[0] === width && viewport[1] === height;
    },
    { timeout: 10_000, interval: 100, timeoutMsg: `窗口尺寸 ${width}x${height} 未收敛` },
  );
  return original;
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

// ── A. 设置搜索 ─────────────────────────────────────────────────────────────

interface SettingsSearchResultFact {
  id: string | null;
  sectionTitle: string;
  selected: string | null;
  text: string;
  title: string;
}

function readSettingsSearchResults(): Promise<SettingsSearchResultFact[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid="settings-search-result"]')).map(
      (element) => {
        const spans = element.querySelectorAll<HTMLElement>("span");
        return {
          id: element.getAttribute("data-settings-search-result-id"),
          sectionTitle: (spans[spans.length - 1]?.textContent ?? "").replace(/\s+/gu, " ").trim(),
          selected: element.getAttribute("aria-selected"),
          text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
          title: (spans[0]?.textContent ?? "").replace(/\s+/gu, " ").trim(),
        };
      },
    ),
  );
}

interface SettingsTargetFact {
  highlighted: string | null;
  present: boolean;
  rect: ClipRect | null;
  text: string;
}

function readSettingsTarget(targetId: string): Promise<SettingsTargetFact> {
  return browser.execute((value) => {
    const element = document.querySelector<HTMLElement>(
      `[data-settings-search-target="${value}"]`,
    );
    const rect = element?.getBoundingClientRect();
    return {
      highlighted: element?.getAttribute("data-settings-search-highlighted") ?? null,
      present: Boolean(element),
      rect:
        rect && rect.width > 0 && rect.height > 0
          ? {
              height: Math.ceil(rect.height),
              width: Math.ceil(rect.width),
              x: Math.floor(rect.left),
              y: Math.floor(rect.top),
            }
          : null,
      text: element ? (element.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 500) : "",
    };
  }, targetId);
}

function readSettingsActiveSection(): Promise<string | null> {
  return browser.execute(
    (selector) => document.querySelector<HTMLElement>(selector)?.getAttribute("data-active-section") ?? null,
    SETTINGS_PAGE_SELECTOR,
  );
}

interface SettingsSearchExpectation {
  key: string;
  query: string;
  resultId: string;
  sectionId: string;
  targetId: string;
  title: string;
}

async function runSettingsSearch(expectation: SettingsSearchExpectation): Promise<Record<string, unknown>> {
  await setInputValueByTestIdDom("settings-search-input", expectation.query, {
    timeout: 15_000,
    timeoutMsg: "设置搜索输入框没有出现或不可输入",
  });
  await waitForTestIdByDom("settings-search-results", { timeout: 15_000 });
  await browser.waitUntil(
    async () =>
      (await readSettingsSearchResults()).some((result) => result.id === expectation.resultId),
    {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: `搜索「${expectation.query}」没有出现目标结果 ${expectation.resultId}`,
    },
  );
  const results = await readSettingsSearchResults();
  record(`a.${expectation.key}.results`, results);
  const resultsRect = await readUnionRect(
    ['[data-testid="settings-search"]', '[data-testid="settings-search-results"]'],
    6,
  );
  const resultsScreenshot = resultsRect
    ? await shotClip(`01a-search-${expectation.key}-results`, resultsRect, { maxHeight: 460 })
    : null;
  record(`a.${expectation.key}.resultsScreenshot`, resultsScreenshot);

  const clicked = await browser.execute((resultId) => {
    const target = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="settings-search-result"]'),
    ).find((element) => element.getAttribute("data-settings-search-result-id") === resultId);
    if (!target) return false;
    target.click();
    return true;
  }, expectation.resultId);
  if (!clicked) throw new Error(`搜索结果里没有 ${expectation.resultId}`);

  await browser.waitUntil(
    async () => {
      const target = await readSettingsTarget(expectation.targetId);
      return target.present && target.highlighted === "true";
    },
    {
      timeout: 20_000,
      interval: 50,
      timeoutMsg: `搜索「${expectation.query}」没有导航并把高亮落到 ${expectation.targetId}`,
    },
  );
  const activeSection = await readSettingsActiveSection();
  const target = await readSettingsTarget(expectation.targetId);
  const mainRect = await readRect(SETTINGS_MAIN_SELECTOR);
  const navigatedScreenshot = mainRect
    ? await shotClip(`01b-search-${expectation.key}-navigated`, mainRect, { maxHeight: 780 })
    : null;
  const value = {
    activeSection,
    navigatedScreenshot,
    results,
    resultsScreenshot,
    target,
  };
  record(`a.${expectation.key}`, value);
  return value;
}

// ── B. 子智能体表情 ─────────────────────────────────────────────────────────

interface FaceFact {
  computedFill: string | null;
  expression: string | null;
  faceBodyVar: string | null;
  faceState: string | null;
  htmlHead: string | null;
  rect: ClipRect | null;
}

interface AgentCardFacts {
  face: FaceFact | null;
  rect: ClipRect | null;
  rowId: string | null;
  rowText: string;
}

function readAgentCardFacts(): Promise<AgentCardFacts | null> {
  return browser.execute((timelineSelector) => {
    const timeline = document.querySelector<HTMLElement>(timelineSelector);
    const rows = Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []);
    const row =
      rows.find(
        (candidate) =>
          (candidate.innerText ?? "").includes("Parity subagent face probe") &&
          Boolean(candidate.querySelector("svg[data-subagent-avatar]")),
      ) ??
      rows.find(
        (candidate) =>
          (candidate.innerText ?? "").includes("general-purpose") &&
          Boolean(candidate.querySelector("svg[data-subagent-avatar]")),
      ) ??
      rows.find((candidate) => Boolean(candidate.querySelector("svg[data-subagent-avatar]")));
    if (!row) return null;
    const face = row.querySelector<SVGSVGElement>("svg[data-subagent-avatar]");
    const body = face?.querySelector<SVGRectElement>("rect.wf-face-body") ?? null;
    const faceRect = face?.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    return {
      face: face
        ? {
            computedFill: body ? getComputedStyle(body).fill : null,
            expression: face.getAttribute("data-expression"),
            faceBodyVar: face.style.getPropertyValue("--wf-face-body").trim() || null,
            faceState: face.getAttribute("data-face-state"),
            htmlHead: face.outerHTML.slice(0, 600),
            rect: faceRect
              ? {
                  height: Math.ceil(faceRect.height),
                  width: Math.ceil(faceRect.width),
                  x: Math.floor(faceRect.left),
                  y: Math.floor(faceRect.top),
                }
              : null,
          }
        : null,
      rect:
        rowRect.width > 0 && rowRect.height > 0
          ? {
              height: Math.ceil(rowRect.height),
              width: Math.ceil(rowRect.width),
              x: Math.floor(rowRect.left),
              y: Math.floor(rowRect.top),
            }
          : null,
      rowId: row.getAttribute("data-row-id"),
      rowText: (row.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 600),
    };
  }, TIMELINE_SELECTOR);
}

interface StatusPanelFacts {
  childSessionId: string | null;
  face: FaceFact | null;
  panelDisplayMode: string | null;
  panelRect: ClipRect | null;
  panelState: string | null;
  runningBackgroundCount: string | null;
  rowText: string;
  workStatus: string | null;
}

function readStatusPanelFacts(): Promise<StatusPanelFacts | null> {
  return browser.execute((panelTestId) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
    const row = panel?.querySelector<HTMLElement>('li[data-background-task-kind="agent"]');
    if (!panel || !row) return null;
    const face = row.querySelector<SVGSVGElement>("svg[data-subagent-avatar]");
    const body = face?.querySelector<SVGRectElement>("rect.wf-face-body") ?? null;
    const faceRect = face?.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      childSessionId: row.getAttribute("data-child-session-id"),
      face: face
        ? {
            computedFill: body ? getComputedStyle(body).fill : null,
            expression: face.getAttribute("data-expression"),
            faceBodyVar: face.style.getPropertyValue("--wf-face-body").trim() || null,
            faceState: face.getAttribute("data-face-state"),
            htmlHead: face.outerHTML.slice(0, 600),
            rect: faceRect
              ? {
                  height: Math.ceil(faceRect.height),
                  width: Math.ceil(faceRect.width),
                  x: Math.floor(faceRect.left),
                  y: Math.floor(faceRect.top),
                }
              : null,
          }
        : null,
      panelRect:
        panelRect.width > 0 && panelRect.height > 0
          ? {
              height: Math.ceil(panelRect.height),
              width: Math.ceil(panelRect.width),
              x: Math.floor(panelRect.left),
              y: Math.floor(panelRect.top),
            }
          : null,
      panelDisplayMode: panel.getAttribute("data-display-mode"),
      panelState: panel.getAttribute("data-state"),
      runningBackgroundCount: panel.getAttribute("data-running-background-count"),
      rowText: (row.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 500),
      workStatus: row.getAttribute("data-work-status"),
    };
  }, TID_CHAT_SUMMARY_PANEL);
}

function readStatusPanelDisplayMode(): Promise<string | null> {
  return browser.execute(
    (panelTestId) =>
      document
        .querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`)
        ?.getAttribute("data-display-mode") ?? null,
    TID_CHAT_SUMMARY_PANEL,
  );
}

async function expandStatusPanelAgentSection(): Promise<void> {
  await browser.execute((panelTestId) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
    if (!panel) return;
    const mode = panel.getAttribute("data-display-mode");
    const face = panel.querySelector<SVGSVGElement>(
      'li[data-background-task-kind="agent"] svg[data-subagent-avatar]',
    );
    const faceRect = face?.getBoundingClientRect();
    if (mode !== "panel" || !faceRect || faceRect.width === 0) {
      // 胶囊（mini/auto）只显示 “1 running” 计数，running 行的脸没有布局尺寸；
      // 点摘要行切到完整 panel，才会渲染分区和脸。
      const expand = Array.from(panel.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => {
          const label = button.getAttribute("aria-label") ?? "";
          return label === "Expand status" || label === "展开状态";
        },
      );
      (expand ?? panel.querySelector<HTMLButtonElement>("button"))?.click();
    }
  }, TID_CHAT_SUMMARY_PANEL);
  await browser.waitUntil(
    async () => (await readStatusPanelDisplayMode()) === "panel",
    { timeout: 10_000, interval: 100, timeoutMsg: "状态面板没有从胶囊展开" },
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        (panelTestId) =>
          Boolean(
            document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`)?.querySelector(
              '[data-status-section-trigger="agent"]',
            ),
          ),
        TID_CHAT_SUMMARY_PANEL,
      ),
    { timeout: 10_000, interval: 100, timeoutMsg: "状态面板没有 Agents 分区" },
  );
  await browser.execute((panelTestId) => {
    const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
    const trigger = panel?.querySelector<HTMLButtonElement>(
      '[data-status-section-trigger="agent"]',
    );
    if (trigger?.getAttribute("aria-expanded") === "false") {
      trigger.click();
    }
  }, TID_CHAT_SUMMARY_PANEL);
  await browser.waitUntil(
    () =>
      browser.execute((panelTestId) => {
        const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
        return (
          panel
            ?.querySelector('[data-status-section-trigger="agent"]')
            ?.getAttribute("aria-expanded") === "true"
        );
      }, TID_CHAT_SUMMARY_PANEL),
    { timeout: 10_000, interval: 100, timeoutMsg: "状态面板 Agents 分区没有展开" },
  );
}

async function scrollTimelineToFindAgentCard(): Promise<AgentCardFacts | null> {
  // 先看当前视口：刚发送完时 Agent 卡通常就在底部可视区，贸然滚到顶会把它移出渲染窗口。
  const visible = await readAgentCardFacts();
  if (visible?.face) return visible;
  const metrics = (await browser.execute((timelineSelector) => {
    const timeline = document.querySelector<HTMLElement>(timelineSelector);
    if (!timeline) return null;
    timeline.scrollTop = 0;
    timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { clientHeight: timeline.clientHeight, scrollHeight: timeline.scrollHeight };
  }, TIMELINE_SELECTOR)) as { clientHeight: number; scrollHeight: number } | null;
  if (!metrics) return null;
  await browser.pause(300);
  const first = await readAgentCardFacts();
  if (first?.face) return first;
  const max = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const stops = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1].map((fraction) =>
    Math.round(max * fraction),
  );
  for (const top of stops) {
    await browser.execute(
      (timelineSelector, value) => {
        const timeline = document.querySelector<HTMLElement>(timelineSelector);
        if (!timeline) return;
        timeline.scrollTop = value;
        timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
      },
      TIMELINE_SELECTOR,
      top,
    );
    await browser.pause(250);
    const card = await readAgentCardFacts();
    if (card?.face) return card;
  }
  return null;
}

async function probeAgentSurfaces(): Promise<Record<string, unknown>> {
  return browser.execute(
    (panelTestId, timelineSelector) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      const timeline = document.querySelector<HTMLElement>(timelineSelector);
      const rows = Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []);
      return {
        agentRowsInPanel: panel?.querySelectorAll('li[data-background-task-kind="agent"]').length ?? 0,
        facesInTimeline: rows.filter((row) => row.querySelector("svg[data-subagent-avatar]")).length,
        panelPresent: Boolean(panel),
        panelState: panel?.getAttribute("data-state") ?? null,
        panelText: panel
          ? (panel.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 800)
          : null,
        runningBackgroundCount: panel?.getAttribute("data-running-background-count") ?? null,
        runningTriggerCount:
          panel?.querySelectorAll('[data-running-subagent-session-trigger="true"]').length ?? 0,
        sectionTriggers: Array.from(
          panel?.querySelectorAll<HTMLElement>("[data-status-section-trigger]") ?? [],
        ).map((element) => ({
          expanded: element.getAttribute("aria-expanded"),
          section: element.getAttribute("data-status-section-trigger"),
        })),
        timeline: timeline
          ? {
              clientHeight: timeline.clientHeight,
              faceCount: timeline.querySelectorAll("svg[data-subagent-avatar]").length,
              following: timeline.getAttribute("data-following"),
              renderUnitCount: timeline.getAttribute("data-render-unit-count"),
              rowCount: timeline.querySelectorAll("[data-row-id]").length,
              rowTexts: rows
                .slice(0, 12)
                .map((row) => (row.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 120)),
              scrollHeight: timeline.scrollHeight,
              scrollTop: timeline.scrollTop,
            }
          : null,
      };
    },
    TID_CHAT_SUMMARY_PANEL,
    TIMELINE_SELECTOR,
  ) as Promise<Record<string, unknown>>;
}

async function waitForAgentCardAndRunningStatus(
  timeout = 90_000,
): Promise<{ card: AgentCardFacts; status: StatusPanelFacts }> {
  let latest: { card: AgentCardFacts; status: StatusPanelFacts } | null = null;
  try {
    await browser.waitUntil(
      async () => {
        const card = await scrollTimelineToFindAgentCard();
        if (!card?.face) return false;
        await expandStatusPanelAgentSection();
        const status = await readStatusPanelFacts();
        if (!status?.face || (status.face.rect?.width ?? 0) <= 0) return false;
        if (!status.panelRect || status.panelRect.height < 90) return false;
        const faceRect = status.face.rect;
        // 展开动画期间 panel 高度还没跟上时，脸会被 overflow-hidden 裁在面板外。
        if (
          !faceRect ||
          faceRect.y + faceRect.height > status.panelRect.y + status.panelRect.height
        ) {
          return false;
        }
        latest = { card, status };
        return true;
      },
      {
        timeout,
        interval: 300,
        timeoutMsg: "Agent 工具卡或状态面板 running 行没有出现",
      },
    );
  } catch (error) {
    record("b.probe", await probeAgentSurfaces().catch((probeError) => ({
      error: probeError instanceof Error ? probeError.message : String(probeError),
    })));
    throw error;
  }
  return latest as unknown as { card: AgentCardFacts; status: StatusPanelFacts };
}

interface SubagentTabFacts {
  face: FaceFact | null;
  rect: ClipRect | null;
  tabId: string | null;
  tabText: string;
  via: string | null;
}

async function openSubagentSidePaneTab(): Promise<SubagentTabFacts | null> {
  let via: string | null = null;
  await browser.waitUntil(
    async () => {
      via = (await browser.execute(() => {
        const button = document.querySelector<HTMLElement>(
          '[data-testid^="v4-subagent-open-side-pane-"]',
        );
        if (button) {
          button.click();
          return "agent-summary";
        }
        const running = document.querySelector<HTMLElement>(
          '[data-running-subagent-session-trigger="true"]',
        );
        if (running) {
          running.click();
          return "status-panel";
        }
        return null;
      })) as string | null;
      if (!via) {
        await browser.execute(() => {
          document.querySelector<HTMLElement>("[data-side-pane-add-trigger]")?.click();
        });
      }
      return Boolean(via);
    },
    { timeout: 60_000, interval: 400, timeoutMsg: "没有可打开的子代理会话入口" },
  );
  await browser.waitUntil(
    () =>
      browser.execute(() =>
        Array.from(document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]")).some(
          (element) => element.getAttribute("data-side-pane-tab-id")?.startsWith("subagent-session"),
        ),
      ),
    { timeout: 30_000, interval: 200, timeoutMsg: "右侧没有出现 subagent-session tab" },
  );
  return browser.execute((clickedVia) => {
    const tabs = Array.from(
      document.querySelectorAll<HTMLElement>("[data-side-pane-tab-id]"),
    ).filter((element) =>
      element.getAttribute("data-side-pane-tab-id")?.startsWith("subagent-session"),
    );
    const tab = tabs[tabs.length - 1];
    if (!tab) return null;
    const face = tab.querySelector<SVGSVGElement>("svg[data-subagent-avatar]");
    const body = face?.querySelector<SVGRectElement>("rect.wf-face-body") ?? null;
    const faceRect = face?.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    return {
      face: face
        ? {
            computedFill: body ? getComputedStyle(body).fill : null,
            expression: face.getAttribute("data-expression"),
            faceBodyVar: face.style.getPropertyValue("--wf-face-body").trim() || null,
            faceState: face.getAttribute("data-face-state"),
            htmlHead: face.outerHTML.slice(0, 600),
            rect: faceRect
              ? {
                  height: Math.ceil(faceRect.height),
                  width: Math.ceil(faceRect.width),
                  x: Math.floor(faceRect.left),
                  y: Math.floor(faceRect.top),
                }
              : null,
          }
        : null,
      rect:
        tabRect.width > 0 && tabRect.height > 0
          ? {
              height: Math.ceil(tabRect.height),
              width: Math.ceil(tabRect.width),
              x: Math.floor(tabRect.left),
              y: Math.floor(tabRect.top),
            }
          : null,
      tabId: tab.getAttribute("data-side-pane-tab-id"),
      tabText: (tab.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 300),
      via: clickedVia,
    };
  }, via);
}

async function ensureFullAccessMode(): Promise<Record<string, unknown>> {
  const before = await getV4ConfigProjection();
  if (before.mode === "yolo") return { before, confirmed: false, switched: false };
  await switchV4Mode("yolo");
  const dialogSelector = '[data-testid="full-access-mode-confirm-dialog"]';
  const appeared = await browser
    .waitUntil(
      () =>
        browser.execute((selector) => Boolean(document.querySelector(selector)), dialogSelector),
      { timeout: 8_000, interval: 200, timeoutMsg: "full access 确认弹窗没有出现" },
    )
    .then(() => true)
    .catch(() => false);
  let confirmed = false;
  if (appeared) {
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
    confirmed = await browser.execute((selector) => {
      const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>(`${selector} button`)).at(
        -1,
      );
      if (!confirm || confirm.disabled) return false;
      confirm.click();
      return true;
    }, dialogSelector);
    if (confirmed) {
      await browser.waitUntil(
        () => browser.execute((selector) => !document.querySelector(selector), dialogSelector),
        { timeout: 15_000, interval: 200, timeoutMsg: "full access 确认弹窗没有关闭" },
      );
    }
  }
  await browser.waitUntil(
    async () => (await getV4ConfigProjection()).mode === "yolo",
    { timeout: 30_000, timeoutMsg: "没有切换到 Full access/yolo mode" },
  );
  return { after: await getV4ConfigProjection(), before, confirmed, switched: true };
}

// ── C. 文件动作 ─────────────────────────────────────────────────────────────

interface MenuItemFact {
  disabled: boolean;
  label: string;
}

interface VisibleMenuFacts {
  items: MenuItemFact[];
  rect: ClipRect | null;
  text: string;
}

function readVisibleMenu(): Promise<VisibleMenuFacts | null> {
  return browser.execute(() => {
    const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).filter(
      (menu) => menu.getClientRects().length > 0,
    );
    const menu =
      menus.find((candidate) =>
        /Save as|另存为|Show in Folder|在文件夹中显示|Open with|打开方式/u.test(
          candidate.innerText ?? "",
        ),
      ) ?? menus[menus.length - 1];
    if (!menu) return null;
    const rect = menu.getBoundingClientRect();
    return {
      items: Array.from(
        menu.querySelectorAll<HTMLElement>(
          '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [data-radix-collection-item]',
        ),
      )
        .filter((item) => item.getClientRects().length > 0)
        .map((item) => ({
          disabled:
            item.getAttribute("aria-disabled") === "true" || item.hasAttribute("data-disabled"),
          label: (item.innerText ?? "").replace(/\s+/gu, " ").trim(),
        })),
      rect:
        rect.width > 0 && rect.height > 0
          ? {
              height: Math.ceil(rect.height),
              width: Math.ceil(rect.width),
              x: Math.floor(rect.left),
              y: Math.floor(rect.top),
            }
          : null,
      text: (menu.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 1200),
    };
  });
}

async function waitForVisibleMenu(timeout = 10_000): Promise<VisibleMenuFacts> {
  let latest: VisibleMenuFacts | null = null;
  await browser.waitUntil(
    async () => {
      latest = await readVisibleMenu();
      return Boolean(latest && latest.items.length > 0);
    },
    { timeout, interval: 100, timeoutMsg: "右键菜单没有出现" },
  );
  return latest as unknown as VisibleMenuFacts;
}

async function closeVisibleMenu(): Promise<void> {
  await browser.execute(() => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    document.dispatchEvent(event);
  });
  await browser.pause(150);
  const stillOpen = await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).some(
      (menu) => menu.getClientRects().length > 0,
    ),
  );
  if (stillOpen) {
    await browser.execute(() => {
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
      );
      document.body.click();
    });
    await browser.pause(150);
  }
}

function findMenuItem(
  menu: VisibleMenuFacts,
  matcher: (label: string) => boolean,
): MenuItemFact | null {
  return menu.items.find((item) => matcher(item.label)) ?? null;
}

async function ensureSidePaneOpen(): Promise<void> {
  const isVisible = async () =>
    Boolean(
      await browser.execute(() => {
        const target =
          document.querySelector<HTMLElement>("[data-side-pane-content-slot]") ??
          document.querySelector<HTMLElement>("[data-side-pane-add-trigger]");
        const rect = target?.getBoundingClientRect();
        return Boolean(rect && rect.width > 100 && rect.height > 100);
      }),
    );
  if (await isVisible()) return;
  await clickTestIdByDom(TID_SIDE_PANE_TOGGLE, {
    timeout: 15_000,
    timeoutMsg: "没有找到右侧面板开关",
  });
  await browser.waitUntil(isVisible, { timeout: 15_000, interval: 200, timeoutMsg: "右侧面板没有打开" });
}

async function ensureFileTreeOpen(): Promise<void> {
  if (await isTestIdPresent(TID_WORKSPACE_FILE_TREE_PANEL)) return;
  await ensureSidePaneOpen();
  // 已存在的 file-manager tab 直接激活；否则从侧栏启动器打开“文件”。
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
        { timeout: 10_000, interval: 200, timeoutMsg: "侧面板 Open Tab 里没有文件入口" },
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
  await waitForTestIdByDom(TID_WORKSPACE_FILE_TREE_PANEL, { timeout: 20_000 });
}

async function clickFileTreeRowBySuffix(suffix: string): Promise<string | null> {
  const rowTestId = await browser.execute(
    (rowPrefix, needle) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}-"]`),
      );
      const row = rows.find((candidate) =>
        (candidate.getAttribute("data-testid") ?? "").endsWith(needle),
      );
      if (!row) return null;
      row.scrollIntoView({ block: "center" });
      row.click();
      return row.getAttribute("data-testid");
    },
    TID_WORKSPACE_FILE_TREE_ROW,
    suffix,
  );
  return rowTestId;
}

interface OpenSplitButtonFacts {
  chevronAriaLabel: string | null;
  groupText: string | null;
  headerRect: ClipRect | null;
  openAriaLabel: string | null;
  openDisabled: boolean | null;
  openText: string | null;
  previewPaneText: string | null;
  rect: ClipRect | null;
}

function readPreviewOpenSplitButton(): Promise<OpenSplitButtonFacts | null> {
  return browser.execute((paneTestId) => {
    const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
    // FileManagerPane 把 PreviewPane 的 header portal 到预览 pane 之外；Open 拆分按钮
    // 实际在 [data-file-manager-pane] 的第一行 header 里。
    const scope =
      Array.from(document.querySelectorAll<HTMLElement>("[data-file-manager-pane]")).find(
        (candidate) => candidate.getClientRects().length > 0,
      ) ?? document;
    const buttons = Array.from(scope.querySelectorAll<HTMLButtonElement>("button"));
    const open = buttons.find((button) =>
      ["Open", "打开"].includes((button.textContent ?? "").trim()),
    );
    const chevron = buttons.find((button) =>
      ["Choose app", "选择打开方式"].includes(button.getAttribute("aria-label") ?? ""),
    );
    const group = open?.parentElement ?? null;
    const rect = group?.getBoundingClientRect();
    const header = scope.firstElementChild?.getBoundingClientRect() ?? null;
    return {
      chevronAriaLabel: chevron?.getAttribute("aria-label") ?? null,
      groupText: group ? (group.innerText ?? "").replace(/\s+/gu, " ").trim() : null,
      headerRect:
        header && header.width > 0 && header.height > 0
          ? {
              height: Math.ceil(header.height),
              width: Math.ceil(header.width),
              x: Math.floor(header.left),
              y: Math.floor(header.top),
            }
          : null,
      openAriaLabel: open?.getAttribute("aria-label") ?? null,
      openDisabled: open ? open.disabled : null,
      openText: open ? (open.textContent ?? "").trim() : null,
      previewPaneText: pane
        ? (pane.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 400)
        : null,
      rect:
        rect && rect.width > 0 && rect.height > 0
          ? {
              height: Math.ceil(rect.height),
              width: Math.ceil(rect.width),
              x: Math.floor(rect.left),
              y: Math.floor(rect.top),
            }
          : null,
    };
  }, TID_PREVIEW_PANE);
}

async function openFileTreeRowContextMenu(suffix: string): Promise<VisibleMenuFacts> {
  const opened = await browser.execute(
    (rowPrefix, needle) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(`[data-testid^="${rowPrefix}-"]`),
      );
      const row = rows.find((candidate) =>
        (candidate.getAttribute("data-testid") ?? "").endsWith(needle),
      );
      if (!row) return false;
      const rect = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 30,
          clientY: rect.top + rect.height / 2,
          button: 2,
        }),
      );
      return true;
    },
    TID_WORKSPACE_FILE_TREE_ROW,
    suffix,
  );
  if (!opened) throw new Error(`文件树没有目标行 ${suffix}`);
  return waitForVisibleMenu();
}

async function openMessageFileLinkContextMenu(
  rowMarker: string,
  linkText: string,
): Promise<{ menu: VisibleMenuFacts; rowId: string | null }> {
  const rowId = await browser.execute(
    (timelineSelector, marker, expectedLink) => {
      const timeline = document.querySelector<HTMLElement>(timelineSelector);
      const row = Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []).find(
        (candidate) => (candidate.innerText ?? "").includes(marker),
      );
      if (!row) return null;
      row.scrollIntoView({ block: "center" });
      const link = Array.from(row.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
        (button.textContent ?? "").includes(expectedLink),
      );
      if (!link) return null;
      const rect = link.getBoundingClientRect();
      link.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
          button: 2,
        }),
      );
      return row.getAttribute("data-row-id");
    },
    TIMELINE_SELECTOR,
    rowMarker,
    linkText,
  );
  if (!rowId) throw new Error(`消息里没有可右键的文件链接 ${linkText}`);
  // 链接右键菜单会异步 stat 目标文件；等“另存为”出现再读完整菜单。
  await browser
    .waitUntil(
      async () => {
        const menu = await readVisibleMenu();
        return Boolean(
          menu?.items.some((item) => /Save as|另存为/u.test(item.label)) ||
            menu?.items.some((item) => /Show in Folder|在文件夹中显示/u.test(item.label)),
        );
      },
      { timeout: 8_000, interval: 200, timeoutMsg: "消息文件链接菜单没有出现另存为/定位项" },
    )
    .catch(() => undefined);
  const menu = await waitForVisibleMenu();
  return { menu, rowId };
}

interface FileActionCapabilities {
  openInEditorCount: number;
  saveAsDisabled: boolean | null;
  saveAsPresent: boolean;
  revealDisabled: boolean | null;
  revealPresent: boolean;
}

function readFileActionCapabilities(menu: VisibleMenuFacts): FileActionCapabilities {
  const saveAs = findMenuItem(menu, (label) => /Save as|另存为/u.test(label));
  const reveal = findMenuItem(
    menu,
    (label) =>
      /Show in Folder|在文件夹中显示|Open in File Explorer|在资源管理器中打开|Reveal/u.test(label),
  );
  return {
    openInEditorCount: menu.items.filter((item) =>
      /Visual Studio Code|Cursor|Zed|Sublime|IntelliJ|打开方式|Open with/u.test(item.label),
    ).length,
    saveAsDisabled: saveAs?.disabled ?? null,
    saveAsPresent: Boolean(saveAs),
    revealDisabled: reveal?.disabled ?? null,
    revealPresent: Boolean(reveal),
  };
}

async function readNibiBridgeCapabilities(): Promise<{ openExternalFile: string; saveFile: string }> {
  return browser.execute(() => {
    const bridge = (window as Window & { nibi?: Record<string, unknown> }).nibi;
    return {
      openExternalFile: typeof bridge?.openExternalFile,
      saveFile: typeof bridge?.saveFile,
    };
  });
}

// ── E. 图片文件引用 ─────────────────────────────────────────────────────────

interface ImageMentionFacts {
  ariaLabel: string | null;
  buttonRect: ClipRect | null;
  rowId: string | null;
  rowText: string;
  text: string;
}

async function openImageMentionPreview(): Promise<Record<string, unknown>> {
  const holder: { value: ImageMentionFacts | null } = { value: null };
  await browser.waitUntil(
    async () => {
      holder.value = (await browser.execute(
        (timelineSelector, marker) => {
          const timeline = document.querySelector<HTMLElement>(timelineSelector);
          const row = Array.from(
            timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
          ).find((candidate) => (candidate.innerText ?? "").includes(marker));
          const button = row?.querySelector<HTMLButtonElement>("[data-image-file-mention]");
          if (!row || !button) return null;
          row.scrollIntoView({ block: "center" });
          const rect = button.getBoundingClientRect();
          return {
            ariaLabel: button.getAttribute("aria-label"),
            buttonRect:
              rect.width > 0 && rect.height > 0
                ? {
                    height: Math.ceil(rect.height),
                    width: Math.ceil(rect.width),
                    x: Math.floor(rect.left),
                    y: Math.floor(rect.top),
                  }
                : null,
            rowId: row.getAttribute("data-row-id"),
            rowText: (row.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 500),
            text: (button.textContent ?? "").replace(/\s+/gu, " ").trim(),
          };
        },
        TIMELINE_SELECTOR,
        PARITY_IMAGE_MARKER,
      )) as ImageMentionFacts | null;
      return Boolean(holder.value);
    },
    { timeout: 60_000, interval: 300, timeoutMsg: "种入的图片文件引用没有渲染成按钮" },
  );
  const mention = holder.value;
  record("e.mention", mention);
  const buttonScreenshot = mention?.buttonRect
    ? await shotClip("13-image-mention-button", mention.buttonRect, { padding: 10, maxHeight: 180 })
    : null;
  record("e.mentionScreenshot", buttonScreenshot);

  const clicked = await browser.execute(() => {
    const button = document.querySelector<HTMLButtonElement>("[data-image-file-mention]");
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error("图片文件引用按钮不存在");

  await browser.waitUntil(
    () => browser.execute(() => Boolean(document.querySelector("[data-image-preview-actions]"))),
    { timeout: 30_000, interval: 200, timeoutMsg: "共享图片预览对话框没有出现" },
  );
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const image = document.querySelector<HTMLImageElement>('[role="dialog"] img');
        return Boolean(image && image.complete && image.naturalWidth > 0);
      }),
    { timeout: 30_000, interval: 200, timeoutMsg: "图片预览没有加载出真实像素" },
  );

  const dialog = (await browser.execute(() => {
    const dialogRoot = document.querySelector<HTMLElement>('[role="dialog"]');
    const image = dialogRoot?.querySelector<HTMLImageElement>("img") ?? null;
    const actions = dialogRoot?.querySelector<HTMLElement>("[data-image-preview-actions]");
    const rect = dialogRoot?.getBoundingClientRect();
    const imageRect = image?.getBoundingClientRect();
    const actionsRect = actions?.getBoundingClientRect();
    return {
      actionIds: Array.from(actions?.querySelectorAll<HTMLElement>("[data-image-preview-action]") ?? [])
        .map((element) => element.getAttribute("data-image-preview-action"))
        .filter((value): value is string => Boolean(value)),
      actionsRect:
        actionsRect && actionsRect.width > 0 && actionsRect.height > 0
          ? {
              height: Math.ceil(actionsRect.height),
              width: Math.ceil(actionsRect.width),
              x: Math.floor(actionsRect.left),
              y: Math.floor(actionsRect.top),
            }
          : null,
      dialogRect:
        rect && rect.width > 0 && rect.height > 0
          ? {
              height: Math.ceil(rect.height),
              width: Math.ceil(rect.width),
              x: Math.floor(rect.left),
              y: Math.floor(rect.top),
            }
          : null,
      image: image
        ? {
            alt: image.getAttribute("alt"),
            naturalHeight: image.naturalHeight,
            naturalWidth: image.naturalWidth,
            srcPrefix: (image.getAttribute("src") ?? "").slice(0, 32),
          }
        : null,
      imageRect:
        imageRect && imageRect.width > 0 && imageRect.height > 0
          ? {
              height: Math.ceil(imageRect.height),
              width: Math.ceil(imageRect.width),
              x: Math.floor(imageRect.left),
              y: Math.floor(imageRect.top),
            }
          : null,
      title: dialogRoot
        ?.querySelector('[class*="sr-only"]')
        ?.textContent?.replace(/\s+/gu, " ")
        .trim(),
    };
  })) as {
    actionIds: string[];
    actionsRect: ClipRect | null;
    dialogRect: ClipRect | null;
    image: {
      alt: string | null;
      naturalHeight: number;
      naturalWidth: number;
      srcPrefix: string;
    } | null;
    imageRect: ClipRect | null;
    title: string | undefined;
  };
  const screenshot = dialog.dialogRect
    ? await shotClip("14-image-preview-dialog", dialog.dialogRect, { maxHeight: 880 })
    : null;
  const imageScreenshot = dialog.imageRect
    ? await shotClip("14b-image-preview-image", dialog.imageRect, {
        maxHeight: 640,
        padding: 12,
      })
    : null;
  const actionsScreenshot = dialog.actionsRect
    ? await shotClip("14c-image-preview-actions", dialog.actionsRect, {
        maxHeight: 120,
        padding: 8,
      })
    : null;
  record("e.dialog", dialog);
  record("e.dialogScreenshot", screenshot);
  record("e.imageScreenshot", imageScreenshot);
  record("e.actionsScreenshot", actionsScreenshot);
  recordResult("e", { actionsScreenshot, dialog, imageScreenshot, mention, screenshot });

  await browser.execute(() => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    document.dispatchEvent(event);
  });
  await browser
    .waitUntil(
      () => browser.execute(() => !document.querySelector("[data-image-preview-actions]")),
      { timeout: 10_000, interval: 200 },
    )
    .catch(async () => {
      // Escape 没有生效时走对话框自带关闭按钮，避免模态遮住后续证据步骤。
      await browser.execute(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '[role="dialog"] button[aria-label="Close"]',
        );
        button?.click();
      });
      await browser.pause(300);
    });
  await browser
    .waitUntil(
      () => browser.execute(() => !document.querySelector("[data-image-preview-actions]")),
      { timeout: 10_000, interval: 200, timeoutMsg: "图片预览没有关闭" },
    )
    .catch(() => undefined);
  return { dialog, mention, screenshot };
}

// ── D. 重启任务 ─────────────────────────────────────────────────────────────

interface TaskMenuFacts {
  items: MenuItemFact[];
  restartDisabled: boolean | null;
  restartLabel: string | null;
  restartPresent: boolean;
  screenshot: string | null;
}

/** Radix DropdownMenuTrigger 由 pointerdown 打开；DOM `.click()` 不会触发菜单。 */
async function openRadixTriggerByTestId(testIdValue: string): Promise<boolean> {
  return browser.execute((value) => {
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
      (candidate) => candidate.dataset.testid === value,
    );
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const base = {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    element.dispatchEvent(
      new PointerEvent("pointerdown", { ...base, isPrimary: true, pointerType: "mouse" }),
    );
    element.dispatchEvent(
      new PointerEvent("pointerup", { ...base, isPrimary: true, pointerType: "mouse" }),
    );
    element.dispatchEvent(new MouseEvent("mousedown", base));
    element.dispatchEvent(new MouseEvent("mouseup", base));
    element.click();
    return true;
  }, testIdValue);
}

async function openTaskMenuAndReadRestart(): Promise<TaskMenuFacts> {
  const opened = await openRadixTriggerByTestId(TID_WORKSPACE_MORE_BUTTON);
  if (!opened) throw new Error("任务标题旁没有 More 菜单入口");
  await waitForVisibleMenu(15_000);
  const items = await browser.execute(() => {
    const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).filter(
      (menu) => menu.getClientRects().length > 0,
    );
    const menu = menus[menus.length - 1];
    return menu
      ? {
          items: Array.from(
            menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemcheckbox"]'),
          )
            .filter((item) => item.getClientRects().length > 0)
            .map((item) => ({
              disabled:
                item.getAttribute("aria-disabled") === "true" ||
                item.hasAttribute("data-disabled"),
              label: (item.innerText ?? "").replace(/\s+/gu, " ").trim(),
            })),
          restartDisabled:
            menu
              .querySelector<HTMLElement>('[data-testid="task-restart"]')
              ?.getAttribute("aria-disabled") === "true",
          restartLabel:
            menu
              .querySelector<HTMLElement>('[data-testid="task-restart"]')
              ?.innerText?.replace(/\s+/gu, " ")
              .trim() ?? null,
          restartPresent: Boolean(menu.querySelector('[data-testid="task-restart"]')),
        }
      : { items: [], restartDisabled: null, restartLabel: null, restartPresent: false };
  });
  const menuRect = await browser.execute(() => {
    const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).filter(
      (menu) => menu.getClientRects().length > 0,
    );
    const menu = menus[menus.length - 1];
    if (!menu) return null;
    const rect = menu.getBoundingClientRect();
    return {
      height: Math.ceil(rect.height),
      width: Math.ceil(rect.width),
      x: Math.floor(rect.left),
      y: Math.floor(rect.top),
    };
  });
  const screenshot = menuRect
    ? await shotClip("16-task-restart-menu", menuRect, { padding: 8, maxHeight: 720 })
    : null;
  return { ...items, screenshot };
}

async function observeRestartPendingAfterClick(): Promise<Record<string, unknown>> {
  const clicked = await browser.execute(() => {
    const item = document.querySelector<HTMLElement>('[data-testid="task-restart"]');
    if (!item) return false;
    item.click();
    return true;
  });
  if (!clicked) return { clicked: false, pendingLabel: null };
  const observed = await browser
    .waitUntil(
      async () => {
        let label = await browser.execute(() => {
          const item = document.querySelector<HTMLElement>('[data-testid="task-restart"]');
          return item?.innerText?.replace(/\s+/gu, " ").trim() ?? null;
        });
        if (!label) {
          // 点击后菜单关闭；重启在途时重新打开菜单应显示 “Restarting task…”。
          await openRadixTriggerByTestId(TID_WORKSPACE_MORE_BUTTON);
          await browser.pause(60);
          label = await browser.execute(() => {
            const item = document.querySelector<HTMLElement>('[data-testid="task-restart"]');
            return item?.innerText?.replace(/\s+/gu, " ").trim() ?? null;
          });
        }
        return label && /Restarting task|正在重启任务/u.test(label) ? label : null;
      },
      { timeout: 12_000, interval: 60 },
    )
    .then((label) => String(label))
    .catch(() => null);
  let screenshot: string | null = null;
  if (observed) {
    const rect = await browser.execute(() => {
      const menus = Array.from(document.querySelectorAll<HTMLElement>('[role="menu"]')).filter(
        (menu) => menu.getClientRects().length > 0,
      );
      const menu = menus[menus.length - 1];
      if (!menu) return null;
      const box = menu.getBoundingClientRect();
      return {
        height: Math.ceil(box.height),
        width: Math.ceil(box.width),
        x: Math.floor(box.left),
        y: Math.floor(box.top),
      };
    });
    screenshot = rect
      ? await shotClip("17-task-restarting-pending", rect, { padding: 8, maxHeight: 720 })
      : null;
  }
  await closeVisibleMenu();
  return { clicked: true, pendingLabel: observed, screenshot };
}

// ── 种子 ────────────────────────────────────────────────────────────────────

function appendParityTranscriptRows(options: {
  modelId: string;
  providerId: string;
  workspacePath: string;
}): void {
  const databasePath = join(E2E_HOME_DIR!, ".nibi", "cli", "db", "db.sqlite");
  if (!existsSync(databasePath)) {
    throw new Error(`parity transcript seed 没有找到 CLI DB: ${databasePath}`);
  }
  const database = new DatabaseSync(databasePath);
  const createdAt = Date.now();
  const completedAt = createdAt + 400;
  const userText = `${PARITY_IMAGE_MARKER}: open [${PARITY_IMAGE_FILENAME}](${PARITY_IMAGE_FILENAME}) in the shared preview.`;
  const assistantText = `${PARITY_FILE_MARKER}: see [${PARITY_FILE_FILENAME}](${PARITY_FILE_FILENAME}) for the workspace notes.`;
  const userId = "msg_user_parity_batch_image";
  const assistantId = "msg_assistant_parity_batch_file_link";
  try {
    database
      .prepare(
        "insert or replace into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
      )
      .run(
        userId,
        PARITY_SESSION_ID,
        createdAt,
        createdAt,
        JSON.stringify({
          agent: "nibi-agent",
          anchor: { turnId: PARITY_TURN_ID },
          content: userText,
          metadata: {
            conversationInputIntent: {
              admittedAt: createdAt,
              attachments: [],
              clientId: "cli",
              delivery: { admitted: "queue", requested: "queue" },
              dispatch: { state: "drained" },
              kind: "sendText",
              modelSelection: { modelId: options.modelId, providerId: options.providerId },
              order: { admissionSeq: 90 },
              queueItemId: "cmd_parity_batch_image",
              sourceCommandId: "cmd_parity_batch_image",
              steer: { state: "notRequested" },
              text: userText,
            },
          },
          modelSelection: { modelId: options.modelId, providerId: options.providerId },
          path: { cwd: options.workspacePath, root: options.workspacePath },
          role: "user",
          time: { created: createdAt },
        }),
      );
    database
      .prepare(
        "insert or replace into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "part_user_parity_batch_image",
        userId,
        PARITY_SESSION_ID,
        createdAt,
        createdAt,
        JSON.stringify({ text: userText, time: { end: createdAt, start: createdAt }, type: "text" }),
      );
    database
      .prepare(
        "insert or replace into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
      )
      .run(
        assistantId,
        PARITY_SESSION_ID,
        createdAt + 200,
        completedAt,
        JSON.stringify({
          agent: "nibi-agent",
          anchor: { turnId: PARITY_TURN_ID },
          content: assistantText,
          cost: 0,
          finish: "stop",
          mode: "build",
          modelID: options.modelId,
          parentID: userId,
          path: { cwd: options.workspacePath, root: options.workspacePath },
          providerID: options.providerId,
          role: "assistant",
          time: { completed: completedAt, created: createdAt + 200 },
          tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
        }),
      );
    database
      .prepare(
        "insert or replace into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "part_assistant_parity_batch_file_link",
        assistantId,
        PARITY_SESSION_ID,
        createdAt + 200,
        completedAt,
        JSON.stringify({
          text: assistantText,
          time: { end: completedAt, start: createdAt + 200 },
          type: "text",
        }),
      );
  } finally {
    database.close();
  }
}

describe("Parity batch 2026-11-20 evidence（真实 Desktop）", () => {
  before(async function () {
    this.timeout(600_000);
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const providerId = process.env.E2E_PROVIDER_ID?.trim() || "e2e-upstream";
    const modelId = process.env.E2E_PROVIDER_MODEL?.trim() || "deepseek-v4-flash";
    const thoughtLevel = process.env.E2E_PROVIDER_THOUGHT_LEVEL?.trim() || undefined;
    record("fixture.provider", {
      modelId,
      providerId,
      replayFixture: process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.trim() || null,
      thoughtLevel: thoughtLevel ?? null,
    });
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: async () => {
        // U30 同一条 CLI transcript 种子路径；Electron 完全退出后写入，避免 tasks-index 被 Host 覆盖。
        await seedSixthBatchSessions({
          e2eHomeDir: E2E_HOME_DIR,
          modelId,
          providerId,
          workspacePath: DEFAULT_WORKSPACE,
          ...(thoughtLevel ? { thoughtLevel } : {}),
        });
        const imagePath = await writeSixthBatchImage(DEFAULT_WORKSPACE);
        appendParityTranscriptRows({ modelId, providerId, workspacePath: DEFAULT_WORKSPACE });
        record("fixture.image", { path: imagePath });
        record("fixture.pluginSeed", readPluginSeedState(E2E_HOME_DIR));
        record("fixture.transcript", {
          assistantMarker: PARITY_FILE_MARKER,
          imageMarker: PARITY_IMAGE_MARKER,
          sessionId: PARITY_SESSION_ID,
        });
      },
    });
    await prepareV4ConversationE2E();
    await setRendererLocale(LOCALE);
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

  it("A. 设置搜索：动态工作流/提示音/证书 命中并跳转", async function () {
    this.timeout(300_000);
    await openSettings();
    const expectations: SettingsSearchExpectation[] = [
      {
        key: "dynamic-workflow",
        query: "动态工作流",
        resultId: "agentBehavior:dynamicWorkflows",
        sectionId: "agentBehavior",
        targetId: "agentBehavior.dynamicWorkflows",
        title: "Dynamic workflows",
      },
      {
        key: "notification-sound",
        query: "提示音",
        resultId: "general:notificationSound",
        sectionId: "general",
        targetId: "general.notificationSound",
        title: "Notification sound",
      },
      {
        key: "certificate",
        query: "证书",
        resultId: "general:httpProxyCaCertPath",
        sectionId: "general",
        targetId: "general.httpProxyCaCertPath",
        title: "Custom certificate",
      },
    ];
    const captured: Record<string, unknown>[] = [];
    for (const expectation of expectations) {
      const current = await runSettingsSearch(expectation);
      const results = current.results as SettingsSearchResultFact[];
      const first = results[0];
      expect(first?.id).toBe(expectation.resultId);
      expect(first?.title).toBe(expectation.title);
      expect(current.activeSection).toBe(expectation.sectionId);
      const target = current.target as SettingsTargetFact;
      expect(target.present).toBe(true);
      expect(target.highlighted).toBe("true");
      expect(target.text.length).toBeGreaterThan(0);
      captured.push(current);
    }
    recordResult("a", captured);
  });

  it("B. 子智能体表情：Agent 卡 / 状态面板 / 侧栏 tab", async function () {
    this.timeout(600_000);
    await closeSettingsIfOpen();
    await ensureSidebarVisible();
    await ensureFullAccessMode();
    const draft = await startDraftFromProjectSafe();
    record("b.draft", draft);
    const prompt = [
      `${AGENT_PARENT_MARKER}: launch exactly one Agent.`,
      "Use subagent_type general-purpose and rely on the task notification for the child result.",
    ].join(" ");
    await sendV4PromptAndWaitAccepted(
      prompt,
      AGENT_PARENT_MARKER,
      "子智能体证据 prompt 没有被接受",
      120_000,
    );
    // Agent 卡与状态面板在 tool_use 投影出来后就应可见；ack 故意延迟 8s，
    // 让 running/完成前表情有真实截图窗口，而不是靠碰运气抢 70ms。
    const { card, status } = await waitForAgentCardAndRunningStatus(60_000);
    const cardScreenshot = card?.rect
      ? await shotClip("04-subagent-agent-card", card.rect, {
          maxHeight: 620,
          padding: 4,
        })
      : null;
    const statusScreenshot = status?.panelRect
      ? await shotClip("05-subagent-status-panel-running", status.panelRect, {
          maxHeight: 720,
          padding: 4,
        })
      : null;
    const tab = await openSubagentSidePaneTab();
    const tabScreenshot = tab?.rect
      ? await shotClip("06-subagent-side-pane-tab", tab.rect, { maxHeight: 180, padding: 8 })
      : null;
    record("b.agentCard", card);
    record("b.statusPanel", status);
    record("b.sidePaneTab", tab);
    record("b.agentCardScreenshot", cardScreenshot);
    record("b.statusPanelScreenshot", statusScreenshot);
    record("b.sidePaneTabScreenshot", tabScreenshot);

    expect(["scanning", "content"]).toContain(card?.face?.faceState);
    expect(colorToHex(card?.face?.faceBodyVar)).toBe("#3c82f6");
    expect(colorToHex(card?.face?.computedFill)).toBe("#3c82f6");
    expect(status?.face?.faceState).toBe("scanning");
    expect(colorToHex(status?.face?.faceBodyVar)).toBe("#3c82f6");
    expect(tab?.face?.faceState).toBe("idle");
    expect(colorToHex(tab?.face?.faceBodyVar)).toBe("#3c82f6");
    expect(tab?.tabId ?? "").toContain("subagent-session");
    expect(status?.rowText.length ?? 0).toBeGreaterThan(0);

    // general-purpose 的 definition.background=true：父回合在 ack 后结束。
    await waitForV4TimelineContaining(AGENT_PARENT_ACK, 60_000);
    await waitForV4TimelineContaining(AGENT_PARENT_DONE, 180_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.sessionId !== "draft",
      "子智能体证据回合没有结束",
      180_000,
    );
    const completedCard = await scrollTimelineToFindAgentCard();
    record("b.completedAgentCard", completedCard);
    recordResult("b", {
      agentCard: { face: card?.face, rowText: card?.rowText, screenshot: cardScreenshot },
      completedAgentCard: { face: completedCard?.face, screenshot: null },
      sidePaneTab: { face: tab?.face, screenshot: tabScreenshot, tabId: tab?.tabId, via: tab?.via },
      statusPanel: { face: status?.face, screenshot: statusScreenshot, rowText: status?.rowText },
    });
  });

  it("C. 文件动作：Open ▾、文件树行菜单与消息文件链接菜单", async function () {
    this.timeout(420_000);
    // 打开种入的 transcript 任务，消息文件链接来自真实冷加载的 assistant 文本。
    await waitForTaskRowInProject(PARITY_SESSION_ID, DEFAULT_WORKSPACE);
    await selectV4TaskById(PARITY_SESSION_ID);
    await waitForV4TimelineContaining(PARITY_FILE_MARKER, 120_000);
    await ensureFileTreeOpen();
    const previewRowTestId = await clickFileTreeRowBySuffix(PARITY_FILE_FILENAME);
    record("c.previewRowTestId", previewRowTestId);
    if (!previewRowTestId) throw new Error("文件树没有 README.md 行");
    await waitForTestIdByDom(TID_PREVIEW_PANE, { timeout: 30_000 });
    await browser.waitUntil(
      async () => Boolean((await readPreviewOpenSplitButton())?.openText),
      { timeout: 30_000, interval: 200, timeoutMsg: "预览头部没有 Open 拆分按钮" },
    );
    const split = await readPreviewOpenSplitButton();
    record("c.openSplitButton", split);
    const splitScreenshot = split?.headerRect
      ? await shotClip("08-file-preview-open-split-button", split.headerRect, {
          maxHeight: 60,
        })
      : null;
    record("c.openSplitButtonScreenshot", splitScreenshot);
    expect(split?.openText).toBe("Open");
    expect(split?.chevronAriaLabel).toBe("Choose app");
    expect(split?.groupText ?? "").toContain("Open");
    expect(split?.rect?.width ?? 0).toBeGreaterThan(40);

    const treeMenuEn = await openFileTreeRowContextMenu(PARITY_FILE_FILENAME);
    const treeMenuEnShot = treeMenuEn.rect
      ? await shotClip("09-file-tree-row-menu", treeMenuEn.rect, { maxHeight: 640, padding: 8 })
      : null;
    const treeMenuEnActions = readFileActionCapabilities(treeMenuEn);
    record("c.fileTreeMenu.en", treeMenuEn);
    record("c.fileTreeMenu.enScreenshot", treeMenuEnShot);
    expect(treeMenuEnActions.saveAsPresent).toBe(true);
    expect(treeMenuEnActions.revealPresent).toBe(true);
    await closeVisibleMenu();

    await setRendererLocale("zh-CN");
    const treeMenuZh = await openFileTreeRowContextMenu(PARITY_FILE_FILENAME);
    const treeMenuZhShot = treeMenuZh.rect
      ? await shotClip("09b-file-tree-row-menu-zh", treeMenuZh.rect, {
          maxHeight: 640,
          padding: 8,
        })
      : null;
    const treeMenuZhActions = readFileActionCapabilities(treeMenuZh);
    record("c.fileTreeMenu.zh", treeMenuZh);
    record("c.fileTreeMenu.zhScreenshot", treeMenuZhShot);
    expect(treeMenuZhActions.saveAsPresent).toBe(true);
    expect(treeMenuZhActions.revealPresent).toBe(true);
    await closeVisibleMenu();

    const messageMenuZh = await openMessageFileLinkContextMenu(
      PARITY_FILE_MARKER,
      PARITY_FILE_FILENAME,
    );
    const messageMenuZhShot = messageMenuZh.menu.rect
      ? await shotClip("11-message-file-link-menu-zh", messageMenuZh.menu.rect, {
          maxHeight: 640,
          padding: 8,
        })
      : null;
    const messageMenuZhActions = readFileActionCapabilities(messageMenuZh.menu);
    record("c.messageFileLinkMenu.zh", {
      menu: messageMenuZh.menu,
      rowId: messageMenuZh.rowId,
    });
    record("c.messageFileLinkMenu.zhScreenshot", messageMenuZhShot);
    expect(messageMenuZhActions.saveAsPresent).toBe(true);
    expect(messageMenuZhActions.revealPresent).toBe(true);
    await closeVisibleMenu();
    await setRendererLocale(LOCALE);

    const messageMenuEn = await openMessageFileLinkContextMenu(
      PARITY_FILE_MARKER,
      PARITY_FILE_FILENAME,
    );
    const messageMenuEnShot = messageMenuEn.menu.rect
      ? await shotClip("11b-message-file-link-menu", messageMenuEn.menu.rect, {
          maxHeight: 640,
          padding: 8,
        })
      : null;
    const messageMenuEnActions = readFileActionCapabilities(messageMenuEn.menu);
    record("c.messageFileLinkMenu.en", {
      menu: messageMenuEn.menu,
      rowId: messageMenuEn.rowId,
    });
    record("c.messageFileLinkMenu.enScreenshot", messageMenuEnShot);
    expect(messageMenuEnActions.saveAsPresent).toBe(true);
    expect(messageMenuEnActions.revealPresent).toBe(true);
    await closeVisibleMenu();

    const bridge = await readNibiBridgeCapabilities();
    record("c.capabilities", {
      bridge,
      fileTreeMenuEn: treeMenuEnActions,
      fileTreeMenuZh: treeMenuZhActions,
      messageMenuEn: messageMenuEnActions,
      messageMenuZh: messageMenuZhActions,
    });
    expect(bridge.saveFile).toBe("function");
    expect(bridge.openExternalFile).toBe("function");
    recordResult("c", {
      capabilities: {
        bridge,
        fileTreeMenuEn: treeMenuEnActions,
        fileTreeMenuZh: treeMenuZhActions,
        messageMenuEn: messageMenuEnActions,
        messageMenuZh: messageMenuZhActions,
      },
      openSplitButton: split,
      screenshots: {
        messageEn: messageMenuEnShot,
        messageZh: messageMenuZhShot,
        previewHeader: splitScreenshot,
        treeEn: treeMenuEnShot,
        treeZh: treeMenuZhShot,
      },
    });
  });

  it("E. 图片文件引用：按钮打开共享图片预览对话框", async function () {
    this.timeout(240_000);
    await waitForTaskRowInProject(PARITY_SESSION_ID, DEFAULT_WORKSPACE);
    await selectV4TaskById(PARITY_SESSION_ID);
    await waitForV4TimelineContaining(PARITY_IMAGE_MARKER, 120_000);
    const result = await openImageMentionPreview();
    const dialog = result.dialog as {
      actionIds: string[];
      image: { naturalHeight: number; naturalWidth: number; srcPrefix: string } | null;
    };
    expect(dialog.image?.srcPrefix.startsWith("data:image/png")).toBe(true);
    expect(dialog.image?.naturalWidth ?? 0).toBeGreaterThan(0);
    expect(dialog.image?.naturalHeight ?? 0).toBeGreaterThan(0);
    expect(dialog.actionIds.length).toBeGreaterThanOrEqual(3);
  });

  it("F. 插件：全部更新（N）按钮是否出现（无更新时如实记录）", async function () {
    this.timeout(240_000);
    await openSettings();
    await clickSettingsSection("plugin");
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.querySelectorAll('[data-testid="plugin-settings-plugin-row"]').length > 0,
        ),
      { timeout: 60_000, interval: 300, timeoutMsg: "设置页 Plugins 没有列出已安装插件" },
    );
    const snapshot = (await browser.execute(() => {
      const updateAll = document.querySelector<HTMLElement>(
        '[data-testid="plugin-settings-update-all"]',
      );
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-testid="plugin-settings-plugin-row"]'),
      );
      return {
        installedCount: rows.length,
        pluginIds: rows
          .map((row) => row.getAttribute("data-plugin-id"))
          .filter((value): value is string => Boolean(value)),
        updateAllDisabled: updateAll
          ? updateAll.getAttribute("aria-disabled") === "true" ||
            (updateAll as HTMLButtonElement).disabled
          : null,
        updateAllLabel: updateAll
          ? (updateAll.innerText ?? "").replace(/\s+/gu, " ").trim()
          : null,
        updateAllPresent: Boolean(updateAll),
      };
    })) as {
      installedCount: number;
      pluginIds: string[];
      updateAllDisabled: boolean | null;
      updateAllLabel: string | null;
      updateAllPresent: boolean;
    };
    record("f.plugins", snapshot);
    const updatePath = snapshot.updateAllPresent
      ? "button-present"
      : "no-updates-available-in-isolated-home";
    record("f.updatePath", updatePath);
    const mainRect = await readRect(SETTINGS_MAIN_SELECTOR);
    const screenshot = mainRect
      ? await shotClip("15-plugins-update-all", mainRect, { maxHeight: 520 })
      : null;
    record("f.screenshot", screenshot);
    recordResult("f", {
      ...snapshot,
      screenshot,
      updatePath,
    });
    expect(snapshot.installedCount).toBeGreaterThan(0);
    if (snapshot.updateAllPresent) {
      expect(snapshot.updateAllLabel ?? "").toMatch(/Update all|全部更新/u);
    } else {
      // 隔离 HOME 内没有可更新插件时按钮按设计不渲染；记录事实，不伪造更新。
      expect(updatePath).toBe("no-updates-available-in-isolated-home");
    }
    await closeSettingsIfOpen();
  });

  it("D. 重启任务：任务菜单 Restart task 与 replay 下的 pending/恢复", async function () {
    this.timeout(300_000);
    await closeSettingsIfOpen();
    await waitForTaskRowInProject(PARITY_SESSION_ID, DEFAULT_WORKSPACE);
    await selectV4TaskById(PARITY_SESSION_ID);
    await waitForV4TimelineContaining(PARITY_IMAGE_MARKER, 120_000);
    const menu = await openTaskMenuAndReadRestart();
    record("d.taskMenu", menu);
    expect(menu.restartPresent).toBe(true);
    expect(menu.restartLabel).toBe("Restart task");
    expect(menu.restartDisabled).toBe(false);

    const pending = await observeRestartPendingAfterClick();
    record("d.restartClick", pending);
    const recovered = await waitForV4Pane(
      (snapshot) => snapshot.sessionId === PARITY_SESSION_ID && !snapshot.canStop,
      "重启任务后会话没有恢复",
      180_000,
    )
      .then(() => true)
      .catch(() => false);
    const timelineAfterRestart = await waitForV4TimelineContaining(PARITY_IMAGE_MARKER, 60_000)
      .then(() => true)
      .catch(() => false);
    record("d.recovery", { recovered, timelineAfterRestart });
    recordResult("d", {
      menu: {
        items: menu.items.map((item) => item.label),
        restartDisabled: menu.restartDisabled,
        restartLabel: menu.restartLabel,
        restartPresent: menu.restartPresent,
        screenshot: menu.screenshot,
      },
      pending,
      recovery: { recovered, timelineAfterRestart },
    });
    // 点击本身只作为 replay 下可选证据；硬性要求是菜单项与标签存在。
    expect(menu.screenshot).not.toBeNull();
  });
});

async function startDraftFromProjectSafe(): Promise<Record<string, unknown>> {
  const before = await getV4PaneSnapshot();
  if (before.sessionId === "draft") return { reused: true, sessionId: before.sessionId };
  await startDraftFromProject(DEFAULT_WORKSPACE);
  const after = await waitForV4Pane(
    (snapshot) => snapshot.sessionId === "draft",
    "新建任务后没有回到 draft",
    30_000,
  );
  return { reused: false, sessionId: after.sessionId };
}
