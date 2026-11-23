import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  clearAppData,
  getE2EAppDataPaths,
  readAgentsState,
} from "../helpers/desktop-app.js";
import { seedOfficialPluginsViaCli } from "../helpers/tier2-sixth-batch.js";
import {
  assertUpstreamRequestCapture,
  assertUpstreamThoughtLevelCapture,
} from "../helpers/upstream-capture.js";
import {
  UPSTREAM_MODEL,
  UPSTREAM_PROVIDER_ID,
  UPSTREAM_ALTERNATE_MODEL,
  UPSTREAM_ALTERNATE_PROVIDER_ID,
} from "../helpers/upstream-provider.js";
import { resolveE2EStorageRoot } from "../helpers/e2e-runtime-paths.js";
import {
  restartIntoWorkspacePreservingProfile,
  seedPersistedModelSelection,
} from "../helpers/model-provider-restart.js";
import type {
  E2ENetworkCaptureArtifact,
  E2ENetworkCaptureRecord,
} from "../helpers/network-capture-proxy.js";
import { requirePluginManualReview } from "../helpers/plugin-management-lifecycle.js";
import { waitForToolCallBlockByToolName } from "../helpers/conversation-session-tool.js";
import {
  prepareV4ConversationE2E,
  sendV4PromptAndWaitAccepted,
  waitForV4AssistantMessageContaining,
  waitForV4ConversationState,
} from "../helpers/v4-conversation.js";

const AGENT_ID = "plugin:documents@nibi-official:visual-judge";
const PARENT = "E2E_PLUGIN_OVERRIDE_COLD_PARENT";
const CHILD = "E2E_PLUGIN_OVERRIDE_COLD_CHILD";
const FINAL = "plugin-override-cold-done";

describe("PLM-LC-020 插件 Subagent 覆盖冷启动请求", () => {
  before(() => {
    // document-skills 是官方内置插件；冷启动前必须把官方 cache seed 进隔离 HOME，
    // 否则 Agent type document-skills:judge 不存在。
    const { homeDir, workspace } = getE2EAppDataPaths();
    seedOfficialPluginsViaCli({
      e2eHomeDir: homeDir,
      resourceDir: resolve(process.cwd(), "../../apps/nibi-cli"),
      timeoutMs: 120_000,
      workspacePath: workspace,
    });
  });

  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("完整重启后 judge 使用已保存模型/high，父 continuation 保持原模型/max", async () => {
    requirePluginManualReview();
    await prepareV4ConversationE2E({ skipProvider: true });
    const selection = {
      providerId: UPSTREAM_ALTERNATE_PROVIDER_ID,
      modelId: UPSTREAM_ALTERNATE_MODEL,
      options: { reasoningLevel: "high" },
    };
    // SE-04 已验证 UI 保存；这里仅构造同格式测试副本，冷启动后不再调用设置服务。
    await writeFile(
      join(resolveE2EStorageRoot(), "v2", "agents-state.json"),
      JSON.stringify({
        ...(await readAgentsState()),
        pluginAgentModelSelectionOverrides: { [AGENT_ID]: selection },
      }),
    );
    await seedPersistedModelSelection({
      providerId: UPSTREAM_PROVIDER_ID,
      modelId: UPSTREAM_MODEL,
      reasoningLevel: "max",
    });
    await restartIntoWorkspacePreservingProfile();
    await prepareV4ConversationE2E({ skipProvider: true });
    await sendV4PromptAndWaitAccepted(
      `${PARENT}: Use Agent with subagent_type documents:visual-judge, then report its result.`,
      PARENT,
      "插件覆盖冷启动消息未被接受",
    );
    await waitForV4AssistantMessageContaining(FINAL);
    await waitForV4ConversationState(
      (snapshot) => snapshot.state === "idle" && snapshot.queueCount === 0,
      "插件执行后未回到 idle",
      60_000,
    );
    // Agent 工具现在异步启动子会话：父轮先拿 async_launched 回执；child 很快返回时
    // 状态也可能已经推进到 completed。两种都是异步语义，断言不能钉死中间态。
    expect(["async_launched", "completed"]).toContain(
      (await waitForToolCallBlockByToolName("Agent")).status,
    );

    const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH;
    if (!capturePath) throw new Error("缺少插件请求 capture 文件路径");
    const capture = JSON.parse(await readFile(capturePath, "utf8")) as E2ENetworkCaptureArtifact;
    // 不能只搜整份请求：父 continuation 也包含 child prompt；按最新 user block 的类型区分。
    const child = capture.records.find((record) => latestUserContains(record, "text", CHILD));
    // 异步启动时父 continuation 的 tool_result 是启动回执，不是 child 的 RESULT；
    // 仍要证明父请求没有被 child 的模型/档位污染。
    const parent = capture.records.find((record) =>
      latestUserContains(record, "tool_result", "Async agent launched successfully"),
    );
    if (!child || !parent) throw new Error("缺少独立 child 或父 tool_result continuation 请求");
    assertUpstreamRequestCapture(child, { expectedText: CHILD, model: UPSTREAM_ALTERNATE_MODEL });
    assertUpstreamThoughtLevelCapture(child, "high");
    assertUpstreamRequestCapture(parent, {
      expectedText: "Async agent launched successfully",
      model: UPSTREAM_MODEL,
    });
    assertUpstreamThoughtLevelCapture(parent, "max");
    expect((await readAgentsState()).pluginAgentModelSelectionOverrides).toEqual({
      [AGENT_ID]: selection,
    });
  });
});

function latestUserContains(
  record: E2ENetworkCaptureRecord,
  type: string,
  marker: string,
): boolean {
  if (record.method !== "POST" || record.status !== "complete") return false;
  const request = record.requestJson as { messages?: Array<{ role?: string; content?: unknown }> };
  const content = request?.messages?.findLast((message) => message.role === "user")?.content;
  return (
    Array.isArray(content) &&
    content.some((part) => part?.type === type && JSON.stringify(part).includes(marker))
  );
}
