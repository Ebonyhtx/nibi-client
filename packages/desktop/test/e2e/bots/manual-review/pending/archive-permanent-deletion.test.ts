/**
 * R05 归档会话永久删除（manual-review / pending）。
 *
 * 目的：用真实 UI + 真实 Rust 内核验证归档后的永久删除闭环，不 mock 删除链路：
 * 1. replay 只负责生成一个普通 assistant 回合，得到真实 CLI session。
 * 2. 通过侧栏 task 行的真实归档操作（hover 归档按钮 → 原位二次确认）归档。
 * 3. 设置 → 归档管理 → 行内永久删除，校验新的预检文案（willDelete / willKeep /
 *    cannotDelete 的适用性）与确认按钮。
 * 4. 确认后行从归档列表消失，并从 CLI 库拿到 `session_purge.state='deleted'`
 *    的持久回执，同时确认 `session` 行已物理删除。
 *
 * 运行：
 *   NIBI_E2E_EVIDENCE_DIR=<evidence dir> E2E_PROVIDER_HTTP_MODE=replay \
 *   E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json,packages/desktop/test/e2e/fixtures/upstream/archive-permanent-deletion.json \
 *   pnpm --filter @nibi/desktop exec wdio run wdio.conf.ts \
 *     --spec test/e2e/bots/manual-review/pending/archive-permanent-deletion.test.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TID_TASK_ARCHIVE, TID_TASK_ITEM, testId } from "@nibi/shared/test-ids";
import {
  DEFAULT_WORKSPACE,
  clickTestIdByDom,
  waitForTestIdByDom,
} from "../../../helpers/desktop-app.js";
import { projectSectionSelector } from "../../../helpers/project-sidebar.js";
import {
  clickFirstV4Fork,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4Fork,
  waitForV4Pane,
} from "../../../helpers/v4-conversation.js";

const EVIDENCE_DIR =
  process.env.NIBI_E2E_EVIDENCE_DIR?.trim() ||
  join(process.cwd(), ".e2e-artifacts", "archive-permanent-deletion");
const E2E_HOME_DIR = process.env.NIBI_E2E_HOME_DIR?.trim();
if (!E2E_HOME_DIR) {
  throw new Error("NIBI_E2E_HOME_DIR missing; run through the isolated WDIO harness");
}
const STORAGE_ROOT = join(E2E_HOME_DIR, ".nibi");
const CLI_DB_PATH = join(STORAGE_ROOT, "cli", "db", "db.sqlite");
const TASKS_DB_PATH = join(STORAGE_ROOT, "v2", "tasks-index.sqlite");
const PROMPT_MARKER = "E2E_R05_ARCHIVE_PURGE";
const REPLY_TOKEN = "R05_ARCHIVE_PURGE_OK";
const LOCALE = "en-US";

interface PurgeRow {
  retained_artifacts: string;
  root_id: string;
  session_id: string;
  state: string;
  workspace_path: string;
}
interface TaskPurgeRow {
  state: string;
}
interface SessionRow {
  id: string;
  parent_id: string | null;
}
interface TaskIndexRow {
  archived: number;
  deleted: number;
}

async function shot(name: string): Promise<string> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `${name}.png`);
  await browser.saveScreenshot(path);
  return path;
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

function readRows<T>(path: string, sql: string, ...params: Array<string | number>): T[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).all(...params) as T[];
  } finally {
    database.close();
  }
}

function readCliRows<T>(sql: string, ...params: Array<string | number>): T[] {
  return readRows<T>(CLI_DB_PATH, sql, ...params);
}

function readTaskRows<T>(sql: string, ...params: Array<string | number>): T[] {
  return readRows<T>(TASKS_DB_PATH, sql, ...params);
}

async function waitForTaskIndexArchived(taskId: string): Promise<void> {
  await browser.waitUntil(
    () => {
      try {
        const rows = readTaskRows<TaskIndexRow>(
          "SELECT archived, deleted FROM tasks WHERE task_id = ?",
          taskId,
        );
        return rows.length === 1 && rows[0]?.archived === 1;
      } catch {
        // Host 正在写 tasks-index 时会短暂拿不到读锁；重试即可。
        return false;
      }
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `tasks-index 没有记录归档: ${taskId}`,
    },
  );
}

async function ensureProjectExpanded(workspacePath: string): Promise<void> {
  const section = await $(projectSectionSelector(workspacePath));
  await section.waitForExist({ timeout: 30_000, timeoutMsg: `项目区没有出现: ${workspacePath}` });
  const toggle = await section.$('[data-testid="virtual-project-toggle"]');
  await toggle.waitForDisplayed({ timeout: 15_000 });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
    await browser.waitUntil(
      async () => (await toggle.getAttribute("aria-expanded")) === "true",
      { timeout: 15_000, timeoutMsg: `项目没有展开: ${workspacePath}` },
    );
  }
}

/** 走真实侧栏归档：hover 出现归档按钮 → 首击进入确认态 → 原位二次点击提交。 */
async function archiveTaskThroughSidebar(taskId: string): Promise<void> {
  await ensureProjectExpanded(DEFAULT_WORKSPACE);
  const rowSelector = `${projectSectionSelector(DEFAULT_WORKSPACE)} [data-testid="${testId(TID_TASK_ITEM, taskId)}"]`;
  const row = await $(rowSelector);
  await row.waitForDisplayed({
    timeout: 60_000,
    timeoutMsg: `侧栏没有显示刚创建的会话: ${taskId}`,
  });
  await row.scrollIntoView({ block: "center", inline: "nearest" });
  await row.moveTo();
  const archiveSelector = `${rowSelector} [data-testid="${testId(TID_TASK_ARCHIVE, taskId)}"]`;
  await browser.waitUntil(
    async () => Boolean(await $(archiveSelector).isExisting()),
    {
      timeout: 15_000,
      interval: 200,
      timeoutMsg: `task 行没有出现归档按钮: ${taskId}`,
    },
  );
  await $(archiveSelector).click();
  await browser.waitUntil(
    async () => (await row.getAttribute("data-archive-confirming-task-id")) === taskId,
    { timeout: 15_000, timeoutMsg: `归档没有进入原位确认态: ${taskId}` },
  );
  await $(archiveSelector).click();
  await row.waitForExist({
    reverse: true,
    timeout: 60_000,
    timeoutMsg: `归档后 task 仍留在侧栏: ${taskId}`,
  });
}

async function openArchiveManagement(): Promise<void> {
  await clickTestIdByDom("task-settings-button", {
    timeout: 30_000,
    timeoutMsg: "设置入口没有出现",
  });
  await clickTestIdByDom("settings-section-nav-archives", {
    timeout: 30_000,
    timeoutMsg: "设置里没有归档管理入口",
  });
  await waitForTestIdByDom("archive-management", {
    timeout: 30_000,
    timeoutMsg: "归档管理页没有打开",
  });
}

async function expandArchiveGroups(): Promise<void> {
  await browser.waitUntil(
    async () => {
      if ((await $$('[data-testid="archive-group-toggle"]').length) > 0) return true;
      const text = await $('[data-testid="archive-management"]').getText();
      return /No archived sessions|没有归档会话/u.test(text);
    },
    { timeout: 30_000, timeoutMsg: "归档列表没有加载完成" },
  );
  // 组默认收起；逐组展开到真正的行挂载，避免只等折叠容器。
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let changed = false;
    for (const toggle of await $$('[data-testid="archive-group-toggle"]')) {
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
        changed = true;
        await browser.waitUntil(
          async () => (await toggle.getAttribute("aria-expanded")) === "true",
          { timeout: 15_000, timeoutMsg: "归档分组没有展开" },
        );
      }
    }
    if (!changed) return;
  }
  throw new Error("归档分组展开没有收敛");
}

/**
 * 在 tasks-index 里放一条“已归档但 CLI 已无对应 session”的陈旧行，用来验证预检的
 * cannotDelete 分支。真实产品里对应外部删除/索引遗留；这里只补数据前置，不 mock UI。
 */
function seedStaleArchivedTask(taskId: string): void {
  const now = Date.now();
  const title = "E2E R05 stale archived task";
  const meta = {
    taskId,
    traceId: `trace_${taskId}`,
    title,
    titleOverridden: true,
    workspacePath: DEFAULT_WORKSPACE,
    createdAt: now,
    updatedAt: now,
    mode: "build",
    model: "missing-model",
    provider: "nibi-agent",
    status: "completed",
  };
  const database = new DatabaseSync(TASKS_DB_PATH);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database
      .prepare(
        `INSERT INTO tasks (
          workspace_key, workspace_path, workspace_identity, task_id, title, task_status,
          provider, mode, model, migration_source, forked_from_task_id, cron_automation_id,
          created_at, updated_at, unread_at, pinned, archived, deleted, title_overridden,
          searchable_text, meta_json, cli_title, cli_title_source, cli_created_at,
          cli_updated_at, cli_last_outcome, cli_deleted, host_id, root_path
        ) VALUES (?, ?, null, ?, ?, 'completed', 'nibi-agent', 'build', 'missing-model', null,
          null, null, ?, ?, null, 0, 1, 0, 1, ?, ?, ?, 'custom', ?, ?, 'completed', 0,
          'local', ?)`,
      )
      .run(
        DEFAULT_WORKSPACE,
        DEFAULT_WORKSPACE,
        taskId,
        title,
        now,
        now,
        title,
        JSON.stringify(meta),
        title,
        now,
        now,
        DEFAULT_WORKSPACE,
      );
  } finally {
    database.close();
  }
}

/** 删掉陈旧行的索引记录，让最后的归档列表回到真实的空态（隔离 HOME 内）。 */
function deleteStaleArchivedTask(taskId: string): void {
  const database = new DatabaseSync(TASKS_DB_PATH);
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.prepare("DELETE FROM tasks WHERE task_id = ?").run(taskId);
  } finally {
    database.close();
  }
}

async function cancelConfirmDialog(
  dialog: ReturnType<typeof $>,
  cancelLabel: string,
): Promise<void> {
  const clicked = await browser.execute(
    (intent, label) => {
      const root = document.querySelector<HTMLElement>(`[data-confirm-intent="${intent}"]`);
      const button = Array.from(root?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (candidate) => (candidate.textContent ?? "").trim().startsWith(label),
      );
      button?.click();
      return Boolean(button);
    },
    "archive-management-delete",
    cancelLabel,
  );
  expect(clicked).toBe(true);
  await dialog.waitForExist({ reverse: true, timeout: 15_000 });
}

describe("R05 archive permanent deletion (manual review)", () => {
  before(async function () {
    this.timeout(300_000);
    await prepareV4ConversationE2E();
    await setEnglishLocale();
  });

  it("归档 → 预检永久删除 → 确认 → CLI 回执 deleted 且 session 行消失", async function () {
    this.timeout(600_000);

    await sendV4PromptAndWaitAccepted(
      PROMPT_MARKER,
      PROMPT_MARKER,
      "R05 归档删除的 replay prompt 没有被接受",
      120_000,
    );
    await waitForV4AssistantMessageContaining(REPLY_TOKEN, 120_000);
    const completed = await waitForV4Pane(
      (snapshot) =>
        !snapshot.canStop &&
        Boolean(snapshot.sessionId) &&
        snapshot.sessionId !== "draft",
      "R05 会话在 assistant 回答后没有完成",
      120_000,
    );
    const sessionId = completed.sessionId;
    expect(sessionId).toBeTruthy();

    // 用真实 v4 fork 入口留下一个分叉会话，让预览的 willKeep 分支有真实输入。
    await waitForV4Fork(120_000);
    expect(await clickFirstV4Fork()).toBe(true);
    const forked = await waitForV4Pane(
      (snapshot) =>
        Boolean(snapshot.sessionId) &&
        snapshot.sessionId !== "draft" &&
        snapshot.sessionId !== sessionId,
      "fork 后没有切到子会话",
      120_000,
    );
    const forkSessionId = forked.sessionId;
    expect(forkSessionId).toBeTruthy();
    await waitForV4Pane(
      (snapshot) => !snapshot.canStop,
      "fork 子会话没有完成",
      60_000,
    );
    await selectV4TaskById(sessionId!, 60_000);

    // 先放一条“已归档但 CLI 已无对应 session”的陈旧索引行；归档真实任务触发的目录
    // 刷新会把它一起带进归档管理，用来验证预检的 cannotDelete 分支。
    const staleTaskId = `r05-stale-archived-${Date.now()}`;
    seedStaleArchivedTask(staleTaskId);

    await archiveTaskThroughSidebar(sessionId!);
    await waitForTaskIndexArchived(sessionId!);
    expect(
      readCliRows<SessionRow>("SELECT id, parent_id FROM session WHERE id = ?", sessionId!),
    ).toHaveLength(1);

    await openArchiveManagement();
    await expandArchiveGroups();
    const staleRowSelector = `[data-testid="archive-task"][data-task-id="${staleTaskId}"]`;
    const staleRow = await $(staleRowSelector);
    await staleRow.waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: `归档列表没有显示陈旧行: ${staleTaskId}`,
    });
    const archiveRowSelector = `[data-testid="archive-task"][data-task-id="${sessionId}"]`;
    await (await $(archiveRowSelector)).waitForDisplayed({
      timeout: 60_000,
      timeoutMsg: `归档列表没有显示会话: ${sessionId}`,
    });
    await shot("01-archive-list-with-archived-session");

    // cannotDelete：陈旧行没有 CLI session，预检必须明确说明“已被移除”，且确认按钮禁用。
    await staleRow.$('[data-testid="archive-delete"]').click();
    const blockedDialog = await $('[data-confirm-intent="archive-management-delete"]');
    await blockedDialog.waitForDisplayed({ timeout: 15_000 });
    const blockedConfirm = await $('[data-testid="confirm-dialog-confirm"]');
    await browser.waitUntil(
      async () =>
        /Cannot delete 1 session\(s\): already removed/u.test(await blockedDialog.getText()),
      { timeout: 60_000, interval: 500, timeoutMsg: "cannotDelete 预检没有出现" },
    );
    const blockedText = await blockedDialog.getText();
    expect(blockedText).toContain("Cannot delete 1 session(s): already removed.");
    expect(blockedText).not.toContain("will be permanently deleted");
    expect(await blockedConfirm.isEnabled()).toBe(false);
    await shot("02-archive-preview-cannot-delete");
    await cancelConfirmDialog(blockedDialog, "Cancel");

    // 清掉陈旧索引行；确认真实删除后的事件刷新会让列表回到真实空态。
    deleteStaleArchivedTask(staleTaskId);

    const archiveRow = await $(archiveRowSelector);
    await archiveRow.waitForDisplayed({ timeout: 30_000 });
    await archiveRow.$('[data-testid="archive-delete"]').click();
    const dialog = await $('[data-confirm-intent="archive-management-delete"]');
    await dialog.waitForDisplayed({ timeout: 15_000 });
    const confirm = await $('[data-testid="confirm-dialog-confirm"]');
    await browser.waitUntil(
      async () => {
        const text = await dialog.getText();
        return (
          (await confirm.isEnabled()) &&
          !/Checking what will be deleted|正在准备/u.test(text) &&
          /will be permanently deleted|将永久删除/u.test(text)
        );
      },
      { timeout: 60_000, interval: 500, timeoutMsg: "永久删除预检没有完成" },
    );
    const previewText = await dialog.getText();
    // 预检必须说明删除范围、保留范围，并在没有阻塞项时明确不显示 cannotDelete。
    expect(previewText).toMatch(/1 session\(s\) and 1 conversation\(s\) will be permanently deleted/u);
    expect(previewText).toMatch(/Kept: 1 forked session\(s\) and 0 referenced artifact\(s\)/u);
    expect(previewText).not.toMatch(/Cannot delete|无法删除/u);
    expect(await confirm.isEnabled()).toBe(true);
    await shot("03-archive-preview-dialog");

    await confirm.click();
    await browser.waitUntil(
      async () => !(await $(archiveRowSelector).isExisting()),
      { timeout: 120_000, interval: 500, timeoutMsg: "确认后归档行没有消失" },
    );
    await browser.waitUntil(
      async () => {
        const text = await $('[data-testid="archive-management"]').getText();
        return (
          /Succeeded: 1; failed: 0/u.test(text) &&
          /No archived sessions|没有归档会话/u.test(text)
        );
      },
      { timeout: 60_000, interval: 500, timeoutMsg: "归档管理没有回到成功的空态" },
    );
    await shot("04-archive-list-after-delete");

    // 持久回执：CLI 库里 session_purge.state 必须已收敛到 deleted，session 行必须消失。
    await browser.waitUntil(
      () => {
        try {
          const rows = readCliRows<{ state: string }>(
            "SELECT state FROM session_purge WHERE session_id = ?",
            sessionId!,
          );
          return rows.length === 1 && rows[0]?.state === "deleted";
        } catch {
          return false;
        }
      },
      {
        timeout: 60_000,
        interval: 500,
        timeoutMsg: `session_purge 没有收敛到 deleted: ${sessionId}`,
      },
    );
    const purgeRows = readCliRows<PurgeRow>(
      `SELECT session_id, root_id, retained_artifacts, workspace_path, state
       FROM session_purge WHERE session_id = ?`,
      sessionId!,
    );
    expect(purgeRows).toHaveLength(1);
    expect(purgeRows[0]).toMatchObject({
      session_id: sessionId,
      root_id: sessionId,
      state: "deleted",
      retained_artifacts: "[]",
    });
    expect(purgeRows[0]!.workspace_path.length).toBeGreaterThan(0);
    expect(readCliRows<SessionRow>("SELECT id, parent_id FROM session WHERE id = ?", sessionId!))
      .toHaveLength(0);
    // 保留的分叉会话必须仍在库里，不能被父会话的删除连带清掉。
    const forkRows = readCliRows<SessionRow>(
      "SELECT id, parent_id FROM session WHERE id = ?",
      forkSessionId!,
    );
    expect(forkRows).toHaveLength(1);
    expect(forkRows[0]!.parent_id).toBe(sessionId);
    // tasks-index 也按 purged 凭据硬删除索引行。
    expect(
      readTaskRows<TaskIndexRow>("SELECT archived, deleted FROM tasks WHERE task_id = ?", sessionId!),
    ).toHaveLength(0);
    const taskPurgeRows = readTaskRows<TaskPurgeRow>(
      "SELECT state FROM task_purge WHERE task_id = ?",
      sessionId!,
    );
    expect(taskPurgeRows).toHaveLength(1);
    expect(taskPurgeRows[0]!.state).toBe("purged");

    await mkdir(EVIDENCE_DIR, { recursive: true });
    await writeFile(
      join(EVIDENCE_DIR, "05-db-receipt.txt"),
      [
        "R05 archive permanent deletion - durable receipt",
        `generatedAt: ${new Date().toISOString()}`,
        `e2eHomeDir: ${E2E_HOME_DIR}`,
        `cliDb: ${CLI_DB_PATH}`,
        `tasksDb: ${TASKS_DB_PATH}`,
        `sessionId: ${sessionId}`,
        `forkSessionId: ${forkSessionId}`,
        "",
        "session_purge:",
        JSON.stringify(purgeRows[0], null, 2),
        "",
        `session rows for deleted session: ${readCliRows<SessionRow>(
          "SELECT id, parent_id FROM session WHERE id = ?",
          sessionId!,
        ).length}`,
        `fork session row: ${JSON.stringify(forkRows[0])}`,
        `tasks-index row count: ${readTaskRows<unknown>(
          "SELECT 1 FROM tasks WHERE task_id = ?",
          sessionId!,
        ).length}`,
        `task_purge: ${JSON.stringify(taskPurgeRows[0])}`,
      ].join("\n"),
      "utf-8",
    );
  });
});