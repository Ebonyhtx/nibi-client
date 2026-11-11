import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSourceText } from "./readSourceText.js";

const UI_SRC = "packages/ui/src";

function listSourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") return [];
    const path = join(root, entry.name);
    return entry.isDirectory() ? listSourceFiles(path) : /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe("data sync single entry", () => {
  it("removes every legacy sync dialog module", () => {
    for (const file of [
      "RemoteMcpSyncDialog.tsx",
      "RemotePluginSyncDialog.tsx",
      "RemoteSkillSyncDialog.tsx",
      "RemoteSkillSyncResultList.tsx",
      "RemoteSkillSyncSelectionList.tsx",
      "RemoteSkillSyncTitle.tsx",
      "RemoteSyncActions.tsx",
    ]) {
      expect(existsSync(join(UI_SRC, "settings", file)), file).toBe(false);
    }
  });

  it("no UI source imports or renders a legacy sync dialog", () => {
    const legacyNames = [
      "RemoteMcpSyncDialog",
      "RemotePluginSyncDialog",
      "RemoteSkillSyncDialog",
      "RemoteSyncActions",
      "RemoteSyncDialogs",
      "RemoteSyncMenuItems",
      "RemoteSyncDropdownButton",
    ];
    const offenders = listSourceFiles(UI_SRC).filter((path) => {
      const source = readFileSync(path, "utf8");
      return legacyNames.some((name) => source.includes(name));
    });
    expect(offenders).toEqual([]);
  });

  it("routes the settings sections, plugin market and header entries through the data sync page", () => {
    const skills = readSourceText(`${UI_SRC}/settings/SkillsSection.tsx`);
    const mcp = readSourceText(`${UI_SRC}/settings/McpSettingsSection.tsx`);
    const plugins = readSourceText(`${UI_SRC}/settings/PluginsSection.tsx`);
    const header = readSourceText(`${UI_SRC}/WorkspaceHeaderSections.tsx`);
    const settingsPage = readSourceText(`${UI_SRC}/SettingsPage.tsx`);

    expect(skills).toContain('<DataSyncEntryButton category="skills"');
    expect(mcp).toContain('<DataSyncEntryButton category="mcp"');
    // 插件市场的「重装到设备」语义是把手头插件推到目标设备，必须落到 plugins 分类。
    expect(plugins).toContain('<DataSyncEntryButton');
    expect(plugins).toContain('category="plugins"');
    expect(header).toContain("<DataSyncEntryMenuItems");
    expect(settingsPage).toContain("initialCategory={dataSyncCategoryTarget}");
  });
});
