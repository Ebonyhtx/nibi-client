import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { clearAppData, getE2EAppDataPaths } from "../../../helpers/desktop-app.js";
import { seedOfficialPluginsViaCli } from "../../../helpers/tier2-sixth-batch.js";
import {
  capturePluginManualReview,
  clickPluginControl,
  openPluginManagementSettings,
  requirePluginManualReview,
  restartPluginLifecycleApp,
  selectPluginSettingsScope,
  waitForPluginControl,
} from "../../../helpers/plugin-management-lifecycle.js";

// 产品规则：项目层只能禁用插件，Workspace 的「启用」会提升到 user。
// 所以 enabledSource=workspace 的覆盖要通过「在 Workspace scope 暂停」创建。
const BUILTIN_ID = "skill-creator@nibi-official";
const MENU_LAYOUT_TIMEOUT_MS = 240000;
const RESTORE_USER_DEFAULT_PATTERN = /恢复 User 默认|Restore User default/u;

interface MenuItemLayout {
  text: string;
  textLineCount: number;
  height: number;
}

describe("PLM-LC-017 已安装列表行内菜单布局 E2E", () => {
  before(() => {
    // 干净 E2E HOME 没有内置插件缓存；skill-creator 不在列表里时行内菜单用例无从断言。
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

  it("Workspace 覆盖下菜单只含启停与卸载且保持单行", async function () {
    this.timeout(MENU_LAYOUT_TIMEOUT_MS);
    requirePluginManualReview();

    // user 层显式启用，确保 Workspace 暂停能形成明确的覆盖（而不是停在默认值）。
    await seedUserPluginEnabled();
    await restartPluginLifecycleApp();
    await openPluginManagementSettings();
    await selectPluginSettingsScope("workspace");
    await waitForPluginControl("plugin-settings-plugin-row", { pluginId: BUILTIN_ID }, 60000);

    // 走真实用户路径：在 Workspace scope 暂停，生成 enabledSource=workspace。
    await openInstalledRowMenu(BUILTIN_ID);
    await clickPluginControl("plugin-store-menu-enabled", { pluginId: BUILTIN_ID });
    await browser.waitUntil(
      () =>
        browser.execute((pluginId) => {
          const row = Array.from(
            document.querySelectorAll<HTMLElement>('[data-testid="plugin-settings-plugin-row"]'),
          ).find((candidate) => candidate.dataset.pluginId === pluginId);
          return Boolean(row?.querySelector('[data-settings-scope="workspace"]'));
        }, BUILTIN_ID),
      { timeout: 30000, timeoutMsg: "已安装列表没有把内置插件标记为 Workspace 覆盖" },
    );

    // 重新打开行内菜单，断言布局并截图。
    // 启停成功后列表会刷新；等菜单关闭动画与重渲染落定再打开，避免 pointerdown 被丢弃。
    await browser.pause(800);
    await openInstalledRowMenu(BUILTIN_ID);
    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelectorAll(
              '[data-slot="dropdown-menu-content"][data-state="open"] [role="menuitem"]',
            ).length >= 2,
        ),
      { timeout: 15000, timeoutMsg: "行内「…」菜单没有展开" },
    );

    const items = await browser.execute((): MenuItemLayout[] => {
      const content = document.querySelector<HTMLElement>(
        '[data-slot="dropdown-menu-content"][data-state="open"]',
      );
      if (!content) return [];
      return Array.from(content.querySelectorAll<HTMLElement>('[role="menuitem"]')).map((item) => {
        // 只统计文本节点的行框：菜单项是 flex 行，文本节点会成为匿名 flex item，
        // 折行时 Range 会返回多个非空 rect。
        let textLineCount = 0;
        for (const node of Array.from(item.childNodes)) {
          if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          textLineCount += Array.from(range.getClientRects()).filter(
            (rect) => rect.width > 0 && rect.height > 0,
          ).length;
        }
        return {
          text: item.innerText.trim(),
          textLineCount,
          height: item.getBoundingClientRect().height,
        };
      });
    });
    await capturePluginManualReview("PLM-LC-017", "installed-row-menu-workspace-override");

    const restoreItem = items.find((item) => RESTORE_USER_DEFAULT_PATTERN.test(item.text));
    expect(restoreItem).toBeUndefined();
    expect(items).toHaveLength(2);
    const wrapped = items.filter((item) => item.textLineCount !== 1);
    if (wrapped.length > 0) {
      throw new Error(`菜单项折行：${JSON.stringify(wrapped)}`);
    }
    // 所有菜单项等高，进一步排除折行把某一行撑高。
    const heights = new Set(items.map((item) => Math.round(item.height)));
    if (heights.size !== 1) {
      throw new Error(`菜单项高度不一致：${JSON.stringify(items)}`);
    }
    expect(items.length).toBeGreaterThanOrEqual(2);
  });
});

async function openInstalledRowMenu(pluginId: string): Promise<void> {
  // 启停操作进行中时菜单触发器是 disabled，pointerdown 不会展开菜单；先等它恢复可用。
  await browser.waitUntil(
    () =>
      browser.execute((targetPluginId) => {
        const row = Array.from(
          document.querySelectorAll<HTMLElement>('[data-testid="plugin-settings-plugin-row"]'),
        ).find((candidate) => candidate.dataset.pluginId === targetPluginId);
        const trigger = row?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
        return Boolean(trigger && !trigger.disabled);
      }, pluginId),
    { timeout: 30000, timeoutMsg: "已安装列表行内菜单触发器仍不可用" },
  );
  await browser.execute((targetPluginId) => {
    const row = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="plugin-settings-plugin-row"]'),
    ).find((candidate) => candidate.dataset.pluginId === targetPluginId);
    const trigger = row?.querySelector<HTMLElement>('button[aria-haspopup="menu"]');
    if (!trigger) throw new Error("已安装列表行内没有「…」菜单触发器");
    // 内置插件行位于列表下方，先滚到视口中央，人工审核截图才能同时看到行与展开的菜单。
    row?.scrollIntoView({ block: "center" });
    // Radix DropdownMenu 在 pointerdown 上切换 open；仅 click 不会打开菜单。
    trigger.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }),
    );
  }, pluginId);
}

async function seedUserPluginEnabled(): Promise<void> {
  const { homeDir } = getE2EAppDataPaths();
  const userConfigPath = join(homeDir, ".nibi", "cli", "config.json");
  await mkdir(dirname(userConfigPath), { recursive: true });
  const existing = existsSync(userConfigPath)
    ? (JSON.parse(await readFile(userConfigPath, "utf8")) as Record<string, unknown>)
    : {};
  const plugins = isRecord(existing.plugins) ? existing.plugins : {};
  const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
  await writeFile(
    userConfigPath,
    JSON.stringify(
      {
        ...existing,
        plugins: { ...plugins, enabledPlugins: { ...enabledPlugins, [BUILTIN_ID]: true } },
      },
      null,
      2,
    ),
    "utf8",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
