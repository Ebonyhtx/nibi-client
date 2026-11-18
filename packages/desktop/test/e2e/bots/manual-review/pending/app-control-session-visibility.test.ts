/**
 * App 控制与 CreateSession 侧栏可见性证据（manual-review / pending）。
 *
 * 目的：只验证真实内核回执驱动的 UI，不 mock 工具结果：
 * 1. ListProjects 工具卡渲染出项目区（真实 Host/内核回执）。
 * 2. CreateSession 在对话进行中创建一个后台会话，侧栏不 reload 就出现新的 task 行，
 *    且当前 pane 的 session/target 不变。
 *
 * 运行：
 *   pnpm --filter @nibi/desktop exec wdio run wdio.conf.ts \
 *     --spec test/e2e/bots/manual-review/pending/app-control-session-visibility.test.ts
 *
 * 依赖 upstream/common.json 的 E2E_APP_CONTROL_* fixtures。
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { prepareV4ConversationE2E, sendV4PromptAndWaitAccepted, waitForV4AssistantMessageContaining, getV4PaneSnapshot, getV4ConversationState, approveV4Permission } from "../../../helpers/v4-conversation.js";
import { waitForTestIdByDom } from "../../../helpers/desktop-app.js";

const EVIDENCE_DIR =
  process.env.NIBI_E2E_EVIDENCE_DIR?.trim() ||
  join(process.cwd(), ".e2e-artifacts", "app-control-session-visibility");
const TASK_ROW_SELECTOR = '[data-testid^="task-item-"]';

async function shot(name: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await browser.saveScreenshot(join(EVIDENCE_DIR, `${name}.png`));
}

async function taskRowCount(): Promise<number> {
  return (await browser.execute(
    (selector) => document.querySelectorAll(selector).length,
    TASK_ROW_SELECTOR,
  )) as number;
}

async function clickSessionCardByLabel(labels: readonly string[]): Promise<boolean> {
  return (await browser.execute((candidates) => {
    const target = Array.from(
      document.querySelectorAll<HTMLElement>('[role="button"], button'),
    ).find((node) => candidates.some((label) => (node.textContent ?? "").includes(label)));
    if (!target) return false;
    target.click();
    return true;
  }, labels)) as boolean;
}

describe("App control session visibility (manual review)", () => {
  before(async () => {
    await prepareV4ConversationE2E();
  });

  it("ListProjects renders a real project card", async function () {
    this.timeout(300_000);
    await sendV4PromptAndWaitAccepted(
      "E2E_APP_CONTROL_LIST_PROJECTS",
      "E2E_APP_CONTROL_LIST_PROJECTS",
      "App control prompt was not accepted",
      120_000,
    );
    await waitForV4AssistantMessageContaining("upstream-e2e-ok", 120_000);
    await browser.waitUntil(() => clickSessionCardByLabel(["列出项目", "List projects"]), {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: "ListProjects card summary did not reach the timeline",
    });
    await waitForTestIdByDom("session-tool-details", { timeout: 20_000 });
    await waitForTestIdByDom("session-tool-projects", { timeout: 20_000 });
    await browser.pause(600);
    const card = (await browser.execute(() => {
      const root = document.querySelector<HTMLElement>('[data-testid="session-tool-projects"]');
      return {
        visible: Boolean(root),
        text: (root?.textContent ?? "").replace(/\s+/gu, " ").trim(),
      };
    })) as { visible: boolean; text: string };
    await shot("09a-list-projects-card");
    expect(card.visible).toBe(true);
    expect(card.text.length).toBeGreaterThan(0);
  });

  it("CreateSession adds a sidebar row without reload and keeps the active pane", async function () {
    this.timeout(300_000);
    // 侧栏必须展开才看得到新行；已有测试的布局 helper 只在 evidence 里，这里直接查 DOM。
    await browser.execute(() => {
      (window as Window & { __nibiAppControlNoReload?: boolean }).__nibiAppControlNoReload = true;
    });
    const beforeCount = await taskRowCount();
    const beforePane = await getV4PaneSnapshot();
    const beforeState = await getV4ConversationState();
    await sendV4PromptAndWaitAccepted(
      "E2E_APP_CONTROL_CREATE_SESSION",
      "E2E_APP_CONTROL_CREATE_SESSION",
      "CreateSession prompt was not accepted",
      120_000,
    );
    // CreateSession 是写工具：内核按 session_control.createSession 要求用户确认。
    // 弹窗不存在（yolo/自动批准）也算通过，不能盲点其它确认框。
    await approveV4Permission().catch(() => false);
    await waitForV4AssistantMessageContaining("upstream-e2e-ok", 120_000);
    await browser.waitUntil(async () => (await taskRowCount()) > beforeCount, {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: "CreateSession did not add a sidebar task row",
    });
    const afterPane = await getV4PaneSnapshot();
    const afterState = await getV4ConversationState();
    expect(afterPane.sessionId).toBe(beforePane.sessionId);
    expect(afterState.targetId).toBe(beforeState.targetId);
    const reloaded = (await browser.execute(
      () =>
        (window as Window & { __nibiAppControlNoReload?: boolean }).__nibiAppControlNoReload !==
        true,
    )) as boolean;
    expect(reloaded).toBe(false);
    // 新行必须是真实任务行，不是占位：文本非空。
    const newRowText = (await browser.execute((selector) => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>(selector));
      return (rows.at(-1)?.textContent ?? "").replace(/\s+/gu, " ").trim();
    }, TASK_ROW_SELECTOR)) as string;
    expect(newRowText.length).toBeGreaterThan(0);
    await shot("09b-create-session-sidebar-row");
  });
});