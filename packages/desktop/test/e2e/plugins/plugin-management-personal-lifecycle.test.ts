import { type NibiPluginComponentKind } from "@nibi/shared";
import { TID_V4_COMPOSER_INPUT } from "@nibi/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "../helpers/desktop-app.js";
import { openWorkspaceDraftFromSidebar } from "../helpers/workspace-agent-warmup.js";
import { waitForUpstreamRequestContaining } from "../helpers/conversation-session.js";
import {
  getV4ComposerText,
  prepareV4ConversationE2E,
  sendV4Prompt,
} from "../helpers/v4-conversation.js";
import {
  captureArtifactAdvertisesToolName,
  findUpstreamRequestContaining,
} from "../helpers/plugin-mcp-skill.js";
import {
  PLUGIN_LIFECYCLE_CONFIG_VALUE,
  PLUGIN_LIFECYCLE_EXAMPLE_PROMPT,
  PLUGIN_LIFECYCLE_ID,
  PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
  PLUGIN_LIFECYCLE_RUNTIME_MARKER,
  addLifecycleMarketplaceThroughUi,
  capturePluginManualReview,
  clickPluginControl,
  configureLifecyclePluginThroughUi,
  confirmPluginConsentAndWaitEnabled,
  createPluginLifecycleFixture,
  getPluginList,
  getPluginOverview,
  openManageView,
  openPluginCard,
  openPluginSettings,
  readPluginDraftRuntimeInvalidationVersion,
  requirePluginManualReview,
  setPluginEnabledThroughUi,
  uninstallPluginThroughUi,
  updatePluginLifecycleFixture,
  waitForPluginControl,
  waitForPluginDraftRuntimeInvalidation,
  waitUntilPluginOverview,
} from "../helpers/plugin-management-lifecycle.js";

const LIFECYCLE_TIMEOUT_MS = 300000;

describe("PLM-LC-003 Personal Source 插件主生命周期 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("从来源添加到运行时升级，再取消并确认卸载", async function () {
    this.timeout(LIFECYCLE_TIMEOUT_MS);
    requirePluginManualReview();

    let fixture = await createPluginLifecycleFixture("1.0.0");
    await openPluginSettings();
    await addLifecycleMarketplaceThroughUi(fixture);
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);

    // 未安装候选只展示「安装后可查看」提示；组件清单按设计只在安装后出现。
    await waitForPluginControl("plugin-store-components-after-install", {}, 30000);
    await capturePluginManualReview("PLM-LC-003", "uninstalled-components-after-install");

    await clickPluginControl("plugin-store-example-prompt", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitUntilPluginOverview(
      (overview) => overview.installedPlugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID),
      "Example Prompt did not install the plugin",
      120000,
    );
    // 带 hooks/MCP 的社区插件安装后会异步弹出权限同意框；Example Prompt 的下一次点击
    // 与后续详情操作都必须先完成真实同意。
    await confirmPluginConsentAndWaitEnabled(PLUGIN_LIFECYCLE_ID);
    // 商店详情不再有独立启停开关；安装态由详情头部的插件菜单表达。
    await waitForPluginControl(
      "plugin-store-item-menu",
      { pluginId: PLUGIN_LIFECYCLE_ID },
      30000,
    );
    // 安装完成后详情页展示真实组件清单（安装前只显示提示）。
    for (const kind of [
      "mcp",
      "skill",
      "command",
      "agent",
      "hook",
    ] satisfies NibiPluginComponentKind[]) {
      await waitForPluginControl("plugin-store-component-section", { componentKind: kind }, 30000);
    }
    await capturePluginManualReview("PLM-LC-003", "installed-five-components");
    expect(await isPluginSettingsVisible()).toBe(true);

    await clickPluginControl("plugin-store-example-prompt", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitForTestIdByDom(TID_V4_COMPOSER_INPUT, { timeout: 30000 });
    try {
      await browser.waitUntil(
        async () => {
          const composerText = (await getV4ComposerText()) ?? "";
          return (
            composerText.includes(`plugin://${PLUGIN_LIFECYCLE_ID}`) &&
            composerText.endsWith(` ${PLUGIN_LIFECYCLE_EXAMPLE_PROMPT}`)
          );
        },
        {
          timeout: 10000,
          timeoutMsg: "Example Prompt did not prefill the canonical Plugin reference and prompt",
        },
      );
    } catch (error) {
      const evidence = await browser.execute(() => {
        interface ComposerEvidenceWorkspace {
          activeTaskId: string | null;
          composerTextInsertRequest: { requestId: number; text: string } | null;
          composerTextInsertVersion: number;
        }
        const store = (
          window as typeof window & {
            __nibiSessionStoreE2E?: {
              getState: () => { workspaces: Record<string, ComposerEvidenceWorkspace> };
            };
          }
        ).__nibiSessionStoreE2E;
        const state = store?.getState();
        return {
          composers: Array.from(
            document.querySelectorAll<
              HTMLElement & { __nibiLexicalInputE2E?: { getText: () => string } }
            >('[data-testid="v4-composer-input"]'),
          ).map(
            (element) =>
              element.__nibiLexicalInputE2E?.getText() ??
              element.innerText ??
              element.textContent ??
              "",
          ),
          workspaces: Object.fromEntries(
            Object.entries(state?.workspaces ?? {}).map(([key, workspace]) => [
              key,
              {
                activeTaskId: workspace.activeTaskId,
                composerTextInsertRequest: workspace.composerTextInsertRequest,
                composerTextInsertVersion: workspace.composerTextInsertVersion,
              },
            ]),
          ),
        };
      });
      throw new Error(`Example Prompt evidence: ${JSON.stringify(evidence)}`, { cause: error });
    }
    expect(await countCapturedRequestsContaining(PLUGIN_LIFECYCLE_EXAMPLE_PROMPT)).toBe(0);

    // Example Prompt 留在无 workspace path 的草稿态；先回到默认项目草稿，
    // 再走真实 Settings 入口，避免等待默认工作区就绪时超时。
    await openWorkspaceDraftFromSidebar(getE2EAppDataPaths().workspace);
    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    // 配置项已收口到「插件管理」里的选中插件详情；商店详情只保留市场信息。
    await clickPluginControl("plugin-store-detail-back");
    await openManageView();
    await clickPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_LIFECYCLE_ID });
    await configureLifecyclePluginThroughUi(PLUGIN_LIFECYCLE_CONFIG_VALUE);
    await setPluginEnabledThroughUi(PLUGIN_LIFECYCLE_ID, false, "detail");
    await clickPluginControl("plugin-settings-detail-back");
    await setPluginEnabledThroughUi(PLUGIN_LIFECYCLE_ID, true, "manage");

    fixture = await updatePluginLifecycleFixture(fixture, "2.0.0");
    // 旧的 plugin-store-check-updates 已下线；商店顶栏刷新就是真实的检查更新入口。
    await clickPluginControl("plugin-store-browse-all");
    await clickPluginControl("plugin-store-refresh");
    await waitUntilPluginOverview(
      (overview) =>
        overview.installedPlugins.some(
          (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID && plugin.updateStatus !== "none",
        ),
      "Checking updates did not expose lifecycle v2",
      60000,
    );
    // 2026-09-02：检查更新后，已安装行必须直接亮出「可更新」角标与行内「更新」按钮；
    // 此前更新入口只藏在「…」菜单和详情页高级区，用户刷新后看不出哪个插件可更新。
    await waitForPluginControl("plugin-store-card-update", { pluginId: PLUGIN_LIFECYCLE_ID });
    await openManageView();
    await waitForPluginControl("plugin-store-update-badge", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitForPluginControl("plugin-store-card-update", { pluginId: PLUGIN_LIFECYCLE_ID });
    // 管理视图行内按钮只重载列表；触发 draft runtime 失效的是商店更新入口。
    await clickPluginControl("plugin-store-browse-all");
    const draftRuntimeVersionBeforeUpdate = await readPluginDraftRuntimeInvalidationVersion();
    await clickPluginControl("plugin-store-card-update", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitUntilPluginOverview(
      (overview) =>
        overview.installedPlugins.some(
          (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID && plugin.version === "2.0.0",
        ),
      "Lifecycle plugin did not upgrade to v2",
      120000,
    );
    expect(
      (await getPluginList()).plugins.find((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID)?.version,
    ).toBe("2.0.0");
    await waitForPluginDraftRuntimeInvalidation(draftRuntimeVersionBeforeUpdate);
    await capturePluginManualReview("PLM-LC-003", "updated-v2-detail");

    // 插件商店是 workspace 主视图，返回聊天走桌面顶栏，而不是设置页返回按钮。
    await clickTestIdByDom("desktop-top-nav-back");
    await prepareV4ConversationE2E();
    const runMarker = `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_2.0.0_${Date.now()}`;
    await sendV4Prompt(
      `${runMarker}: Call ${PLUGIN_LIFECYCLE_MCP_TOOL_NAME} once, then reply with exactly upstream-e2e-ok.`,
    );
    await waitForUpstreamRequestContaining(runMarker, 60000);
    const runtimeRequest = await findUpstreamRequestContaining(runMarker, 60000, {
      advertisedToolName: PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
    });
    expect(runtimeRequest).not.toBeNull();
    expect(
      captureArtifactAdvertisesToolName(
        runtimeRequest?.requestJson,
        PLUGIN_LIFECYCLE_MCP_TOOL_NAME,
      ),
    ).toBe(true);
    expect(JSON.stringify(runtimeRequest?.requestJson)).toContain(
      `${PLUGIN_LIFECYCLE_RUNTIME_MARKER}_2.0.0`,
    );

    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await uninstallPluginThroughUi(PLUGIN_LIFECYCLE_ID, false);
    expect(
      (await getPluginOverview()).installedPlugins.some(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
      ),
    ).toBe(true);
    await uninstallPluginThroughUi(PLUGIN_LIFECYCLE_ID, true);
    expect(
      (await getPluginOverview()).installedPlugins.some(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
      ),
    ).toBe(false);
  });
});

async function isPluginSettingsVisible(): Promise<boolean> {
  return browser.execute(() =>
    Boolean(document.querySelector('[data-testid="plugin-store-root"]')),
  );
}

async function countCapturedRequestsContaining(marker: string): Promise<number> {
  const capturePath = process.env.E2E_PROVIDER_CAPTURE_PATH?.trim();
  if (!capturePath) return 0;
  try {
    const artifact = JSON.parse(
      await (await import("node:fs/promises")).readFile(capturePath, "utf-8"),
    ) as {
      records?: Array<{ requestJson?: unknown }>;
    };
    return (artifact.records ?? []).filter((record) =>
      JSON.stringify(record.requestJson).includes(marker),
    ).length;
  } catch {
    return 0;
  }
}
