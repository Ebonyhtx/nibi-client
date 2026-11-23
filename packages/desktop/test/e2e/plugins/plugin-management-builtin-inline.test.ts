import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
} from "../helpers/desktop-app.js";
import { waitForUpstreamRequestContaining } from "../helpers/conversation-session.js";
import { findUpstreamRequestContaining } from "../helpers/plugin-mcp-skill.js";
import { restartIntoWorkspacePreservingProfile } from "../helpers/model-provider-restart.js";
import { seedOfficialPluginsViaCli } from "../helpers/tier2-sixth-batch.js";
import { prepareV4ConversationE2E, sendV4Prompt } from "../helpers/v4-conversation.js";
import {
  PLUGIN_INLINE_ID,
  capturePluginManualReview,
  clickPluginControl,
  getPluginList,
  getPluginOverview,
  openManageView,
  openPluginCard,
  openPluginSettings,
  pluginDataPath,
  pluginPathExists,
  requirePluginManualReview,
  restartPluginLifecycleApp,
  seedInlineLifecyclePlugin,
  uninstallPluginThroughUi,
  waitForPluginCard,
  waitForPluginControl,
  waitUntilPluginOverview,
} from "../helpers/plugin-management-lifecycle.js";

const BUILTIN_ID = "skill-creator@nibi-official";
const BUILTIN_TIMEOUT_MS = 240000;

describe("PLM-LC-006/009 Builtin 抑制恢复与 inline smoke E2E", () => {
  before(() => {
    // 官方内置插件 cache 默认只为 builtin-uninstall spec 由 runner seed；
    // 本 spec 依赖 skill-creator@nibi-official 的官方 cache，必须在首次 overview 前落盘。
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

  it("Builtin 卸载跨重启抑制并干净恢复，inline 在 Personal/Detail/Manage 可见", async function () {
    this.timeout(BUILTIN_TIMEOUT_MS);
    requirePluginManualReview();

    await openPluginSettings();
    await waitForPluginCard(BUILTIN_ID, 60000);
    await openPluginCard(BUILTIN_ID);
    const builtinCachePath = (await getPluginList()).plugins.find(
      (plugin) => plugin.id === BUILTIN_ID,
    )?.rootPath;
    expect(builtinCachePath).toBeTruthy();
    expect(pluginPathExists(builtinCachePath!)).toBe(true);
    await seedBuiltinUserState();
    await uninstallPluginThroughUi(BUILTIN_ID, true);
    // 官方 cache 内置不在 installed_plugins.json 里，uninstall 的「已安装集合消失」
    // 等待条件会立即成立；必须再等 restorableBuiltins 投影落盘，避免与 uninstall RPC 竞态。
    await waitUntilPluginOverview(
      (overview) => overview.restorableBuiltins.some((plugin) => plugin.id === BUILTIN_ID),
      "Builtin did not become restorable after uninstall",
      120000,
    );
    expect(
      (await getPluginOverview()).restorableBuiltins.some((plugin) => plugin.id === BUILTIN_ID),
    ).toBe(true);
    expect(pluginPathExists(pluginDataPath(BUILTIN_ID))).toBe(false);
    // 内置 cache 是详情与恢复所需的不可变 Catalog 资产，卸载只抑制 Runtime 并清理 data/config。
    expect(pluginPathExists(builtinCachePath!)).toBe(true);
    expect(await builtinOptionsExist()).toBe(false);

    await restartPluginLifecycleApp();
    await openPluginSettings();
    await waitUntilPluginOverview(
      (overview) => overview.restorableBuiltins.some((plugin) => plugin.id === BUILTIN_ID),
      "Builtin suppression did not survive restart",
      60000,
    );
    await waitForPluginCard(BUILTIN_ID, 60000);
    await capturePluginManualReview("PLM-LC-006", "restorable-builtin");
    await openPluginCard(BUILTIN_ID);
    await clickPluginControl("plugin-store-install", { pluginId: BUILTIN_ID });
    await waitUntilPluginOverview(
      (overview) => !overview.restorableBuiltins.some((plugin) => plugin.id === BUILTIN_ID),
      "Builtin did not restore cleanly",
      120000,
    );
    expect(await builtinOptionsExist()).toBe(false);
    expect(pluginPathExists(join(pluginDataPath(BUILTIN_ID), "state.json"))).toBe(false);

    await seedInlineLifecyclePlugin();
    // 运行时的插件 skill 注册表在 Workspace Agent 进程内；renderer reload 不会重读
    // plugins.dirs，必须完整重启 Electron 让 Agent 冷启动时加载 inline 插件。
    await restartIntoWorkspacePreservingProfile();
    await openPluginSettings();
    await clickPluginControl("plugin-store-segment-personal");
    await waitForPluginCard(PLUGIN_INLINE_ID, 60000);
    await openPluginCard(PLUGIN_INLINE_ID);
    await waitForPluginControl("plugin-store-component-section", { componentKind: "skill" });
    expect(
      (await getPluginList()).plugins.find((plugin) => plugin.id === PLUGIN_INLINE_ID)?.enabled,
    ).toBe(true);

    // 插件商店是 workspace 主视图，返回聊天走桌面顶栏，而不是设置页返回按钮。
    await clickTestIdByDom("desktop-top-nav-back");
    await prepareV4ConversationE2E();
    const inlineRuntimeRequest = `E2E_PLUGIN_INLINE_REQUEST_${Date.now()}`;
    await sendV4Prompt(
      `${inlineRuntimeRequest}: invoke the Skill named e2e-inline-lifecycle:inline-lifecycle, then reply with exactly upstream-e2e-ok.`,
    );
    await waitForUpstreamRequestContaining(inlineRuntimeRequest, 60000);
    const inlineRequest = await findUpstreamRequestContaining(
      "E2E_PLUGIN_INLINE_LIFECYCLE_RUNTIME",
      60000,
    );
    expect(JSON.stringify(inlineRequest?.requestJson)).toContain(inlineRuntimeRequest);

    await openPluginSettings();
    await openManageView();
    await waitForPluginControl("plugin-settings-plugin-row", { pluginId: PLUGIN_INLINE_ID });
    await capturePluginManualReview("PLM-LC-009", "inline-manage-smoke");
  });
});

async function seedBuiltinUserState(): Promise<void> {
  const { homeDir } = getE2EAppDataPaths();
  const configPath = join(homeDir, ".nibi", "cli", "config.json");
  const config = await readJsonRecord(configPath);
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  await writeJson(configPath, {
    ...config,
    plugins: { ...plugins, options: { ...options, [BUILTIN_ID]: { e2e: "purge-me" } } },
  });
  await writeJson(join(pluginDataPath(BUILTIN_ID), "state.json"), { purge: true });
}

async function builtinOptionsExist(): Promise<boolean> {
  const configPath = join(getE2EAppDataPaths().homeDir, ".nibi", "cli", "config.json");
  const config = await readJsonRecord(configPath);
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const options = isRecord(plugins.options) ? plugins.options : {};
  return BUILTIN_ID in options;
}

async function readJsonRecord(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
