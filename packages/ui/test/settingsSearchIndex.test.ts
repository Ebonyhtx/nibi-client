import { describe, expect, it } from "vitest";
import { Settings } from "lucide-react";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  createSettingsPageConfig,
  type SettingsSectionDefinition,
} from "../src/settings/settingsPageConfig.js";
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
const windowsIndex = createSettingsSearchIndex({
  settingsSections: createSettingsPageConfig({ isWindowsDesktop: true }).settingsSections,
  isDesktop: true,
  isWindowsDesktop: true,
  translate,
});
const linuxIndex = createSettingsSearchIndex({
  settingsSections: createSettingsPageConfig({ isDesktop: true }).settingsSections,
  isDesktop: true,
  isLinuxDesktop: true,
  translate,
});
const webIndex = createSettingsSearchIndex({
  settingsSections: createSettingsPageConfig({}).settingsSections,
  isDesktop: false,
  translate,
});

function findByKeyword(query: string) {
  return searchSettingsIndex(macIndex, query);
}

function findFirst(query: string, index = macIndex) {
  return searchSettingsIndex(index, query)[0];
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
      ["dynamicWorkflows", "agentBehavior.dynamicWorkflows"],
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

  it("非 macOS 桌面不收录字体平滑项，但收录 Windows 专属行", () => {
    expect(windowsIndex.some((entry) => entry.id === "appearance:fontSmoothing")).toBe(false);
    expect(windowsIndex.some((entry) => entry.id === "appearance:theme")).toBe(true);
    expect(windowsIndex.some((entry) => entry.id === "general:integratedTerminalShell")).toBe(true);
    expect(windowsIndex.some((entry) => entry.id === "general:closeToTray")).toBe(true);
  });

  it("Web 端不收录仅桌面可见的远程设备与数据同步", () => {
    expect(webIndex.some((entry) => entry.sectionId === "remoteDevices")).toBe(false);
    expect(webIndex.some((entry) => entry.sectionId === "dataSync")).toBe(false);
  });

  it("Web 端不收录未挂载的桌面专属设置行", () => {
    for (const id of [
      "general:desktopChromiumHardwareAcceleration",
      "general:updates",
      "general:autoDownloadUpdates",
      "general:keepAwake",
      "general:closeToTray",
      "general:integratedTerminalShell",
      "appearance:fontSmoothing",
      "computerUse:toggle",
      "computerUse:composerEntry",
      "computerUse:fullAccessHint",
    ]) {
      expect(webIndex.some((entry) => entry.id === id)).toBe(false);
    }

    // Web 仍挂载的行必须继续可搜：通知声音、代码字号、清缓存、导入浏览器数据。
    expect(webIndex.some((entry) => entry.id === "general:notificationSound")).toBe(true);
    expect(webIndex.some((entry) => entry.id === "appearance:codeFontSize")).toBe(true);
    expect(webIndex.some((entry) => entry.id === "browser:clearCache")).toBe(true);
    expect(webIndex.some((entry) => entry.id === "browser:import")).toBe(true);
  });

  it("Linux 桌面收录关闭到托盘，但不收录 Windows 专属的集成终端 Shell", () => {
    expect(linuxIndex.some((entry) => entry.id === "general:closeToTray")).toBe(true);
    expect(linuxIndex.some((entry) => entry.id === "general:integratedTerminalShell")).toBe(false);
    expect(linuxIndex.some((entry) => entry.id === "browser:import")).toBe(true);
  });

  it("Windows 桌面不收录导入 Chrome 登录状态行", () => {
    expect(windowsIndex.some((entry) => entry.id === "browser:import")).toBe(false);
  });

  it("web / desktop / macDesktop / Windows 可见性枚举按平台过滤", () => {
    const section: SettingsSectionDefinition = {
      id: "general",
      icon: Settings,
      titleId: "settings.systemTitle",
      groupId: "basics",
      searchItems: [
        { id: "webOnly", titleId: "settings.locale", visibility: "web" },
        { id: "desktopOnly", titleId: "settings.onboarding", visibility: "desktop" },
        { id: "macOnly", titleId: "settings.macFontSmoothing", visibility: "macDesktop" },
        { id: "windowsOnly", titleId: "settings.integratedTerminalShell", visibility: "windowsDesktop" },
        {
          id: "windowsOrLinux",
          titleId: "settings.closeToTrayOnWindows",
          visibility: "windowsOrLinuxDesktop",
        },
        { id: "notWindows", titleId: "settings.browser.import.title", visibility: "notWindowsDesktop" },
      ],
    };
    const idsFor = (isDesktop: boolean, isMacDesktop = false, isWindowsDesktop = false) =>
      createSettingsSearchIndex({
        settingsSections: [section],
        isDesktop,
        isMacDesktop,
        isWindowsDesktop,
        isLinuxDesktop: isDesktop && !isWindowsDesktop && !isMacDesktop,
        translate,
      }).map((entry) => entry.id);

    const webIds = idsFor(false);
    expect(webIds).toContain("general:webOnly");
    expect(webIds).toContain("general:notWindows");
    expect(webIds).not.toContain("general:desktopOnly");
    expect(webIds).not.toContain("general:macOnly");
    expect(webIds).not.toContain("general:windowsOnly");
    expect(webIds).not.toContain("general:windowsOrLinux");

    const macIds = idsFor(true, true);
    expect(macIds).toContain("general:desktopOnly");
    expect(macIds).toContain("general:macOnly");
    expect(macIds).toContain("general:notWindows");
    expect(macIds).not.toContain("general:webOnly");
    expect(macIds).not.toContain("general:windowsOnly");
    expect(macIds).not.toContain("general:windowsOrLinux");

    const windowsIds = idsFor(true, false, true);
    expect(windowsIds).toContain("general:desktopOnly");
    expect(windowsIds).toContain("general:windowsOnly");
    expect(windowsIds).toContain("general:windowsOrLinux");
    expect(windowsIds).not.toContain("general:webOnly");
    expect(windowsIds).not.toContain("general:macOnly");
    expect(windowsIds).not.toContain("general:notWindows");
  });

  it("每个索引行的中文标题都能命中该行自己的锚点", () => {
    const indexes = [
      ["macOS", macIndex],
      ["Windows", windowsIndex],
      ["Linux", linuxIndex],
      ["Web", webIndex],
    ] as const;

    for (const [platform, index] of indexes) {
      const rows = index.filter((entry) => !entry.isSectionEntry);
      expect(rows.length, `${platform} 没有设置行`).toBeGreaterThan(0);

      for (const row of rows) {
        expect(row.targetId, `${platform}「${row.title}」（${row.id}）缺少行锚点`).not.toBe(
          `section:${row.sectionId}`,
        );
        const first = findFirst(row.title, index);
        expect(first, `${platform} 搜不到「${row.title}」（${row.id}）`).toBeDefined();
        expect(first?.targetId, `${platform}「${row.title}」（${row.id}）命中到错误锚点`).toBe(
          row.targetId,
        );
      }
    }
  });

  it("缺失项与错位项的回归查询都落到正确锚点", () => {
    expect(findFirst("动态工作流")).toMatchObject({
      id: "agentBehavior:dynamicWorkflows",
      targetId: "agentBehavior.dynamicWorkflows",
    });
    expect(findFirst("dynamic workflow")?.id).toBe("agentBehavior:dynamicWorkflows");
    expect(findFirst("通知声音")).toMatchObject({
      id: "general:notificationSound",
      targetId: "general.notificationSound",
    });
    expect(findFirst("提示音")?.id).toBe("general:notificationSound");
    expect(findFirst("notification sound")?.id).toBe("general:notificationSound");
    expect(findFirst("自动下载")).toMatchObject({
      id: "general:autoDownloadUpdates",
      targetId: "general.autoDownloadUpdates",
    });
    expect(findFirst("auto download")?.id).toBe("general:autoDownloadUpdates");
    expect(findFirst("证书")).toMatchObject({
      id: "general:httpProxyCaCertPath",
      targetId: "general.httpProxyCaCertPath",
    });
    expect(findFirst("certificate")?.id).toBe("general:httpProxyCaCertPath");
    expect(findFirst("忽略证书")?.id).toBe("browser:allowInsecureCertificates");
    expect(findFirst("浅色主题")).toMatchObject({
      id: "appearance:codeLightTheme",
      targetId: "appearance.codeLightTheme",
    });
    expect(findFirst("light theme")?.id).toBe("appearance:codeLightTheme");
    expect(findFirst("界面模式")?.id).toBe("general:interfaceMode");
    expect(findFirst("行号")?.id).toBe("appearance:showLineNumbers");
    expect(findFirst("缓存")?.id).toBe("browser:clearCache");
    expect(findFirst("全权访问")?.id).toBe("computerUse:fullAccessHint");
    expect(findFirst("硬件加速")?.id).toBe("general:desktopChromiumHardwareAcceleration");
    expect(findFirst("关闭到托盘", windowsIndex)?.id).toBe("general:closeToTray");
    expect(findFirst("保持唤醒")?.id).toBe("general:keepAwake");
    expect(findFirst("代码字号")?.id).toBe("appearance:codeFontSize");
    expect(findFirst("归档天数")?.id).toBe("archives:taskAutoArchiveDays");
    expect(findFirst("主动任务推荐")?.id).toBe("general:proactiveSuggestions");
    expect(findFirst("编辑项目")?.id).toBe("projects:edit");
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