import {
  Archive,
  Monitor,
  Moon,
  Settings,
  Settings2,
  Package,
  Bot,
  Palette,
  Sun,
  BarChart3,
  Terminal,
  AlarmClock,
  Anchor,
  Brain,
  Blocks,
  Globe2,
  Cable,
  RefreshCw,
  WandSparkles,
  HardDrive,
  Keyboard,
  FileSearch,
  FileText,
  FolderKanban,
} from "lucide-react";
import { isSettingsSectionEnabled, type SettingsSectionId } from "@/lib/settingsNavigation.js";
import type { Theme } from "@/useTheme.js";

export const THEME_MODES: Array<{
  mode: Theme;
  icon: typeof Sun;
}> = [
  { mode: "system", icon: Monitor },
  { mode: "nibi-dark", icon: Moon },
  { mode: "nibi-light", icon: Sun },
];

export type SettingsSectionGroupId = "basics" | "agentCapabilities" | "dataAndStats";

export interface SettingsSearchItemDefinition {
  /** 分区内稳定 ID；索引记录 ID 为 `${sectionId}:${id}`。 */
  id: string;
  titleId: string;
  /** 标题之外的可命中词，中英都放，切语言后仍能搜到同一项。 */
  keywords?: readonly string[];
  /** 设置项 DOM 锚点；缺省时跳回分区标题。 */
  targetId?: string;
  /** 只在 macOS 桌面可用的设置项。 */
  visibility?: "macDesktop";
}

export interface SettingsSectionDefinition {
  id: SettingsSectionId;
  icon: typeof Settings;
  titleId: string;
  contentTitleId?: string;
  titleBadgeId?: string;
  groupId: SettingsSectionGroupId;
  /** 分区级搜索关键词（中英）。 */
  searchKeywords?: readonly string[];
  /** 分区内可深链的高价值设置项。 */
  searchItems?: readonly SettingsSearchItemDefinition[];
}

const BASE_SETTINGS_SECTION_GROUPS: Array<{
  id: SettingsSectionGroupId;
  titleId: string;
}> = [
  { id: "basics", titleId: "settings.sidebar.group.basics" },
  {
    id: "agentCapabilities",
    titleId: "settings.sidebar.group.agentCapabilities",
  },
  { id: "dataAndStats", titleId: "settings.sidebar.group.dataAndStats" },
];

const BASE_SETTINGS_SECTIONS: SettingsSectionDefinition[] = [
  {
    id: "general",
    icon: Settings2,
    titleId: "settings.systemTitle",
    groupId: "basics",
    searchKeywords: ["通用", "常规", "偏好", "general", "preferences"],
    searchItems: [
      {
        id: "locale",
        titleId: "settings.locale",
        keywords: ["界面语言", "语言", "language", "locale"],
        targetId: "general.locale",
      },
      {
        id: "notification",
        titleId: "settings.notification",
        keywords: ["通知", "提示音", "notification", "sound"],
        targetId: "general.notification",
      },
      {
        id: "terminal",
        titleId: "settings.terminalProfile",
        keywords: ["终端", "terminal", "shell", "字体", "font"],
        targetId: "general.terminal",
      },
      {
        id: "httpProxy",
        titleId: "settings.httpProxy",
        keywords: ["网络", "代理", "proxy", "证书", "certificate", "ca"],
        targetId: "general.httpProxy",
      },
      {
        id: "dataBaseDir",
        titleId: "settings.dataBaseDir",
        keywords: ["数据目录", "存储", "路径", "data directory", "storage", "path"],
        targetId: "general.dataBaseDir",
      },
      {
        id: "updates",
        titleId: "settings.receivePreviewUpdates",
        keywords: ["更新", "预览版", "自动下载", "update", "preview", "auto update"],
        targetId: "general.updates",
      },
      {
        id: "onboarding",
        titleId: "settings.onboarding",
        keywords: ["引导", "教程", "onboarding", "tutorial"],
        targetId: "general.onboarding",
      },
      {
        id: "reasoning",
        titleId: "settings.messageStreamShowReasoning",
        keywords: ["思考过程", "reasoning"],
        targetId: "general.reasoning",
      },
      {
        id: "todos",
        titleId: "settings.messageStreamShowTodos",
        keywords: ["待办", "todo"],
        targetId: "general.todos",
      },
      {
        id: "fileTreeHtmlClick",
        titleId: "settings.fileTreeHtmlClickOpensBrowser",
        keywords: ["文件树", "html", "浏览器", "预览", "file tree", "browser", "preview"],
        targetId: "general.fileTreeHtmlClick",
      },
      {
        id: "interaction",
        titleId: "settings.nibiInteractionBehavior",
        keywords: ["交互", "队列", "interaction", "queue"],
        targetId: "general.interaction",
      },
    ],
  },
  {
    id: "appearance",
    icon: Palette,
    titleId: "settings.appearanceTitle",
    groupId: "basics",
    searchKeywords: ["外观", "显示", "appearance", "display", "theme", "font"],
    searchItems: [
      {
        id: "theme",
        titleId: "settings.themeMode",
        keywords: ["主题", "深色", "浅色", "theme", "dark", "light"],
        targetId: "appearance.theme",
      },
      {
        id: "uiFontSize",
        titleId: "settings.uiFontSize",
        keywords: ["字号", "字体大小", "font size"],
        targetId: "appearance.uiFontSize",
      },
      {
        id: "fontSmoothing",
        titleId: "settings.macFontSmoothing",
        keywords: ["字体平滑", "抗锯齿", "macos", "font smoothing", "antialias"],
        targetId: "appearance.fontSmoothing",
        visibility: "macDesktop",
      },
      {
        id: "motion",
        titleId: "settings.motionEnabled",
        keywords: ["动效", "动画", "motion", "animation"],
        targetId: "appearance.motion",
      },
    ],
  },
  {
    id: "modelProvider",
    icon: Package,
    titleId: "settings.modelProviderTitle",
    groupId: "basics",
    searchKeywords: ["模型", "提供商", "连接", "密钥", "model", "provider", "api key"],
  },
  // 个性化紧跟基础设置之后：用户级 AGENTS.md 是 Agent 行为的全局输入，
  // 放在 Agent 能力组最前，和记忆 / 子代理等能力配置形成同一叙事。
  {
    id: "personalization",
    icon: FileText,
    titleId: "settings.personalization.title",
    contentTitleId: "settings.personalization.title",
    groupId: "agentCapabilities",
    searchKeywords: ["个性化", "提示词", "instructions", "agents md", "personalization"],
  },
  {
    id: "memory",
    icon: Brain,
    titleId: "settings.memory",
    groupId: "agentCapabilities",
    searchKeywords: ["记忆", "memory"],
  },
  {
    id: "subagents",
    icon: Bot,
    titleId: "settings.subagents.title",
    groupId: "agentCapabilities",
    searchKeywords: ["子代理", "子智能体", "subagent", "agent"],
  },
  {
    id: "plugin",
    icon: Blocks,
    titleId: "settings.plugins.title",
    groupId: "agentCapabilities",
    searchKeywords: ["插件", "扩展", "plugin", "extension"],
  },
  {
    id: "mcp",
    icon: Cable,
    titleId: "settings.mcpTitle",
    groupId: "agentCapabilities",
    searchKeywords: ["服务器", "工具", "mcp", "server", "tool"],
  },
  {
    id: "skill",
    icon: WandSparkles,
    titleId: "settings.skills.title",
    groupId: "agentCapabilities",
    searchKeywords: ["技能", "skill"],
  },
  {
    id: "commands",
    icon: Terminal,
    titleId: "settings.commands.title",
    groupId: "agentCapabilities",
    searchKeywords: ["命令", "斜杠", "command", "slash"],
  },
  {
    id: "automations",
    icon: AlarmClock,
    titleId: "settings.automations.title",
    titleBadgeId: "settings.automations.betaBadge",
    groupId: "agentCapabilities",
  },
  {
    id: "hooks",
    icon: Anchor,
    titleId: "settings.hooks.title",
    groupId: "agentCapabilities",
    searchKeywords: ["钩子", "脚本", "hook", "script"],
  },
  {
    id: "browser",
    icon: Globe2,
    titleId: "settings.browser.title",
    groupId: "basics",
    searchKeywords: ["浏览器", "网页", "browser", "web"],
  },
  // 原型导航顺序：浏览器之后才是远程设备；电脑控制继续紧随其后并受灰度门禁。
  {
    id: "remoteDevices",
    icon: HardDrive,
    titleId: "settings.remoteDevicesTitle",
    contentTitleId: "settings.remoteDevicesTitle",
    groupId: "basics",
    searchKeywords: ["远程", "设备", "连接", "remote", "device", "connection"],
  },
  // 数据同步归在「数据与统计」组首位，与上游一致：它管的是用户数据面，不是本机基础行为。
  {
    id: "dataSync",
    icon: RefreshCw,
    titleId: "settings.dataSync.title",
    contentTitleId: "settings.dataSync.title",
    groupId: "dataAndStats",
    searchKeywords: ["同步", "设备", "sync", "device"],
  },
  // 电脑控制紧跟「浏览器」：两者都是给 Agent 用的本机操控入口，
  // 放在基础设置里让用户在同一处理解「控制浏览器 / 控制整台电脑」的关系。
  {
    id: "computerUse",
    icon: Monitor,
    titleId: "settings.computerUse.title",
    groupId: "basics",
    searchKeywords: ["电脑控制", "屏幕", "computer use", "cua", "screen"],
  },
  // 键盘快捷键紧跟「电脑控制」：同属本机操控/效率配置，收纳在基础设置尾部。
  {
    id: "shortcuts",
    icon: Keyboard,
    titleId: "settings.shortcuts.title",
    groupId: "basics",
    searchKeywords: ["快捷键", "键盘", "shortcut", "keyboard", "keybinding"],
  },
  // 工作区搜索范围（.nibiignore）：面向所有用户的基础工作区行为配置，收在基础设置末尾。
  {
    id: "workspaceFileSearch",
    icon: FileSearch,
    titleId: "settings.workspaceFileSearch.title",
    groupId: "basics",
    searchKeywords: ["工作区", "搜索范围", "忽略", "workspace", "search scope", "ignore"],
  },
  {
    id: "usage",
    icon: BarChart3,
    titleId: "settings.usageTitle",
    groupId: "dataAndStats",
    searchKeywords: ["使用统计", "用量", "令牌", "usage", "token"],
  },
  // 项目是用户数据组织的主体；放在使用统计之后、归档之前，
  // 与侧栏「项目 → 会话 → 归档」的心智顺序一致。
  {
    id: "projects",
    icon: FolderKanban,
    titleId: "settings.projects.title",
    contentTitleId: "settings.projects.title",
    groupId: "dataAndStats",
    searchKeywords: ["项目", "项目管理", "project", "project management"],
    searchItems: [
      {
        id: "search",
        titleId: "settings.projects.searchLabel",
        keywords: ["搜索项目", "search projects"],
        targetId: "projects.search",
      },
      {
        id: "remove",
        titleId: "settings.projects.removeProject",
        keywords: ["移除项目", "删除", "remove project", "delete"],
        targetId: "projects.list",
      },
      {
        id: "restore",
        titleId: "settings.projects.restore",
        keywords: ["恢复项目", "restore project"],
        targetId: "projects.removed",
      },
    ],
  },
  {
    id: "archives",
    icon: Archive,
    titleId: "archives.nav",
    groupId: "dataAndStats",
    searchKeywords: ["归档", "自动归档", "archive", "auto archive"],
    searchItems: [
      {
        id: "taskAutoArchive",
        titleId: "settings.taskAutoArchive",
        keywords: ["旧会话", "自动归档", "old sessions", "auto archive"],
        targetId: "archives.taskAutoArchive",
      },
    ],
  },
  // 暂时隐藏设置页里的 Migration 入口，只保留页面实现，后续可以直接恢复这一项。
  // {
  //   id: "migration",
  //   icon: ArrowLeftRight,
  //   titleId: "settings.migration.title",
  // },
];

// 兼容既有只读消费者：默认配置代表不带桌面平台能力的 Web 视图；
// macOS/Windows/Linux 必须继续通过 createSettingsPageConfig 动态加入 Computer Use。
export const SETTINGS_SECTIONS = BASE_SETTINGS_SECTIONS.filter(
  (section) => section.id !== "computerUse" && isSettingsSectionEnabled(section.id),
);

export interface SettingsPageConfigOptions {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}

export function createSettingsPageConfig({
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
}: SettingsPageConfigOptions = {}) {
  const showComputerUse = isDesktop || isMacDesktop || isWindowsDesktop;
  const settingsSections = BASE_SETTINGS_SECTIONS.filter((section) => {
    if (section.id === "computerUse" && !showComputerUse) return false;
    return isSettingsSectionEnabled(section.id);
  });
  const settingsSectionGroups = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
    ...group,
    sections: settingsSections.filter((section) => section.groupId === group.id),
  })).filter((group) => group.sections.length > 0);

  return { settingsSectionGroups, settingsSections };
}

export function resolveSettingsSectionForPlatform(
  section: SettingsSectionId,
  visibleSections: ReadonlyArray<Pick<SettingsSectionDefinition, "id">>,
  fallbackSection: SettingsSectionId = "general",
): SettingsSectionId {
  if (visibleSections.some((candidate) => candidate.id === section)) return section;
  if (visibleSections.some((candidate) => candidate.id === fallbackSection)) {
    return fallbackSection;
  }
  return visibleSections[0]?.id ?? "general";
}

export const SETTINGS_SECTION_GROUPS = BASE_SETTINGS_SECTION_GROUPS.map((group) => ({
  ...group,
  sections: SETTINGS_SECTIONS.filter((section) => section.groupId === group.id),
})).filter((group) => group.sections.length > 0);

export type { SettingsSectionId };

export function isSettingsSectionAvailable(
  section: SettingsSectionId,
  isDesktop: boolean,
): boolean {
  // 数据同步与远程设备一样只在桌面端出现；页面还需要至少一台在线远端「用户」才算真正可用。
  if (section === "dataSync") return isDesktop;
  return isDesktop || section !== "remoteDevices";
}
