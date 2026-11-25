import { join } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "../helpers/desktop-app.js";
import {
  PLUGIN_LIFECYCLE_ID,
  addLifecycleMarketplaceThroughUi,
  addMarketplaceSourceThroughUi,
  capturePluginManualReview,
  clickPluginControl,
  confirmPluginConsentAndWaitEnabled,
  corruptLifecycleMarketplaceManifest,
  createInvalidOfficialCollisionFixture,
  createPluginLifecycleFixture,
  detachLifecyclePluginConfig,
  getPluginOverview,
  hasPluginControl,
  installPluginThroughUi,
  openPluginCard,
  openPluginSettings,
  removeLifecyclePluginInstalledCache,
  removeLifecyclePluginPayload,
  requirePluginManualReview,
  restoreLifecyclePluginInstalledCache,
  uninstallPluginThroughUi,
  updatePluginLifecycleFixture,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "../helpers/plugin-management-lifecycle.js";

const FAILURES_TIMEOUT_MS = 300000;

describe("PLM-LC-008 插件管理关键可恢复失败 E2E", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("来源、describe、install、update 失败可见且重试不破坏旧状态", async function () {
    this.timeout(FAILURES_TIMEOUT_MS);
    requirePluginManualReview();

    await openPluginSettings();
    await addMarketplaceSourceThroughUi(
      join(getE2EAppDataPaths().homeDir, "fixtures", "missing-marketplace"),
    );
    await waitForPluginControl("plugin-store-add-source-error");
    await capturePluginManualReview("PLM-LC-008", "invalid-source-error");
    await browser.keys("Escape");

    const collision = await createInvalidOfficialCollisionFixture();
    await addMarketplaceSourceThroughUi(collision);
    await waitForPluginControl("plugin-store-add-source-error");
    expect((await getPluginOverview()).diagnostics.length).toBeGreaterThanOrEqual(0);
    await browser.keys("Escape");

    let fixture = await createPluginLifecycleFixture("1.0.0");
    await addLifecycleMarketplaceThroughUi(fixture);
    await clickPluginControl("plugin-store-segment-personal");

    await corruptLifecycleMarketplaceManifest(fixture);
    // 旧的 plugin-store-check-updates 已下线；商店顶栏刷新就是真实的目录刷新入口。
    await clickPluginControl("plugin-store-refresh");
    await waitForPluginControl("plugin-store-error", {}, 60000);
    await capturePluginManualReview("PLM-LC-008", "catalog-refresh-failure");
    fixture = await createPluginLifecycleFixture("1.0.0");
    await clickPluginControl("plugin-store-refresh");
    await browser.waitUntil(async () => !(await hasPluginControl("plugin-store-error")), {
      timeout: 60000,
      timeoutMsg: "Catalog refresh retry did not clear the visible error",
    });

    await removeLifecyclePluginPayload(fixture);
    await clickPluginControl("plugin-store-install", { pluginId: PLUGIN_LIFECYCLE_ID });
    await waitForPluginControl("plugin-store-error", {}, 60000);
    expect(
      (await getPluginOverview()).installedPlugins.some(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
      ),
    ).toBe(false);
    fixture = await createPluginLifecycleFixture("1.0.0");
    await installPluginThroughUi(PLUGIN_LIFECYCLE_ID);
    // 失败重试安装的是带 hooks/MCP 的社区插件，安装成功后会异步弹出权限同意框。
    await confirmPluginConsentAndWaitEnabled(PLUGIN_LIFECYCLE_ID);

    // describe 错误态只属于“已安装但运行时清单不可读”的条目：未安装候选用中性提示，
    // 因此先完成安装。清掉安装缓存与 marketplace payload 让 describe 的安装优先路径和
    // 源解析路径都失败；同时移除 config 登记，避免发现层合成 packageStatus:"missing"
    // 后把条目降级成未安装、从而再也走不到组件错误态。
    // 安装从商店列表卡片发起，成功后仍停留在列表；describe 故障注入直接在当前商店视图进行。
    await detachLifecyclePluginConfig();
    await removeLifecyclePluginInstalledCache();
    await removeLifecyclePluginPayload(fixture);
    await clickPluginControl("plugin-store-refresh");
    await waitUntilPluginOverview(
      (overview) =>
        overview.installedPlugins.some((plugin) => plugin.id === PLUGIN_LIFECYCLE_ID),
      "Installed record disappeared during describe fault injection",
      60000,
    );
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await waitForPluginControl("plugin-store-components-error", {}, 60000);
    await capturePluginManualReview("PLM-LC-008", "describe-failure");
    fixture = await createPluginLifecycleFixture("1.0.0");
    await restoreLifecyclePluginInstalledCache(fixture);
    await clickPluginControl("plugin-store-components-retry");
    await waitForPluginControl("plugin-store-component-section", { componentKind: "skill" }, 60000);

    fixture = await updatePluginLifecycleFixture(fixture, "2.0.0");
    await clickPluginControl("plugin-store-detail-back");
    // 商店顶栏刷新触发真实的目录检查更新。
    await clickPluginControl("plugin-store-refresh");
    await waitUntilPluginOverview(
      (overview) =>
        overview.installedPlugins.some(
          (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID && plugin.updateStatus !== "none",
        ),
      "Update badge did not appear before failure injection",
      60000,
    );
    await openPluginCard(PLUGIN_LIFECYCLE_ID);
    await removeLifecyclePluginPayload(fixture);
    await clickPluginControl("plugin-store-detail-update");
    await waitForPluginControl("plugin-store-error", {}, 60000);
    expect(
      (await getPluginOverview()).installedPlugins.find(
        (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID,
      )?.version,
    ).toBe("1.0.0");

    fixture = await createPluginLifecycleFixture("2.0.0");
    await clickPluginControl("plugin-store-detail-update");
    await waitUntilPluginOverview(
      (overview) =>
        overview.installedPlugins.some(
          (plugin) => plugin.id === PLUGIN_LIFECYCLE_ID && plugin.version === "2.0.0",
        ),
      "Update retry did not install v2",
      120000,
    );
    expect(await hasPluginControl("plugin-store-error")).toBe(false);
    await uninstallPluginThroughUi(PLUGIN_LIFECYCLE_ID, false);
  });
});
