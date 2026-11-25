import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getE2EAppDataPaths } from "./desktop-app.js";
import { pluginStoragePath } from "./plugin-management-lifecycle.js";

/**
 * `nibi.ui.view` E2E fixture 的静态源文件（plugin.json / extension.mjs / server.mjs）。
 * 每次 seed 都复制进隔离 HOME，插件根目录与仓库源码分离，Host 只读隔离 HOME 的副本。
 */
const FIXTURE_SOURCE_DIR = fileURLToPath(new URL("../fixtures/plugin-ui-view", import.meta.url));

export const PLUGIN_UI_VIEW_NAME = "e2e-ui-view";
export const PLUGIN_UI_VIEW_ID = `${PLUGIN_UI_VIEW_NAME}@inline`;
export const PLUGIN_UI_VIEW_VERSION = "1.0.0";
export const PLUGIN_UI_VIEW_SURFACE_ID = "panel";

/**
 * 运行时权限：`code`（extension runtime）+ `process`/`network`（stdio MCP server）。
 * 本地目录插件（inline）不是内置/官方信任，发现层要求逐版本显式同意，否则插件会被
 * `plugin_consent_required` 降级为 disabled，扩展宿主和 MCP server 都不会启动。
 */
export const PLUGIN_UI_VIEW_PERMISSIONS = ["code", "network", "process"] as const;

export interface PluginUiViewSeed {
  consentPath: string;
  fixtureRoot: string;
  /** 扩展通过 `nibi.settings.own` 读取的设置文件；spec 稍后写 `{"armed":true}`。 */
  settingsPath: string;
}

/**
 * 在旧 Electron 进程完全退出、新 Host 尚未启动的窗口内调用（`reloadElectronSessionSafely`
 * 的 `afterElectronProcessExit`）。此时没有并发配置写者，seed 不会被旧快照覆盖。
 */
export async function seedPluginUiViewPlugin(): Promise<PluginUiViewSeed> {
  const { homeDir } = getE2EAppDataPaths();
  const fixtureRoot = join(homeDir, "fixtures", "e2e-ui-view-plugin");
  await rm(fixtureRoot, { force: true, recursive: true });
  await cp(FIXTURE_SOURCE_DIR, fixtureRoot, { recursive: true });

  const configPath = join(homeDir, ".nibi", "cli", "config.json");
  const config = await readJsonRecord(configPath);
  const configPlugins = isRecord(config.plugins) ? config.plugins : {};
  const enabledPlugins = isRecord(configPlugins.enabledPlugins)
    ? configPlugins.enabledPlugins
    : {};
  await writeJson(configPath, {
    ...config,
    plugins: {
      ...configPlugins,
      dirs: [fixtureRoot],
      enabled: true,
      enabledPlugins: { ...enabledPlugins, [PLUGIN_UI_VIEW_ID]: true },
    },
  });

  const consentPath = pluginStoragePath("plugin-consents.json");
  const consent = await readJsonRecord(consentPath);
  const consentPlugins = isRecord(consent.plugins) ? consent.plugins : {};
  await writeJson(consentPath, {
    version: 1,
    plugins: {
      ...consentPlugins,
      [PLUGIN_UI_VIEW_ID]: {
        grantedAt: new Date().toISOString(),
        permissions: [...PLUGIN_UI_VIEW_PERMISSIONS],
        version: PLUGIN_UI_VIEW_VERSION,
      },
    },
  });

  const settingsPath = join(pluginStoragePath("data", PLUGIN_UI_VIEW_ID), "settings.json");
  await writeJson(settingsPath, { armed: false });

  return { consentPath, fixtureRoot, settingsPath };
}

/** 只翻转 armed 位；扩展的 250ms 轮询会在下一次读取时调用 `nibi.ui.openView`。 */
export async function armPluginUiView(settingsPath: string): Promise<void> {
  const settings = await readJsonRecord(settingsPath);
  await writeJson(settingsPath, { ...settings, armed: true });
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
