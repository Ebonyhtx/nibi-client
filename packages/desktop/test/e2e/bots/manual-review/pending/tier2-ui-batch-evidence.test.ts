/**
 * Tier 2 U02/U03/U04 视觉证据（manual-review / pending）。
 *
 * 目的：用真实 Desktop UI + 真实 Rust 内核 + replay 上游，只做截图与 DOM 事实断言：
 * 1. U02 统一摘要分组：真实执行 Read/Bash/Write 三种类别的工具调用，收起态显示统计，
 *    展开后能看到子行。
 * 2. U03 composer 编辑：最新用户消息的编辑入口进入底部 Composer，原行显示 “Editing below”，
 *    编辑条声明 data-edit-target-kind="userQuery"；取消后编辑条消失。
 * 3. U04 正文注释：在 assistant 正文里真实框选一段文字，走“Annotate”浮层保存评论，
 *    正文出现编号气泡、composer chip 带评论；删除后出现 6 秒撤销 toast，撤销恢复标记。
 *
 * 运行：
 *   NIBI_E2E_HOME_DIR=<isolated home> NIBI_E2E_EVIDENCE_DIR=<evidence dir> \
 *   E2E_PROVIDER_HTTP_MODE=replay \
 *   E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,\
 * packages/desktop/test/e2e/fixtures/upstream/conversation-session/conversation-session-tool-group-settings-persistence.json,\
 * packages/desktop/test/e2e/fixtures/upstream/tier2-ui-batch.json \
 *   pnpm --filter @nibi/desktop exec wdio run wdio.conf.ts \
 *     --spec test/e2e/bots/manual-review/pending/tier2-ui-batch-evidence.test.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TID_V4_SESSION_PANE, testId } from "@nibi/shared/test-ids";
import { expandAssistantHistoriesWithContent } from "../../../helpers/conversation-session-tool.js";
import {
  resolveE2ERuntimePath,
  resolveE2EToolPath,
} from "../../../helpers/e2e-runtime-paths.js";
import {
  V4_MAIN_PANE_ID,
  getV4ConfigProjection,
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  switchV4Mode,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";

const EVIDENCE_DIR =
  process.env.NIBI_E2E_EVIDENCE_DIR?.trim() ||
  join(process.cwd(), ".e2e-artifacts", "tier2-ui-batch");
const E2E_HOME_DIR = process.env.NIBI_E2E_HOME_DIR?.trim();
if (!E2E_HOME_DIR) {
  throw new Error("NIBI_E2E_HOME_DIR missing; run through the isolated WDIO harness");
}
const FACTS_FILE = "wdio-facts.json";
const LOCALE = "en-US";
const PANE_SELECTOR = `[data-testid="${testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID)}"]`;
const TIMELINE_SELECTOR = `${PANE_SELECTOR} [data-testid="v4-timeline"]`;
const COMPOSER_SELECTOR = `${PANE_SELECTOR} [data-testid="v4-composer"]`;

// U02: 复用已有的 Read/Bash/Write 三类工具 replay 用例；提示词里的 marker 与 fixture 契约一致。
const TOOL_CASE_NAME = "conversation-session-tool-group-settings-persistence";
const TOOL_PROMPT_MARKER = "E2E_TOOL_GROUP_SETTINGS_PERSISTENCE";
const TOOL_RUNTIME_ROOT = resolveE2ERuntimePath(TOOL_CASE_NAME);
const TOOL_READ_PATHS = [
  resolveE2EToolPath(TOOL_CASE_NAME, "seed-a.txt"),
  resolveE2EToolPath(TOOL_CASE_NAME, "seed-b.txt"),
] as const;
const TOOL_WRITE_PATHS = [
  resolveE2EToolPath(TOOL_CASE_NAME, "result-a.ts"),
  resolveE2EToolPath(TOOL_CASE_NAME, "result-b.ts"),
] as const;
const TOOL_PROMPT = [
  `${TOOL_PROMPT_MARKER}: Follow these tool steps exactly in order.`,
  `1. Read ${TOOL_READ_PATHS[0]} and ${TOOL_READ_PATHS[1]}.`,
  `2. Bash exactly: node -e "console.log('TGE06_TERMINAL_A')" and node -e "console.log('TGE06_TERMINAL_B')".`,
  `3. Write ${TOOL_WRITE_PATHS[0]} and ${TOOL_WRITE_PATHS[1]} with exactly "export const grouped = true;\\n".`,
  `4. Reply with exactly "upstream-e2e-ok" and no other text.`,
].join(" ");

// U04: 追加的 additive fixture 只负责返回一段可框选的普通正文。
const ANNOTATION_PROMPT_MARKER = "E2E_TIER2_UI_BATCH_TEXT";
const ANNOTATION_ASSISTANT_TOKEN = "TIER2_UI_BATCH_ANNOTATION_TEXT";
const ANNOTATION_SELECTION_TEXT = "this sentence is the anchor";
const ANNOTATION_COMMENT = "Please keep this sentence in the final summary.";

const facts: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  host: { platform: process.platform, cwd: process.cwd() },
  e2eHomeDir: E2E_HOME_DIR,
  screenshots: [] as string[],
};

async function shot(name: string): Promise<string> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await browser.saveScreenshot(path);
  (facts.screenshots as string[]).push(path);
  return path;
}

function record(key: string, value: unknown): void {
  facts[key] = value;
}

async function writeFacts(): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(join(EVIDENCE_DIR, FACTS_FILE), JSON.stringify(facts, null, 2), "utf-8");
}

/** Electron 下 WebDriver setWindowSize 不可用，改经 main 进程设置主窗口尺寸。 */
async function setWindowSize(width: number, height: number): Promise<void> {
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
  await browser.waitUntil(
    async () => {
      const viewport = (await browser.execute(() => [innerWidth, innerHeight])) as [
        number,
        number,
      ];
      return viewport[0] === width && viewport[1] === height;
    },
    { timeout: 10_000, interval: 150, timeoutMsg: `窗口尺寸 ${width}x${height} 未收敛` },
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
    async () =>
      (await browser.execute(() => document.documentElement.lang)) === LOCALE,
    { timeout: 15_000, timeoutMsg: `界面语言没有切到 ${LOCALE}` },
  );
}

/**
 * 切到 full access 会先挂一个风险确认弹窗；不确认则整页被 Radix modal 的 inert 遮罩盖住，
 * 后面的真实点击全部失效。按产品真实路径勾选风险声明并确认。
 */
async function confirmFullAccessDialogIfPresent(): Promise<boolean> {
  const dialogSelector = '[data-testid="full-access-mode-confirm-dialog"]';
  const appeared = await browser
    .waitUntil(
      () => browser.execute((selector) => Boolean(document.querySelector(selector)), dialogSelector),
      { timeout: 10_000, interval: 200, timeoutMsg: "full access 确认弹窗没有出现" },
    )
    .then(() => true)
    .catch(() => false);
  if (!appeared) return false;

  const checked = await browser.execute((selector) => {
    const checkbox = document.querySelector<HTMLElement>(
      `${selector} [role="checkbox"]`,
    );
    checkbox?.click();
    return Boolean(checkbox);
  }, dialogSelector);
  expect(checked).toBe(true);
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
  expect(confirmed).toBe(true);
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector) => !document.querySelector(selector),
        dialogSelector,
      ),
    { timeout: 15_000, interval: 200, timeoutMsg: "full access 确认弹窗没有关闭" },
  );
  return true;
}

/** 点击任意 DOM 选择器；先等它出现，避免直接派发到尚未挂载的节点。 */
async function clickSelectorByDom(selector: string, timeoutMsg: string, timeout = 15_000) {
  await browser.waitUntil(
    () =>
      browser.execute((currentSelector) => {
        const element = document.querySelector<HTMLElement>(currentSelector);
        if (!element) return false;
        element.click();
        return true;
      }, selector),
    { timeout, interval: 200, timeoutMsg },
  );
}

async function waitForSelector(selector: string, timeoutMsg: string, timeout = 30_000) {
  await browser.waitUntil(
    () => browser.execute((currentSelector) => Boolean(document.querySelector(currentSelector)), selector),
    { timeout, interval: 200, timeoutMsg },
  );
}

/** 时间线在 U03 手动滚动过后会退出 follow-bottom；发新回合前回到真实用户会看到的底部。 */
async function scrollTimelineToBottom(): Promise<void> {
  await browser.execute((timelineSelector) => {
    const timeline = document.querySelector<HTMLElement>(timelineSelector);
    if (timeline) timeline.scrollTop = timeline.scrollHeight;
  }, TIMELINE_SELECTOR);
  await browser.pause(500);
}

/** 编号气泡必须真实落在时间线可视区内且没有被 composer 遮住，截图才有证据价值。 */
async function scrollAssistantMessageIntoView(fragment: string): Promise<void> {
  const found = await browser.execute((timelineSelector, needle) => {
    const timeline = document.querySelector<HTMLElement>(timelineSelector);
    if (!timeline) return false;
    const row = Array.from(timeline.querySelectorAll<HTMLElement>("[data-row-id]"))
      .filter((candidate) => candidate.classList.contains("group/assistant-row"))
      .find((candidate) => (candidate.innerText ?? "").includes(needle));
    if (!row) return false;
    row.scrollIntoView({ block: "center" });
    return true;
  }, TIMELINE_SELECTOR, fragment);
  expect(found).toBe(true);
  await browser.pause(400);
}

async function waitForAnnotationMarkVisible(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((timelineSelector) => {
        const timeline = document.querySelector<HTMLElement>(timelineSelector);
        const composer = document.querySelector<HTMLElement>('[data-testid="v4-composer"]');
        const bubble = document.querySelector<HTMLElement>("[data-annotation-mark-id]");
        if (!timeline || !composer || !bubble) return false;
        const timelineRect = timeline.getBoundingClientRect();
        const composerRect = composer.getBoundingClientRect();
        const rect = bubble.getBoundingClientRect();
        if (
          rect.width <= 0 ||
          rect.height <= 0 ||
          rect.top < timelineRect.top ||
          rect.bottom > timelineRect.bottom ||
          rect.bottom >= composerRect.top
        ) {
          return false;
        }
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return Boolean(hit && bubble.contains(hit));
      }, TIMELINE_SELECTOR),
    { timeout: 20_000, interval: 200, timeoutMsg: "注释编号气泡没有进入可视区" },
  );
}

interface SummaryGroupSnapshot {
  exists: boolean;
  groupCount: number;
  visible: boolean;
  visibleCount: number;
  statistics: string;
  expanded: boolean;
  childCount: number;
  childToolNames: string[];
}

function readSummaryGroup(): Promise<SummaryGroupSnapshot> {
  return browser.execute((timelineSelector) => {
    const groups = Array.from(
      document.querySelectorAll<HTMLElement>(
        `${timelineSelector} [data-consecutive-summary-group]`,
      ),
    ).map((group) => {
      const rect = group.getBoundingClientRect();
      return {
        group,
        rect,
        visible:
          group.getClientRects().length > 0 && rect.width > 1 && rect.height > 1,
      };
    });
    const visibleGroups = groups.filter((entry) => entry.visible);
    // 历史展开动画期间会同时存在“已挂载但高度仍为 0”的旧树；只以可见组为事实。
    const chosen = (visibleGroups.at(-1) ?? groups.at(-1))?.group;
    const trigger = chosen?.querySelector<HTMLElement>("[data-summary-group-trigger]");
    const scroll = chosen?.querySelector<HTMLElement>("[data-summary-group-scroll]");
    const childBlocks = Array.from(
      scroll?.querySelectorAll<HTMLElement>("[data-tool-call-id][data-tool-name]") ?? [],
    );
    return {
      exists: Boolean(chosen),
      groupCount: groups.length,
      visible: (visibleGroups.at(-1) ?? groups.at(-1))?.visible ?? false,
      visibleCount: visibleGroups.length,
      statistics:
        chosen?.querySelector<HTMLElement>("[data-summary-group-statistics]")?.textContent?.trim() ??
        "",
      expanded: trigger?.getAttribute("aria-expanded") === "true",
      childCount: childBlocks.length,
      childToolNames: childBlocks.map((block) => block.dataset.toolName ?? ""),
    };
  }, TIMELINE_SELECTOR);
}

async function scrollVisibleSummaryGroupIntoView(): Promise<void> {
  const scrolled = await browser.execute((timelineSelector) => {
    const groups = Array.from(
      document.querySelectorAll<HTMLElement>(
        `${timelineSelector} [data-consecutive-summary-group]`,
      ),
    ).map((group) => {
      const rect = group.getBoundingClientRect();
      return {
        group,
        visible: group.getClientRects().length > 0 && rect.width > 1 && rect.height > 1,
      };
    });
    const target = (groups.filter((entry) => entry.visible).at(-1) ?? groups.at(-1))?.group;
    target?.scrollIntoView({ block: "center" });
    return Boolean(target);
  }, TIMELINE_SELECTOR);
  expect(scrolled).toBe(true);
}

async function clickVisibleSummaryGroupTrigger(): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((timelineSelector) => {
        const groups = Array.from(
          document.querySelectorAll<HTMLElement>(
            `${timelineSelector} [data-consecutive-summary-group]`,
          ),
        ).map((group) => {
          const rect = group.getBoundingClientRect();
          return {
            group,
            visible: group.getClientRects().length > 0 && rect.width > 1 && rect.height > 1,
          };
        });
        const target = (groups.filter((entry) => entry.visible).at(-1) ?? groups.at(-1))?.group;
        const trigger = target?.querySelector<HTMLElement>("[data-summary-group-trigger]");
        if (!trigger) return false;
        trigger.click();
        return true;
      }, TIMELINE_SELECTOR),
    { timeout: 15_000, interval: 200, timeoutMsg: "U02 摘要分组头不可点击" },
  );
}

interface LatestUserRowSnapshot {
  rowId: string | null;
  hasEditAction: boolean;
}

function readLatestUserRow(): Promise<LatestUserRowSnapshot> {
  return browser.execute((timelineSelector) => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>(`${timelineSelector} [data-row-id]`),
    ).filter((row) => row.classList.contains("group/user-row"));
    const row = rows.at(-1);
    return {
      rowId: row?.getAttribute("data-row-id") ?? null,
      hasEditAction: Boolean(row?.querySelector('[data-testid^="v4-edit-"]')),
    };
  }, TIMELINE_SELECTOR);
}

interface ComposerEditSnapshot {
  hintText: string | null;
  hintRowId: string | null;
  barExists: boolean;
  barKind: string | null;
  barTargetId: string | null;
  barText: string;
}

function readComposerEditState(): Promise<ComposerEditSnapshot> {
  return browser.execute(() => {
    const hint = document.querySelector<HTMLElement>('[data-composer-editing-below="true"]');
    const bar = document.querySelector<HTMLElement>('[data-testid="v4-composer-edit-bar"]');
    return {
      hintText: hint?.textContent?.trim() ?? null,
      hintRowId: hint?.getAttribute("data-composer-editing-row") ?? null,
      barExists: Boolean(bar),
      barKind: bar?.getAttribute("data-edit-target-kind") ?? null,
      barTargetId: bar?.getAttribute("data-edit-target-id") ?? null,
      barText: bar?.textContent?.replace(/\s+/gu, " ").trim() ?? "",
    };
  });
}

interface SelectionActionResult {
  ok: boolean;
  reason?: string;
  rowId: string | null;
  selectedText: string;
}

/**
 * 在 assistant 行的 [data-conversation-selectable] 区域内构造真实 DOM Range 并触发 mouseup，
 * 让 useTextSelection 走生产监听路径（不伪造 React 状态）。
 */
function selectAssistantText(fragment: string): Promise<SelectionActionResult> {
  return browser.execute((timelineSelector, needle) => {
    const timeline = document.querySelector<HTMLElement>(timelineSelector);
    if (!timeline) return { ok: false, reason: "no-timeline", rowId: null, selectedText: "" };
    const rows = Array.from(timeline.querySelectorAll<HTMLElement>("[data-row-id]")).filter(
      (row) => row.classList.contains("group/assistant-row"),
    );
    for (const row of rows) {
      const region = row.querySelector<HTMLElement>("[data-conversation-selectable]");
      if (!region || !(region.textContent ?? "").includes(needle)) continue;
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push(node as Text);
      }
      const full = nodes.map((node) => node.data).join("");
      const start = full.indexOf(needle);
      if (start < 0) continue;
      const end = start + needle.length;
      let cursor = 0;
      let startNode: { node: Text; offset: number } | null = null;
      let endNode: { node: Text; offset: number } | null = null;
      for (const node of nodes) {
        const length = node.data.length;
        if (!startNode && start < cursor + length) {
          startNode = { node, offset: start - cursor };
        }
        if (end <= cursor + length) {
          endNode = { node, offset: end - cursor };
          break;
        }
        cursor += length;
      }
      if (!startNode || !endNode) continue;
      const range = document.createRange();
      range.setStart(startNode.node, startNode.offset);
      range.setEnd(endNode.node, endNode.offset);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      timeline.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }),
      );
      return {
        ok: true,
        rowId: row.getAttribute("data-row-id"),
        selectedText: selection?.toString() ?? "",
      };
    }
    return { ok: false, reason: "fragment-not-found", rowId: null, selectedText: "" };
  }, TIMELINE_SELECTOR, fragment);
}

interface AnnotationMarkSnapshot {
  count: number;
  number: number | null;
  markId: string | null;
  rect: { left: number; top: number; width: number; height: number } | null;
}

function readAnnotationMark(): Promise<AnnotationMarkSnapshot> {
  return browser.execute(() => {
    const marks = Array.from(document.querySelectorAll<HTMLElement>("[data-annotation-mark]"));
    const bubble = marks.at(-1)?.querySelector<HTMLElement>("[data-annotation-mark-id]");
    const rect = bubble?.getBoundingClientRect();
    return {
      count: marks.length,
      number: bubble?.getAttribute("data-annotation-mark-number")
        ? Number(bubble.getAttribute("data-annotation-mark-number"))
        : null,
      markId: bubble?.getAttribute("data-annotation-mark-id") ?? null,
      rect: rect
        ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        : null,
    };
  });
}

interface AnnotationChipSnapshot {
  triggerCount: number;
  label: string | null;
  comment: string | null;
  contentText: string | null;
}

function readAnnotationChip(): Promise<AnnotationChipSnapshot> {
  return browser.execute((composerSelector) => {
    const trigger = document.querySelector<HTMLElement>(
      `${composerSelector} [data-conversation-selection-reference-count]`,
    );
    const comment = document.querySelector<HTMLElement>(
      '[data-conversation-selection-comment="true"]',
    );
    return {
      triggerCount: trigger
        ? Number(trigger.getAttribute("data-conversation-selection-reference-count"))
        : 0,
      label: trigger?.getAttribute("aria-label") ?? null,
      comment: comment?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
      contentText:
        comment
          ?.closest("[data-conversation-annotation-row]")
          ?.textContent?.replace(/\s+/gu, " ")
          .trim() ?? null,
    };
  }, COMPOSER_SELECTOR);
}

interface ToastSnapshot {
  text: string;
  undoButtonPresent: boolean;
}

function readToast(): Promise<ToastSnapshot> {
  return browser.execute(() => {
    const host = document.getElementById("nibi-toast-host");
    const buttons = Array.from(host?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    return {
      text: (host?.innerText ?? "").replace(/\s+/gu, " ").trim(),
      undoButtonPresent: buttons.some((button) => (button.textContent ?? "").trim() === "Undo"),
    };
  });
}

async function prepareToolFixtureFiles(): Promise<void> {
  await mkdir(TOOL_RUNTIME_ROOT, { recursive: true });
  await writeFile(join(TOOL_RUNTIME_ROOT, "seed-a.txt"), "TGE06_READ_A\n", "utf-8");
  await writeFile(join(TOOL_RUNTIME_ROOT, "seed-b.txt"), "TGE06_READ_B\n", "utf-8");
}

describe("Tier 2 U02/U03/U04 visual evidence (real Desktop)", () => {
  before(async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E();
    await switchV4Mode("yolo");
    const confirmed = await confirmFullAccessDialogIfPresent();
    record("fullAccessDialogConfirmed", confirmed);
    await setEnglishLocale();
    await setWindowSize(1440, 900);
    await mkdir(EVIDENCE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await writeFacts();
  });

  after(async () => {
    await writeFacts();
    await browser.electron.restoreAllMocks();
  });

  it("U02 连续工具摘要分组：收起显示统计，展开显示子行", async function () {
    this.timeout(600_000);
    await prepareToolFixtureFiles();
    await browser.waitUntil(
      async () => (await getV4ConfigProjection()).mode === "yolo",
      { timeout: 60_000, interval: 300, timeoutMsg: "U02 没有进入 full access/yolo 模式" },
    );

    await sendV4PromptAndWaitAccepted(
      TOOL_PROMPT,
      TOOL_PROMPT_MARKER,
      "U02 工具分组 prompt 没有被接受",
      120_000,
    );
    await waitForV4AssistantMessageContaining("upstream-e2e-ok", 180_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "U02 工具轮在最终回复后没有结束",
      180_000,
    );
    // 回合完成后工作项进入 “Worked for …” 历史折叠区；按用户路径展开后才能看到摘要分组。
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          Boolean(document.querySelector('[data-testid^="chat-assistant-history-trigger-"]')),
        ),
      { timeout: 30_000, interval: 200, timeoutMsg: "U02 没有出现 Worked for 历史折叠区" },
    );
    await expandAssistantHistoriesWithContent();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const triggers = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-testid^="chat-assistant-history-trigger-"]',
            ),
          );
          return (
            triggers.length > 0 &&
            triggers.every((trigger) => trigger.getAttribute("data-history-open") === "true")
          );
        }),
      { timeout: 30_000, interval: 200, timeoutMsg: "U02 历史区没有展开" },
    );
    // 展开动画会短暂保留高度为 0 的内容；等摘要组真正可见后再读取与截图。
    await browser.pause(600);

    let collapsed: SummaryGroupSnapshot | null = null;
    await browser.waitUntil(
      async () => {
        collapsed = await readSummaryGroup();
        return (
          collapsed.exists &&
          collapsed.visible &&
          collapsed.statistics.length > 0 &&
          collapsed.expanded === false
        );
      },
      { timeout: 60_000, interval: 300, timeoutMsg: "U02 没有出现已收起的摘要分组或统计为空" },
    );
    const group = collapsed!;
    expect(group.statistics).toMatch(/Explored 2 items/u);
    expect(group.statistics).toMatch(/Ran 2 commands/u);
    expect(group.statistics).toMatch(/Changed 2 files/u);
    // 收起态只保留组头；子行由 CollapsibleContent 卸载，展开后再验证。
    expect(group.childCount).toBe(0);
    record("u02.collapsed", group);

    await scrollVisibleSummaryGroupIntoView();
    await browser.pause(400);
    const collapsedShot = await shot("01-u02-summary-group-collapsed");
    record("u02.collapsedScreenshot", collapsedShot);

    await clickVisibleSummaryGroupTrigger();
    let expanded: SummaryGroupSnapshot | null = null;
    await browser.waitUntil(
      async () => {
        expanded = await readSummaryGroup();
        return expanded.exists && expanded.visible && expanded.expanded === true;
      },
      { timeout: 30_000, interval: 200, timeoutMsg: "U02 摘要分组没有展开" },
    );
    const expandedGroup = expanded!;
    expect(expandedGroup.childCount).toBeGreaterThanOrEqual(3);
    for (const toolName of ["Read", "Bash", "Write"]) {
      expect(expandedGroup.childToolNames).toContain(toolName);
    }
    record("u02.expanded", expandedGroup);

    // 展开态把组滚到视口中间再截图，确保子行和统计都能被看见。
    await scrollVisibleSummaryGroupIntoView();
    await browser.pause(400);
    const expandedShot = await shot("02-u02-summary-group-expanded");
    record("u02.expandedScreenshot", expandedShot);
  });

  it("U03 composer 编辑：行内提示 + 底部编辑条，取消后消失", async function () {
    this.timeout(300_000);
    let latest: LatestUserRowSnapshot | null = null;
    await browser.waitUntil(
      async () => {
        latest = await readLatestUserRow();
        return Boolean(latest.rowId && latest.hasEditAction);
      },
      { timeout: 60_000, interval: 300, timeoutMsg: "U03 最新用户消息没有编辑入口" },
    );
    const rowId = latest!.rowId!;

    await browser.execute((timelineSelector, editRowId) => {
      const timeline = document.querySelector<HTMLElement>(timelineSelector);
      const row = Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []).find(
        (candidate) => candidate.getAttribute("data-row-id") === editRowId,
      );
      row?.scrollIntoView({ block: "center" });
      row?.querySelector<HTMLElement>(`[data-testid="v4-edit-${editRowId}"]`)?.click();
    }, TIMELINE_SELECTOR, rowId);

    let editing: ComposerEditSnapshot | null = null;
    await browser.waitUntil(
      async () => {
        editing = await readComposerEditState();
        return Boolean(
          editing.hintText === "Editing below" &&
            editing.barExists &&
            editing.barKind === "userQuery",
        );
      },
      { timeout: 60_000, interval: 300, timeoutMsg: "U03 没有进入底部 composer 编辑态" },
    );
    const editState = editing!;
    expect(editState.hintText).toBe("Editing below");
    expect(editState.hintRowId).toBe(rowId);
    expect(editState.barKind).toBe("userQuery");
    expect(editState.barTargetId).toBe(rowId);
    record("u03.begin", { rowId, ...editState });

    // 编辑条在底部，用户消息在时间线里；给窗口多一点高度，避免轮尾文件摘要卡压在编辑条下面。
    await setWindowSize(1440, 1000);
    await browser.execute((timelineSelector, editRowId) => {
      const timeline = document.querySelector<HTMLElement>(timelineSelector);
      const row = Array.from(timeline?.querySelectorAll<HTMLElement>("[data-row-id]") ?? []).find(
        (candidate) => candidate.getAttribute("data-row-id") === editRowId,
      );
      row?.scrollIntoView({ block: "center" });
    }, TIMELINE_SELECTOR, rowId);
    // “Editing below” 与复制/编辑入口同属 hover 操作条；像用户一样把指针停在原行上再截图。
    const editedRow = await $(`${TIMELINE_SELECTOR} [data-row-id="${rowId}"]`);
    await editedRow.moveTo();
    await browser.pause(400);
    const editShot = await shot("03-u03-composer-edit-bar");
    record("u03.screenshot", editShot);

    await clickSelectorByDom(
      '[data-testid="v4-composer-edit-cancel"]',
      "U03 编辑条没有取消按钮",
    );
    await browser.waitUntil(
      async () => {
        const state = await readComposerEditState();
        return !state.barExists && state.hintText === null;
      },
      { timeout: 30_000, interval: 200, timeoutMsg: "U03 取消后编辑条或行内提示没有消失" },
    );
    record("u03.cancelled", await readComposerEditState());
  });

  it("U04 正文注释：选择 → Annotate → 编号气泡 + composer chip → 删除撤销", async function () {
    this.timeout(600_000);
    await sendV4PromptAndWaitAccepted(
      `${ANNOTATION_PROMPT_MARKER}: Reply with a short plain-text paragraph.`,
      ANNOTATION_PROMPT_MARKER,
      "U04 注释 prompt 没有被接受",
      120_000,
    );
    await waitForV4AssistantMessageContaining(ANNOTATION_ASSISTANT_TOKEN, 120_000);
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "U04 正文回合在回复后没有结束",
      120_000,
    );
    // U03 的定位滚动会让时间线退出跟随底部；先回到真实用户看到的最新回复位置。
    await scrollTimelineToBottom();

    const selection = await selectAssistantText(ANNOTATION_SELECTION_TEXT);
    expect(selection.ok).toBe(true);
    expect(selection.selectedText).toContain(ANNOTATION_SELECTION_TEXT);
    record("u04.selection", selection);

    await waitForSelector(
      '[data-conversation-selection-tooltip="true"] [data-conversation-selection-action="comment"]',
      "U04 选择后没有出现 Annotate 动作",
    );
    const annotateLabel = await browser.execute(() =>
      document
        .querySelector<HTMLElement>('[data-conversation-selection-action="comment"]')
        ?.textContent?.replace(/\s+/gu, " ")
        .trim(),
    );
    expect(annotateLabel).toContain("Annotate");
    await clickSelectorByDom(
      '[data-conversation-selection-action="comment"]',
      "U04 Annotate 动作不可点击",
    );

    await waitForSelector(
      '[data-conversation-selection-comment-editor="true"] [data-conversation-selection-comment-input="true"]',
      "U04 注释输入浮层没有出现",
    );
    const typed = await browser.execute((comment) => {
      const input = document.querySelector<HTMLTextAreaElement>(
        '[data-conversation-selection-comment-input="true"]',
      );
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      setter?.call(input, comment);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return input.value === comment;
    }, ANNOTATION_COMMENT);
    expect(typed).toBe(true);
    await clickSelectorByDom(
      '[data-conversation-selection-comment-save="true"]',
      "U04 注释保存按钮不可点击",
    );

    let mark: AnnotationMarkSnapshot | null = null;
    await browser.waitUntil(
      async () => {
        mark = await readAnnotationMark();
        return mark.count > 0 && mark.number === 1 && Boolean(mark.rect);
      },
      { timeout: 30_000, interval: 200, timeoutMsg: "U04 保存后正文没有出现编号注释标记" },
    );
    const markState = mark!;
    expect(markState.markId).not.toBeNull();
    expect(markState.rect!.width).toBeGreaterThan(0);
    expect(markState.rect!.height).toBeGreaterThan(0);
    record("u04.mark", markState);

    await scrollAssistantMessageIntoView(ANNOTATION_ASSISTANT_TOKEN);
    await waitForAnnotationMarkVisible();
    await browser.pause(300);
    const markShot = await shot("04-u04-annotation-mark-number-bubble");
    record("u04.markScreenshot", markShot);

    const chipTrigger = await $(`${COMPOSER_SELECTOR} [data-conversation-selection-reference-count]`);
    await chipTrigger.waitForDisplayed({ timeout: 30_000, timeoutMsg: "U04 composer chip 没有出现" });
    await chipTrigger.moveTo();
    let chip: AnnotationChipSnapshot | null = null;
    try {
      await browser.waitUntil(
        async () => {
          chip = await readAnnotationChip();
          return chip.triggerCount === 1 && chip.comment === ANNOTATION_COMMENT;
        },
        { timeout: 15_000, interval: 200, timeoutMsg: "U04 composer chip 没有显示注释评论" },
      );
    } catch {
      // Electron 下 WebDriver hover 偶尔不产生 Radix 的 pointerenter；补一次真实焦点/指针事件。
      await browser.execute((composerSelector) => {
        const trigger = document.querySelector<HTMLElement>(
          `${composerSelector} [data-conversation-selection-reference-count]`,
        );
        if (!trigger) return;
        trigger.focus();
        trigger.dispatchEvent(
          new PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse" }),
        );
        trigger.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
      }, COMPOSER_SELECTOR);
      await browser.waitUntil(
        async () => {
          chip = await readAnnotationChip();
          return chip.triggerCount === 1 && chip.comment === ANNOTATION_COMMENT;
        },
        { timeout: 15_000, interval: 200, timeoutMsg: "U04 composer chip 没有显示注释评论" },
      );
    }
    record("u04.chip", chip);
    // Radix hover 卡在指针/焦点变化后会立即收起；不要等待，紧贴可见态截图并记录前后帧事实。
    const chipBeforeShot = await readAnnotationChip();
    record("u04.chipBeforeScreenshot", chipBeforeShot);
    const chipShot = await shot("05-u04-annotation-composer-chip");
    record("u04.chipScreenshot", chipShot);
    const chipAfterShot = await readAnnotationChip();
    record("u04.chipAfterScreenshot", chipAfterShot);
    if (chipAfterShot.comment !== ANNOTATION_COMMENT) {
      // WebDriver 的 moveTo 在部分 Electron/Chromedriver 组合下会立刻产生 pointerleave；
      // 用不跟随 leave 的合成 pointerenter 强制打开 hover 卡，再立即截图。
      await browser.execute((composerSelector) => {
        const trigger = document.querySelector<HTMLElement>(
          `${composerSelector} [data-conversation-selection-reference-count]`,
        );
        if (!trigger) return;
        trigger.focus();
        trigger.dispatchEvent(
          new PointerEvent("pointerenter", {
            bubbles: true,
            cancelable: false,
            pointerId: 1,
            pointerType: "mouse",
          }),
        );
        trigger.dispatchEvent(
          new PointerEvent("pointerover", {
            bubbles: true,
            cancelable: true,
            pointerId: 1,
            pointerType: "mouse",
          }),
        );
      }, COMPOSER_SELECTOR);
      await browser.waitUntil(
        async () => {
          const retry = await readAnnotationChip();
          return retry.comment === ANNOTATION_COMMENT;
        },
        { timeout: 10_000, interval: 100, timeoutMsg: "U04 chip 强制 hover 后仍没有显示评论" },
      );
      const retryShot = await shot("05b-u04-annotation-composer-chip-retry");
      record("u04.chipRetryScreenshot", retryShot);
      record("u04.chipRetry", await readAnnotationChip());
    }

    // 先把指针移出 chip，避免 Radix hover 卡继续遮住后续删除/恢复截图。
    await (await $(TIMELINE_SELECTOR)).moveTo();
    await browser.pause(300);

    // 删除：点正文编号气泡打开编辑浮层 → 显式删除 → 6 秒撤销 toast。
    await browser.execute(() => {
      document.querySelector<HTMLElement>("[data-annotation-mark-id]")?.click();
    });
    await waitForSelector(
      '[data-conversation-selection-comment-editor="true"][data-conversation-selection-comment-mode="edit"]',
      "U04 点编号气泡没有打开编辑浮层",
    );
    await clickSelectorByDom(
      '[data-conversation-selection-comment-delete="true"]',
      "U04 编辑浮层没有删除按钮",
    );

    let toast: ToastSnapshot | null = null;
    await browser.waitUntil(
      async () => {
        toast = await readToast();
        return toast.text.includes("Annotation deleted") && toast.undoButtonPresent;
      },
      { timeout: 5_000, interval: 100, timeoutMsg: "U04 删除后没有出现撤销 toast" },
    );
    const toastState = toast!;
    record("u04.toast", toastState);
    // toast 内容先挂载、再在 rAF 后进入可见态；等内容真正可见再截图。
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const host = document.getElementById("nibi-toast-host");
          if (!host) return false;
          return Array.from(host.querySelectorAll<HTMLElement>("div")).some((element) => {
            if (!(element.textContent ?? "").includes("Annotation deleted")) return false;
            const rect = element.getBoundingClientRect();
            return (
              rect.width > 200 &&
              rect.height > 30 &&
              Number(getComputedStyle(element).opacity) > 0.5
            );
          });
        }),
      { timeout: 5_000, interval: 100, timeoutMsg: "撤销 toast 没有可见地出现" },
    );
    await browser.pause(250);
    const toastShot = await shot("06-u04-annotation-delete-undo-toast");
    record("u04.toastScreenshot", toastShot);

    const markGone = await browser.execute(
      () => document.querySelectorAll("[data-annotation-mark]").length === 0,
    );
    expect(markGone).toBe(true);

    const undoClicked = await browser.execute(() => {
      const host = document.getElementById("nibi-toast-host");
      const button = Array.from(host?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (candidate) => (candidate.textContent ?? "").trim() === "Undo",
      );
      button?.click();
      return Boolean(button);
    });
    expect(undoClicked).toBe(true);

    let restored: AnnotationMarkSnapshot | null = null;
    await browser.waitUntil(
      async () => {
        restored = await readAnnotationMark();
        return restored.count > 0 && restored.number === 1;
      },
      { timeout: 30_000, interval: 200, timeoutMsg: "U04 撤销后正文标记没有恢复" },
    );
    record("u04.restored", restored);
    await scrollAssistantMessageIntoView(ANNOTATION_ASSISTANT_TOKEN);
    await waitForAnnotationMarkVisible();
    await browser.pause(300);
    const restoredShot = await shot("07-u04-annotation-mark-restored");
    record("u04.restoredScreenshot", restoredShot);
  });
});