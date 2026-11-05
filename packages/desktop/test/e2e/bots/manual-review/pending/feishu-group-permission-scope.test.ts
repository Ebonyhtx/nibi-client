import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { BotInboundMessage, BotsStateFile } from "@nibi/shared";
import {
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  waitForDefaultWorkspaceReady,
} from "../../../helpers/desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../../../helpers/occupation-onboarding.js";
import { resolveE2EStorageRoot, resolveE2EToolPath } from "../../../helpers/e2e-runtime-paths.js";
import { createFeishuConfig } from "../../helpers/bots-service-harness.js";
import {
  approveV4Permission,
  clickV4Stop,
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4PermissionDialogInComposerDock,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

/**
 * 验收用例（manual-review）：真实 Desktop → botsService → zcodeTaskService.createTask
 * （`permissionScope: "session"`）→ 真实 Host/Kernel 建会话 → 群会话里的权限弹窗与授权。
 *
 * 断言：
 * 1. 群消息创建出来的会话行 `session.permission` 是 `{version:1, scope:"session", mode:"build"}`；
 * 2. 非 yolo（mode=build）；
 * 3. 群会话里批准一次 Write 后，规则落会话行，工作区项目配置（`.nibi/config.json`）不变。
 *
 * 不向飞书发网络请求：配置里的 credentialRef 删掉，输入经 E2E 测试入口直接进 Host 服务。
 */
const CASE = "feishu-group-permission-scope";
const BOT_ID = "feishu-group-permission";
const CHAT_ID = "oc_group_permission_e2e";
const PERMISSION_PROMPT = `E2E_V4_PERMISSION_WRITE 请写入文件 ${resolveE2EToolPath(CASE, "group-write-output.txt")}`;
const PROJECT_CONFIG = join(DEFAULT_WORKSPACE, ".nibi", "config.json");

interface SessionPermissionRow {
  id: string;
  permission: string | null;
}

function readPermissionRows(): SessionPermissionRow[] {
  const db = new DatabaseSync(join(resolveE2EStorageRoot(), "cli", "db", "db.sqlite"), {
    readOnly: true,
  });
  try {
    return db.prepare("select id, permission from session").all() as unknown as SessionPermissionRow[];
  } finally {
    db.close();
  }
}

async function readProjectConfig(): Promise<string | null> {
  try {
    return await readFile(PROJECT_CONFIG, "utf8");
  } catch {
    return null;
  }
}

async function screenshot(name: string): Promise<void> {
  const dir = process.env.NIBI_E2E_EVIDENCE_DIR?.trim();
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await browser.saveScreenshot(join(dir, `${name}.png`));
}

describe("group task permission scope (real Host)", () => {
  it("creates a session-scoped task, keeps build mode and writes grants to the session row only", async () => {
    await skipOccupationOnboardingIfPresent();

    // 先按真实用户路径准备默认工作区与模型，再刷新让 Bot 服务读到种子配置。
    await prepareV4ConversationE2E();
    const { appDataDir } = getE2EAppDataPaths();
    const config = createFeishuConfig("feishu", BOT_ID);
    // 只走真实 Host 服务输入，不向飞书发网络请求。
    delete config.bots[0]!.credentialRef;
    const state: BotsStateFile = {
      version: 3,
      bots: {
        [JSON.stringify([BOT_ID, CHAT_ID])]: {
          botId: BOT_ID,
          workspacePath: DEFAULT_WORKSPACE,
          workspaceId: DEFAULT_WORKSPACE,
          mode: "draft",
          activeTaskId: null,
          updatedAt: Date.now(),
          group: {
            chatId: CHAT_ID,
            name: "E2E 权限群",
            ownerId: "ou_e2e_user",
            enabled: true,
            authorizationId: "e2e-group-permission-auth",
            taskIds: [],
            currentOptions: {},
          },
        },
      },
    };
    await mkdir(appDataDir, { recursive: true });
    await writeFile(join(appDataDir, "bot-config.v3.json"), JSON.stringify(config));
    await writeFile(join(appDataDir, "bot-state.v3.json"), JSON.stringify(state));
    await browser.refresh();
    await waitForDefaultWorkspaceReady(60000);
    await skipOccupationOnboardingIfPresent();
    await prepareV4ConversationE2E();

    const before = await readProjectConfig();

    const input: BotInboundMessage = {
      botId: BOT_ID,
      text: "E2E_GROUP_PERMISSION 建一个群任务",
      attachments: [],
      actor: {
        botId: BOT_ID,
        provider: "feishu",
        chatType: "group",
        chatId: CHAT_ID,
        providerUserId: "ou_member",
        displayName: "E2E 群成员",
        providerMessageId: "om_group_permission_e2e",
      },
    };
    await browser.execute(async (message) => {
      const actions = (
        window as unknown as {
          __testActions: { sendBotMessage(input: BotInboundMessage): Promise<unknown> };
        }
      ).__testActions;
      await actions.sendBotMessage(message);
    }, input);

    // 群任务创建走真实 v4 createSession：会话行应带 session 作用域且模式固定 build。
    await browser.waitUntil(
      async () => readPermissionRows().some((row) => row.permission?.includes('"scope":"session"')),
      { timeout: 60000, interval: 1000, timeoutMsg: "群任务会话没有出现 session 作用域的 permission" },
    );
    const rows = readPermissionRows();
    const created = rows.find((row) => row.permission?.includes('"scope":"session"'));
    expect(created).toBeTruthy();
    const permission = JSON.parse(created!.permission!) as {
      version?: number;
      scope?: string;
      mode?: string;
    };
    expect(permission.version).toBe(1);
    expect(permission.scope).toBe("session");
    expect(permission.mode).toBe("build");

    // 群的模型回合可能仍在跑；停下它，再用同一条会话做权限点击。
    const pane = await waitForV4Pane((state) => !!state.sessionId, "群任务会话没有进入 pane", 30000);
    if (pane.canStop) await clickV4Stop();
    await waitForV4Pane((state) => !state.canStop, "群任务的首个回合没有停下", 30000);

    await selectV4TaskById(created!.id);
    await sendV4Prompt(PERMISSION_PROMPT);
    await waitForV4PermissionDialogInComposerDock();
    await screenshot("group-permission-dialog");
    expect(await approveV4Permission()).toBe(true);
    await waitForV4TimelineContaining("V4_PERMISSION_DONE", 60000);
    await screenshot("group-permission-done");

    // 授权落会话行：同一条 permission 里出现规则；工作区项目配置一字节不动。
    await browser.waitUntil(
      async () => {
        const row = readPermissionRows().find((item) => item.id === created!.id);
        return typeof row?.permission === "string" && row.permission.length > created!.permission!.length;
      },
      { timeout: 30000, interval: 1000, timeoutMsg: "批准后会话行的 permission 没有变化" },
    );
    const afterPermission = readPermissionRows().find((item) => item.id === created!.id)!.permission!;
    expect(afterPermission).not.toBe(created!.permission);
    expect(JSON.parse(afterPermission).scope).toBe("session");
    expect(await readProjectConfig()).toBe(before);
  });
});
