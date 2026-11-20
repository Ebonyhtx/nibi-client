import { describe, expect, it } from "vitest";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";
import {
  createSettingsSearchIndex,
  scoreSettingsSearchEntry,
  searchSettingsIndex,
} from "../src/settings-search/settingsSearchIndex.js";

const translate = (id: string): string => (zhCN as Record<string, string>)[id] ?? id;
const macConfig = createSettingsPageConfig({ isMacDesktop: true });
const macIndex = createSettingsSearchIndex({
  settingsSections: macConfig.settingsSections,
  isDesktop: true,
  isMacDesktop: true,
  translate,
});

function findByKeyword(query: string) {
  return searchSettingsIndex(macIndex, query);
}

describe("settingsSearchIndex", () => {
  it("从 settingsPageConfig 建立分区与深链项索引", () => {
    const fontSmoothing = macIndex.find((entry) => entry.id === "appearance:fontSmoothing");
    expect(fontSmoothing).toMatchObject({
      sectionId: "appearance",
      title: "字体平滑",
      targetId: "appearance.fontSmoothing",
      isSectionEntry: false,
    });

    const locale = macIndex.find((entry) => entry.id === "general:locale");
    expect(locale?.targetId).toBe("general.locale");

    const projects = macIndex.find((entry) => entry.id === "projects:__section");
    expect(projects).toMatchObject({
      sectionId: "projects",
      title: "项目管理",
      targetId: "section:projects",
      isSectionEntry: true,
    });
    expect(projects?.keywords).toContain("项目");
  });

  it("行为与工具的分区项与深链项位于 Agent 能力组，旧常规项不再重复", () => {
    const section = macIndex.find((entry) => entry.id === "agentBehavior:__section");
    expect(section).toMatchObject({
      sectionId: "agentBehavior",
      title: "行为与工具",
      targetId: "section:agentBehavior",
      isSectionEntry: true,
    });

    for (const [id, targetId] of [
      ["toolSearch", "agentBehavior.toolSearch"],
      ["nativeSearchEnhancements", "agentBehavior.nativeSearchEnhancements"],
      ["interaction", "agentBehavior.interaction"],
      ["askUserQuestionAutoResolution", "agentBehavior.askUserQuestionAutoResolution"],
      ["modelIoFullRetention", "agentBehavior.modelIoFullRetention"],
      ["reasoning", "agentBehavior.reasoning"],
      ["todos", "agentBehavior.todos"],
    ] as const) {
      expect(macIndex.find((entry) => entry.id === `agentBehavior:${id}`)).toMatchObject({
        sectionId: "agentBehavior",
        targetId,
        isSectionEntry: false,
      });
    }

    expect(macIndex.some((entry) => entry.id === "general:reasoning")).toBe(false);
    expect(macIndex.some((entry) => entry.id === "general:todos")).toBe(false);
    expect(macIndex.some((entry) => entry.id === "general:interaction")).toBe(false);
  });

  it("非 macOS 桌面不收录字体平滑项", () => {
    const windowsIndex = createSettingsSearchIndex({
      settingsSections: createSettingsPageConfig({ isWindowsDesktop: true }).settingsSections,
      isDesktop: true,
      isMacDesktop: false,
      translate,
    });
    expect(windowsIndex.some((entry) => entry.id === "appearance:fontSmoothing")).toBe(false);
    expect(windowsIndex.some((entry) => entry.id === "appearance:theme")).toBe(true);
  });

  it("Web 端不收录仅桌面可见的远程设备与数据同步", () => {
    const webIndex = createSettingsSearchIndex({
      settingsSections: createSettingsPageConfig({}).settingsSections,
      isDesktop: false,
      translate,
    });
    expect(webIndex.some((entry) => entry.sectionId === "remoteDevices")).toBe(false);
    expect(webIndex.some((entry) => entry.sectionId === "dataSync")).toBe(false);
  });

  it("中文标题优先命中，英文关键词也能命中同一项", () => {
    expect(findByKeyword("字体平滑")[0]).toMatchObject({
      id: "appearance:fontSmoothing",
      targetId: "appearance.fontSmoothing",
    });
    expect(findByKeyword("font smoothing")[0]).toMatchObject({
      id: "appearance:fontSmoothing",
    });
  });

  it("搜索分区名返回分区入口，搜索项目操作命中项目分区深链", () => {
    expect(findByKeyword("项目管理").some((entry) => entry.id === "projects:__section")).toBe(true);
    expect(findByKeyword("移除项目").some((entry) => entry.id === "projects:remove")).toBe(true);
    expect(macIndex.find((entry) => entry.id === "projects:remove")?.targetId).toBe("projects.list");
  });

  it("思考过程/待办/交互搜索词跟随控件迁到行为与工具页", () => {
    expect(findByKeyword("思考过程")[0]).toMatchObject({
      id: "agentBehavior:reasoning",
      targetId: "agentBehavior.reasoning",
    });
    expect(findByKeyword("待办")[0]).toMatchObject({ id: "agentBehavior:todos" });
    expect(findByKeyword("交互")[0]).toMatchObject({ id: "agentBehavior:interaction" });
    expect(findByKeyword("工具搜索")[0]).toMatchObject({ id: "agentBehavior:toolSearch" });
  });

  it("多词查询要求每个词都命中；空查询不返回全量清单", () => {
    expect(findByKeyword("")).toEqual([]);
    expect(findByKeyword("font 平滑").some((entry) => entry.id === "appearance:fontSmoothing")).toBe(
      true,
    );
    expect(findByKeyword("font 不存在的词")).toEqual([]);
  });

  it("标题完全匹配的分数高于关键词包含匹配", () => {
    const sectionEntry = macIndex.find((entry) => entry.id === "appearance:__section")!;
    const itemEntry = macIndex.find((entry) => entry.id === "appearance:fontSmoothing")!;
    expect(scoreSettingsSearchEntry(itemEntry, "字体平滑")).toBeGreaterThan(
      scoreSettingsSearchEntry(sectionEntry, "平滑"),
    );
  });
});