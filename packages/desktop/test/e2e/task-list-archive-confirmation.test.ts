import {
  TID_VIRTUAL_PROJECT_NEW_TASK,
  TID_CONVERSATION_SECTION,
  TID_TASK_ARCHIVE,
  TID_TASK_ITEM,
  TID_V4_SESSION_PANE,
  testId,
} from "@nibi/shared/test-ids";
import { clearAppData } from "./helpers/desktop-app.js";
import {
  E2E_REPLY_TOKEN,
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "./helpers/conversation-session.js";
import { sel } from "./helpers/selectors.js";
import {
  V4_MAIN_PANE_ID,
  getV4ConfigProjection,
  getV4PaneSnapshot,
  prepareV4ConversationE2E,
  sendV4Prompt,
  switchV4Mode,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "./helpers/v4-conversation.js";

describe("任务列表归档二次确认 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("项目视图的任务区归档确认不会在按下时消失，完整点击后任务离开任务区", async function () {
    this.timeout(150000);

    await ensureReadonlyToolFixtureFile();
    await prepareV4ConversationE2E();
    await useProjectConversationTaskView();
    await browser.refresh();
    await startConversationTaskDraft();
    // 前置只读工具要真正执行完才能拿到 taskId；默认 Ask 模式会停在权限弹窗。
    await switchV4Mode("yolo");
    await confirmFullAccessModeIfAsked();

    const marker = `E2E_FIRST_SEND_TASK_ARCHIVE_CONFIRM_${Date.now()}`;
    await sendV4Prompt(buildReadonlyToolPrompt(marker));
    await waitForV4TimelineContaining(marker);
    await waitForV4TimelineContaining(E2E_REPLY_TOKEN, 90000);
    const completed = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop && Boolean(snapshot.sessionId) && snapshot.sessionId !== "draft",
      "任务归档确认 E2E 前置任务没有完成",
      90000,
    );

    // 修复原因：v4 taskId 就是 pane 绑定的 sessionId；legacy ChatView root 已退出 DOM。
    const taskId = completed.sessionId ?? (await getV4PaneSnapshot()).sessionId;
    expect(taskId).toBeTruthy();

    await hoverConversationTaskRow(taskId as string);
    await waitForArchiveButtonState(taskId as string, (state) => state.visible);

    await $(sel(testId(TID_TASK_ARCHIVE, taskId as string))).click();
    await waitForArchiveButtonState(taskId as string, (state) => state.confirming && state.visible);

    await pointerDownArchiveConfirmButton(taskId as string);
    await waitForArchiveButtonState(taskId as string, (state) => state.confirming && state.visible);

    await movePointerAwayFromTaskRow();
    await waitForArchiveButtonState(taskId as string, (state) => state.confirming && state.visible);

    await clickBlankArea();
    await waitForArchiveButtonState(
      taskId as string,
      (state) => !state.confirming && !state.exists,
    );

    await hoverConversationTaskRow(taskId as string);
    await waitForArchiveButtonState(taskId as string, (state) => state.visible);
    await $(sel(testId(TID_TASK_ARCHIVE, taskId as string))).click();
    await waitForArchiveButtonState(taskId as string, (state) => state.confirming && state.visible);
    await $(sel(testId(TID_TASK_ARCHIVE, taskId as string))).click();
    await waitForConversationTaskRowAbsent(taskId as string);
  });
});

async function confirmFullAccessModeIfAsked() {
  // switchV4Mode 只是点了菜单项；完全访问确认框可能下一帧才挂载，必须轮询到按钮可用再确认。
  await browser.waitUntil(
    async () => {
      if ((await getV4ConfigProjection()).mode === "yolo") return true;
      await browser.execute(() => {
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        if (!dialog) return;
        const checkbox = dialog.querySelector<HTMLElement>('[role="checkbox"]');
        if (checkbox && checkbox.getAttribute("aria-checked") !== "true") checkbox.click();
        const confirm = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).find(
          (button) => /Enable full access|启用完全访问/u.test(button.textContent ?? ""),
        );
        if (confirm && !confirm.disabled) confirm.click();
      });
      return (await getV4ConfigProjection()).mode === "yolo";
    },
    { timeout: 15000, interval: 200, timeoutMsg: "归档 E2E 没有切到 yolo 模式" },
  );
}

async function useProjectConversationTaskView() {
  await browser.execute(() => {
    localStorage.setItem(
      "nibi-sidebar-task-preferences",
      JSON.stringify({
        organizeBy: "project",
        sortBy: "updated",
      }),
    );
    localStorage.setItem(
      "nibi-sidebar-purpose-section-preferences",
      JSON.stringify({
        projectsExpanded: true,
        conversationsExpanded: true,
        sectionOrder: ["projects", "conversations"],
      }),
    );
  });
}

async function startConversationTaskDraft() {
  // Bug 根因：refresh 后 sidebar 的 task section 会异步水合，原先同步读取 DOM
  // 偶发拿不到已经按产品语义应出现的“新建任务”按钮，尚未覆盖后续归档交互。
  await browser.waitUntil(
    async () =>
      browser.execute((testIdValue) => {
        const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testIdValue}"]`);
        return Boolean(button && !button.disabled);
      }, TID_VIRTUAL_PROJECT_NEW_TASK),
    {
      timeout: 15000,
      timeoutMsg: "项目任务区水合后没有出现可用的“新建任务”按钮",
    },
  );

  const clicked = await browser.execute((testIdValue) => {
    const button = document.querySelector<HTMLElement>(`[data-testid="${testIdValue}"]`);
    button?.click();
    return Boolean(button);
  }, TID_VIRTUAL_PROJECT_NEW_TASK);
  expect(clicked).toBe(true);
  await waitForV4Pane(
    (snapshot) => snapshot.sessionId === "draft",
    "点击“任务”分区新建按钮后没有进入 conversation 草稿",
  );
}

interface ArchiveButtonState {
  ariaLabel: string | null;
  confirming: boolean;
  display: string | null;
  exists: boolean;
  text: string;
  visible: boolean;
}

async function hoverConversationTaskRow(taskId: string) {
  const row = await $(`${sel(TID_CONVERSATION_SECTION)} ${sel(testId(TID_TASK_ITEM, taskId))}`);
  await row.waitForDisplayed({
    timeout: 15000,
    timeoutMsg: `项目视图的“任务”分区没有显示目标 conversation task: ${taskId}`,
  });
  // 任务多时目标行可能在滚动容器外；先滚到视口中间，再移指针，否则 headless 的 moveTo
  // 会落在容器边缘，mouseenter 不触发，归档按钮永远不会挂载。
  await row.scrollIntoView({ block: "center", inline: "nearest" });
  await row.moveTo();
}

async function waitForConversationTaskRowAbsent(taskId: string) {
  const row = await $(`${sel(TID_CONVERSATION_SECTION)} ${sel(testId(TID_TASK_ITEM, taskId))}`);
  await row.waitForExist({
    reverse: true,
    timeout: 15000,
    timeoutMsg: `确认归档后 task 仍留在项目视图的“任务”分区: ${taskId}`,
  });
}

async function movePointerAwayFromTaskRow() {
  const sessionPane = await $(sel(testId(TID_V4_SESSION_PANE, V4_MAIN_PANE_ID)));
  await sessionPane.waitForDisplayed({
    timeout: 15000,
    timeoutMsg: "v4 会话主区域没有显示，无法移动鼠标离开任务行",
  });
  await sessionPane.moveTo({ xOffset: 20, yOffset: 20 });
}

async function pointerDownArchiveConfirmButton(taskId: string) {
  const dispatched = await browser.execute(
    (archiveTestId) => {
      const button = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]")).find(
        (element) =>
          element.dataset.testid === archiveTestId &&
          element.closest("[data-archive-confirming-task-id]"),
      );
      if (!button) {
        return false;
      }

      // 回归 Windows 按住确认按钮的真实时序：pointerdown 发生时按钮必须继续存在，
      // 直到后续 click 才能提交归档，不能被外部点击退出逻辑抢先清掉确认态。
      button.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          composed: true,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
      return true;
    },
    testId(TID_TASK_ARCHIVE, taskId),
  );
  expect(dispatched).toBe(true);
}

async function clickBlankArea() {
  await browser.execute(() => {
    // 修复原因：归档确认态由 window capture pointerdown 退出。
    // 这里向 body 派发真实 PointerEvent，目标明确在任务行外，避免坐标点击误落到输入框或其他控件。
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
      }),
    );
    document.body.click();
  });
}

async function waitForArchiveButtonState(
  taskId: string,
  predicate: (state: ArchiveButtonState) => boolean,
) {
  await browser.waitUntil(async () => predicate(await getArchiveButtonState(taskId)), {
    timeout: 10000,
    timeoutMsg: `归档按钮状态没有达到预期: ${JSON.stringify(await getArchiveButtonState(taskId))}`,
  });
}

async function getArchiveButtonState(taskId: string): Promise<ArchiveButtonState> {
  return browser.execute(
    (archiveTestId) => {
      const button = document.querySelector<HTMLElement>(`[data-testid="${archiveTestId}"]`);
      if (!button) {
        return {
          ariaLabel: null,
          confirming: Boolean(document.querySelector("[data-archive-confirming-task-id]")),
          display: null,
          exists: false,
          text: "",
          visible: false,
        };
      }

      const style = window.getComputedStyle(button);
      const rect = button.getBoundingClientRect();
      return {
        ariaLabel: button.getAttribute("aria-label"),
        confirming: Boolean(button.closest("[data-archive-confirming-task-id]")),
        display: style.display,
        exists: true,
        text: button.textContent?.trim() ?? "",
        visible:
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0,
      };
    },
    testId(TID_TASK_ARCHIVE, taskId),
  );
}
