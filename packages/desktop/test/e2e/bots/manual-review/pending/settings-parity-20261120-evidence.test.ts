/**
 * Settings parity evidence for the 2026-11-20 fixes (manual-review / pending).
 *
 * Real Electron Desktop + isolated HOME + replay upstream. Three fixed items:
 * A. Settings → 行为与工具 (agentBehavior): nav item, section title, and the seven rows
 *    (tool search / enhanced Find / interaction / auto-continue / model I/O / reasoning / todos).
 *    The screenshot clips the settings <main> pane, not the full screen.
 * B. Settings → 子智能体: general-purpose / Explore rows and their procedural workflow face.
 *    The avatar body fill must resolve to #3C82F6 (general-purpose) and #54B9A6 (Explore).
 * C. New task in the isolated workspace: insert a canonical plugin mention for
 *    spreadsheets@nibi-official through the composer @ picker (type `@spreadsheets`, click the
 *    plugin option), send a short prompt, and verify the turn completes with no
 *    `未启用` / `插件` rejection banner or toast. Workspace and session reference catalogs are
 *    recorded from the real Host/kernel path.
 * D. Best-effort: open the same task's plugin side-panel entry and confirm it no longer shows
 *    `当前任务没有连接这个插件`. Unsupported paths are recorded honestly, never faked.
 *
 * Run from the repo root (same isolated-home contract as the sixth-batch evidence):
 *   NIBI_E2E_HOME_DIR=<isolated> NIBI_E2E_EVIDENCE_DIR=<evidence dir> \
 *   E2E_PROVIDER_HTTP_MODE=replay \
 *   E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,\
 * packages/desktop/test/e2e/fixtures/upstream/settings-parity-20261120.json \
 *   NIBI_BUNDLED_AGENT_RESOURCE_DIR=D:\NIBI\NIBI-Client\apps\nibi-cli \
 *   pnpm --filter @nibi/desktop exec wdio run wdio.conf.ts \
 *     --spec test/e2e/bots/manual-review/pending/settings-parity-20261120-evidence.test.ts
 *
 * The official plugin cache is seeded by the same CLI path used by
 * `helpers/tier2-sixth-batch.ts:seedOfficialPluginsViaCli` while Electron is fully exited,
 * so the Rust kernel reads the same `<App> <nibi.cjs> __nibi-plugin-host <server.mjs>` MCP argv
 * that the bug report names.
 */
/* eslint-disable max-lines -- one pending evidence entry intentionally keeps A/B/C/D locators, screenshots and facts together. */
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_PLUGIN_UI_CARD,
  TID_PROMPT_SUGGESTION_OPTION,
  TID_PROMPT_SUGGESTION_PANEL,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_SIDE_PANE_TOGGLE,
  TID_SUBAGENT_ROW,
  TID_TASK_SETTINGS_BUTTON,
  TID_V4_COMPOSER_INPUT,
  TID_V4_SESSION_PANE,
  TID_V4_TIMELINE,
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
import { getPluginReferenceCatalog } from "../../../helpers/plugin-management-lifecycle.js";
import { startDraftFromProject } from "../../../helpers/project-sidebar.js";
import { readPluginSeedState, seedOfficialPluginsViaCli } from "../../../helpers/tier2-sixth-batch.js";
import {
  V4_MAIN_PANE_ID,
  clickV4Send,
  clickV4SlashOption,
  getV4ComposerText,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const EVIDENCE_DIR =
  process.env.NIBI_E2E_EVIDENCE_DIR?.trim() ||
  join(process.cwd(), ".e2e-artifacts", "settings-parity-20261120");
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

const PLUGIN_ID = "spreadsheets@nibi-official";
const PLUGIN_OPTION_ID = `plugin:${PLUGIN_ID}`;
const PROMPT_MARKER = "E2E_SETTINGS_PARITY_PLUGIN_SEND";
const REPLY_MARKER = "E2E_SETTINGS_PARITY_REPLY_OK";
const OFFICE_PLUGIN_IDS = [
  "documents@nibi-official",
  "pdf@nibi-official",
  "presentations@nibi-official",
  "spreadsheets@nibi-official",
] as const;
const AGENT_BEHAVIOR_TARGETS = [
  "agentBehavior.toolSearch",
  "agentBehavior.nativeSearchEnhancements",
  "agentBehavior.interaction",
  "agentBehavior.askUserQuestionAutoResolution",
  "agentBehavior.modelIoFullRetention",
  "agentBehavior.reasoning",
  "agentBehavior.todos",
] as const;

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

async function restoreMainWindowSize(original: WindowGeometry | null): Promise<void> {
  if (!original) return;
  await browser.electron.execute(
    (electron, minimum, size) => {
      const win = electron.BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      win?.setMinimumSize(minimum[0], minimum[1]);
      win?.setContentSize(size[0], size[1]);
    },
    original.minimum,
    original.size,
  );
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

interface AgentBehaviorRowFact {
  checked: string | null;
  controlKind: string;
  controlTestId: string | null;
  label: string | null;
  target: string | null;
  text: string;
  valueText: string | null;
}

interface AgentBehaviorFacts {
  dynamicWorkflow: { present: boolean; text: string | null };
  navItem: {
    ariaCurrent: string | null;
    present: boolean;
    sectionId: string | null;
    testId: string | null;
    text: string | null;
  };
  pageActiveSection: string | null;
  sectionTitle: string | null;
  rows: AgentBehaviorRowFact[];
}

function readAgentBehaviorFacts(): Promise<AgentBehaviorFacts> {
  return browser.execute(
    (pageSelector, navTestId, titleTarget) => {
      const page = document.querySelector<HTMLElement>(pageSelector);
      const navItem = document.querySelector<HTMLElement>(`[data-testid="${navTestId}"]`);
      const titleSection = document.querySelector<HTMLElement>(
        `[data-settings-search-target="${titleTarget}"]`,
      );
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-settings-search-target^="agentBehavior."]'),
      ).map((row) => {
        const switchEl = row.querySelector<HTMLElement>('button[role="switch"]');
        const selectEl = row.querySelector<HTMLElement>('[role="combobox"]');
        const labelEl =
          row.querySelector<HTMLElement>("div.font-medium") ?? row.querySelector<HTMLElement>("div");
        return {
          checked: switchEl?.getAttribute("aria-checked") ?? null,
          controlKind: switchEl ? "switch" : selectEl ? "select" : "unknown",
          controlTestId:
            switchEl?.getAttribute("data-testid") ??
            selectEl?.getAttribute("data-testid") ??
            null,
          label: labelEl?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
          target: row.getAttribute("data-settings-search-target"),
          text: (row.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 400),
          valueText: selectEl?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
        };
      });
      const dynamicWorkflow = document.querySelector<HTMLElement>(
        '[data-testid="settings-dynamic-workflow-mode-trigger"]',
      );
      return {
        dynamicWorkflow: {
          present: Boolean(dynamicWorkflow),
          text: dynamicWorkflow?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
        },
        navItem: {
          ariaCurrent: navItem?.getAttribute("aria-current") ?? null,
          present: Boolean(navItem),
          sectionId: navItem?.getAttribute("data-settings-section-nav") ?? null,
          testId: navItem?.getAttribute("data-testid") ?? null,
          text: navItem?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
        },
        pageActiveSection: page?.getAttribute("data-active-section") ?? null,
        sectionTitle:
          titleSection?.querySelector("h2")?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
        rows,
      };
    },
    SETTINGS_PAGE_SELECTOR,
    testId(TID_SETTINGS_SECTION_NAV, "agentBehavior"),
    "section:agentBehavior",
  );
}

interface SubagentAvatarFacts {
  avatarCount: number;
  avatarHtmlHead: string | null;
  bodyComputedFill: string | null;
  bodyFillAttribute: string | null;
  inlineFaceBody: string | null;
  rowPresent: boolean;
  rowText: string | null;
}

function readSubagentAvatar(name: string): Promise<SubagentAvatarFacts> {
  return browser.execute((rowTestId) => {
    const row = document.querySelector<HTMLElement>(`[data-testid="${rowTestId}"]`);
    const avatar = row?.querySelector<SVGSVGElement>("svg[data-subagent-avatar]") ?? null;
    const body =
      avatar?.querySelector<SVGRectElement>("rect.wf-face-body") ??
      avatar?.querySelector<SVGRectElement>("rect") ??
      null;
    return {
      avatarCount: row?.querySelectorAll("svg[data-subagent-avatar]").length ?? 0,
      avatarHtmlHead: avatar?.outerHTML.slice(0, 600) ?? null,
      bodyComputedFill: body ? getComputedStyle(body).fill : null,
      bodyFillAttribute: body?.getAttribute("fill") ?? null,
      inlineFaceBody: avatar?.style.getPropertyValue("--wf-face-body").trim() ?? null,
      rowPresent: Boolean(row),
      rowText: row ? (row.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 400) : null,
    };
  }, testId(TID_SUBAGENT_ROW, name));
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

interface PluginSettingsRowFact {
  enabled: string | null;
  pluginId: string;
  present: boolean;
  text: string | null;
}

/** 设置页 Plugins 的四个 Office 内置插件开关（Node 发现面）作为对照事实。 */
async function readSettingsPluginRows(): Promise<Record<string, unknown>> {
  try {
    await openSettings();
    await clickSettingsSection("plugin");
    await browser.waitUntil(
      () =>
        browser.execute((ids) => {
          return ids.every((id) =>
            Boolean(
              document.querySelector(
                `[data-testid="plugin-settings-plugin-row"][data-plugin-id="${id}"]`,
              ),
            ),
          );
        }, [...OFFICE_PLUGIN_IDS]),
      { timeout: 45_000, interval: 300, timeoutMsg: "设置页 Plugins 没有列出四个 Office 插件" },
    );
    const rows = (await browser.execute(
      (ids) =>
        ids.map((id) => {
          const row = document.querySelector<HTMLElement>(
            `[data-testid="plugin-settings-plugin-row"][data-plugin-id="${id}"]`,
          );
          const toggle = row?.querySelector<HTMLElement>(
            '[data-testid="plugin-settings-enabled-switch"]',
          );
          return {
            enabled: toggle?.getAttribute("aria-checked") ?? null,
            pluginId: id,
            present: Boolean(row),
            text: row ? (row.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 300) : null,
          };
        }),
      [...OFFICE_PLUGIN_IDS],
    )) as PluginSettingsRowFact[];
    await closeSettingsIfOpen();
    return { rows };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await closeSettingsIfOpen().catch(() => undefined);
    return { error: message, rows: [] };
  }
}

interface PluginCatalogSummary {
  authority: string | null;
  office: Array<{
    conflictingPluginIds: string[];
    enabled: boolean | null;
    mcpServerNames: string[];
    pluginId: string;
    present: boolean;
    skillQualifiedNames: string[];
  }>;
  total: number;
}

function summarizeCatalog(
  catalog: { authority?: string; plugins?: Array<Record<string, unknown>> } | null,
): PluginCatalogSummary {
  const entries = catalog?.plugins ?? [];
  return {
    authority: typeof catalog?.authority === "string" ? catalog.authority : null,
    office: OFFICE_PLUGIN_IDS.map((id) => {
      const entry = entries.find((candidate) => candidate.pluginId === id);
      return {
        conflictingPluginIds: Array.isArray(entry?.conflictingPluginIds)
          ? (entry.conflictingPluginIds as string[])
          : [],
        enabled: typeof entry?.enabled === "boolean" ? entry.enabled : null,
        mcpServerNames: Array.isArray(entry?.mcpServerNames)
          ? (entry.mcpServerNames as string[])
          : [],
        pluginId: id,
        present: Boolean(entry),
        skillQualifiedNames: Array.isArray(entry?.skillQualifiedNames)
          ? (entry.skillQualifiedNames as string[])
          : [],
      };
    }),
    total: entries.length,
  };
}

interface ComposerMentionFact {
  category: string | null;
  mentionId: string | null;
  text: string;
}

interface ComposerFacts {
  bridgeText: string | null;
  domText: string;
  mentionCount: number;
  mentions: ComposerMentionFact[];
}

function readComposerFacts(): Promise<ComposerFacts> {
  return browser.execute((inputTestId) => {
    type LexicalElement = HTMLElement & {
      __nibiLexicalInputE2E?: { getText: () => string };
    };
    const input = document.querySelector<LexicalElement>(`[data-testid="${inputTestId}"]`);
    const mentions = Array.from(
      input?.querySelectorAll<HTMLElement>("[data-mention-id]") ?? [],
    ).map((element) => ({
      category: element.getAttribute("data-mention-category"),
      mentionId: element.getAttribute("data-mention-id"),
      text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
    }));
    return {
      bridgeText: input?.__nibiLexicalInputE2E?.getText() ?? null,
      domText: (input?.innerText ?? input?.textContent ?? "").replace(/\s+/gu, " ").trim(),
      mentionCount: mentions.length,
      mentions,
    };
  }, TID_V4_COMPOSER_INPUT);
}

interface PickerFacts {
  composerMentionCount: number;
  optionAriaDisabled: string | null;
  optionDisabled: string | null;
  optionId: string | null;
  optionPresent: boolean;
  optionSelected: string | null;
  optionText: string | null;
  panelPresent: boolean;
  panelRect: ClipRect | null;
  panelText: string | null;
  sectionHeaders: string[];
  statusRows: string[];
  visibleOptionIds: string[];
}

function readPluginPickerFacts(): Promise<PickerFacts> {
  return browser.execute(
    (panelTestId, optionTestId, inputTestId) => {
      const panel = document.querySelector<HTMLElement>(`[data-testid="${panelTestId}"]`);
      const option = document.querySelector<HTMLElement>(`[data-testid="${optionTestId}"]`);
      const input = document.querySelector<HTMLElement>(`[data-testid="${inputTestId}"]`);
      const rect = panel?.getBoundingClientRect();
      return {
        composerMentionCount: input?.querySelectorAll("[data-mention-id]").length ?? 0,
        optionAriaDisabled: option?.getAttribute("aria-disabled") ?? null,
        optionDisabled: option?.getAttribute("data-disabled") ?? null,
        optionId: option?.getAttribute("data-option-id") ?? null,
        optionPresent: Boolean(option),
        optionSelected: option?.getAttribute("data-selected") ?? null,
        optionText: option ? (option.innerText ?? "").replace(/\s+/gu, " ").trim() : null,
        panelPresent: Boolean(panel),
        panelRect: rect
          ? {
              height: Math.ceil(rect.height),
              width: Math.ceil(rect.width),
              x: Math.floor(rect.left),
              y: Math.floor(rect.top),
            }
          : null,
        panelText: panel ? (panel.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 1200) : null,
        sectionHeaders: Array.from(
          panel?.querySelectorAll<HTMLElement>("[data-section-id]") ?? [],
        )
          .filter((element) =>
            (element.getAttribute("data-testid") ?? "").includes("prompt-suggestion-section-"),
          )
          .map((element) => (element.textContent ?? "").trim()),
        statusRows: Array.from(
          panel?.querySelectorAll<HTMLElement>('[data-testid^="prompt-suggestion-status-"]') ?? [],
        ).map((element) => (element.textContent ?? "").replace(/\s+/gu, " ").trim()),
        visibleOptionIds: Array.from(
          panel?.querySelectorAll<HTMLElement>('[data-testid^="prompt-suggestion-option-"]') ?? [],
        ).map((element) => element.getAttribute("data-option-id") ?? ""),
      };
    },
    TID_PROMPT_SUGGESTION_PANEL,
    testId(TID_PROMPT_SUGGESTION_OPTION, PLUGIN_OPTION_ID),
    TID_V4_COMPOSER_INPUT,
  );
}

async function waitForPluginPicker(timeout = 60_000): Promise<PickerFacts> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (panelTestId, optionTestId) =>
          Boolean(
            document.querySelector(`[data-testid="${panelTestId}"]`) &&
            document.querySelector(`[data-testid="${optionTestId}"]`),
          ),
        TID_PROMPT_SUGGESTION_PANEL,
        testId(TID_PROMPT_SUGGESTION_OPTION, PLUGIN_OPTION_ID),
      ),
    { timeout, interval: 250, timeoutMsg: `@ 面板没有出现 ${PLUGIN_OPTION_ID} 候选项` },
  );
  return readPluginPickerFacts();
}

async function focusComposerAtEnd(): Promise<void> {
  const result = (await browser.execute((inputTestId) => {
    type LexicalElement = HTMLElement & {
      __nibiLexicalInputE2E?: { focus: () => void };
    };
    const input = document.querySelector<LexicalElement>(`[data-testid="${inputTestId}"]`);
    const bridge = input?.__nibiLexicalInputE2E;
    if (!input || !bridge) return { ok: false, reason: "lexical-bridge-missing" };
    bridge.focus();
    return { ok: true };
  }, TID_V4_COMPOSER_INPUT)) as { ok: boolean; reason?: string };
  if (!result.ok) throw new Error(`composer 没有焦点: ${JSON.stringify(result)}`);
  // 单段 composer：End 把 caret 放到 mention token 之后，不重建编辑状态。
  await browser.keys("End");
  await browser.pause(100);
}

async function waitForComposerContains(fragments: string[], timeout = 20_000): Promise<string> {
  let text = "";
  await browser.waitUntil(
    async () => {
      text = (await getV4ComposerText()) ?? "";
      return fragments.every((fragment) => text.includes(fragment));
    },
    { timeout, interval: 200, timeoutMsg: `composer 没有同时包含: ${fragments.join(", ")}` },
  );
  return text;
}

interface PromptAcceptance {
  composerText: string | null;
  sessionId: string | null;
  userRowText: string | null;
}

async function waitForPluginPromptAccepted(timeout = 120_000): Promise<PromptAcceptance> {
  let latest: PromptAcceptance | null = null;
  await browser.waitUntil(
    async () => {
      latest = (await browser.execute(
        (paneTestId, inputTestId, timelineTestId, marker) => {
          type LexicalElement = HTMLElement & {
            __nibiLexicalInputE2E?: { getText: () => string };
          };
          const pane = document.querySelector<HTMLElement>(`[data-testid="${paneTestId}"]`);
          const input = pane?.querySelector<LexicalElement>(`[data-testid="${inputTestId}"]`);
          const timeline = pane?.querySelector<HTMLElement>(`[data-testid="${timelineTestId}"]`);
          const userRow = Array.from(
            timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? [],
          ).find(
            (row) =>
              row.classList.contains("group/user-row") &&
              (row.innerText ?? "").includes(marker),
          );
          return {
            composerText: input?.__nibiLexicalInputE2E?.getText() ?? null,
            sessionId: pane?.getAttribute("data-session-id") ?? null,
            userRowText: userRow
              ? (userRow.innerText ?? "").replace(/\s+/gu, " ").trim().slice(0, 500)
              : null,
          };
        },
        testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID),
        TID_V4_COMPOSER_INPUT,
        TID_V4_TIMELINE,
        PROMPT_MARKER,
      )) as PromptAcceptance;
      return latest.composerText === "" && latest.userRowText !== null;
    },
    { timeout, interval: 250, timeoutMsg: "发送后 composer 没有清空或 user row 没有出现" },
  );
  return latest as unknown as PromptAcceptance;
}

interface ErrorSurfaceSnapshot {
  bodyHasNotEnabled: boolean;
  bodyHasPluginQuote: boolean;
  bodyPluginOccurrenceCount: number;
  surfaces: string[];
}

function readErrorSurfaces(): Promise<ErrorSurfaceSnapshot> {
  return browser.execute(() => {
    const collect = (selector: string) =>
      Array.from(document.querySelectorAll<HTMLElement>(selector))
        .map((element) => (element.innerText ?? "").replace(/\s+/gu, " ").trim())
        .filter(Boolean);
    const bodyText = document.body.innerText ?? "";
    return {
      bodyHasNotEnabled: bodyText.includes("未启用"),
      bodyHasPluginQuote: bodyText.includes("插件「"),
      bodyPluginOccurrenceCount: (bodyText.match(/插件/gu) ?? []).length,
      surfaces: [
        ...collect("#nibi-toast-host"),
        ...collect('[role="alert"]'),
        ...collect('[data-testid*="error"]'),
        ...collect('[data-testid*="banner"]'),
        ...collect(".text-destructive"),
      ],
    };
  });
}

async function sampleErrorSurfaces(durationMs = 4_000): Promise<ErrorSurfaceSnapshot> {
  const startedAt = Date.now();
  const surfaces = new Set<string>();
  let bodyHasNotEnabled = false;
  let bodyHasPluginQuote = false;
  let bodyPluginOccurrenceCount = 0;
  while (Date.now() - startedAt < durationMs) {
    const snapshot = await readErrorSurfaces();
    snapshot.surfaces.forEach((text) => surfaces.add(text));
    bodyHasNotEnabled ||= snapshot.bodyHasNotEnabled;
    bodyHasPluginQuote ||= snapshot.bodyHasPluginQuote;
    bodyPluginOccurrenceCount = Math.max(
      bodyPluginOccurrenceCount,
      snapshot.bodyPluginOccurrenceCount,
    );
    await browser.pause(250);
  }
  return {
    bodyHasNotEnabled,
    bodyHasPluginQuote,
    bodyPluginOccurrenceCount,
    surfaces: [...surfaces],
  };
}

async function readSessionIdAfterSend(): Promise<string | null> {
  const snapshot = await getV4PaneSnapshot();
  return snapshot.sessionId === "draft" ? null : snapshot.sessionId;
}

async function tryReadCatalog(options: {
  sessionId?: string;
}): Promise<{ error?: string; summary?: PluginCatalogSummary }> {
  try {
    const catalog = (await getPluginReferenceCatalog({
      workspacePath: DEFAULT_WORKSPACE,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    })) as { authority?: string; plugins?: Array<Record<string, unknown>> };
    return { summary: summarizeCatalog(catalog) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

interface SidePanePluginPanelFacts {
  errorText: string | null;
  mode: string;
  notConnectedMessagePresent: boolean;
  phase: string | null;
  reason?: string;
  screenshot: string | null;
  surfaceId: string | null;
  tabCount: number;
  toast: string | null;
}

/** D（尽力而为）：会话右侧市场 → Spreadsheets「打开」→ 插件面板。 */
async function openSpreadsheetPluginSidePanel(): Promise<SidePanePluginPanelFacts> {
  const base: SidePanePluginPanelFacts = {
    errorText: null,
    mode: "limitation",
    notConnectedMessagePresent: false,
    phase: null,
    screenshot: null,
    surfaceId: null,
    tabCount: 0,
    toast: null,
  };
  try {
    const sidePaneVisible = async () =>
      Boolean(
        await browser.execute(() => {
          const target =
            document.querySelector<HTMLElement>("[data-side-pane-content-slot]") ??
            document.querySelector<HTMLElement>("[data-side-pane-add-trigger]");
          const rect = target?.getBoundingClientRect();
          return Boolean(rect && rect.width > 100 && rect.height > 100);
        }),
      );
    if (!(await sidePaneVisible())) {
      await clickTestIdByDom(TID_SIDE_PANE_TOGGLE, {
        timeout: 15_000,
        timeoutMsg: "没有找到右侧面板开关",
      });
    }
    await browser.waitUntil(sidePaneVisible, {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: "右侧面板没有打开",
    });

    // 打开新标签启动器；只点一次，避免重复开 tab。
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const trigger = document.querySelector<HTMLElement>("[data-side-pane-add-trigger]");
          if (!trigger) return false;
          trigger.click();
          return true;
        }),
      { timeout: 15_000, interval: 200, timeoutMsg: "侧面板没有“打开标签页”入口" },
    );
    await waitForTestIdByDom("side-pane-plugin-market", { timeout: 20_000 });
    await clickTestIdByDom("side-pane-plugin-market", {
      timeout: 15_000,
      timeoutMsg: "侧面板启动器没有插件市场入口",
    });
    await waitForTestIdByDom("plugin-store-root", { timeout: 60_000 });

    const cardSelector = `[data-testid="plugin-store-card"][data-plugin-id="${PLUGIN_ID}"]`;
    let cardPresent = await browser
      .waitUntil(
        () =>
          browser.execute((selector) => Boolean(document.querySelector(selector)), cardSelector),
        { timeout: 30_000, interval: 300, timeoutMsg: "插件市场没有列出 Spreadsheets" },
      )
      .then(() => true)
      .catch(() => false);
    if (!cardPresent) {
      await setInputValueByTestIdDom("plugin-store-search", "Spreadsheets", {
        timeout: 15_000,
        timeoutMsg: "插件市场没有搜索框",
      });
      cardPresent = await browser
        .waitUntil(
          () =>
            browser.execute(
              (selector) => Boolean(document.querySelector(selector)),
              cardSelector,
            ),
          { timeout: 20_000, interval: 300, timeoutMsg: "插件市场搜索后仍没有 Spreadsheets" },
        )
        .then(() => true)
        .catch(() => false);
    }
    if (!cardPresent) {
      base.reason = "plugin-store-card not found for spreadsheets";
      base.toast = (await readErrorSurfaces()).surfaces.join(" | ") || null;
      return base;
    }

    const openButtonSelector = `[data-testid="plugin-store-open-ui"][data-plugin-id="${PLUGIN_ID}"]`;
    const openButtonPresent = await browser
      .waitUntil(
        () =>
          browser.execute(
            (selector) => Boolean(document.querySelector(selector)),
            openButtonSelector,
          ),
        { timeout: 30_000, interval: 300, timeoutMsg: "Spreadsheets 卡片没有“打开”按钮" },
      )
      .then(() => true)
      .catch(() => false);
    if (!openButtonPresent) {
      base.reason = "plugin-store-open-ui button not rendered (item not installed or not a UI plugin)";
      const factsText = await browser.execute((selector) => {
        const card = document.querySelector<HTMLElement>(selector);
        return card ? (card.innerText ?? "").replace(/\s+/gu, " ").trim() : null;
      }, cardSelector);
      base.errorText = factsText;
      return base;
    }

    await browser.execute((selector) => {
      document.querySelector<HTMLElement>(selector)?.click();
    }, openButtonSelector);
    // 点击“打开”后，成功路径创建 plugin-ui tab；环境不支持时只会出现 toast。
    await browser.pause(1_000);
    const cardAppeared = await browser
      .waitUntil(
        () =>
          browser.execute(
            (cardTestId) => Boolean(document.querySelector(`[data-testid="${cardTestId}"]`)),
            TID_PLUGIN_UI_CARD,
          ),
        { timeout: 60_000, interval: 300, timeoutMsg: "没有出现 plugin-ui-card" },
      )
      .then(() => true)
      .catch(() => false);
    if (!cardAppeared) {
      const surfaces = await readErrorSurfaces();
      base.reason = "plugin-ui-card did not render; see toast/error surfaces";
      base.toast = surfaces.surfaces.join(" | ") || null;
      return base;
    }

    await browser.waitUntil(
      async () => {
        const phase = await browser.execute(
          (cardTestId) =>
            document
              .querySelector<HTMLElement>(`[data-testid="${cardTestId}"]`)
              ?.getAttribute("data-plugin-ui-phase") ?? null,
          TID_PLUGIN_UI_CARD,
        );
        return phase !== "loading" && phase !== "idle";
      },
      { timeout: 90_000, interval: 500, timeoutMsg: "plugin-ui-card 一直停在 loading" },
    );
    const panelFacts = await browser.execute(
      (cardTestId) => {
        const card = document.querySelector<HTMLElement>(`[data-testid="${cardTestId}"]`);
        const surface = card?.closest<HTMLElement>("[data-plugin-ui-surface-id]");
        return {
          cardText: card ? (card.innerText ?? "").replace(/\s+/gu, " ").trim() : null,
          phase: card?.getAttribute("data-plugin-ui-phase") ?? null,
          surfaceId: surface?.getAttribute("data-plugin-ui-surface-id") ?? null,
          tabCount: document.querySelectorAll("[data-side-pane-tab-id]").length,
        };
      },
      TID_PLUGIN_UI_CARD,
    );
    base.phase = panelFacts.phase;
    base.surfaceId = panelFacts.surfaceId;
    base.tabCount = panelFacts.tabCount;
    base.errorText = panelFacts.cardText;
    base.notConnectedMessagePresent = (panelFacts.cardText ?? "").includes(
      "当前任务没有连接这个插件",
    );
    base.mode =
      panelFacts.phase === "ready"
        ? "captured-ready"
        : panelFacts.phase === "error"
          ? "captured-error"
          : `captured-${panelFacts.phase ?? "unknown"}`;
    const sidePaneRect = await readUnionRect(
      [`[data-testid="${TID_PLUGIN_UI_CARD}"]`, "[data-side-pane-content-slot]"],
      8,
    );
    base.screenshot = sidePaneRect
      ? await shotClip("06-plugin-side-panel", sidePaneRect, { maxHeight: 760 })
      : null;
    return base;
  } catch (error) {
    base.reason = error instanceof Error ? error.message : String(error);
    base.toast = (await readErrorSurfaces().catch(() => ({ surfaces: [] }))).surfaces
      .slice(0, 8)
      .join(" | ");
    return base;
  }
}

describe("Settings parity evidence（真实 Desktop）", () => {
  before(async function () {
    this.timeout(600_000);
    await mkdir(EVIDENCE_DIR, { recursive: true });
    // 官方插件 cache 必须在 Electron 完全退出后、Host 启动前写入；与第六批 U08 同一条
    // CLI seed 路径，保证 Rust 内核读到的是 `<App> <nibi.cjs> __nibi-plugin-host ...` argv。
    await reloadElectronSessionSafely(browser, {
      afterElectronProcessExit: async () => {
        seedOfficialPluginsViaCli({
          e2eHomeDir: E2E_HOME_DIR,
          workspacePath: DEFAULT_WORKSPACE,
        });
        record("fixture.pluginSeed", readPluginSeedState(E2E_HOME_DIR));
      },
    });
    await prepareV4ConversationE2E();
    await setEnglishLocale();
    await setMainWindowSize(1280, 900);
    record("fixture.provider", {
      modelId: process.env.E2E_PROVIDER_MODEL?.trim() || null,
      providerId: process.env.E2E_PROVIDER_ID?.trim() || null,
      replayFixture: process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH?.trim() || null,
    });
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

  it("A. 行为与工具：导航、标题与七行行为开关", async function () {
    this.timeout(240_000);
    await openSettings();
    await clickSettingsSection("agentBehavior");
    await browser.waitUntil(
      async () => {
        const current = await readAgentBehaviorFacts();
        return (
          current.navItem.present &&
          current.navItem.ariaCurrent === "page" &&
          current.sectionTitle !== null &&
          AGENT_BEHAVIOR_TARGETS.every((target) =>
            current.rows.some((row) => row.target === target),
          )
        );
      },
      { timeout: 30_000, interval: 300, timeoutMsg: "行为与工具分区没有渲染完整" },
    );
    // 回到滚动顶部再截图，确保标题与首行同框。
    await browser.execute((selector) => {
      const main = document.querySelector<HTMLElement>(selector);
      if (main) main.scrollTop = 0;
    }, SETTINGS_MAIN_SELECTOR);
    await browser.pause(300);
    const current = await readAgentBehaviorFacts();
    record("a.agentBehavior", current);
    const mainRect = await readRect(SETTINGS_MAIN_SELECTOR);
    const screenshot = mainRect
      ? await shotClip("01-settings-agent-behavior", mainRect, { maxHeight: 900 })
      : null;
    // 行为与工具内容高于 1280x900 的可视 main pane；再截一张滚动到底部的主面板，
    // 让 todos 行也有可见证据（仍是裁剪后的设置主面板，不是全屏）。
    await browser.execute((selector) => {
      const main = document.querySelector<HTMLElement>(selector);
      if (main) main.scrollTop = main.scrollHeight;
    }, SETTINGS_MAIN_SELECTOR);
    await browser.pause(300);
    const bottomRect = await readRect(SETTINGS_MAIN_SELECTOR);
    const screenshotBottom = bottomRect
      ? await shotClip("01b-settings-agent-behavior-bottom", bottomRect, { maxHeight: 900 })
      : null;
    const todosVisibility = (await browser.execute((selector, rowSelector) => {
      const main = document.querySelector<HTMLElement>(selector);
      const row = document.querySelector<HTMLElement>(rowSelector);
      if (!main || !row) return { present: false, visible: false };
      const mainRect = main.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      return {
        present: true,
        visible: rowRect.top >= mainRect.top - 1 && rowRect.bottom <= mainRect.bottom + 1,
      };
    }, SETTINGS_MAIN_SELECTOR, '[data-settings-search-target="agentBehavior.todos"]')) as {
      present: boolean;
      visible: boolean;
    };
    record("a.screenshot", screenshot);
    record("a.screenshotBottom", screenshotBottom);
    record("a.todosVisibilityAfterScroll", todosVisibility);
    recordResult("a", {
      navItem: current.navItem,
      rows: current.rows,
      screenshot,
      screenshotBottom,
      sectionTitle: current.sectionTitle,
      todosVisibilityAfterScroll: todosVisibility,
    });

    expect(current.navItem.present).toBe(true);
    expect(current.navItem.sectionId).toBe("agentBehavior");
    expect(current.navItem.ariaCurrent).toBe("page");
    expect(current.pageActiveSection).toBe("agentBehavior");
    expect(current.sectionTitle).toBe("Behavior and tools");
    for (const target of AGENT_BEHAVIOR_TARGETS) {
      const row = current.rows.find((candidate) => candidate.target === target);
      if (!row) throw new Error(`missing agentBehavior row: ${target}`);
      expect(row.label?.length ?? 0).toBeGreaterThan(0);
      expect(["switch", "select"]).toContain(row.controlKind);
    }
    // 行为与工具共 7 行：tool search + interaction 是 Select，其余 5 行是 Switch。
    const switches = current.rows.filter((row) => row.controlKind === "switch");
    expect(switches.length).toBeGreaterThanOrEqual(5);
    for (const row of switches) {
      expect(["true", "false"]).toContain(row.checked);
    }
    const toolSearch = current.rows.find(
      (row) => row.target === "agentBehavior.toolSearch",
    );
    expect(toolSearch?.controlKind).toBe("select");
    expect(toolSearch?.valueText?.length ?? 0).toBeGreaterThan(0);
  });

  it("B. 子智能体头像：general-purpose #3C82F6 / Explore #54B9A6", async function () {
    this.timeout(240_000);
    await openSettings();
    await clickSettingsSection("subagents");
    await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "general-purpose"), { timeout: 60_000 });
    await waitForTestIdByDom(testId(TID_SUBAGENT_ROW, "Explore"), { timeout: 60_000 });
    await browser.execute((rowTestId) => {
      document
        .querySelector<HTMLElement>(`[data-testid="${rowTestId}"]`)
        ?.scrollIntoView({ block: "start" });
    }, testId(TID_SUBAGENT_ROW, "general-purpose"));
    await browser.pause(400);
    const general = await readSubagentAvatar("general-purpose");
    const explore = await readSubagentAvatar("Explore");
    record("b.subagents", { explore, general });
    const rect = await readUnionRect(
      [
        `[data-testid="${testId(TID_SUBAGENT_ROW, "general-purpose")}"]`,
        `[data-testid="${testId(TID_SUBAGENT_ROW, "Explore")}"]`,
      ],
      8,
    );
    const screenshot = rect
      ? await shotClip("02-settings-subagent-avatars", rect, { maxHeight: 420 })
      : null;
    record("b.screenshot", screenshot);
    recordResult("b", {
      explore: {
        computedFill: explore.bodyComputedFill,
        inlineFaceBody: explore.inlineFaceBody,
      },
      general: {
        computedFill: general.bodyComputedFill,
        inlineFaceBody: general.inlineFaceBody,
      },
      screenshot,
    });

    expect(general.rowPresent).toBe(true);
    expect(explore.rowPresent).toBe(true);
    expect(general.avatarCount).toBeGreaterThan(0);
    expect(explore.avatarCount).toBeGreaterThan(0);
    expect(general.inlineFaceBody?.toUpperCase()).toBe("#3C82F6");
    expect(explore.inlineFaceBody?.toUpperCase()).toBe("#54B9A6");
    expect(colorToHex(general.bodyComputedFill)).toBe("#3c82f6");
    expect(colorToHex(explore.bodyComputedFill)).toBe("#54b9a6");
    expect(general.rowText).toContain("general-purpose");
    expect(explore.rowText).toContain("Explore");
  });

  it("C. 新任务 @spreadsheets → 发送 → replay 回复且无未启用拒绝", async function () {
    this.timeout(600_000);
    // 对照面：设置页 Plugins（Node 发现）对四个 Office 插件报 enabled。
    record("c.settingsPluginRows", await readSettingsPluginRows());
    await closeSettingsIfOpen();
    await ensureSidebarVisible();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    await waitForV4Pane(
      (snapshot) => snapshot.sessionId === "draft",
      "新建任务后没有回到 draft",
      30_000,
    );

    const workspaceCatalog = await tryReadCatalog({});
    record("c.workspaceCatalog", workspaceCatalog);
    if (workspaceCatalog.summary) {
      recordResult("c.workspaceCatalog.office", workspaceCatalog.summary.office);
      for (const entry of workspaceCatalog.summary.office) {
        if (!entry.present) throw new Error(`workspace catalog missing ${entry.pluginId}`);
        if (!entry.enabled) throw new Error(`workspace catalog disabled ${entry.pluginId}`);
      }
    }

    await setInputValueByTestIdDom(TID_V4_COMPOSER_INPUT, "@spreadsheets", {
      stabilizeLexicalCaretAtEnd: true,
      timeout: 30_000,
      timeoutMsg: "v4 composer 没有出现或不可输入",
    });
    let picker: PickerFacts | null = null;
    try {
      picker = await waitForPluginPicker(60_000);
    } catch (error) {
      const failureFacts = await readPluginPickerFacts().catch(() => null);
      record("c.pickerFailure", failureFacts);
      const composerRect = await readUnionRect(
        [
          `[data-testid="${TID_V4_COMPOSER_INPUT}"]`,
          `[data-testid="${TID_PROMPT_SUGGESTION_PANEL}"]`,
        ],
        16,
      );
      const shot = composerRect
        ? await shotClip("03-plugin-mention-picker-missing", composerRect, { maxHeight: 420 })
        : null;
      record("c.pickerFailureScreenshot", shot);
      throw new Error(
        `@ 面板没有出现 ${PLUGIN_OPTION_ID}; picker=${JSON.stringify(failureFacts)}; catalog=${JSON.stringify(workspaceCatalog)}`,
        { cause: error },
      );
    }
    record("c.picker", picker);
    const pickerRect = await readUnionRect(
      [
        `[data-testid="${TID_V4_COMPOSER_INPUT}"]`,
        `[data-testid="${TID_PROMPT_SUGGESTION_PANEL}"]`,
      ],
      16,
    );
    const pickerScreenshot = pickerRect
      ? await shotClip("03-plugin-mention-picker", pickerRect, { maxHeight: 440 })
      : null;
    record("c.pickerScreenshot", pickerScreenshot);
    expect(picker.optionPresent).toBe(true);
    expect(picker.optionId).toBe(PLUGIN_OPTION_ID);
    expect(picker.optionDisabled).toBe("false");
    expect(picker.optionAriaDisabled).toBe("false");
    expect(picker.visibleOptionIds).toContain(PLUGIN_OPTION_ID);

    expect(await clickV4SlashOption(PLUGIN_OPTION_ID)).toBe(true);
    const canonical = `plugin://${PLUGIN_ID}`;
    await waitForComposerContains([canonical], 20_000);
    await browser.waitUntil(
      async () => !(await isTestIdPresent(TID_PROMPT_SUGGESTION_PANEL)),
      { timeout: 15_000, interval: 200, timeoutMsg: "选中 plugin mention 后面板没有关闭" },
    );
    const composerAfterMention = await readComposerFacts();
    record("c.composerAfterMention", composerAfterMention);
    expect(composerAfterMention.bridgeText ?? "").toContain(canonical);
    expect(
      composerAfterMention.mentions.some(
        (mention) =>
          mention.mentionId === PLUGIN_OPTION_ID &&
          mention.category === "plugins" &&
          mention.text === "spreadsheets",
      ),
    ).toBe(true);

    await focusComposerAtEnd();
    await browser.keys(PROMPT_MARKER);
    const composerWithPrompt = await waitForComposerContains([canonical, PROMPT_MARKER], 20_000);
    const composerFacts = await readComposerFacts();
    record("c.composerWithPrompt", { ...composerFacts, text: composerWithPrompt });
    const composerRect = await readUnionRect(
      [
        `${PANE_SELECTOR} form`,
        `${PANE_SELECTOR} [data-testid="${TID_V4_COMPOSER_INPUT}"]`,
      ],
      12,
    );
    const composerScreenshot = composerRect
      ? await shotClip("04-plugin-send-composer", composerRect, { maxHeight: 280 })
      : null;
    record("c.composerScreenshot", composerScreenshot);

    let acceptance: PromptAcceptance | null = null;
    try {
      await clickV4Send();
      // 插件引用门禁是同步拒绝：2.5s 内没有 user row 却有拒绝 toast 时立刻留证失败，
      // 不把 120s 花在等待一个永远不出现的回合上。
      await browser.pause(2_500);
      const earlyErrors = await readErrorSurfaces();
      const earlyRejected =
        earlyErrors.surfaces.some(
          (text) => text.includes("未启用") || text.includes("插件「") || text.includes("插件"),
        ) || earlyErrors.bodyHasPluginQuote;
      if (earlyRejected) {
        record("c.sendFailure", { earlyErrors });
        const timelineRectEarly = await readRect(TIMELINE_SELECTOR);
        const shot = timelineRectEarly
          ? await shotClip("05-plugin-send-rejected", timelineRectEarly, { maxHeight: 600 })
          : null;
        record("c.sendFailureScreenshot", shot);
        throw new Error(`plugin send rejected: ${JSON.stringify(earlyErrors)}`);
      }
      acceptance = await waitForPluginPromptAccepted(120_000);
    } catch (error) {
      const failure = await sampleErrorSurfaces(1_000).catch(() => null);
      record("c.sendFailure", { error: String(error), surfaces: failure });
      const timelineRect = await readRect(TIMELINE_SELECTOR);
      const shot = timelineRect
        ? await shotClip("05-plugin-send-rejected", timelineRect, { maxHeight: 600 })
        : null;
      record("c.sendFailureScreenshot", shot);
      throw error;
    }
    record("c.acceptance", acceptance);
    const sessionId = await readSessionIdAfterSend();
    record("c.sessionId", sessionId);
    expect(sessionId).toBeTruthy();
    await waitForV4TimelineContaining(REPLY_MARKER, 180_000);
    await waitForV4AssistantMessageContaining(REPLY_MARKER, 180_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop && snapshot.sessionId !== "draft" && snapshot.sessionId !== null,
      "plugin 发送回合没有完成",
      180_000,
    );
    const timelineText = (await getV4PaneSnapshot()).timelineText;
    record("c.timelineText", timelineText.slice(0, 2_000));
    const errorSurfaces = await sampleErrorSurfaces(4_000);
    record("c.errorSurfaces", errorSurfaces);
    const timelineRect = await readRect(TIMELINE_SELECTOR);
    const timelineScreenshot = timelineRect
      ? await shotClip("05-plugin-send-timeline", timelineRect, { maxHeight: 620 })
      : null;
    record("c.timelineScreenshot", timelineScreenshot);
    const sessionCatalog = sessionId
      ? await tryReadCatalog({ sessionId })
      : { error: "missing session id" };
    record("c.sessionCatalog", sessionCatalog);
    recordResult("c", {
      acceptance,
      errorSurfaces,
      picker,
      sessionCatalog,
      sessionId,
      settingsPluginRows: facts["c.settingsPluginRows"],
      timelineScreenshot,
      workspaceCatalog,
    });

    expect(timelineText).toContain(REPLY_MARKER);
    expect(errorSurfaces.surfaces.some((text) => text.includes("未启用"))).toBe(false);
    expect(errorSurfaces.surfaces.some((text) => text.includes("插件"))).toBe(false);
    expect(errorSurfaces.bodyHasNotEnabled).toBe(false);
    expect(errorSurfaces.bodyHasPluginQuote).toBe(false);
    if (sessionCatalog.summary) {
      expect(sessionCatalog.summary.authority).toBe("session");
      for (const entry of sessionCatalog.summary.office) {
        if (!entry.present) throw new Error(`session catalog missing ${entry.pluginId}`);
        if (!entry.enabled) throw new Error(`session catalog disabled ${entry.pluginId}`);
      }
    }

    // D（尽力而为）：同一任务的插件侧栏入口；失败只记录，不伪造面板。
    const sidePanel = await openSpreadsheetPluginSidePanel();
    record("c.pluginSidePanel", sidePanel);
  });
});
