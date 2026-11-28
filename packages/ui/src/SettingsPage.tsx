import { SettingsMachinesProvider } from "@/settings/SettingsMachine.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import { RemoteConnectionNavigationDot } from "@/remote-connection/RemoteConnectionNavigationDot.js";
import { resolveRemoteConnectionNavigationPresentation } from "@/lib/remoteConnectionPresentation.js";
/* oxlint-disable eslint(max-lines) */
import { ArrowLeft, ArrowRightLeft, Info, type LucideIcon } from "lucide-react";
import { useStore } from "zustand";
import {
  marketingNavigation,
  finishMarketingNavigation,
  marketingSettingsSections,
} from "@/lib/marketingNavigation.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type {
  AppSettings,
  DesktopCloseToTrayCapability,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  UserInfo,
  NibiInteractionBehavior,
} from "@nibi/shared";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  testId,
} from "@nibi/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import { getPathLeaf } from "@/lib/path.js";
import { persistMotionEnabled, useMotionPreferenceEnabled } from "@/lib/motionPreference.js";
import {
  addPendingSettingsSectionListener,
  clearPendingSettingsPluginOrigin,
  clearPendingSettingsPluginScopeKey,
  consumeInitialSettingsSection,
  consumePendingSettingsDataSyncCategory,
  consumePendingSettingsSourceServerId,
  consumePendingSettingsSourceServerDetails,
  consumePendingSettingsPluginOrigin,
  consumePendingSettingsPluginScopeKey,
  consumePendingSettingsPluginTab,
  consumePendingSettingsModelProviderTarget,
  resolveSettingsSection,
  setPendingSettingsSectionIntent,
  writeLastSettingsSectionPreference,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";
import { ArchiveManagement, useOptionalProjectDirectory } from "@/project-sidebar/index.js";
import { resolveRecentRemoteProjectPreference } from "@/project-sidebar/remote-project-connection.js";
import { ModelProviderSection } from "@/settings/ModelProviderSection.js";
import { UsageStatsSection } from "@/settings/UsageStatsSection.js";
import { SubagentsSection } from "@/settings/SubagentsSection.js";
import { AutomationsSection } from "@/settings/AutomationsSection.js";
import { PluginsSection } from "@/settings/PluginsSection.js";
import { HooksSection } from "@/settings/HooksSection.js";
import { WorkspaceFileSearchSection } from "@/settings/WorkspaceFileSearchSection.js";
import { PersonalizationSection } from "@/settings/PersonalizationSection.js";
import { ProjectsSection } from "@/settings/ProjectsSection.js";
import { SettingsSearch } from "@/settings-search/SettingsSearch.js";
import { highlightSettingsSearchTarget } from "@/settings-search/settingsSearchHighlight.js";
import type { SettingsSearchIndexEntry } from "@/settings-search/settingsSearchIndex.js";
import { MemorySettingsSection } from "@/settings/MemorySettingsSection.js";
import { BrowserSettingsSection } from "@/settings/BrowserSettingsSection.js";
import { ComputerUseSection } from "@/settings/ComputerUseSection.js";
import { ShortcutSettingsSection } from "@/settings/ShortcutSettingsSection.js";
import { MigrationSection } from "@/settings/MigrationSection.js";
import { MigrationWizardDialog } from "@/settings/migration-wizard/MigrationWizardDialog.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import {
  SettingsSectionPane,
  useRetainedSettingsSections,
} from "@/settings/SettingsSectionKeepAlive.js";
import { DataSyncSettingsEntry, useDataSyncDevices } from "@/data-sync/index.js";
import {
  SettingsBreadcrumbProvider,
  SettingsHeaderBreadcrumb,
  type SettingsBreadcrumbItem,
} from "@/settings/SettingsHeaderBreadcrumb.js";
import { useNibiStore } from "@/store/StoreProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { Theme } from "@/useTheme.js";
import { WindowsTopLeftLogo } from "@/WindowsTopLeftLogo.js";

import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useSelectDirectory } from "@/hooks/usePlatform.js";
import { ServiceProvider, useServices } from "@/hooks/useServices.js";
import type { AppToolSearchMode } from "@nibi/shared";
import { isLocale } from "@nibi/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import type { CreateTaskRequest, RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveModelProviderConnectivityWorkspacePath } from "@/lib/modelProviderConnectivityTarget.js";
import {
  createSettingsPageConfig,
  AgentBehaviorSectionContent,
  GeneralSectionContent,
  TaskAutoArchiveSettings,
  isSettingsSectionAvailable,
  resolveSettingsSectionForPlatform,
} from "@/settingsPageHelpers.js";
import { SourceServerManagementPanel } from "@/settings/SourceServerManagementPanel.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useOptionalRemoteWorkspaceController } from "@/remote/useRemoteWorkspaceController.js";
import { AppearanceSectionContent } from "./settingsCodePreview.js";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import {
  runUserAction,
  runUserActionAsync,
  type UserActionResult,
  type UserActionTrigger,
} from "@/lib/userActionTelemetry.js";
import type { SettingsUserActionFeatureId } from "@/lib/userActionTraceCatalog.js";

function runSettingsActionAsync<T>(options: {
  featureId: SettingsUserActionFeatureId;
  action: string;
  trigger: UserActionTrigger;
  operation: () => Promise<T>;
  completed: UserActionResult;
  failureStage?: string;
}): Promise<T> {
  return runUserActionAsync({
    input: {
      featureId: options.featureId,
      action: options.action,
      trigger: options.trigger,
    },
    operation: options.operation,
    completed: options.completed,
    failureStage: options.failureStage ?? "settings_commit",
  });
}

function SettingsSidebarButton({
  icon: Icon,
  label,
  active,
  children,
  className,
  ...buttonProps
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  children?: ReactNode;
  className?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <ControlHintTooltip title={label} side="right" align="center">
      <button
        {...buttonProps}
        type={buttonProps.type ?? "button"}
        aria-label={label}
        className={cn(
          "relative flex h-8 w-full items-center gap-2 rounded-xl pl-3.5 pr-2.5 text-left transition-colors",
          "max-lg:mx-auto max-lg:size-10 max-lg:justify-center max-lg:px-0",
          "compact-web:mx-0 compact-web:h-8 compact-web:w-auto compact-web:shrink-0 compact-web:px-2.5",
          active
            ? "bg-card font-medium text-foreground shadow-[var(--nibi-shadow-active-row)] ring-1 ring-primary/25"
            : "text-remote-foreground-muted hover:bg-card/55 hover:text-foreground",
          className,
        )}
      >
        {active ? (
          <span
            aria-hidden="true"
            className="absolute left-1.5 top-1/2 h-3.5 w-0.5 -translate-y-1/2 rounded-full bg-primary max-lg:hidden compact-web:hidden"
          />
        ) : null}
        <span className="flex size-4 shrink-0 items-center justify-center text-current">
          <Icon className={cn("size-4", active ? "text-primary" : "text-current")} />
        </span>
        <span className="min-w-0 flex-1 max-lg:sr-only compact-web:not-sr-only">
          {children ?? <span className="truncate text-ui-base">{label}</span>}
        </span>
      </button>
    </ControlHintTooltip>
  );
}

/** 设置页外层两列/两行布局；compact-web 下改为“顶部导航 + 内容”两行。 */
export const SETTINGS_PAGE_LAYOUT_CLASSNAME =
  "relative grid h-screen min-h-full w-full grid-cols-[68px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] lg:grid-cols-[268px_minmax(0,1fr)] compact-web:grid-cols-1 compact-web:grid-rows-[auto_minmax(0,1fr)]";

/** 设置导航滚动容器；compact-web 下横向滚动，桌面保持纵向滚动。 */
export const SETTINGS_NAV_CLASSNAME =
  "flex-1 overflow-y-auto px-2 pb-3 compact-web:min-w-0 compact-web:overflow-x-auto compact-web:overflow-y-hidden compact-web:py-1.5";

/** 设置导航分组列表；compact-web 下改为单行横向排列。 */
export const SETTINGS_NAV_LIST_CLASSNAME =
  "space-y-4 compact-web:flex compact-web:items-center compact-web:gap-2 compact-web:space-y-0";

export function SettingsPage({
  isDesktop,
  isWindowsDesktop,
  isMacDesktop,
  isWebRemoteControl = false,
  windowsWindowControlsRightPaddingPx: _windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenWorkspace,
  onOpenRemoteWorkspace,
  allowOpenWorkspace = true,
  onLogin,
  onLogout,
  user,
}: {
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isMacDesktop?: boolean;
  isWebRemoteControl?: boolean;
  windowsWindowControlsRightPaddingPx?: number;
  captionWorkspacePath?: string | null;
  onBack?: () => void;
  onCreateTask?: (request?: CreateTaskRequest) => void;
  onOpenWorkspace?: () => void;
  onOpenRemoteWorkspace?: (preference?: RemoteConnectionOpenPreference) => void;
  /** 远程设备卡「新任务」：激活该设备已打开的 tab 并开新草稿（Root 注入）。 */
  allowOpenWorkspace?: boolean;
  onLogin?: () => void;
  onLogout?: () => void;
  user?: UserInfo | null;
}) {
  const { intl, localePreference, setLocalePreference } = useNibiIntl();
  const { settingsSectionGroups, settingsSections } = useMemo(
    () =>
      createSettingsPageConfig({
        isDesktop: Boolean(isDesktop),
        isMacDesktop: Boolean(isMacDesktop),
        isWindowsDesktop: Boolean(isWindowsDesktop),
      }),
    [isDesktop, isMacDesktop, isWindowsDesktop],
  );
  const isLinuxDesktop = Boolean(isDesktop && !isMacDesktop && !isWindowsDesktop);
  const usesInlineWindowControls = Boolean(isWindowsDesktop || isLinuxDesktop);
  const platform = usePlatform();
  const remoteWorkspaceController = useOptionalRemoteWorkspaceController();
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    const initialSection = consumeInitialSettingsSection("general");
    const visibleInitialSection = resolveSettingsSectionForPlatform(
      initialSection,
      settingsSections,
    );
    // 设置页首次挂载时也要写入当前落点。否则用户直接打开再退出，
    // 下一次仍可能因为没有偏好记录而回到旧默认入口。
    writeLastSettingsSectionPreference(visibleInitialSection);
    return visibleInitialSection;
  });
  // 保留当前分区 + 最近访问的一个；首次访问才挂载，正常切换不重建。
  const retainedSettingsSections = useRetainedSettingsSections(activeSection);
  const [targetSourceServerId, setTargetSourceServerId] = useState(
    consumePendingSettingsSourceServerId,
  );
  const [targetSourceServerDetails, setTargetSourceServerDetails] = useState(
    consumePendingSettingsSourceServerDetails,
  );
  // 旧同步弹窗删除后，技能 / MCP / 插件入口统一带分类意图打开数据同步分区。
  const [dataSyncCategoryTarget, setDataSyncCategoryTarget] = useState(
    consumePendingSettingsDataSyncCategory,
  );
  // 数据同步页头「迁移数据」：复用已有的 Claude 会话迁移能力，不另造第二套迁移流程。
  const [dataSyncMigrationOpen, setDataSyncMigrationOpen] = useState(false);
  const [pluginTab, setPluginTab] = useState(() => consumePendingSettingsPluginTab());
  // Linux 关闭驻留托盘能力查询（spec：docs/desktop/linux-close-to-tray.md）：打开设置页时
  // 经 platform IPC 触发 main 侧探测（带 stale 缓存），用户装完 AppIndicator 扩展重开
  // 设置页即可解除置灰；Web/远控无桥不查询。
  const [linuxCloseToTrayCapability, setLinuxCloseToTrayCapability] =
    useState<DesktopCloseToTrayCapability | null>(null);
  useEffect(() => {
    if (!isLinuxDesktop) {
      return;
    }
    let cancelled = false;
    platform
      .getCloseToTrayCapability?.()
      .then((capability) => {
        if (!cancelled) {
          setLinuxCloseToTrayCapability(capability);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isLinuxDesktop, platform]);
  const linuxCloseToTray = isLinuxDesktop
    ? {
        // 探测中按不可用锁定，防止查询完成前误开导致关窗失联
        disabled: linuxCloseToTrayCapability === null || !linuxCloseToTrayCapability.supported,
        unavailable: linuxCloseToTrayCapability?.supported === false,
        gnomeLikeHint:
          linuxCloseToTrayCapability?.supported === false &&
          linuxCloseToTrayCapability.gnomeLikeWithoutTray,
      }
    : undefined;
  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  useEffect(() => {
    if (marketingRequest?.target.page !== "settings") return;
    const target = marketingRequest.target;
    const section = target.section ? marketingSettingsSections[target.section] : activeSection;
    if (!settingsSections.some((item) => item.id === section)) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_navigation_unavailable"));
    } else if (activeSection === section && !target.provider_id) {
      finishMarketingNavigation(marketingRequest.id);
    }
  }, [activeSection, marketingRequest, settingsSections]);
  const [pluginNavigationOrigin, setPluginNavigationOrigin] = useState(() =>
    consumePendingSettingsPluginOrigin(),
  );
  const [pluginScopeKey, setPluginScopeKey] = useState(() =>
    consumePendingSettingsPluginScopeKey(),
  );
  const [settingsSectionNavigationVersion, setSettingsSectionNavigationVersion] = useState(0);
  useEffect(() => {
    // React Strict Mode 会双执行 state initializer；来源和 scopeKey 都在挂载完成后再清理，
    // Marketplace 只返回 User 已安装视图；Workspace 仍通过设置页自身的配置层切换进入。
    clearPendingSettingsPluginOrigin();
    clearPendingSettingsPluginScopeKey();
  }, []);
  const [settingsBreadcrumbItems, setSettingsBreadcrumbItems] = useState<
    readonly SettingsBreadcrumbItem[]
  >([]);
  const interfaceMode = useNibiStore((state) => state.interfaceMode);
  const setInterfaceMode = useNibiStore((state) => state.setInterfaceMode);
  const theme = useNibiStore((state) => state.theme);
  const setTheme = useNibiStore((state) => state.setTheme);
  const codePreviewSettings = useNibiStore((state) => state.codePreviewSettings);
  const setCodePreviewSettings = useNibiStore((state) => state.setCodePreviewSettings);
  const uiFontSizePx = useNibiStore((state) => state.uiFontSizePx);
  // 动效偏好是 localStorage 偏好 + DOM 属性，不进 store（见 lib/motionPreference）。
  const motionEnabled = useMotionPreferenceEnabled();
  const macFontSmoothingEnabled = useNibiStore((state) => state.macFontSmoothingEnabled);
  const setMacFontSmoothingEnabled = useNibiStore((state) => state.setMacFontSmoothingEnabled);
  const setUiFontSizePx = useNibiStore((state) => state.setUiFontSizePx);
  const notificationEnabled = useNibiStore((state) => state.notificationEnabled);
  const setNotificationEnabled = useNibiStore((state) => state.setNotificationEnabled);
  const notificationSoundEnabled = useNibiStore((state) => state.notificationSoundEnabled);
  const setNotificationSoundEnabled = useNibiStore((state) => state.setNotificationSoundEnabled);
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [pendingModelProviderTarget, setPendingModelProviderTarget] = useState<
    SettingsModelProviderTarget | undefined
  >(() => initialModelProviderTarget);
  const setNewUserOnboardingOpen = useNibiStore((state) => state.setNewUserOnboardingOpen);
  const requestOnboardingDialog = () => setNewUserOnboardingOpen(true);
  const setActiveSettingsSection = useCallback(
    (section: SettingsSectionId, fallbackSection: SettingsSectionId = activeSection) => {
      const resolvedSection = resolveSettingsSection(section, fallbackSection);
      setActiveSection(resolvedSection);
      writeLastSettingsSectionPreference(resolvedSection);
    },
    [activeSection],
  );
  const settingsPageRef = useRef<HTMLDivElement>(null);
  const settingsNavRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = settingsNavRef.current;
    // compact-web 使用顶部横向导航；从搜索或其他入口直达分区时把当前项滚进可见区域。
    // 桌面竖向导航没有横向溢出，不进入该分支。
    if (!nav || nav.scrollWidth <= nav.clientWidth) {
      return;
    }
    nav
      .querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSection]);
  const settingsSearchRequestSeq = useRef(0);
  const [settingsSearchNavigation, setSettingsSearchNavigation] = useState<{
    sectionId: SettingsSectionId;
    targetId: string;
    requestId: number;
  } | null>(null);
  const handleSettingsSearchNavigate = useCallback(
    (entry: SettingsSearchIndexEntry) => {
      // 与侧栏分区点击走同一条导航清理；否则从搜索进入插件/远程设备时会沿用旧意图。
      setPluginNavigationOrigin(undefined);
      setTargetSourceServerId(undefined);
      setDataSyncCategoryTarget(undefined);
      setSettingsSectionNavigationVersion((version) => version + 1);
      setActiveSettingsSection(entry.sectionId);
      setSettingsSearchNavigation({
        sectionId: entry.sectionId,
        targetId: entry.targetId,
        requestId: ++settingsSearchRequestSeq.current,
      });
    },
    [setActiveSettingsSection],
  );
  const appliedSettingsSearchRequestRef = useRef<number | null>(null);
  useEffect(() => {
    const navigation = settingsSearchNavigation;
    if (!navigation || appliedSettingsSearchRequestRef.current === navigation.requestId) {
      return;
    }

    let cancelled = false;
    let cleanupHighlight = () => {};
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (cancelled) return;
        appliedSettingsSearchRequestRef.current = navigation.requestId;
        cleanupHighlight = highlightSettingsSearchTarget(
          settingsPageRef.current,
          navigation.targetId,
          {
            // 设置项锚点可能尚未挂载（例如懒加载分区）：至少落在分区标题上。
            fallbackTargetId: `section:${activeSection}`,
          },
        );
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      cleanupHighlight();
    };
  }, [activeSection, settingsSearchNavigation]);
  useEffect(() => {
    if (!isDesktop && (activeSection === "remoteDevices" || activeSection === "dataSync")) {
      setActiveSettingsSection("general");
    }
  }, [activeSection, isDesktop, setActiveSettingsSection]);
  const handleOpenModelProviderSettings = useCallback(() => {
    setActiveSettingsSection("modelProvider");
  }, [setActiveSettingsSection]);
  const handleOpenUsageSettings = useCallback(() => {
    // 设置页 sidebar footer 里的齿轮/返回按钮复用 onBack，
    // 但头像菜单的“使用统计”应该停留在设置页并切到 Usage，不能跟着返回工作区。
    setActiveSettingsSection("usage");
  }, [setActiveSettingsSection]);
  const activeWorkspacePath = useTabStore((state) => state.activeWorkspacePath);
  const activateTab = useTabStore((state) => state.activateTab);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const tabs = useTabStore((state) => state.tabs);
  const workspaceTabs = useMemo(() => tabs.filter(isWorkspaceTab), [tabs]);
  // Settings 打开后 activeTab 会变成 settings，本地反查 activeTab 读 identity 会稳定丢失。
  // 这里改为读取 tabStore 维护的“最近激活 workspace identity”，让插件管理继续命中正确远端。
  const activeWorkspaceIdentity = useTabStore(
    (state) => state.activeWorkspaceIdentity ?? undefined,
  );
  const activeWorkspaceTab = useTabStore((state) => {
    const workspacePath = state.activeWorkspacePath;
    if (!workspacePath) {
      return null;
    }
    const workspaceIdentity = state.activeWorkspaceIdentity ?? undefined;
    const matchingTabs = state.tabs
      .filter(isWorkspaceTab)
      .filter((tab) => tab.workspacePath === workspacePath);
    return (
      matchingTabs.find((tab) =>
        workspaceIdentity ? tab.workspaceIdentity === workspaceIdentity : !tab.workspaceIdentity,
      ) ??
      matchingTabs[0] ??
      null
    );
  });
  const localModelProviderConnectivityWorkspacePath = useMemo(
    () =>
      resolveModelProviderConnectivityWorkspacePath({
        activeWorkspacePath,
        activeWorkspaceIdentity,
        activeWorkspaceTab,
        workspaceTabs,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath, activeWorkspaceTab, workspaceTabs],
  );
  const isRemoteModelProviderWorkspace = Boolean(
    activeWorkspaceIdentity?.trim() ||
    activeWorkspaceTab?.remoteSessionId?.trim() ||
    activeWorkspaceTab?.remoteTarget,
  );
  const selectDirectory = useSelectDirectory();
  const services = useServices();
  const onboardingRecordService = services.onboardingRecordService;
  const localHostServices = useBaseWorkspaceServices();
  const projectDirectory = useOptionalProjectDirectory();
  // SettingsPage 可能挂在远端 workspace 的 ServiceProvider 下；共享设置属于本机 Host，
  // 读写必须固定走本机 settingService，否则会写进远端 setting。
  const { settings: sharedSettings, update: updateSharedSettings } = useSettings({
    services: localHostServices,
  });
  const sourceManagement = localHostServices.sourceServerManagementService;
  const { snapshot: sourceManagementSnapshot } = useSourceServerManagementSnapshot(
    sourceManagement,
    {
      onError: (error) =>
        logger.warn("[SettingsPage] 读取 Source 状态失败", {
          error: error instanceof Error ? error.message : String(error),
        }),
    },
  );
  const remoteDevicesPresentation = useMemo(
    () => resolveRemoteConnectionNavigationPresentation(sourceManagementSnapshot),
    [sourceManagementSnapshot],
  );
  // 数据同步导航在桌面端常显：没有设备时页面自己给空态与「连接设备」入口，
  // 不能因为设备列表为空就把功能藏掉（用户会不知道如何开始配对）。
  const dataSyncDevices = useDataSyncDevices();
  const handleConnectDataSyncDevice = useCallback(() => {
    // 优先复用既有远程连接向导；没有 Root 注入时退回远程设备设置页（同样能新建连接）。
    if (onOpenRemoteWorkspace) {
      onOpenRemoteWorkspace({ completion: "device-management" });
      return;
    }
    setActiveSettingsSection("remoteDevices");
  }, [onOpenRemoteWorkspace, setActiveSettingsSection]);
  const memoryWorkspaceDisplayNames = useMemo(() => {
    const names = new Set<string>();
    // Memory Scope 的项目顺序以 settings.json recentProjects 为准；打开中的
    // Workspace 只补充尚未持久化的项目，不能抢占最近项目排序。
    for (const path of sharedSettings?.recentProjects ?? []) {
      const name = getPathLeaf(path).trim();
      if (name) names.add(name);
    }
    for (const tab of workspaceTabs) {
      const name = tab.label.trim() || getPathLeaf(tab.workspacePath).trim();
      if (name) names.add(name);
    }
    return [...names];
  }, [sharedSettings?.recentProjects, workspaceTabs]);
  const memoryEnabled = sharedSettings?.memoryEnabled === true;
  const toolSearchMode = sharedSettings?.toolSearchMode ?? "off";
  const nativeSearchEnhancementsEnabled = sharedSettings?.nativeSearchEnhancementsEnabled !== false;
  const askUserQuestionAutoResolutionEnabled =
    sharedSettings?.askUserQuestionAutoResolutionEnabled !== false;
  const modelIoFullRetentionEnabled = sharedSettings?.modelIoFullRetentionEnabled === true;
  const [dataBaseDir, setDataBaseDir] = useState("");
  const [terminalInheritSystemProfile, setTerminalInheritSystemProfile] = useState(true);
  const [terminalFontFamily, setTerminalFontFamily] = useState("");
  const [integratedTerminalShell, setIntegratedTerminalShell] =
    useState<IntegratedTerminalShellSelection>({ mode: "auto" });
  const [integratedTerminalShellOptions, setIntegratedTerminalShellOptions] = useState<
    IntegratedTerminalShellOption[]
  >([]);
  const [httpProxyMode, setHttpProxyMode] = useState<"system" | "manual" | undefined>();
  const [httpProxy, setHttpProxy] = useState("");
  const [httpProxyNoProxy, setHttpProxyNoProxy] = useState("");
  const [httpProxyCaCertPath, setHttpProxyCaCertPath] = useState("");
  const [embeddedBrowserAllowInsecureCertificates, setEmbeddedBrowserAllowInsecureCertificates] =
    useState(false);
  const [taskAutoArchiveEnabled, setTaskAutoArchiveEnabled] = useState(false);
  const [taskAutoArchiveOlderThanDays, setTaskAutoArchiveOlderThanDays] = useState(30);
  const [closeToTrayOnWindows, setCloseToTrayOnWindows] = useState(Boolean(isWindowsDesktop));
  const [
    desktopChromiumHardwareAccelerationEnabled,
    setDesktopChromiumHardwareAccelerationEnabled,
  ] = useState(true);
  const [receivePreviewUpdates, setReceivePreviewUpdates] = useState(false);
  const [autoDownloadAndInstallUpdates, setAutoDownloadAndInstallUpdates] = useState(false);
  const [messageStreamShowReasoning, setMessageStreamShowReasoning] = useState(true);
  const [messageStreamShowTodos, setMessageStreamShowTodos] = useState(false);
  const [fileTreeHtmlClickOpensBrowser, setFileTreeHtmlClickOpensBrowser] = useState(false);
  const [toolGroupingExploreEnabled, setToolGroupingExploreEnabled] = useState(true);
  const [toolGroupingTerminalEnabled, setToolGroupingTerminalEnabled] = useState(true);
  const [toolGroupingChangesEnabled, setToolGroupingChangesEnabled] = useState(false);
  const [nibiInteractionBehavior, setNibiInteractionBehavior] =
    useState<NibiInteractionBehavior>("queue");
  const [defaultHomeDir, setDefaultHomeDir] = useState("");
  const [hostPlatform, setHostPlatform] = useState("");

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        // SettingsPage 已打开时再次从 quickpick 点“个性化/MCP”等设置入口，
        // 页面不会重新挂载，之前写入的 pending section 无人消费，看起来像点击没反应。
        // 这里订阅同窗口跳转意图，立即切换当前设置分区。
        setActiveSettingsSection(section, activeSection);
        // 设置入口是一级路由边界。即使仍落在同一 section，也必须销毁旧的 New/Edit/Detail 子状态。
        setSettingsSectionNavigationVersion((version) => version + 1);
        setTargetSourceServerId(section === "remoteDevices" ? detail?.sourceServerId : undefined);
        setTargetSourceServerDetails(
          section === "remoteDevices" && detail?.sourceServerDetails === true,
        );
        // 数据同步分类只属于 dataSync 分区；离开该分区后清空，避免下次进入沿用旧预选。
        setDataSyncCategoryTarget(section === "dataSync" ? detail?.dataSyncCategory : undefined);
        if (resolveSettingsSection(section) === "plugin" && detail?.pluginTab) {
          setPluginTab(detail.pluginTab);
          setPluginNavigationOrigin(detail.pluginOrigin);
          setPluginScopeKey(detail.pluginScopeKey);
        } else if (resolveSettingsSection(section) !== "plugin") {
          setPluginNavigationOrigin(undefined);
        }
        if (section === "modelProvider" && detail?.modelProviderId) {
          setPendingModelProviderTarget({
            providerId: detail.modelProviderId,
          });
        }
      }),
    [activeSection, setActiveSettingsSection],
  );

  useEffect(() => {
    let active = true;
    // 修复原因：远程 tab 的 services 属于 Source，但 Main 启动、native picker 和
    // 本机 shell 枚举都使用 Desktop 配置；读写必须同属 base Host，不能随 tab 切换。
    localHostServices.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        setDataBaseDir(settings.dataBaseDir ?? "");
        setIntegratedTerminalShell(settings.integratedTerminalShell ?? { mode: "auto" });
        setHttpProxyMode(settings.httpProxyMode);
        setHttpProxy(settings.httpProxy ?? "");
        setHttpProxyNoProxy(settings.httpProxyNoProxy ?? "");
        setHttpProxyCaCertPath(settings.httpProxyCaCertPath ?? "");
        setEmbeddedBrowserAllowInsecureCertificates(
          settings.embeddedBrowserAllowInsecureCertificates ?? false,
        );
        setCloseToTrayOnWindows(settings.closeToTrayOnWindows ?? Boolean(isWindowsDesktop));
        setDesktopChromiumHardwareAccelerationEnabled(
          settings.desktopChromiumHardwareAccelerationEnabled ?? true,
        );
      })
      .catch(() => {});
    localHostServices.systemService
      .info()
      .then((info) => {
        if (!active) return;
        setDefaultHomeDir(info.homedir);
        setHostPlatform(info.platform);
        if (info.platform !== "win32") {
          setIntegratedTerminalShellOptions([]);
          return;
        }
        void localHostServices.systemService
          .listIntegratedTerminalShells()
          .then((options) => {
            if (active) setIntegratedTerminalShellOptions(options);
          })
          .catch(() => {
            if (active) setIntegratedTerminalShellOptions([]);
          });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [localHostServices.systemService, localHostServices.settingService, isWindowsDesktop]);

  useEffect(() => {
    let active = true;
    // 终端 Profile 与任务归档由目标 Environment 消费，仍读 Source；切换后丢弃旧响应。
    services.settingService
      .get()
      .then((settings: AppSettings) => {
        if (!active) return;
        setTerminalInheritSystemProfile(settings.terminalInheritSystemProfile ?? true);
        setTerminalFontFamily(settings.terminalFontFamily ?? "");
        setTaskAutoArchiveEnabled(settings.taskAutoArchiveEnabled ?? false);
        setTaskAutoArchiveOlderThanDays(settings.taskAutoArchiveOlderThanDays ?? 30);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [services.settingService]);

  useEffect(() => {
    if (!sharedSettings) {
      return;
    }
    setMessageStreamShowReasoning(sharedSettings.messageStreamShowReasoning ?? true);
    setMessageStreamShowTodos(sharedSettings.messageStreamShowTodos ?? false);
    setFileTreeHtmlClickOpensBrowser(sharedSettings.fileTreeHtmlClickOpensBrowser ?? false);
    setToolGroupingExploreEnabled(sharedSettings.toolGroupingExploreEnabled ?? true);
    setToolGroupingTerminalEnabled(sharedSettings.toolGroupingTerminalEnabled ?? true);
    setToolGroupingChangesEnabled(sharedSettings.toolGroupingChangesEnabled ?? false);
    setNibiInteractionBehavior(sharedSettings.nibiInteractionBehavior ?? "queue");
    setReceivePreviewUpdates(sharedSettings.receivePreviewUpdates ?? false);
    setAutoDownloadAndInstallUpdates(sharedSettings.autoDownloadAndInstallUpdates ?? false);
  }, [sharedSettings]);
  const handleTerminalInheritSystemProfileChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "toggle_system_profile",
        trigger: "switch",
        operation: () => services.settingService.update({ terminalInheritSystemProfile: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTerminalInheritSystemProfile(enabled);
    },
    [services.settingService],
  );
  const handleTerminalFontFamilyChange = useCallback(
    async (fontFamily: string) => {
      const normalizedFontFamily = fontFamily.trim();
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "save_font_family",
        trigger: "button",
        operation: () =>
          services.settingService.update({ terminalFontFamily: normalizedFontFamily }),
        completed: { resultSource: "setting_service", configured: normalizedFontFamily.length > 0 },
      });
      setTerminalFontFamily(normalizedFontFamily);
    },
    [services.settingService],
  );
  const handleIntegratedTerminalShellChange = useCallback(
    async (selection: IntegratedTerminalShellSelection) => {
      await runSettingsActionAsync({
        featureId: "settings.terminal",
        action: "change_shell",
        trigger: "select",
        operation: () =>
          localHostServices.settingService.update({ integratedTerminalShell: selection }),
        completed: {
          resultSource: "setting_service",
          valueAfter: selection.mode === "auto" ? "auto" : "explicit",
        },
      });
      setIntegratedTerminalShell(selection);
    },
    [localHostServices.settingService],
  );
  const handleToolSearchModeChange = useCallback(
    async (mode: AppToolSearchMode) => {
      await runSettingsActionAsync({
        featureId: "settings.search",
        action: "change_tool_search_mode",
        trigger: "select",
        operation: () => updateSharedSettings({ toolSearchMode: mode }),
        completed: { resultSource: "shared_settings", valueAfter: mode },
      });
    },
    [updateSharedSettings],
  );
  const handleNativeSearchEnhancementsEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.search",
        action: "toggle_native_search",
        trigger: "switch",
        operation: () => updateSharedSettings({ nativeSearchEnhancementsEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleAskUserQuestionAutoResolutionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_ask_user_auto_resolution",
        trigger: "switch",
        operation: () => updateSharedSettings({ askUserQuestionAutoResolutionEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleModelIoFullRetentionEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_model_io_retention",
        trigger: "switch",
        operation: () => updateSharedSettings({ modelIoFullRetentionEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleMemoryEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.memory",
        action: "toggle_memory",
        trigger: "switch",
        operation: async () => {
          await updateSharedSettings({ memoryEnabled: enabled });
          // 手动修改反向回写 record，换号同步不会复活旧值；失败不阻塞开关。
          await onboardingRecordService
            ?.updateRecordPreferences({ memoryEnabled: enabled })
            .catch((cause: unknown) => {
              console.warn("[settings] 回写引导记录失败", String(cause));
            });
        },
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleHttpProxyModeChange = useCallback(
    async (mode: "system" | "manual") => {
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_http_proxy_mode",
        trigger: "switch",
        operation: () =>
          localHostServices.settingService.update({
            httpProxyMode: mode,
          }),
        completed: {
          resultSource: "setting_service",
          configured: mode === "system",
          requiresRestart: true,
        },
      });
      setHttpProxyMode(mode);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  const handleHttpProxyChange = useCallback(
    async (proxy: string) => {
      const normalizedProxy = proxy.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_http_proxy",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: RPC 会丢弃 undefined；清空代理必须传空串，由服务层删除旧字段。
            httpProxy: normalizedProxy,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedProxy.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxy(normalizedProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  const handleHttpProxyNoProxyChange = useCallback(
    async (noProxy: string) => {
      const normalizedNoProxy = noProxy
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
        .join(",");
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_no_proxy",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: 清空 No Proxy 必须传空串，否则旧绕过规则会继续影响下次启动。
            httpProxyNoProxy: normalizedNoProxy,
          }),
        completed: { resultSource: "setting_service", configured: normalizedNoProxy.length > 0 },
      });
      setHttpProxyNoProxy(normalizedNoProxy);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  const handleHttpProxyCaCertPathChange = useCallback(
    async (caCertPath: string) => {
      const normalizedCaCertPath = caCertPath.trim();
      await runSettingsActionAsync({
        featureId: "settings.network",
        action: "save_ca_certificate",
        trigger: "button",
        operation: () =>
          localHostServices.settingService.update({
            // Bugfix: 清空自定义 CA 必须传空串，否则旧 NODE_EXTRA_CA_CERTS 路径会残留。
            httpProxyCaCertPath: normalizedCaCertPath,
          }),
        completed: {
          resultSource: "setting_service",
          configured: normalizedCaCertPath.length > 0,
          requiresRestart: true,
        },
      });
      setHttpProxyCaCertPath(normalizedCaCertPath);
      toast(intl.formatMessage({ id: "settings.httpProxySavedHint" }));
    },
    [localHostServices.settingService, intl],
  );
  const handleDataBaseDirChange = useCallback(
    async (dir: string) => {
      await runSettingsActionAsync({
        featureId: "settings.storage",
        action: "change_data_directory",
        trigger: "button",
        operation: () => localHostServices.settingService.updateDataBaseDir(dir || undefined),
        completed: { resultSource: "setting_service", requiresRestart: true },
        failureStage: "data_directory_update",
      });
      // Bugfix: 迁移失败时不能先把本地状态改成失败路径，否则设置页会误显示为已切换。
      setDataBaseDir(dir);
    },
    [localHostServices.settingService],
  );
  const handleTaskAutoArchiveEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "toggle_auto_archive",
        trigger: "switch",
        operation: () => services.settingService.update({ taskAutoArchiveEnabled: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setTaskAutoArchiveEnabled(enabled);
    },
    [services.settingService],
  );
  const handleTaskAutoArchiveOlderThanDaysChange = useCallback(
    async (days: number) => {
      await runSettingsActionAsync({
        featureId: "settings.task",
        action: "change_auto_archive_days",
        trigger: "select",
        operation: () => services.settingService.update({ taskAutoArchiveOlderThanDays: days }),
        completed: { resultSource: "setting_service", valueAfter: String(days) },
      });
      setTaskAutoArchiveOlderThanDays(days);
    },
    [services.settingService],
  );
  const handleCloseToTrayOnWindowsChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_close_to_tray",
        trigger: "switch",
        operation: () => localHostServices.settingService.update({ closeToTrayOnWindows: enabled }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      platform.syncAppSettings?.({ closeToTrayOnWindows: enabled });
      setCloseToTrayOnWindows(enabled);
    },
    [localHostServices.settingService, platform],
  );
  // keep-awake：走 useSettings 统一写盘 + syncAppSettings，和 Automations/创建页入口共享同一状态源。
  const handleKeepAwakeWhileRunningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_keep_awake",
        trigger: "switch",
        operation: () => updateSharedSettings({ keepAwakeWhileRunning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
    },
    [updateSharedSettings],
  );
  const handleDesktopChromiumHardwareAccelerationChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.desktop",
        action: "toggle_hardware_acceleration",
        trigger: "switch",
        operation: () =>
          localHostServices.settingService.update({
            desktopChromiumHardwareAccelerationEnabled: enabled,
          }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setDesktopChromiumHardwareAccelerationEnabled(enabled);
      toast(
        intl.formatMessage({
          id: "settings.desktopChromiumHardwareAccelerationSavedHint",
        }),
      );
    },
    [localHostServices.settingService, intl],
  );
  const handleEmbeddedBrowserAllowInsecureCertificatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.browser",
        action: "toggle_insecure_certificates",
        trigger: "switch",
        operation: () =>
          localHostServices.settingService.update({
            embeddedBrowserAllowInsecureCertificates: enabled,
          }),
        completed: {
          resultSource: "setting_service",
          stateAfter: enabled ? "enabled" : "disabled",
          requiresRestart: true,
        },
      });
      setEmbeddedBrowserAllowInsecureCertificates(enabled);
      // 证书策略在 main 启动时装到 Session 上，改完必须重启才会换掉 verifyProc。
      toast(
        intl.formatMessage({
          id: "settings.embeddedBrowserAllowInsecureCertificatesSavedHint",
        }),
      );
    },
    [localHostServices.settingService, intl],
  );
  const handleReceivePreviewUpdatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.update",
        action: "toggle_preview_updates",
        trigger: "switch",
        operation: () => updateSharedSettings({ receivePreviewUpdates: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setReceivePreviewUpdates(enabled);
    },
    [updateSharedSettings],
  );
  const handleAutoDownloadAndInstallUpdatesChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.update",
        action: "toggle_auto_update",
        trigger: "switch",
        operation: () => updateSharedSettings({ autoDownloadAndInstallUpdates: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setAutoDownloadAndInstallUpdates(enabled);
    },
    [updateSharedSettings],
  );
  const handleMessageStreamShowReasoningChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_reasoning",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowReasoning: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowReasoning(enabled);
    },
    [updateSharedSettings],
  );
  const handleMessageStreamShowTodosChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_show_todos",
        trigger: "switch",
        operation: () => updateSharedSettings({ messageStreamShowTodos: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setMessageStreamShowTodos(enabled);
    },
    [updateSharedSettings],
  );
  const handleFileTreeHtmlClickOpensBrowserChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "toggle_file_tree_html_click_browser",
        trigger: "switch",
        operation: () => updateSharedSettings({ fileTreeHtmlClickOpensBrowser: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setFileTreeHtmlClickOpensBrowser(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingExploreEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_explore_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingExploreEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingExploreEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingTerminalEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_terminal_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingTerminalEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingTerminalEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleToolGroupingChangesEnabledChange = useCallback(
    async (enabled: boolean) => {
      await runSettingsActionAsync({
        featureId: "settings.tool_grouping",
        action: "toggle_changes_grouping",
        trigger: "switch",
        operation: () => updateSharedSettings({ toolGroupingChangesEnabled: enabled }),
        completed: {
          resultSource: "shared_settings",
          stateAfter: enabled ? "enabled" : "disabled",
        },
      });
      setToolGroupingChangesEnabled(enabled);
    },
    [updateSharedSettings],
  );
  const handleNibiInteractionBehaviorChange = useCallback(
    async (behavior: NibiInteractionBehavior) => {
      await runSettingsActionAsync({
        featureId: "settings.conversation",
        action: "change_interaction_behavior",
        trigger: "select",
        operation: () => updateSharedSettings({ nibiInteractionBehavior: behavior }),
        completed: { resultSource: "shared_settings", valueAfter: behavior },
      });
      setNibiInteractionBehavior(behavior);
    },
    [updateSharedSettings],
  );
  const handleFooterLocaleChange = useCallback(
    (value: string) => {
      if (value === "system") {
        runUserAction({
          input: { featureId: "settings.locale", action: "change_locale", trigger: "select" },
          operation: () => setLocalePreference("system"),
          completed: { resultSource: "local_commit", valueAfter: "system" },
          failureStage: "local_commit",
        });
        return;
      }
      if (isLocale(value)) {
        runUserAction({
          input: { featureId: "settings.locale", action: "change_locale", trigger: "select" },
          operation: () => setLocalePreference(value),
          completed: { resultSource: "local_commit", valueAfter: value },
          failureStage: "local_commit",
        });
      }
    },
    [setLocalePreference],
  );
  const handleFooterThemeChange = useCallback(
    (value: string) => {
      if (
        value === "light" ||
        value === "dark" ||
        value === "nibi-light" ||
        value === "nibi-dark" ||
        value === "nibi-obsidian" ||
        value === "nibi-mist" ||
        value === "system"
      ) {
        runUserAction({
          input: { featureId: "settings.appearance", action: "change_theme", trigger: "select" },
          operation: () => setTheme(value as Theme),
          completed: { resultSource: "local_commit", valueAfter: value },
          failureStage: "local_commit",
        });
      }
    },
    [setTheme],
  );
  const handleCodePreviewSettingsChange = useCallback(
    (patch: Parameters<typeof setCodePreviewSettings>[0]) => {
      const [key] = Object.keys(patch);
      const action =
        key === "lightTheme"
          ? "change_code_light_theme"
          : key === "darkTheme"
            ? "change_code_dark_theme"
            : key === "showLineNumbers"
              ? "toggle_code_line_numbers"
              : key === "wrapLongLines"
                ? "toggle_code_line_wrap"
                : "change_code_font_size";
      const value = Object.values(patch)[0];
      return runUserAction({
        input: { featureId: "settings.appearance", action, trigger: "select" },
        operation: () => setCodePreviewSettings(patch),
        completed: {
          resultSource: "local_commit",
          ...(typeof value === "boolean"
            ? { stateAfter: value ? ("enabled" as const) : ("disabled" as const) }
            : { valueAfter: String(value) }),
        },
        failureStage: "local_commit",
      });
    },
    [setCodePreviewSettings],
  );
  const activeSectionMeta = settingsSections.find((section) => section.id === activeSection);
  // 灰度裁决异步到达：sections 列表可能在挂载后变化（如 computerUse 区被灰度移除）。
  // 若用户正停留在被移除的 section，回落到第一个可见区，避免整页 return null。
  useEffect(() => {
    setActiveSection((current) => resolveSettingsSectionForPlatform(current, settingsSections));
  }, [settingsSections]);
  if (!activeSectionMeta) {
    return null;
  }

  const activeSectionLabel = intl.formatMessage({
    id: activeSectionMeta.contentTitleId ?? activeSectionMeta.titleId,
  });
  const settingsBreadcrumbSectionLabel =
    activeSection === "plugin" && pluginNavigationOrigin === "plugin-store"
      ? intl.formatMessage({ id: "workspace.openPluginsSettings" })
      : activeSectionLabel;
  const visibleSettingsBreadcrumbItems =
    settingsBreadcrumbItems[0]?.label === settingsBreadcrumbSectionLabel
      ? settingsBreadcrumbItems
      : [];
  const hasVisibleSettingsBreadcrumb = visibleSettingsBreadcrumbItems.length >= 2;
  const showActiveSectionTitle =
    !hasVisibleSettingsBreadcrumb ||
    (activeSection === "plugin" && pluginNavigationOrigin === "plugin-store");

  const renderSettingsSection = (sectionId: SettingsSectionId): ReactNode =>
    sectionId === "general" ? (
      <GeneralSectionContent
        localePreference={localePreference}
        interfaceMode={interfaceMode}
        setInterfaceMode={setInterfaceMode}
        isDesktop={isDesktop}
        isWindowsDesktop={isWindowsDesktop}
        isLinuxDesktop={isLinuxDesktop}
        linuxCloseToTray={linuxCloseToTray}
        platform={platform}
        notificationEnabled={notificationEnabled}
        notificationSoundEnabled={notificationSoundEnabled}
        closeToTrayOnWindows={closeToTrayOnWindows}
        keepAwakeWhileRunning={sharedSettings?.keepAwakeWhileRunning ?? false}
        desktopChromiumHardwareAccelerationEnabled={desktopChromiumHardwareAccelerationEnabled}
        receivePreviewUpdates={receivePreviewUpdates}
        autoDownloadAndInstallUpdates={autoDownloadAndInstallUpdates}
        dataBaseDir={dataBaseDir}
        terminalInheritSystemProfile={terminalInheritSystemProfile}
        terminalFontFamily={terminalFontFamily}
        integratedTerminalShell={integratedTerminalShell}
        integratedTerminalShellOptions={integratedTerminalShellOptions}
        httpProxyMode={httpProxyMode}
        httpProxy={httpProxy}
        httpProxyNoProxy={httpProxyNoProxy}
        httpProxyCaCertPath={httpProxyCaCertPath}
        defaultHomeDir={defaultHomeDir}
        showIntegratedTerminalShell={hostPlatform === "win32"}
        setLocalePreference={handleFooterLocaleChange}
        setNotificationEnabled={(enabled) =>
          runUserAction({
            input: {
              featureId: "settings.notification",
              action: "toggle_notification",
              trigger: "switch",
            },
            operation: () => setNotificationEnabled(enabled),
            completed: {
              resultSource: "local_commit",
              stateAfter: enabled ? "enabled" : "disabled",
            },
            failureStage: "local_commit",
          })
        }
        setNotificationSoundEnabled={(enabled) =>
          runUserAction({
            input: {
              featureId: "settings.notification",
              action: "toggle_notification_sound",
              trigger: "switch",
            },
            operation: () => setNotificationSoundEnabled(enabled),
            completed: {
              resultSource: "local_commit",
              stateAfter: enabled ? "enabled" : "disabled",
            },
            failureStage: "local_commit",
          })
        }
        toolGroupingExploreEnabled={toolGroupingExploreEnabled}
        toolGroupingTerminalEnabled={toolGroupingTerminalEnabled}
        toolGroupingChangesEnabled={toolGroupingChangesEnabled}
        onDataBaseDirChange={handleDataBaseDirChange}
        onSelectDataBaseDir={selectDirectory}
        onTerminalInheritSystemProfileChange={handleTerminalInheritSystemProfileChange}
        onTerminalFontFamilyChange={handleTerminalFontFamilyChange}
        onIntegratedTerminalShellChange={handleIntegratedTerminalShellChange}
        onHttpProxyModeChange={handleHttpProxyModeChange}
        onHttpProxyChange={handleHttpProxyChange}
        onHttpProxyNoProxyChange={handleHttpProxyNoProxyChange}
        onHttpProxyCaCertPathChange={handleHttpProxyCaCertPathChange}
        onCloseToTrayOnWindowsChange={handleCloseToTrayOnWindowsChange}
        onKeepAwakeWhileRunningChange={handleKeepAwakeWhileRunningChange}
        onDesktopChromiumHardwareAccelerationChange={
          handleDesktopChromiumHardwareAccelerationChange
        }
        onReceivePreviewUpdatesChange={handleReceivePreviewUpdatesChange}
        onAutoDownloadAndInstallUpdatesChange={handleAutoDownloadAndInstallUpdatesChange}
        onToolGroupingExploreEnabledChange={handleToolGroupingExploreEnabledChange}
        onToolGroupingTerminalEnabledChange={handleToolGroupingTerminalEnabledChange}
        onToolGroupingChangesEnabledChange={handleToolGroupingChangesEnabledChange}
        onOpenOnboardingDialog={() =>
          runUserAction({
            input: {
              featureId: "settings.navigation",
              action: "open_onboarding",
              trigger: "button",
            },
            operation: requestOnboardingDialog,
            completed: { resultSource: "local_commit" },
            failureStage: "dialog_open",
          })
        }
      />
    ) : sectionId === "agentBehavior" ? (
      <AgentBehaviorSectionContent
        toolSearchMode={toolSearchMode}
        onToolSearchModeChange={handleToolSearchModeChange}
        nativeSearchEnhancementsEnabled={nativeSearchEnhancementsEnabled}
        nibiInteractionBehavior={nibiInteractionBehavior}
        askUserQuestionAutoResolutionEnabled={askUserQuestionAutoResolutionEnabled}
        modelIoFullRetentionEnabled={modelIoFullRetentionEnabled}
        messageStreamShowReasoning={messageStreamShowReasoning}
        messageStreamShowTodos={messageStreamShowTodos}
        onNativeSearchEnhancementsEnabledChange={handleNativeSearchEnhancementsEnabledChange}
        onNibiInteractionBehaviorChange={handleNibiInteractionBehaviorChange}
        onAskUserQuestionAutoResolutionEnabledChange={
          handleAskUserQuestionAutoResolutionEnabledChange
        }
        onModelIoFullRetentionEnabledChange={handleModelIoFullRetentionEnabledChange}
        onMessageStreamShowReasoningChange={handleMessageStreamShowReasoningChange}
        onMessageStreamShowTodosChange={handleMessageStreamShowTodosChange}
      />
    ) : sectionId === "remoteDevices" ? (
      sharedSettings && isDesktop && sourceManagement ? (
        <SourceServerManagementPanel
          key={`remote:${settingsSectionNavigationVersion}`}
          active={activeSection === "remoteDevices"}
          targetSourceServerId={targetSourceServerId}
          targetSourceServerDetails={targetSourceServerDetails}
          onTargetSourceServerFocused={() => {
            setTargetSourceServerId(undefined);
            setTargetSourceServerDetails(false);
          }}
          management={sourceManagement}
          onCreateConnection={
            onOpenRemoteWorkspace
              ? () => onOpenRemoteWorkspace({ completion: "device-management" })
              : undefined
          }
          onConnectProfile={
            remoteWorkspaceController
              ? (profileId) =>
                  remoteWorkspaceController.dispatch({
                    type: "connect-device",
                    profileId,
                    effect: "device-management",
                  })
              : onOpenRemoteWorkspace
                ? (profileId) =>
                    onOpenRemoteWorkspace({
                      preferredProfileId: profileId,
                      completion: "device-management",
                    })
                : undefined
          }
          onDisconnectSource={
            remoteWorkspaceController
              ? (sourceServerId) =>
                  remoteWorkspaceController.dispatch({
                    type: "disconnect-device",
                    sourceServerId,
                  })
              : undefined
          }
          onOpenProject={
            onOpenRemoteWorkspace
              ? async (sourceServerId, path, profileId) => {
                  // 仅传目录会被 Root 当成新建；复用侧栏唯一目录 owner，同步固定原入口。
                  const preference =
                    projectDirectory &&
                    resolveRecentRemoteProjectPreference(projectDirectory.directory, {
                      sourceServerId,
                      path,
                      profileId,
                    });
                  if (!preference) {
                    throw Object.assign(new Error("remote-project.entry-not-found"), {
                      code: "recent-project-unresolved",
                    });
                  }
                  onBack?.();
                  onOpenRemoteWorkspace(preference);
                }
              : undefined
          }
          onShowUpdateDetails={(sourceServerId) => {
            setPendingSettingsSectionIntent("remoteDevices", {
              sourceServerId,
              sourceServerDetails: true,
            });
            openSettingsTab();
          }}
          workspaceTabs={workspaceTabs}
          onShowInSidebar={(sourceServerId) => {
            const target = workspaceTabs.find(
              (tab) =>
                getWorkspaceSourceServerId(tab, {
                  workspaceHistory: sourceManagementSnapshot?.workspaceHistory,
                }) === sourceServerId,
            );
            onBack?.();
            if (target) {
              activateTab(target.id);
              requestAnimationFrame(() => {
                const row = Array.from(
                  document.querySelectorAll<HTMLElement>("[data-remote-project-identity]"),
                ).find(
                  (element) => element.dataset.remoteProjectIdentity === target.workspaceIdentity,
                );
                row?.scrollIntoView({ block: "center" });
                row?.querySelector<HTMLElement>('[role="button"]')?.focus({ preventScroll: true });
              });
            }
          }}
          settings={sharedSettings}
          onUpdateSettings={updateSharedSettings}
        />
      ) : (
        <p className="text-ui-sm text-remote-foreground-muted">
          {intl.formatMessage({
            id: sharedSettings ? "settings.source.empty" : "common.loading",
          })}
        </p>
      )
    ) : sectionId === "dataSync" ? (
      isDesktop ? (
        <DataSyncSettingsEntry
          key={`dataSync:${settingsSectionNavigationVersion}`}
          devices={dataSyncDevices.devices}
          initialCategory={dataSyncCategoryTarget}
          onConnectDevice={handleConnectDataSyncDevice}
        />
      ) : null
    ) : sectionId === "appearance" ? (
      <AppearanceSectionContent
        codePreviewSettings={codePreviewSettings}
        setCodePreviewSettings={handleCodePreviewSettingsChange}
        theme={theme}
        setTheme={(nextTheme) => handleFooterThemeChange(nextTheme)}
        motionEnabled={motionEnabled}
        setMotionEnabled={(enabled) =>
          runUserAction({
            input: {
              featureId: "settings.appearance",
              action: "toggle_motion",
              trigger: "switch",
            },
            operation: () => persistMotionEnabled(enabled),
            completed: {
              resultSource: "local_commit",
              stateAfter: enabled ? "enabled" : "disabled",
            },
            failureStage: "local_commit",
          })
        }
        isMacDesktop={Boolean(isMacDesktop)}
        macFontSmoothingEnabled={macFontSmoothingEnabled}
        setMacFontSmoothingEnabled={setMacFontSmoothingEnabled}
        uiFontSizePx={uiFontSizePx}
        setUiFontSizePx={(fontSizePx) =>
          runUserAction({
            input: {
              featureId: "settings.appearance",
              action: "change_ui_font_size",
              trigger: "keyboard",
            },
            operation: () => setUiFontSizePx(fontSizePx),
            completed: {
              resultSource: "local_commit",
              valueAfter: String(fontSizePx),
            },
            failureStage: "local_commit",
          })
        }
      />
    ) : sectionId === "shortcuts" ? (
      <ShortcutSettingsSection isDesktop={Boolean(isDesktop)} />
    ) : sectionId === "modelProvider" ? (
      <ServiceProvider services={localHostServices}>
        {/* 模型配置属于本机全局事实源；激活远端 workspace 时也不能注入远端 Host。 */}
        <ModelProviderSection
          workspacePath={activeWorkspacePath ?? captionWorkspacePath ?? ""}
          connectivityWorkspacePath={localModelProviderConnectivityWorkspacePath}
          connectivityWorkspaceRequired={isRemoteModelProviderWorkspace}
          pendingModelProviderTarget={pendingModelProviderTarget}
          onConsumePendingModelProviderTarget={() => setPendingModelProviderTarget(undefined)}
        />
      </ServiceProvider>
    ) : sectionId === "personalization" ? (
      <ServiceProvider services={localHostServices}>
        {/* 用户级 AGENTS.md 属于本机 Host；远端设备的同名文件在设备侧单独配置。 */}
        <PersonalizationSection />
      </ServiceProvider>
    ) : sectionId === "memory" ? (
      <ServiceProvider services={localHostServices}>
        {/* Memory catalog 始终使用本地 Host，避免远程 workspace 误读本机数据。 */}
        <MemorySettingsSection
          memoryEnabled={memoryEnabled}
          memoryService={localHostServices.memoryService}
          onMemoryEnabledChange={handleMemoryEnabledChange}
          projectMemoryViewerAvailable={Boolean(isDesktop)}
          workspaceDisplayNames={memoryWorkspaceDisplayNames}
        />
      </ServiceProvider>
    ) : sectionId === "plugin" ? (
      <PluginsSection
        key={`plugin:${settingsSectionNavigationVersion}`}
        active={activeSection === "plugin"}
        isDesktop={Boolean(isDesktop)}
        isMacDesktop={Boolean(isMacDesktop)}
        isWindowsDesktop={Boolean(isWindowsDesktop)}
        isWebRemoteControl={isWebRemoteControl}
        initialTab={pluginTab}
        initialScopeKey={pluginScopeKey}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        showMarketplaceBreadcrumb={pluginNavigationOrigin === "plugin-store"}
        onCreateTask={onCreateTask}
        onOpenPluginStore={(_returnScopeKey, intent) => {
          // 添加市场与浏览插件都先离开设置层，再显示商店。
          requestPluginStoreOpen({ returnScopeKey: "user", intent });
          onBack?.();
        }}
      />
    ) : sectionId === "mcp" ? (
      <PluginsSection
        key={`mcp:${settingsSectionNavigationVersion}`}
        active={activeSection === "mcp"}
        mode="mcp"
        isWebRemoteControl={isWebRemoteControl}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        onCreateTask={onCreateTask}
        onOpenPluginStore={(_returnScopeKey, intent) => {
          // 添加市场与浏览插件都先离开设置层，再显示商店。
          requestPluginStoreOpen({ returnScopeKey: "user", intent });
          onBack?.();
        }}
      />
    ) : sectionId === "skill" ? (
      <PluginsSection
        key={`skill:${settingsSectionNavigationVersion}`}
        active={activeSection === "skill"}
        mode="skill"
        isWebRemoteControl={isWebRemoteControl}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        onCreateTask={onCreateTask}
        onOpenPluginStore={(_returnScopeKey, intent) => {
          // 添加市场与浏览插件都先离开设置层，再显示商店。
          requestPluginStoreOpen({ returnScopeKey: "user", intent });
          onBack?.();
        }}
      />
    ) : sectionId === "migration" ? (
      <MigrationSection
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        isDesktop={isDesktop}
      />
    ) : sectionId === "archives" ? (
      <div className="min-w-0 space-y-6">
        <TaskAutoArchiveSettings
          taskAutoArchiveEnabled={taskAutoArchiveEnabled}
          taskAutoArchiveOlderThanDays={taskAutoArchiveOlderThanDays}
          onTaskAutoArchiveEnabledChange={handleTaskAutoArchiveEnabledChange}
          onTaskAutoArchiveOlderThanDaysChange={handleTaskAutoArchiveOlderThanDaysChange}
        />
        <ArchiveManagement />
      </div>
    ) : sectionId === "usage" ? (
      <UsageStatsSection />
    ) : sectionId === "projects" ? (
      <ProjectsSection isDesktop={Boolean(isDesktop)} />
    ) : sectionId === "subagents" ? (
      <SubagentsSection
        onManageModels={handleOpenModelProviderSettings}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
      />
    ) : sectionId === "automations" ? (
      <AutomationsSection
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
      />
    ) : sectionId === "commands" ? (
      <PluginsSection
        active={activeSection === "commands"}
        mode="command"
        isWebRemoteControl={isWebRemoteControl}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        onCreateTask={onCreateTask}
        onOpenPluginStore={(_returnScopeKey, intent) => {
          // 添加市场与浏览插件都先离开设置层，再显示商店。
          requestPluginStoreOpen({ returnScopeKey: "user", intent });
          onBack?.();
        }}
      />
    ) : sectionId === "hooks" ? (
      <HooksSection
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
      />
    ) : sectionId === "workspaceFileSearch" ? (
      <WorkspaceFileSearchSection
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
      />
    ) : sectionId === "browser" ? (
      <BrowserSettingsSection
        isDesktop={Boolean(isDesktop)}
        isWindowsDesktop={isWindowsDesktop}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        embeddedBrowserAllowInsecureCertificates={embeddedBrowserAllowInsecureCertificates}
        onEmbeddedBrowserAllowInsecureCertificatesChange={
          handleEmbeddedBrowserAllowInsecureCertificatesChange
        }
        fileTreeHtmlClickOpensBrowser={fileTreeHtmlClickOpensBrowser}
        onFileTreeHtmlClickOpensBrowserChange={handleFileTreeHtmlClickOpensBrowserChange}
      />
    ) : sectionId === "computerUse" ? (
      <ComputerUseSection
        isDesktop={Boolean(isDesktop)}
        isMacDesktop={Boolean(isMacDesktop)}
        isWindowsDesktop={Boolean(isWindowsDesktop)}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        remoteSessionId={activeWorkspaceTab?.remoteSessionId}
        remoteTarget={activeWorkspaceTab?.remoteTarget}
        localWorkspacePath={activeWorkspaceTab?.localWorkspacePath}
      />
    ) : null;

  return (
    <>
      <DesktopWindowFrame
        title={intl.formatMessage({ id: "settings.title" })}
        isDesktop={isDesktop}
        isMacDesktop={isMacDesktop}
        isWindowsDesktop={isWindowsDesktop}
      >
        <div
          ref={settingsPageRef}
          data-testid={TID_SETTINGS_PAGE}
          data-active-section={activeSection}
          // 隐式 auto 行会按 Memory viewer 的内容高度撑出窗口，随后被 DesktopWindowFrame 裁切且没有滚动条。
          // 固定为单个 minmax(0, 1fr) 行，让普通设置页和内部滚动 viewer 都以窗口剩余高度为边界。
          className={SETTINGS_PAGE_LAYOUT_CLASSNAME}
        >
          {isWindowsDesktop ? <WindowsTopLeftLogo /> : null}

          {usesInlineWindowControls ? (
            <div
              className={cn(
                "absolute z-30 mt-px mr-px flex h-12 items-center px-2 pointer-events-auto [app-region:no-drag]",
                // 外沿留白变化后，悬浮窗控组也必须同步，保持与系统面板留白一致。
                isWindowsDesktop ? "right-1.5 top-1.5" : "right-1 top-1",
              )}
            >
              <DesktopWindowControls />
            </div>
          ) : null}
          {/* 手机窄屏 Web 下 68px 图标栏会挤占内容宽度，compact-web 下改成顶部横向滚动导航条。
              spec：docs/settings-narrow-layout.md */}
          <aside className="min-w-0">
            <div className="flex h-full flex-col compact-web:flex-row compact-web:items-center">
              <div className="h-12 [app-region:drag] compact-web:hidden"></div>
              <div className="px-2 pb-3 pt-3 compact-web:shrink-0 compact-web:py-1.5 compact-web:pr-0">
                {onBack ? (
                  <ControlHintTooltip
                    title={intl.formatMessage({
                      id: "workspace.backToWorkspace",
                    })}
                    side="right"
                    align="center"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="lg"
                      data-testid={TID_SETTINGS_BACK_BUTTON}
                      aria-label={intl.formatMessage({
                        id: "workspace.backToWorkspace",
                      })}
                      className="mx-1 my-0.5 w-[calc(100%-0.5rem)] justify-start gap-2 rounded-xl border border-transparent bg-transparent px-2.5 text-remote-foreground-muted hover:border-border/55 hover:bg-card/75 hover:text-foreground max-lg:m-1 max-lg:size-10 max-lg:justify-center max-lg:px-0"
                      onClick={() => {
                        runUserAction({
                          input: {
                            featureId: "settings.navigation",
                            action: "back_to_workspace",
                            trigger: "button",
                          },
                          operation: () => {
                            if (pluginNavigationOrigin === "plugin-store") {
                              requestPluginStoreOpen("user");
                            }
                            onBack?.();
                          },
                          completed: { resultSource: "local_commit" },
                          failureStage: "navigation_commit",
                        });
                      }}
                    >
                      <ArrowLeft className="size-4" />
                      <span className="max-lg:sr-only">
                        {intl.formatMessage({
                          id: "workspace.backToWorkspace",
                        })}
                      </span>
                    </Button>
                  </ControlHintTooltip>
                ) : null}
              </div>

              <div className="px-2 pb-2 compact-web:shrink-0 compact-web:px-1 compact-web:pb-0">
                <SettingsSearch
                  settingsSections={settingsSections}
                  isDesktop={Boolean(isDesktop)}
                  isMacDesktop={Boolean(isMacDesktop)}
                  isWindowsDesktop={Boolean(isWindowsDesktop)}
                  isLinuxDesktop={isLinuxDesktop}
                  onNavigate={handleSettingsSearchNavigate}
                />
              </div>

              <nav
                ref={settingsNavRef}
                aria-label={intl.formatMessage({ id: "settings.navLabel" })}
                className={SETTINGS_NAV_CLASSNAME}
              >
                <div className={SETTINGS_NAV_LIST_CLASSNAME}>
                  {settingsSectionGroups.map((group, groupIndex) => {
                    const groupLabel = intl.formatMessage({
                      id: group.titleId,
                    });
                    const groupLabelId = `settings-sidebar-group-${group.id}`;

                    return (
                      <div
                        key={group.id}
                        role="group"
                        aria-labelledby={groupLabelId}
                        className={cn(
                          "space-y-1 compact-web:flex compact-web:shrink-0 compact-web:items-center compact-web:gap-1 compact-web:space-y-0",
                          groupIndex > 0 &&
                            "border-t border-border/45 pt-3 max-lg:border-t max-lg:border-border max-lg:pt-3 compact-web:border-t-0 compact-web:border-l compact-web:pt-0 compact-web:pl-2",
                        )}
                      >
                        <div
                          id={groupLabelId}
                          className="px-2.5 pb-1 text-ui-xs font-semibold tracking-wider text-remote-foreground-muted max-lg:sr-only"
                        >
                          {groupLabel}
                        </div>
                        {group.sections
                          .filter(({ id }) => isSettingsSectionAvailable(id, Boolean(isDesktop)))
                          .map(({ id, icon: Icon, titleId }) => {
                            const isActive = activeSection === id;
                            const label = intl.formatMessage({ id: titleId });

                            return (
                              <SettingsSidebarButton
                                key={id}
                                icon={Icon}
                                label={label}
                                active={isActive}
                                aria-current={isActive ? "page" : undefined}
                                data-testid={testId(TID_SETTINGS_SECTION_NAV, id)}
                                data-settings-section-nav={id}
                                onClick={() => {
                                  runUserAction({
                                    input: {
                                      featureId: "settings.navigation",
                                      action: "open_section",
                                      trigger: "button",
                                    },
                                    operation: () => {
                                      setPluginNavigationOrigin(undefined);
                                      setTargetSourceServerId(undefined);
                                      setDataSyncCategoryTarget(undefined);
                                      // 正常切换分区不 bump key：保活分区不能被重建。
                                      // 再次点击当前分区仍视为一次显式重入，保留原有的
                                      // New/Edit/Detail 子状态重置语义。
                                      if (id === activeSection) {
                                        setSettingsSectionNavigationVersion(
                                          (version) => version + 1,
                                        );
                                      }
                                      setActiveSettingsSection(id);
                                    },
                                    completed: { resultSource: "local_commit", sectionId: id },
                                    failureStage: "navigation_commit",
                                  });
                                }}
                              >
                                <span className="flex min-w-0 flex-1 items-center gap-2">
                                  <span className="truncate text-ui-base">{label}</span>
                                  {id === "remoteDevices" ? (
                                    <RemoteConnectionNavigationDot
                                      presentation={remoteDevicesPresentation}
                                    />
                                  ) : null}
                                </span>
                              </SettingsSidebarButton>
                            );
                          })}
                      </div>
                    );
                  })}
                </div>
              </nav>

              <div className="max-lg:hidden">
                <WorkspaceSidebarFooter
                  theme={theme}
                  localeMenuValue={localePreference}
                  onLocaleChange={handleFooterLocaleChange}
                  onThemeChange={handleFooterThemeChange}
                  onSettingsButtonClick={onBack}
                  onUsageClick={handleOpenUsageSettings}
                  onLogin={onLogin}
                  onLogout={onLogout}
                  settingsButtonMode="back"
                  user={user}
                  // 头像菜单是 WorkspaceSidebarFooter 的共享菜单，Settings 场景不能丢失桌面平台能力。
                  // 之前这里没透传 isDesktop，导致同一个头像菜单在设置页缺少界面缩放入口。
                  isDesktop={isDesktop}
                />
              </div>
            </div>
          </aside>

          <section
            data-settings-content-frame="true"
            className={cn(
              "flex min-h-0 flex-col",
              // 桌面平台统一复用主工作区的面板 inset；左侧仍与导航相接，顶部由独立拖拽留白承接。
              isDesktop ? (isWindowsDesktop ? "pr-1.5 pb-1.5" : "pr-1 pb-1") : "p-0",
            )}
          >
            <div
              data-settings-top-inset={isDesktop ? "true" : undefined}
              // 下方面板使用 h-full；顶部留白不能参与 flex 收缩，否则 6px 会变成小数像素。
              className={cn(
                "shrink-0 [app-region:drag]",
                isDesktop && (isWindowsDesktop ? "h-1.5" : "h-1"),
                isMacDesktop && "max-lg:h-16",
              )}
            />
            <div
              data-settings-panel-frame="true"
              className={cn(
                "nibi-atelier-panel relative flex flex-col min-h-0 h-full overflow-hidden border border-border bg-background",
                // 直接写像素圆角会绕过设计 token；设置页与工作区统一复用 rounded-md（默认 6px）。
                isWindowsDesktop ? "rounded-md" : "rounded-xl",
              )}
            >
              <SettingsBreadcrumbProvider
                onItemsChange={setSettingsBreadcrumbItems}
                sectionLabel={settingsBreadcrumbSectionLabel}
              >
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="flex h-12 shrink-0">
                    <div
                      // Settings 窄布局会像左侧导航一样在 max-lg 收成 icon rail。
                      // 此时外层已经提供 max-lg:h-16 的顶部拖拽/避让区，内层 h-10 再保留会把内容额外压低。
                      // Electron 的 drag 区不能和右上角窗口按钮命中区域重叠；
                      // 这里把右侧窗控按钮区域从拖拽条里让出来，避免真实鼠标点击被标题栏拖拽吞掉。
                      className={cn(
                        "min-w-0 flex-1 [app-region:drag]",
                        // 三个 28px 窗控按钮、组内 2px 间距和左右 8px padding，共 104px（mr-26）。
                        usesInlineWindowControls && "mr-26",
                      )}
                    >
                      <SettingsHeaderBreadcrumb
                        ariaLabel={intl.formatMessage({
                          id: "settings.breadcrumbLabel",
                        })}
                        items={visibleSettingsBreadcrumbItems}
                      />
                    </div>
                  </div>
                  <SettingsMachinesProvider servers={sourceManagementSnapshot?.servers ?? []}>
                    <main className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
                      <div
                        className={cn(
                          SETTINGS_FRAME_CONTENT_CLASSNAME,
                          "flex flex-col gap-8",
                          isMacDesktop && "pt-0",
                          // isWindowsDesktop && "pt-12",
                        )}
                      >
                        {/* 归档设置迁入后也需要公共页头，不能再因列表自带标题而隐藏页面标题。 */}
                        <div
                          className="border-b border-border/55 pb-5"
                          data-settings-search-target={`section:${activeSection}`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-3">
                            <div className="flex min-w-0 flex-wrap items-center gap-3">
                              {showActiveSectionTitle ? (
                                <h2 className="font-display text-ui-settings-title font-semibold tracking-tight text-foreground lg:text-ui-settings-title-lg">
                                  {activeSectionLabel}
                                </h2>
                              ) : null}
                              {!hasVisibleSettingsBreadcrumb && activeSectionMeta.titleBadgeId ? (
                                <span className="inline-flex h-6 items-center rounded-md border border-border px-2 text-ui-xs font-semibold tracking-normal text-foreground">
                                  {intl.formatMessage({
                                    id: activeSectionMeta.titleBadgeId,
                                  })}
                                </span>
                              ) : null}
                            </div>
                            {activeSection === "dataSync" && isDesktop ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="lg"
                                onClick={() => setDataSyncMigrationOpen(true)}
                                data-testid="settings-data-sync-migrate"
                              >
                                <ArrowRightLeft className="size-4" aria-hidden="true" />
                                {intl.formatMessage({
                                  id: "settings.dataSync.migrationAction",
                                })}
                              </Button>
                            ) : null}
                          </div>
                          {activeSection === "dataSync" ? (
                            <div className="mt-2 flex items-center gap-1.5 text-ui-base text-foreground-subtle">
                              <span>
                                {intl.formatMessage({
                                  id: "settings.dataSync.headerDescription",
                                })}
                              </span>
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      type="button"
                                      className="inline-flex size-5 items-center justify-center rounded-md text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground"
                                      aria-label={intl.formatMessage({
                                        id: "settings.dataSync.helpLabel",
                                      })}
                                    >
                                      <Info className="size-3.5" aria-hidden="true" />
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top" align="start" className="max-w-sm">
                                    {intl.formatMessage({
                                      id: "settings.dataSync.category.description",
                                    })}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            </div>
                          ) : null}
                        </div>
                        <div className="space-y-8">
                          {/* 当前分区放最后：space-y 只给非末位子元素加底边距，
                              隐藏的保活分区不吃布局；顺序变化由 key 保持状态。 */}
                          {retainedSettingsSections.toReversed().map((section) => (
                            <SettingsSectionPane
                              key={section}
                              section={section}
                              active={section === activeSection}
                            >
                              {renderSettingsSection(section)}
                            </SettingsSectionPane>
                          ))}
                        </div>
                      </div>
                    </main>
                  </SettingsMachinesProvider>
                </div>
              </SettingsBreadcrumbProvider>
            </div>
          </section>
        </div>
        {/* 迁移弹窗：六步向导复用首启的会话/外部导入/AGENTS.md 能力，并按步骤接真实扫描与导入。 */}
        <MigrationWizardDialog
          open={dataSyncMigrationOpen}
          onOpenChange={setDataSyncMigrationOpen}
          workspacePath={activeWorkspacePath ?? captionWorkspacePath ?? null}
          workspaceIdentity={activeWorkspaceIdentity}
          isDesktop={isDesktop}
        />
      </DesktopWindowFrame>
    </>
  );
}
