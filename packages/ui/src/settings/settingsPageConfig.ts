import {
  Archive,
  Monitor,
  Moon,
  Settings,
  Settings2,
  SlidersHorizontal,
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
  Folders,
  User,
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

/**
 * 设置项的运行时可见性。索引只收录当前平台真正会挂载的行，
 * 避免 Web 搜索到桌面专属开关、或反向漏掉 Web 端也能改的项。
 */
export type SettingsSearchItemVisibility =
  | "all"
  | "desktop"
  | "web"
  | "macDesktop"
  | "windowsDesktop"
  | "windowsOrLinuxDesktop"
  | "notWindowsDesktop";

export interface SettingsSearchItemDefinition {
  /** 分区内稳定 ID；索引记录 ID 为 `${sectionId}:${id}`。 */
  id: string;
  titleId: string;
  /** 标题之外的可命中词，中英都放，切语言后仍能搜到同一项。 */
  keywords?: readonly string[];
  /** 设置项 DOM 锚点；缺省时跳回分区标题。 */
  targetId?: string;
  /** 行实际挂载的平台；缺省等同于 `all`。能力缺失导致的动态隐藏由跳转回退到分区处理。 */
  visibility?: SettingsSearchItemVisibility;
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
        id: "interfaceMode",
        titleId: "settings.interfaceMode",
        keywords: ["界面模式", "模式", "interface mode", "mode"],
        targetId: "general.interfaceMode",
      },
      {
        id: "proactiveSuggestions",
        titleId: "chat.officeSuggestions.setting",
        keywords: ["主动任务推荐", "任务推荐", "proactive suggestions", "suggestions"],
        targetId: "general.proactiveSuggestions",
      },
      {
        id: "terminal",
        titleId: "settings.terminalProfile",
        keywords: ["终端", "terminal", "terminal profile"],
        targetId: "general.terminal",
      },
      {
        id: "terminalFontFamily",
        titleId: "settings.terminalFontFamily",
        keywords: ["终端字体", "字体", "terminal font", "font"],
        targetId: "general.terminalFontFamily",
      },
      {
        id: "integratedTerminalShell",
        titleId: "settings.integratedTerminalShell",
        keywords: ["集成终端", "shell", "integrated terminal shell"],
        targetId: "general.integratedTerminalShell",
        visibility: "windowsDesktop",
      },
      {
        id: "httpProxyFollowSystem",
        titleId: "settings.httpProxyFollowSystem",
        keywords: ["跟随系统代理", "系统代理", "proxy", "system proxy", "follow system proxy"],
        targetId: "general.httpProxyFollowSystem",
      },
      {
        id: "httpProxy",
        titleId: "settings.httpProxy",
        keywords: ["网络", "代理", "proxy", "http proxy"],
        targetId: "general.httpProxy",
      },
      {
        id: "httpProxyNoProxy",
        titleId: "settings.httpProxyNoProxy",
        keywords: ["不使用代理", "代理例外", "no proxy", "proxy bypass", "bypass"],
        targetId: "general.httpProxyNoProxy",
      },
      {
        id: "httpProxyCaCertPath",
        titleId: "settings.httpProxyCaCertPath",
        keywords: ["自定义证书", "证书", "certificate", "ca certificate", "ca"],
        targetId: "general.httpProxyCaCertPath",
      },
      {
        id: "desktopChromiumHardwareAcceleration",
        titleId: "settings.desktopChromiumHardwareAcceleration",
        keywords: ["硬件加速", "chrome 硬件加速", "hardware acceleration", "chromium"],
        targetId: "general.desktopChromiumHardwareAcceleration",
        visibility: "desktop",
      },
      {
        id: "updates",
        titleId: "settings.receivePreviewUpdates",
        keywords: ["更新", "预览版", "update", "preview", "preview updates"],
        targetId: "general.updates",
        visibility: "desktop",
      },
      {
        id: "autoDownloadUpdates",
        titleId: "settings.autoDownloadAndInstallUpdates",
        keywords: ["自动下载", "自动更新", "auto download", "auto update"],
        targetId: "general.autoDownloadUpdates",
        visibility: "desktop",
      },
      {
        id: "notification",
        titleId: "settings.notification",
        keywords: ["通知", "任务通知", "notification", "notifications"],
        targetId: "general.notification",
      },
      {
        id: "notificationSound",
        titleId: "settings.notificationSound",
        keywords: ["通知声音", "提示音", "声音", "notification sound", "sound"],
        targetId: "general.notificationSound",
      },
      {
        id: "closeToTray",
        titleId: "settings.closeToTrayOnWindows",
        keywords: ["关闭到托盘", "最小化到托盘", "托盘", "close to tray", "tray"],
        targetId: "general.closeToTray",
        visibility: "windowsOrLinuxDesktop",
      },
      {
        id: "keepAwake",
        titleId: "settings.keepAwakeWhileRunning",
        keywords: [
          "保持唤醒",
          "保持电脑运行",
          "唤醒",
          "keep awake",
          "keep computer running",
          "awake",
        ],
        targetId: "general.keepAwake",
        visibility: "desktop",
      },
      {
        id: "fileTreeHtmlClick",
        titleId: "settings.fileTreeHtmlClickOpensBrowser",
        keywords: ["文件树", "html", "浏览器", "预览", "file tree", "browser", "preview"],
        targetId: "general.fileTreeHtmlClick",
      },
      {
        id: "toolGroupingExplore",
        titleId: "settings.toolGroupingExplore",
        keywords: ["分组探索工具", "探索工具", "tool grouping", "explore tools"],
        targetId: "general.toolGroupingExplore",
      },
      {
        id: "toolGroupingTerminal",
        titleId: "settings.toolGroupingTerminal",
        keywords: ["分组终端命令", "终端命令", "tool grouping", "terminal commands"],
        targetId: "general.toolGroupingTerminal",
      },
      {
        id: "toolGroupingChanges",
        titleId: "settings.toolGroupingChanges",
        keywords: ["分组文件更改", "文件更改", "tool grouping", "file changes"],
        targetId: "general.toolGroupingChanges",
      },
      {
        id: "dataBaseDir",
        titleId: "settings.dataBaseDir",
        keywords: ["数据目录", "存储", "路径", "data directory", "storage", "path"],
        targetId: "general.dataBaseDir",
      },
      {
        id: "onboarding",
        titleId: "settings.onboarding",
        keywords: ["引导", "教程", "onboarding", "tutorial"],
        targetId: "general.onboarding",
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
        keywords: ["主题", "界面主题", "theme", "app theme"],
        targetId: "appearance.theme",
      },
      {
        id: "uiFontSize",
        titleId: "settings.uiFontSize",
        keywords: ["界面字号", "字体大小", "font size"],
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
      {
        id: "companionVisible",
        titleId: "settings.companion.visible",
        keywords: ["显示灵羽", "灵羽", "companion", "show companion"],
        targetId: "appearance.companionVisible",
      },
      {
        id: "companionMode",
        titleId: "settings.companion.mode",
        keywords: ["状态模式", "灵羽状态", "companion mode"],
        targetId: "appearance.companionMode",
      },
      {
        id: "companionFollow",
        titleId: "settings.companion.follow",
        keywords: ["视线跟随", "目光跟随", "gaze follow", "follow"],
        targetId: "appearance.companionFollow",
      },
      {
        id: "companionFeathers",
        titleId: "settings.companion.feathers",
        keywords: ["羽迹氛围", "羽迹", "feathers", "ambience"],
        targetId: "appearance.companionFeathers",
      },
      {
        id: "companionAnimation",
        titleId: "settings.companion.animation",
        keywords: ["灵羽动画", "动画", "companion animation", "animation"],
        targetId: "appearance.companionAnimation",
      },
      {
        id: "codeLightTheme",
        titleId: "settings.lightTheme",
        keywords: ["浅色代码主题", "浅色主题", "浅色", "light code theme", "light theme", "light"],
        targetId: "appearance.codeLightTheme",
      },
      {
        id: "codeDarkTheme",
        titleId: "settings.darkTheme",
        keywords: ["深色代码主题", "深色主题", "深色", "dark code theme", "dark theme", "dark"],
        targetId: "appearance.codeDarkTheme",
      },
      {
        id: "showLineNumbers",
        titleId: "settings.showLineNumbers",
        keywords: ["显示行号", "行号", "line numbers", "line number"],
        targetId: "appearance.showLineNumbers",
      },
      {
        id: "wrapLongLines",
        titleId: "settings.wrapLongLines",
        keywords: ["长行自动换行", "自动换行", "换行", "wrap long lines", "word wrap", "wrap"],
        targetId: "appearance.wrapLongLines",
      },
      {
        id: "codeFontSize",
        titleId: "settings.fontSize",
        keywords: ["代码字号", "字号", "code font size", "code font", "font size"],
        targetId: "appearance.codeFontSize",
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
    icon: User,
    titleId: "settings.personalization.title",
    contentTitleId: "settings.personalization.title",
    groupId: "agentCapabilities",
    searchKeywords: ["个性化", "提示词", "instructions", "agents md", "personalization"],
  },
  // 行为与工具紧跟个性化：这里放的是影响 Agent 单轮行为的开关（工具搜索、交互、
  // 流式展示），与后面的记忆 / 子代理等能力配置区分开（上游 3.18.2 同序）。
  {
    id: "agentBehavior",
    icon: SlidersHorizontal,
    titleId: "settings.agentBehavior.title",
    groupId: "agentCapabilities",
    searchKeywords: ["行为", "工具", "交互", "behavior", "tools", "interaction"],
    searchItems: [
      {
        id: "toolSearch",
        titleId: "settings.toolSearch",
        keywords: ["工具搜索", "工具", "tool search", "toolsearch", "tools"],
        targetId: "agentBehavior.toolSearch",
      },
      {
        id: "nativeSearchEnhancements",
        titleId: "settings.nativeSearchEnhancements",
        keywords: ["搜索增强", "增强搜索", "find", "grep", "native search", "search enhancement"],
        targetId: "agentBehavior.nativeSearchEnhancements",
      },
      {
        id: "interaction",
        titleId: "settings.nibiInteractionBehavior",
        keywords: ["交互", "队列", "interaction", "queue"],
        targetId: "agentBehavior.interaction",
      },
      {
        id: "askUserQuestionAutoResolution",
        titleId: "settings.askUserQuestionAutoResolution",
        keywords: ["提问", "自动继续", "ask user question", "auto resolution", "auto continue"],
        targetId: "agentBehavior.askUserQuestionAutoResolution",
      },
      {
        id: "dynamicWorkflows",
        titleId: "settings.dynamicWorkflow",
        keywords: ["动态工作流", "dynamic workflow", "workflow"],
        targetId: "agentBehavior.dynamicWorkflows",
      },
      {
        id: "modelIoFullRetention",
        titleId: "settings.modelIoFullRetention",
        keywords: ["模型 io", "模型输入输出", "保留", "model io", "retention"],
        targetId: "agentBehavior.modelIoFullRetention",
      },
      {
        id: "reasoning",
        titleId: "settings.messageStreamShowReasoning",
        keywords: ["思考过程", "reasoning"],
        targetId: "agentBehavior.reasoning",
      },
      {
        id: "todos",
        titleId: "settings.messageStreamShowTodos",
        keywords: ["待办", "todo"],
        targetId: "agentBehavior.todos",
      },
    ],
  },
  {
    id: "memory",
    icon: Brain,
    titleId: "settings.memory",
    groupId: "agentCapabilities",
    searchKeywords: ["记忆", "memory"],
    searchItems: [
      {
        id: "workspaceMemory",
        titleId: "settings.memory.workspaceMemory",
        keywords: ["工作区记忆", "记忆", "workspace memory", "memory"],
        targetId: "memory.workspaceMemory",
      },
    ],
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
    searchItems: [
      {
        id: "control",
        titleId: "settings.browser.control.title",
        keywords: ["浏览器控制", "内置浏览器", "browser control", "browser use"],
        targetId: "browser.control",
      },
      {
        id: "import",
        titleId: "settings.browser.import.title",
        keywords: [
          "导入浏览器数据",
          "导入 chrome",
          "chrome 登录状态",
          "import browser data",
          "chrome import",
        ],
        targetId: "browser.import",
        visibility: "notWindowsDesktop",
      },
      {
        id: "allowInsecureCertificates",
        titleId: "settings.embeddedBrowserAllowInsecureCertificates",
        keywords: [
          "忽略证书校验",
          "不安全证书",
          "insecure certificates",
          "ignore certificate errors",
        ],
        targetId: "browser.allowInsecureCertificates",
        visibility: "desktop",
      },
      {
        id: "clearCache",
        titleId: "settings.browser.clearCache.title",
        keywords: ["清除缓存", "清缓存", "缓存", "clear cache", "cache"],
        targetId: "browser.clearCache",
      },
      {
        id: "clearAll",
        titleId: "settings.browser.clearAll.title",
        keywords: [
          "清除全部浏览器数据",
          "清除全部数据",
          "浏览器数据",
          "clear all browser data",
          "clear all data",
        ],
        targetId: "browser.clearAll",
      },
    ],
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
    searchItems: [
      {
        id: "toggle",
        titleId: "settings.computerUse.toggleLabel",
        keywords: ["启用电脑控制", "电脑控制", "computer use", "cua"],
        targetId: "computerUse.toggle",
        visibility: "desktop",
      },
      {
        id: "composerEntry",
        titleId: "settings.computerUse.composerEntry.label",
        keywords: [
          "输入框电脑操作按钮",
          "电脑操作按钮",
          "composer entry",
          "computer use button",
        ],
        targetId: "computerUse.composerEntry",
        visibility: "desktop",
      },
      {
        id: "fullAccessHint",
        titleId: "settings.computerUse.fullAccessHint.label",
        keywords: ["提示切换完全访问", "完全访问", "全权访问", "full access", "full access hint"],
        targetId: "computerUse.fullAccessHint",
        visibility: "desktop",
      },
    ],
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
    icon: Folders,
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
        id: "edit",
        titleId: "project.edit",
        keywords: ["编辑项目", "编辑", "edit project", "edit"],
        targetId: "projects.list",
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
      {
        id: "taskAutoArchiveDays",
        titleId: "settings.taskAutoArchiveDays",
        keywords: ["归档保留时长", "归档天数", "保留时长", "archive days", "retention"],
        targetId: "archives.taskAutoArchiveDays",
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
