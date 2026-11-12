import { useSourceServerDisplayNames } from "@/hooks/useSourceServerDisplayNames.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { countProjectTreeUnreadTasks } from "@/project-sidebar/view.js";
import { useProjectTree } from "@/project-sidebar/useProjectTree.js";
import { useProjectSidebarPreferences } from "@/project-sidebar/useProjectSidebarPreferences.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { useTaskGroups } from "@/project-sidebar/useTaskGroups.js";
import { selectSortedProjects } from "@/project-sidebar/view.js";

function useDirectoryState(isDesktop: boolean, hideProjectRowDeviceName: boolean) {
  const result = useProjectTree(isDesktop);
  // 手机有项目目录不代表拥有 Source 管理权限；名称注册表仅在桌面订阅，手机沿用 Host 目录标签。
  const deviceNames = useSourceServerDisplayNames(isDesktop);
  const groups = useTaskGroups(result.factTree);
  const sortedProjects = useMemo(
    () => selectSortedProjects(result.factTree),
    [result.factTree.projects],
  );
  const preferences = useProjectSidebarPreferences(
    sortedProjects,
    result.loading,
    result.availability,
  );
  const projects = useMemo(() => {
    const sorted = preferences.sort(sortedProjects);
    return [...sorted.filter((p) => p.pinned), ...sorted.filter((p) => !p.pinned)];
  }, [sortedProjects, preferences.order]);
  // Context 不受消费方 memo 保护；父级更新 children 时，等价目录不能再次广播。
  return useMemo(
    () => ({
      ...result,
      preferences,
      projects,
      groups,
      deviceNames,
      // 只控制项目行文字；悬停详情仍从 deviceNames/deviceLabel 读取完整设备名。
      hideProjectRowDeviceName,
    }),
    [result, preferences, projects, groups, deviceNames, hideProjectRowDeviceName],
  );
}
const Context = createContext<ReturnType<typeof useDirectoryState> | null>(null);
/** 侧栏和 composer 共享读取与偏好，避免各自订阅后出现两份项目目录。 */
export function ProjectDirectoryProvider({
  children,
  isDesktop = false,
}: {
  children: ReactNode;
  isDesktop?: boolean;
}) {
  const existing = useContext(Context);
  return existing ? children : <DirectoryOwner isDesktop={isDesktop}>{children}</DirectoryOwner>;
}
function DirectoryOwner({ children, isDesktop }: { children: ReactNode; isDesktop: boolean }) {
  const baseServices = useBaseWorkspaceServices();
  const platform = useOptionalPlatform();
  // 测试/嵌入式装配可能没有 settingService 或 PlatformProvider；
  // 此时保持默认显示设备名，不额外发 RPC。
  if (!baseServices.settingService || !platform) {
    return (
      <DirectoryOwnerContent isDesktop={isDesktop} hideProjectRowDeviceName={false}>
        {children}
      </DirectoryOwnerContent>
    );
  }
  return (
    <SettingsAwareDirectoryOwner services={baseServices} isDesktop={isDesktop}>
      {children}
    </SettingsAwareDirectoryOwner>
  );
}

function SettingsAwareDirectoryOwner({
  services,
  children,
  isDesktop,
}: {
  services: ReturnType<typeof useBaseWorkspaceServices>;
  children: ReactNode;
  isDesktop: boolean;
}) {
  // 跟随本机 Host 设置：开关在设置页更新后，同一个 settingsService 快照会立即广播到侧栏。
  const { settings } = useSettings({ services });
  return (
    <DirectoryOwnerContent
      isDesktop={isDesktop}
      hideProjectRowDeviceName={settings?.remoteProjectRowDeviceNameHidden === true}
    >
      {children}
    </DirectoryOwnerContent>
  );
}

function DirectoryOwnerContent({
  children,
  isDesktop,
  hideProjectRowDeviceName,
}: {
  children: ReactNode;
  isDesktop: boolean;
  hideProjectRowDeviceName: boolean;
}) {
  const directory = useDirectoryState(isDesktop, hideProjectRowDeviceName);
  // 任务栏/托盘角标与侧栏蓝点同源：数权威树的未读任务（过滤与 projectHasUnread 一致）。
  // 挂在 Provider owner（Root 顶层，常驻不卸载）而不是 ProjectSidebar：侧栏卸载期间
  // 后台完成的未读变化也要同步到任务栏/托盘。嵌入 pane / 测试环境无 Provider 时跳过。
  const platform = useOptionalPlatform();
  // 任务通知开关同时门控任务栏/托盘角标：关掉通知 = 连常驻提醒一起关闭
  // （同步 0 清空角标），侧栏蓝点作为应用内状态不受影响。
  const notificationEnabled = useZCodeStoreWithDefault((state) => state.notificationEnabled, true);
  const unreadTaskCount = useMemo(
    () => countProjectTreeUnreadTasks(directory.tree),
    [directory.tree],
  );
  useEffect(() => {
    platform?.syncWindowUnreadCount(notificationEnabled ? unreadTaskCount : 0);
  }, [platform, notificationEnabled, unreadTaskCount]);
  return <Context.Provider value={directory}>{children}</Context.Provider>;
}
export function useProjectDirectory() {
  const directory = useContext(Context);
  if (!directory) throw new Error("project.directory-provider-required");
  return directory;
}

/** 嵌入式 pane 可无侧栏；完整 Shell 必须使用同一目录 owner。 */
export function useOptionalProjectDirectory() {
  return useContext(Context);
}
