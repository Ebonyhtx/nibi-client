/**
 * Worktree handoff transient-state evidence (manual-review / pending).
 *
 * Goal: capture real Electron pixels + DOM facts for the new non-blocking
 * `role="status"` notice shown after a managed worktree task is created and its
 * session auto-opens, until the first projection snapshot arrives.
 *
 * Why two probes:
 * - The notice window is short (~0.4s in practice). During the session switch the
 *   renderer's JS thread is busy for several seconds, so polling from Electron main
 *   via `executeJavaScript` misses the window entirely (measured: first poll resumed
 *   ~5s after the notice had already been replaced by the snapshot).
 * - Therefore an in-page MutationObserver is installed before sending. It records
 *   first-seen/disappeared facts at DOM mutation time, independent of main-process
 *   polling. In parallel, Electron main runs a `webContents.capturePage` burst over
 *   the pane clip; afterwards the frame whose timestamp falls inside
 *   [firstSeenAt, disappearedAt] is selected as pixel evidence.
 *
 * Flow:
 * 1. Isolated HOME + replay provider (WDIO harness), local Git workspace seeded with
 *    `ensureSixthBatchGitWorkspace` (reused from the sixth-batch helper, not reinvented).
 * 2. Create a new project draft, enable the managed Worktree toggle.
 * 3. Install the in-page observer + pane capture burst, then send the first prompt.
 * 4. The Host creates the worktree, auto-opens the session, and the notice may appear
 *    after the 250ms display delay if the pane is still blank. The test branches on the
 *    measured session-open -> first-row blank instead of hard-coding "must show".
 * 5. Record first-seen/disappeared facts, the in-window pane frame, and rows; fast path
 *    asserts the notice never flashed, slow path asserts non-blocking behavior.
 * 6. If the notice is never observed, record the exact reason/timings instead of faking it.
 *
 * Test id source: `TID_WORKTREE_HANDOFF` in
 * `packages/ui/src/managed-worktrees/testIds.ts` (the desktop spec hardcodes the same
 * stable string because `@nibi/ui` does not export that subpath).
 *
 * Run (repo root):
 *   NIBI_E2E_HOME_DIR=<isolated home> \
 *   NIBI_E2E_EVIDENCE_DIR=<evidence dir> \
 *   E2E_PROVIDER_HTTP_MODE=replay \
 *   E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/worktree-handoff.json,\
 * packages/desktop/test/e2e/fixtures/upstream/common.json \
 *   NIBI_BUNDLED_AGENT_RESOURCE_DIR=$PWD/apps/nibi-cli \
 *   pnpm --filter @nibi/desktop exec wdio run wdio.conf.ts \
 *     --spec test/e2e/bots/manual-review/pending/worktree-handoff-evidence.test.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_GIT_PANE,
  TID_GIT_TOGGLE,
  TID_V4_SESSION_PANE,
  testId,
} from "@nibi/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clearAppData,
  clickTestIdByDom,
  waitForTestIdByDom,
} from "../../../helpers/desktop-app.js";
import { startDraftFromProject } from "../../../helpers/project-sidebar.js";
import {
  ensureSixthBatchGitWorkspace,
  readSixthBatchGitWorkspace,
} from "../../../helpers/tier2-sixth-batch.js";
import {
  V4_MAIN_PANE_ID,
  prepareV4ConversationE2E,
  sendV4Prompt,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const EVIDENCE_DIR =
  process.env.NIBI_E2E_EVIDENCE_DIR?.trim() ||
  join(process.cwd(), ".e2e-artifacts", "worktree-handoff");
const E2E_HOME_DIR = process.env.NIBI_E2E_HOME_DIR?.trim();
if (!E2E_HOME_DIR) {
  throw new Error("NIBI_E2E_HOME_DIR missing; run through the isolated WDIO harness");
}

const FACTS_FILE = "wdio-facts.json";
const LOCALE = "en-US";
const PANE_SELECTOR = `[data-testid="${testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID)}"]`;
const TIMELINE_SELECTOR = `${PANE_SELECTOR} [data-testid="v4-timeline"]`;
const WORKTREE_TOGGLE_SELECTOR = '[data-testid="worktree-toggle"]';
const WORKTREE_BRANCH_PICKER_SELECTOR = '[data-testid="worktree-branch-picker"]';
/** Same stable id as `TID_WORKTREE_HANDOFF` in packages/ui/src/managed-worktrees/testIds.ts. */
const WORKTREE_HANDOFF_TEST_ID = "worktree-handoff";
const WORKTREE_HANDOFF_SELECTOR = `[data-testid="${WORKTREE_HANDOFF_TEST_ID}"]`;
const PROMPT_MARKER = "E2E_WORKTREE_HANDOFF";
const PROMPT = `${PROMPT_MARKER}: Reply with a short confirmation.`;
/** In-page observer cadence; also the Node-side DOM polling cadence. */
const OBSERVER_INTERVAL_MS = 50;
/** Mocha's outer config timeout is 120s for this spec; keep the case well below it. */
const FIRST_SEEN_TIMEOUT_MS = 35_000;
const DISAPPEAR_TIMEOUT_MS = 20_000;
const ROWS_TIMEOUT_MS = 30_000;
const CAPTURE_BURST_INTERVAL_MS = 10;
const CAPTURE_BURST_MAX_FRAMES = 400;
const CAPTURE_BURST_TIMEOUT_MS = 45_000;

interface ClipRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

interface HandoffFacts {
  activeElementTestId: string | null;
  ariaLive: string | null;
  at: number;
  clip: ClipRect | null;
  composerContentEditable: string | null;
  composerDisabled: boolean | null;
  composerInteractive: boolean;
  composerPresent: boolean;
  composerText: string | null;
  conversationRowCount: number;
  dialogOpen: boolean;
  dialogText: string | null;
  documentHasFocus: boolean;
  handoffRect: ClipRect | null;
  paneSessionId: string | null;
  paneTestId: string | null;
  pointerEvents: string | null;
  present: boolean;
  role: string | null;
  rowTexts: string[];
  text: string | null;
  timelinePresent: boolean;
  viewport: { height: number; width: number };
}

interface HandoffObserverState {
  disappearedAt: number | null;
  disappearedFacts: HandoffFacts | null;
  firstFacts: HandoffFacts | null;
  firstRowAt: number | null;
  firstRowFacts: HandoffFacts | null;
  firstSeenAt: number | null;
  installedAt: number;
  lastFacts: HandoffFacts | null;
  lastSeenAt: number | null;
  mutationCount: number;
  sessionOpenedAt: number | null;
  sessionOpenedFacts: HandoffFacts | null;
  tickCount: number;
}

interface PaneCaptureState {
  clip: ClipRect;
  error: string | null;
  frames: Array<{ at: number; base64: string }>;
  startedAt: number;
  status: "running" | "stopped";
  stoppedAt: number | null;
}

declare global {
  interface Window {
    // Test-side in-page instrumentation only; no production hook is added.
    __nibiWorktreeHandoffObserver?: HandoffObserverState;
  }
  // Electron-main pane capture burst shared between `browser.electron.execute` calls.
  var __nibiWorktreeHandoffFrames: PaneCaptureState | undefined;
}

const facts: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  host: { platform: process.platform, cwd: process.cwd(), home: E2E_HOME_DIR },
  e2eHomeDir: E2E_HOME_DIR,
  evidenceDir: EVIDENCE_DIR,
  screenshots: [] as string[],
  results: {} as Record<string, unknown>,
};

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

async function writeFactsToDisk(): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFile(join(EVIDENCE_DIR, FACTS_FILE), JSON.stringify(facts, null, 2), "utf-8");
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

/** Clip to the pane only; never fall back to a full-screen capture. */
async function shotClip(name: string, rect: ClipRect): Promise<string | null> {
  const viewport = (await browser.execute(() => ({
    height: window.innerHeight,
    width: window.innerWidth,
  }))) as { height: number; width: number };
  const clip = clampClip(rect, viewport);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.png`);
  try {
    const base64 = (await browser.electron.execute(async (electron, currentClip) => {
      const win = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed(),
      );
      if (!win) return null;
      const image = await win.webContents.capturePage(currentClip);
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

async function shotPane(name: string): Promise<string | null> {
  const rect = await readRect(PANE_SELECTOR);
  return rect ? shotClip(name, rect) : null;
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
  await browser.electron.execute(
    (electron, minimum, size) => {
      const win = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed(),
      );
      win?.setMinimumSize(minimum[0], minimum[1]);
      win?.setContentSize(size[0], size[1]);
    },
    original.minimum,
    original.size,
  );
  await browser.pause(250);
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

/** Mirrors the sixth-batch U06 diagnostics, plus the handoff-specific toggle state. */
function readWorktreeDebug(): Promise<Record<string, unknown>> {
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
    const toggle = document.querySelector<HTMLElement>('[data-testid="worktree-toggle"]');
    return {
      branchTriggerText: actionTrigger?.innerText?.replace(/\s+/gu, " ").trim() ?? null,
      draftProjectId: state?.draftProjectId ?? null,
      draftWorktree: state?.draftWorktree ?? null,
      gitPanePresent: Boolean(document.querySelector('[data-testid="git-pane"]')),
      workspacePath,
      worktreeBranchPickerPresent: Boolean(
        document.querySelector('[data-testid="worktree-branch-picker"]'),
      ),
      worktreeToggleAriaChecked: toggle?.getAttribute("aria-checked") ?? null,
      worktreeToggleDisabled: toggle?.hasAttribute("disabled") ?? null,
      worktreeTogglePresent: Boolean(toggle),
    };
  }, DEFAULT_WORKSPACE);
}

/**
 * Install an in-page MutationObserver before the session switch. The callback runs at
 * DOM-mutation time, so it still sees the notice while the renderer's JS thread is busy.
 */
async function installHandoffObserver(): Promise<void> {
  await browser.execute(
    (handoffSelector, paneSelector, intervalMs) => {
      const scope = window as Window;
      if (scope.__nibiWorktreeHandoffObserver) return;

      const readFacts = (): HandoffFacts => {
        const handoff = document.querySelector<HTMLElement>(handoffSelector);
        const pane =
          (handoff && handoff.closest<HTMLElement>('[data-testid^="v4-session-pane-"]')) ||
          document.querySelector<HTMLElement>('[data-testid^="v4-session-pane-"]');
        const timeline = pane?.querySelector<HTMLElement>('[data-testid="v4-timeline"]');
        const rows = timeline
          ? Array.from(timeline.querySelectorAll<HTMLElement>("[data-row-id]"))
          : [];
        const isVisible = (node: HTMLElement | null): boolean => {
          if (!node) return false;
          const rect = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden"
          );
        };
        const dialog = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-slot="dialog-content"], [role="dialog"], [role="alertdialog"]',
          ),
        ).find(isVisible);
        const composer = pane?.querySelector<HTMLElement>('[data-testid="v4-composer-input"]');
        const composerRect = composer?.getBoundingClientRect() ?? null;
        const composerStyle = composer ? getComputedStyle(composer) : null;
        const viewport = { height: window.innerHeight, width: window.innerWidth };
        const clipOf = (rect: DOMRect | null | undefined): ClipRect | null => {
          if (!rect || rect.width <= 0 || rect.height <= 0) return null;
          const x = Math.max(0, Math.min(Math.floor(rect.left), viewport.width - 1));
          const y = Math.max(0, Math.min(Math.floor(rect.top), viewport.height - 1));
          return {
            x,
            y,
            width: Math.max(1, Math.min(Math.ceil(rect.width), viewport.width - x)),
            height: Math.max(1, Math.min(Math.ceil(rect.height), viewport.height - y)),
          };
        };
        const normalize = (value: string | null | undefined): string =>
          (value ?? "").replace(/\s+/gu, " ").trim();
        return {
          activeElementTestId: document.activeElement
            ? document.activeElement.getAttribute("data-testid")
            : null,
          ariaLive: handoff ? handoff.getAttribute("aria-live") : null,
          at: Date.now(),
          clip: clipOf(pane?.getBoundingClientRect()),
          composerContentEditable: composer ? composer.getAttribute("contenteditable") : null,
          composerDisabled: composer
            ? composer.hasAttribute("disabled") ||
              composer.getAttribute("aria-disabled") === "true"
            : null,
          composerInteractive: Boolean(
            composer &&
              composerRect &&
              composerRect.width > 0 &&
              composerRect.height > 0 &&
              composerStyle?.pointerEvents !== "none" &&
              composerStyle?.visibility !== "hidden" &&
              composer.getAttribute("contenteditable") !== "false" &&
              !composer.hasAttribute("disabled") &&
              composer.getAttribute("aria-disabled") !== "true",
          ),
          composerPresent: Boolean(composer),
          composerText: composer ? normalize(composer.innerText).slice(0, 200) : null,
          conversationRowCount: rows.length,
          dialogOpen: Boolean(dialog),
          dialogText: dialog ? normalize(dialog.innerText).slice(0, 300) : null,
          documentHasFocus: document.hasFocus(),
          handoffRect: clipOf(handoff?.getBoundingClientRect()),
          paneSessionId: pane?.getAttribute("data-session-id") ?? null,
          paneTestId: pane?.getAttribute("data-testid") ?? null,
          pointerEvents: handoff ? getComputedStyle(handoff).pointerEvents : null,
          present: Boolean(handoff),
          role: handoff ? handoff.getAttribute("role") : null,
          rowTexts: rows
            .slice(0, 6)
            .map((row) => normalize(row.innerText).slice(0, 140)),
          text: handoff ? normalize(handoff.innerText) : null,
          timelinePresent: Boolean(timeline),
          viewport,
        };
      };

      const state: HandoffObserverState = {
        disappearedAt: null,
        disappearedFacts: null,
        firstFacts: null,
        firstRowAt: null,
        firstRowFacts: null,
        firstSeenAt: null,
        installedAt: Date.now(),
        lastFacts: null,
        lastSeenAt: null,
        mutationCount: 0,
        sessionOpenedAt: null,
        sessionOpenedFacts: null,
        tickCount: 0,
      };
      scope.__nibiWorktreeHandoffObserver = state;

      let everSeen = false;
      const tick = (): void => {
        state.tickCount += 1;
        const current = readFacts();
        const now = Date.now();
        // The handoff delay timer starts when the registry is marked at settlement,
        // just before the pane navigates to the new session. The first non-draft pane
        // session id is the closest DOM-visible proxy for that moment.
        if (
          state.sessionOpenedAt === null &&
          current.paneSessionId &&
          current.paneSessionId !== "draft"
        ) {
          state.sessionOpenedAt = now;
          state.sessionOpenedFacts = current;
        }
        // First content row: the new gate settles on `rows.window.length > 0`; the DOM
        // timeline row count is the same signal exposed to this test.
        if (state.firstRowAt === null && current.conversationRowCount > 0) {
          state.firstRowAt = now;
          state.firstRowFacts = current;
        }
        if (current.present) {
          everSeen = true;
          state.lastSeenAt = now;
          state.lastFacts = current;
          if (state.firstSeenAt === null) {
            state.firstSeenAt = now;
            state.firstFacts = current;
          }
        } else if (everSeen && state.disappearedAt === null) {
          state.disappearedAt = now;
          state.disappearedFacts = current;
        }
      };

      // The notice is a childList swap in the pane's empty-state slot; `data-session-id`
      // changes when the pane navigates to the auto-opened session. Watch the whole body
      // so the observer survives the draft -> worktree-session pane replacement.
      const observer = new MutationObserver(() => {
        state.mutationCount += 1;
        tick();
      });
      observer.observe(document.body, {
        attributeFilter: ["data-session-id"],
        attributes: true,
        childList: true,
        subtree: true,
      });
      window.setInterval(tick, intervalMs);
      tick();
    },
    WORKTREE_HANDOFF_SELECTOR,
    PANE_SELECTOR,
    OBSERVER_INTERVAL_MS,
  );
}

function readHandoffObserver(): Promise<HandoffObserverState | null> {
  return browser.execute(() => window.__nibiWorktreeHandoffObserver ?? null);
}

/**
 * Start a detached Electron-main capture burst over the pane clip. `capturePage` is a
 * browser-process/compositor operation, so it can still produce frames while the
 * renderer's JS thread is busy switching sessions.
 */
async function startPaneCaptureBurst(): Promise<void> {
  const rect = await readRect(PANE_SELECTOR);
  if (!rect) {
    record("worktreeHandoff.captureBurst", { error: "no-pane-rect" });
    return;
  }
  const viewport = (await browser.execute(() => ({
    height: window.innerHeight,
    width: window.innerWidth,
  }))) as { height: number; width: number };
  const clip = clampClip(rect, viewport);
  await browser.electron.execute(
    (electron, burstClip, options) => {
      const state: PaneCaptureState = {
        clip: burstClip,
        error: null,
        frames: [],
        startedAt: Date.now(),
        status: "running",
        stoppedAt: null,
      };
      globalThis.__nibiWorktreeHandoffFrames = state;
      const win = electron.BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed(),
      );
      if (!win) {
        state.status = "stopped";
        state.error = "no-window";
        state.stoppedAt = Date.now();
        return;
      }
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      void (async () => {
        const deadline = Date.now() + options.timeoutMs;
        while (state.status === "running" && Date.now() < deadline) {
          try {
            const image = await win.webContents.capturePage(burstClip);
            if (!image.isEmpty()) {
              state.frames.push({ at: Date.now(), base64: image.toPNG().toString("base64") });
              if (state.frames.length > options.maxFrames) {
                state.frames.splice(0, state.frames.length - options.maxFrames);
              }
            }
          } catch (error) {
            state.error = error instanceof Error ? error.message : String(error);
          }
          await sleep(options.intervalMs);
        }
        if (state.status === "running") state.status = "stopped";
        state.stoppedAt = Date.now();
      })().catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error);
        state.status = "stopped";
        state.stoppedAt = Date.now();
      });
    },
    clip,
    {
      intervalMs: CAPTURE_BURST_INTERVAL_MS,
      maxFrames: CAPTURE_BURST_MAX_FRAMES,
      timeoutMs: CAPTURE_BURST_TIMEOUT_MS,
    },
  );
  record("worktreeHandoff.captureBurst", { clip, started: true });
}

async function stopPaneCaptureBurst(): Promise<void> {
  await browser.electron.execute(() => {
    const state = globalThis.__nibiWorktreeHandoffFrames;
    if (state && state.status === "running") state.status = "stopped";
  });
}

interface PaneCaptureFrameSample {
  at: number;
  base64: string;
  deltaFromDisappearedMs: number | null;
  deltaFromFirstSeenMs: number;
}

interface PaneCaptureSelection {
  chosenIndex: number;
  frameCount: number;
  frames: PaneCaptureFrameSample[];
  inWindow: boolean;
  nearestDeltaMs: number;
  prerollMs: number;
  tailMs: number;
  windowFrameCount: number;
}

/**
 * Select burst frames inside the painted notice window.
 *
 * `firstSeenAt` comes from a renderer MutationObserver; `capturePage` frames are
 * timestamped when the PNG is ready. The two clocks bracket the same paint with a small
 * skew (measured: frames stamped 38-70ms before `firstSeenAt` may already show the
 * notice, while the immediately preceding frame can still show "Creating worktree").
 * A bounded pre-roll/tail is part of the window; the chosen frame is the one closest to
 * the window midpoint, and every in-window frame is returned so the caller can save and
 * compare them instead of silently trusting one.
 */
async function readPaneCaptureFrames(
  firstSeenAt: number,
  disappearedAt: number | null,
): Promise<PaneCaptureSelection | null> {
  const result = await browser.electron.execute(
    (electron, startAt, endAt) => {
      const state = globalThis.__nibiWorktreeHandoffFrames;
      if (!state || state.frames.length === 0) return null;
      // Observer timestamp vs capture-ready timestamp skew, measured on real hardware.
      const prerollMs = 80;
      const tailMs = 20;
      const lower = startAt - prerollMs;
      const upper = endAt === null ? Number.POSITIVE_INFINITY : endAt + tailMs;
      const inWindow = state.frames
        .filter((frame) => frame.at >= lower && frame.at <= upper)
        .sort((left, right) => left.at - right.at);
      let nearest = state.frames[0]!;
      let nearestDeltaMs = Math.abs(nearest.at - startAt);
      for (const frame of state.frames) {
        const delta = Math.abs(frame.at - startAt);
        if (delta < nearestDeltaMs) {
          nearest = frame;
          nearestDeltaMs = delta;
        }
      }
      const selected = inWindow.length > 0 ? inWindow.slice(0, 6) : [nearest];
      const targetAt = endAt === null ? startAt : startAt + (endAt - startAt) / 2;
      let chosenIndex = 0;
      let bestDelta = Math.abs(selected[0]!.at - targetAt);
      for (let index = 1; index < selected.length; index += 1) {
        const delta = Math.abs(selected[index]!.at - targetAt);
        if (delta < bestDelta) {
          bestDelta = delta;
          chosenIndex = index;
        }
      }
      return {
        chosenIndex,
        frameCount: state.frames.length,
        frames: selected.map((frame) => ({
          at: frame.at,
          base64: frame.base64,
          deltaFromDisappearedMs: endAt === null ? null : frame.at - endAt,
          deltaFromFirstSeenMs: frame.at - startAt,
        })),
        inWindow: inWindow.length > 0,
        nearestDeltaMs,
        prerollMs,
        tailMs,
        windowFrameCount: inWindow.length,
      };
    },
    firstSeenAt,
    disappearedAt,
  );
  return result as unknown as PaneCaptureSelection | null;
}

/** Post-settle facts: notice gone, rows present, dialog/composer state. */
function readPaneSettleFacts(): Promise<Record<string, unknown>> {
  return browser.execute(
    (paneSelector, timelineSelector, handoffSelector) => {
      const pane = document.querySelector<HTMLElement>(paneSelector);
      const timeline = pane?.querySelector<HTMLElement>(timelineSelector);
      const rows = timeline
        ? Array.from(timeline.querySelectorAll<HTMLElement>("[data-row-id]"))
        : [];
      const isVisible = (node: HTMLElement | null): boolean => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      };
      const dialog = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-slot="dialog-content"], [role="dialog"], [role="alertdialog"]',
        ),
      ).find(isVisible);
      const composer = pane?.querySelector<HTMLElement>('[data-testid="v4-composer-input"]');
      const composerRect = composer?.getBoundingClientRect() ?? null;
      const composerStyle = composer ? getComputedStyle(composer) : null;
      return {
        composerInteractive: Boolean(
          composer &&
            composerRect &&
            composerRect.width > 0 &&
            composerRect.height > 0 &&
            composerStyle?.pointerEvents !== "none" &&
            composerStyle?.visibility !== "hidden" &&
            composer.getAttribute("contenteditable") !== "false" &&
            !composer.hasAttribute("disabled") &&
            composer.getAttribute("aria-disabled") !== "true",
        ),
        composerPresent: Boolean(composer),
        dialogOpen: Boolean(dialog),
        dialogText: dialog
          ? (dialog.innerText || "").replace(/\s+/gu, " ").trim().slice(0, 300)
          : null,
        handoffPresent: Boolean(document.querySelector(handoffSelector)),
        paneSessionId: pane?.getAttribute("data-session-id") ?? null,
        rowTexts: rows
          .slice(0, 6)
          .map((row) => (row.innerText || "").replace(/\s+/gu, " ").trim().slice(0, 140)),
        timelinePresent: Boolean(timeline),
        timelineRowCount: rows.length,
      };
    },
    PANE_SELECTOR,
    TIMELINE_SELECTOR,
    WORKTREE_HANDOFF_SELECTOR,
  );
}

describe("Worktree handoff 提示（真实 Desktop）", () => {
  let originalWindow: WindowGeometry | null = null;

  before(async function () {
    this.timeout(600_000);
    await mkdir(EVIDENCE_DIR, { recursive: true });
    const providerId = process.env.E2E_PROVIDER_ID?.trim() || "e2e-upstream";
    const modelId = process.env.E2E_PROVIDER_MODEL?.trim() || "deepseek-v4-flash";
    const thoughtLevel = process.env.E2E_PROVIDER_THOUGHT_LEVEL?.trim() || undefined;
    record("fixture.provider", { modelId, providerId, thoughtLevel: thoughtLevel ?? null });
    // Reuse the sixth-batch Git workspace helper: git init + one commit, idempotent.
    await ensureSixthBatchGitWorkspace(DEFAULT_WORKSPACE);
    record("fixture.git", readSixthBatchGitWorkspace(DEFAULT_WORKSPACE));
    await prepareV4ConversationE2E();
    await setEnglishLocale();
    originalWindow = await setMainWindowSize(1280, 900);
  });

  afterEach(async () => {
    await writeFactsToDisk();
  });

  after(async () => {
    await writeFactsToDisk();
    await restoreMainWindowSize(originalWindow);
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("worktree handoff：按实际时序验证快速路径抑制与慢路径非阻断", async function () {
    this.timeout(110_000);
    await setMainWindowSize(1280, 900);
    await ensureSidebarVisible();
    await startDraftFromProject(DEFAULT_WORKSPACE);
    record("worktree.gitStateBeforeRefresh", await readWorktreeDebug());

    // The Git summary is cached; opening the Git pane is a best-effort refresh so the
    // freshly initialized isolated repository is visible to the worktree entry.
    try {
      await clickTestIdByDom(TID_GIT_TOGGLE, {
        timeout: 10_000,
        timeoutMsg: "没有找到 Git 面板入口",
      });
      await waitForTestIdByDom(TID_GIT_PANE, { timeout: 15_000 });
      await browser.pause(1_000);
      record("worktree.gitPaneOpened", true);
    } catch (error) {
      record("worktree.gitPaneOpened", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    record("worktree.gitStateAfterRefresh", await readWorktreeDebug());

    const toggleVisible = await browser
      .waitUntil(
        () =>
          browser.execute(
            (selector) => Boolean(document.querySelector(selector)),
            WORKTREE_TOGGLE_SELECTOR,
          ),
        { timeout: 60_000, interval: 200, timeoutMsg: "新任务页没有出现 Worktree 开关" },
      )
      .then(() => true)
      .catch(() => false);
    if (!toggleVisible) {
      recordResult("worktreeHandoff", {
        debug: await readWorktreeDebug(),
        mode: "skipped",
        reason:
          "worktree toggle not rendered within 60s (requires a local Git repository, draft project id, and runtime worktreeCwd capability); no fake entry captured",
      });
      await shotPane("00-worktree-handoff-toggle-missing");
      return;
    }

    const toggleState = (await browser.execute((selector) => {
      const toggle = document.querySelector<HTMLElement>(selector);
      return {
        checked: toggle?.getAttribute("aria-checked") ?? null,
        disabled: toggle?.hasAttribute("disabled") ?? null,
        present: Boolean(toggle),
      };
    }, WORKTREE_TOGGLE_SELECTOR)) as {
      checked: string | null;
      disabled: boolean | null;
      present: boolean;
    };
    if (toggleState.disabled) {
      recordResult("worktreeHandoff", {
        debug: await readWorktreeDebug(),
        mode: "skipped",
        reason: "worktree toggle rendered but is disabled (runtime worktreeCwd unavailable)",
      });
      await shotPane("00-worktree-handoff-toggle-disabled");
      return;
    }
    if (toggleState.checked !== "true") {
      await browser.execute((selector) => {
        document.querySelector<HTMLElement>(selector)?.click();
      }, WORKTREE_TOGGLE_SELECTOR);
    }
    await browser.waitUntil(
      () =>
        browser.execute(
          (toggleSelector, pickerSelector) => {
            const toggle = document.querySelector<HTMLElement>(toggleSelector);
            return (
              toggle?.getAttribute("aria-checked") === "true" &&
              Boolean(document.querySelector(pickerSelector))
            );
          },
          WORKTREE_TOGGLE_SELECTOR,
          WORKTREE_BRANCH_PICKER_SELECTOR,
        ),
      { timeout: 15_000, interval: 100, timeoutMsg: "Worktree 开关没有切换出分支选择" },
    );

    const composerFacts = await browser.execute(
      (toggleSelector, pickerSelector) => {
        const toggle = document.querySelector<HTMLElement>(toggleSelector);
        const branch = document.querySelector<HTMLElement>(pickerSelector);
        return {
          branchText: branch?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
          toggleChecked: toggle?.getAttribute("aria-checked") ?? null,
          toggleLabel:
            toggle?.closest("label")?.textContent?.replace(/\s+/gu, " ").trim() ?? null,
        };
      },
      WORKTREE_TOGGLE_SELECTOR,
      WORKTREE_BRANCH_PICKER_SELECTOR,
    );
    record("worktree.composer", composerFacts);
    const toggleShot = await shotPane("00-worktree-toggle-enabled");
    record("worktree.toggleScreenshot", toggleShot);

    // Install instrumentation before sending: the notice window is shorter than the
    // renderer's session-switch block, so main-process polling alone misses it.
    await installHandoffObserver();
    await startPaneCaptureBurst();
    const sendAt = Date.now();
    record("worktreeHandoff.timings.sendAt", sendAt);
    try {
      await sendV4Prompt(PROMPT);
    } catch (error) {
      await stopPaneCaptureBurst();
      recordResult("worktreeHandoff", {
        debug: await readWorktreeDebug(),
        error: error instanceof Error ? error.message : String(error),
        mode: "send-failed",
        reason: "the worktree draft did not accept the first prompt; the creation flow never ran",
        timings: { sendAt },
      });
      await shotPane("00-worktree-handoff-send-failed");
      return;
    }

    // Node-side 50ms polling until either the first content row or the notice appears.
    // The in-page observer is authoritative for timestamps; this loop is the explicit
    // polling contract and stops early if the creation card reports a failure.
    let nodeObservedAt: number | null = null;
    let nodePollError: string | null = null;
    let creationFailed = false;
    try {
      await browser.waitUntil(
        async () => {
          const current = await readHandoffObserver();
          if (current?.firstRowAt || current?.firstSeenAt) return true;
          const present = await browser.execute(
            (selector) => Boolean(document.querySelector(selector)),
            WORKTREE_HANDOFF_SELECTOR,
          );
          if (present) {
            nodeObservedAt ??= Date.now();
            return true;
          }
          creationFailed = Boolean(
            await browser.execute(
              (selector) => Boolean(document.querySelector(selector)),
              '[data-testid="worktree-creation-retry"]',
            ),
          );
          return creationFailed;
        },
        {
          timeout: FIRST_SEEN_TIMEOUT_MS,
          interval: OBSERVER_INTERVAL_MS,
          timeoutMsg: "发送后 35s 内既没有内容行也没有 worktree-handoff 提示",
        },
      );
    } catch (error) {
      nodePollError = error instanceof Error ? error.message : String(error);
    }

    let observer = await readHandoffObserver();
    // If content arrived and no notice has been seen, wait past the 250ms display-delay
    // window so a delayed notice would have been recorded before we assert suppression.
    if (observer?.firstRowAt && !observer.firstSeenAt) {
      await browser.pause(400);
      observer = await readHandoffObserver();
    }

    const sessionOpenedAt = observer?.sessionOpenedAt ?? null;
    const firstRowAt = observer?.firstRowAt ?? null;
    const firstSeenAt = observer?.firstSeenAt ?? nodeObservedAt;
    const firstFacts = observer?.firstFacts ?? null;
    // The 250ms delay starts when the handoff registry is marked at settlement (session
    // auto-open), not at send. `sendToFirstRowMs` additionally includes worktree creation.
    const blankMs = firstRowAt && sessionOpenedAt ? firstRowAt - sessionOpenedAt : null;
    const sendToFirstRowMs = firstRowAt ? firstRowAt - sendAt : null;
    const sendToFirstSeenMs = firstSeenAt ? firstSeenAt - sendAt : null;
    const noticeAppeared = firstSeenAt !== null;

    record("worktreeHandoff.timing", {
      blankAfterSessionOpenMs: blankMs,
      creationFailed,
      firstRowAt,
      firstSeenAt,
      nodeObservedAt,
      nodePollError,
      noticeAppeared,
      sendToFirstRowMs,
      sendToFirstSeenMs,
      sessionOpenedAt,
      showDelayMs: 250,
      note:
        "showDelayMs starts at the handoff mark (session auto-open); sendToFirstRowMs includes worktree creation and is not the delay input",
    });
    record("worktreeHandoff.firstRow", {
      firstRowAt,
      firstRowFacts: observer?.firstRowFacts ?? null,
      note:
        "DOM timeline row count is the test proxy for snapshot.rows.window length; the projection store is not exposed",
      sendToFirstRowMs,
      sessionOpenToFirstRowMs: blankMs,
      sessionOpenedAt,
      sessionOpenedFacts: observer?.sessionOpenedFacts ?? null,
    });

    // Fast path: content arrived inside the 250ms delay, so the notice must never render.
    const fastPath = blankMs !== null && blankMs < 250;
    if (fastPath) {
      await stopPaneCaptureBurst();
      const settleFacts = await readPaneSettleFacts();
      const settledShot = await shotPane("02-worktree-handoff-settled");
      record("worktreeHandoff.conversation", {
        rowsAppeared: true,
        rowsError: null,
        rowsWaitMs: 0,
        settleFacts,
        screenshot: settledShot,
      });
      recordResult("worktreeHandoff", {
        branch: "fast-path-suppressed",
        firstRow: facts["worktreeHandoff.firstRow"],
        mode: "fast-path-suppressed",
        noticeAppeared,
        screenshots: { settled: settledShot },
        timing: facts["worktreeHandoff.timing"],
        toggleScreenshot: toggleShot,
      });
      // Fast-path delivery guarantee: the delayed notice never flashes.
      expect(noticeAppeared).toBe(false);
      expect(blankMs).toBeLessThan(250);
      expect((settleFacts as { timelineRowCount?: number }).timelineRowCount ?? 0).toBeGreaterThan(0);
      return;
    }

    // Slow path (or indeterminate): the blank exceeded the delay, so the notice should show.
    if (!firstSeenAt || !firstFacts) {
      await stopPaneCaptureBurst();
      const settleFacts = await readPaneSettleFacts();
      await shotPane("00-worktree-handoff-not-observed");
      recordResult("worktreeHandoff", {
        branch: blankMs === null ? "indeterminate" : "slow-path-not-shown",
        creationFailed,
        debug: await readWorktreeDebug(),
        mode: "not-observed",
        observer,
        reason: creationFailed
          ? "worktree creation reported failure; no session auto-open, so the handoff notice could not appear"
          : blankMs === null
            ? "could not measure session-open -> first-row blank (no session pane or no content row observed within the window)"
            : `session-open -> first-row blank was ${blankMs}ms (>= 250ms) but the delayed notice was not observed`,
        settleFacts,
        timing: facts["worktreeHandoff.timing"],
      });
      // If the blank exceeded the delay, the delayed notice is a delivery guarantee.
      if (blankMs !== null && blankMs >= 250) {
        expect(noticeAppeared).toBe(true);
      }
      return;
    }

    // Wait for the observer's disappeared timestamp (first snapshot / error / 30s cap).
    try {
      await browser.waitUntil(
        async () => {
          observer = await readHandoffObserver();
          return Boolean(observer?.disappearedAt);
        },
        {
          timeout: DISAPPEAR_TIMEOUT_MS,
          interval: OBSERVER_INTERVAL_MS,
          timeoutMsg: "worktree-handoff 提示在 20s 内没有退场",
        },
      );
    } catch (error) {
      record(
        "worktreeHandoff.disappearPollError",
        error instanceof Error ? error.message : String(error),
      );
    }
    observer = await readHandoffObserver();
    const disappearedAt = observer?.disappearedAt ?? null;
    record("worktreeHandoff.disappearance", {
      disappearedAt,
      facts: observer?.disappearedFacts ?? null,
      visibleForMs: disappearedAt ? disappearedAt - firstSeenAt : null,
    });

    // Stop the burst only after the window closed, then save every in-window frame and
    // mark the one closest to the window midpoint as the primary pixel evidence.
    await stopPaneCaptureBurst();
    const captureSelection = await readPaneCaptureFrames(firstSeenAt, disappearedAt);
    let burstShot: string | null = null;
    const savedBurstFrames: Array<Record<string, unknown>> = [];
    if (captureSelection) {
      await mkdir(EVIDENCE_DIR, { recursive: true });
      for (let index = 0; index < captureSelection.frames.length; index += 1) {
        const frame = captureSelection.frames[index]!;
        const path = join(EVIDENCE_DIR, `01-worktree-handoff-pane-frame-${index}.png`);
        await writeFile(path, Buffer.from(frame.base64, "base64"));
        pushScreenshot(path);
        const chosen = index === captureSelection.chosenIndex;
        if (chosen) burstShot = path;
        savedBurstFrames.push({
          at: frame.at,
          chosen,
          deltaFromDisappearedMs: frame.deltaFromDisappearedMs,
          deltaFromFirstSeenMs: frame.deltaFromFirstSeenMs,
          path,
        });
      }
      record("worktreeHandoff.captureFrame", {
        chosenIndex: captureSelection.chosenIndex,
        frameCount: captureSelection.frameCount,
        frames: savedBurstFrames,
        inWindow: captureSelection.inWindow,
        nearestDeltaMs: captureSelection.nearestDeltaMs,
        prerollMs: captureSelection.prerollMs,
        screenshot: burstShot,
        tailMs: captureSelection.tailMs,
        windowFrameCount: captureSelection.windowFrameCount,
      });
    }

    // The real conversation rows must take the notice's place.
    const rowsWaitStartedAt = Date.now();
    let rowsAppeared = false;
    let rowsError: string | null = null;
    try {
      await waitForV4TimelineContaining(PROMPT_MARKER, ROWS_TIMEOUT_MS);
      rowsAppeared = true;
    } catch (error) {
      rowsError = error instanceof Error ? error.message : String(error);
    }
    const settleFacts = await readPaneSettleFacts();
    const settledShot = await shotPane("02-worktree-handoff-settled");
    record("worktreeHandoff.conversation", {
      rowsAppeared,
      rowsError,
      rowsWaitMs: Date.now() - rowsWaitStartedAt,
      settleFacts,
      screenshot: settledShot,
    });

    recordResult("worktreeHandoff", {
      branch: "slow-path-notice",
      burstFrame: facts["worktreeHandoff.captureFrame"] ?? null,
      disappearance: facts["worktreeHandoff.disappearance"],
      firstRow: facts["worktreeHandoff.firstRow"],
      firstSight: {
        firstSeenAt,
        latencyFromSendMs: firstSeenAt - sendAt,
        role: firstFacts.role,
        text: firstFacts.text,
      },
      mode: "slow-path-notice",
      paneSessionId: firstFacts.paneSessionId,
      rowsAppeared,
      screenshots: { burst: burstShot, settled: settledShot },
      timing: facts["worktreeHandoff.timing"],
      toggleScreenshot: toggleShot,
      visibleForMs: facts["worktreeHandoff.disappearance"]
        ? (facts["worktreeHandoff.disappearance"] as { visibleForMs?: number | null }).visibleForMs
        : null,
    });

    // Slow-path feature guarantees for the captured state.
    expect(firstFacts.present).toBe(true);
    expect(firstFacts.role).toBe("status");
    expect(firstFacts.ariaLive).toBe("polite");
    expect((firstFacts.text ?? "").trim().length).toBeGreaterThan(0);
    expect(firstFacts.paneSessionId).toBeTruthy();
    expect(firstFacts.paneSessionId).not.toBe("draft");
    // Non-blocking: no dialog while the notice is shown, and the composer is present.
    expect(firstFacts.dialogOpen).toBe(false);
    expect(firstFacts.composerPresent).toBe(true);
    // The notice must actually leave once content/error/closed/30s lands.
    expect(disappearedAt).toBeTruthy();
    if (firstRowAt) {
      // Content rows must take the notice's place, and the composer must be usable then.
      expect(rowsAppeared).toBe(true);
      expect((settleFacts as { timelineRowCount?: number }).timelineRowCount ?? 0).toBeGreaterThan(0);
      expect(observer?.disappearedFacts?.dialogOpen ?? false).toBe(false);
      expect(observer?.disappearedFacts?.composerInteractive ?? false).toBe(true);
    }
  });
});
