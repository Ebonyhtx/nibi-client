import { useDataSyncSession } from "@/data-sync/app/useDataSyncSession.js";
import type { DataSyncCategoryId, DataSyncDevice } from "@/data-sync/contract.js";
import { useDataSyncResultRefresh } from "@/data-sync/ui/DataSyncDialogContext.js";
import { DataSyncEmptyState, DataSyncSectionView } from "@/data-sync/ui/DataSyncSectionView.js";

/**
 * 独立数据同步分区（保留给旧内联挂载与现有测试）。
 *
 * 设置页入口已改为 `DataSyncSettingsEntry` → 窗口级弹窗；推送状态统一由
 * `useDataSyncSession` 持有，弹窗最小化时只隐藏界面，不会丢在途推送。
 */
export function DataSyncSection({
  devices,
  initialCategory,
  onConnectDevice,
}: {
  devices: readonly DataSyncDevice[];
  /**
   * 受控初始分类：设置页入口（技能 / MCP / 插件市场重装）通过导航意图传入，
   * 页面挂载时直接落在对应分类，避免用户再手动切一次。
   */
  initialCategory?: DataSyncCategoryId;
  /** 空态「连接设备」：由设置页提供现有远程连接/设备设置入口，本模块不自己发连接请求。 */
  onConnectDevice?: () => void;
}) {
  const session = useDataSyncSession({ devices, ...(initialCategory ? { initialCategory } : {}) });
  // 推送结束后刷新一次；新挂载页面自行加载，不重复刷新。
  useDataSyncResultRefresh(session.onRefresh);

  if (devices.length === 0) {
    return <DataSyncEmptyState {...(onConnectDevice ? { onConnectDevice } : {})} />;
  }

  return (
    <DataSyncSectionView
      devices={session.devices}
      selectedDeviceId={session.selectedDeviceId}
      onSelectDevice={session.onSelectDevice}
      pagePhase={session.pagePhase}
      categories={session.categories}
      activeTab={session.activeTab}
      onSelectCategory={session.onSelectCategory}
      onRefresh={session.onRefresh}
      {...(session.attachmentError ? { attachmentError: session.attachmentError } : {})}
      onRetryAttachment={session.onRetryAttachment}
      selectedTotal={session.selectedTotal}
      canPushAll={session.canPushAll}
      pushAllRunning={session.pushAllRunning}
      {...(session.pushAllSummary ? { pushAllSummary: session.pushAllSummary } : {})}
      onSelectAllCategories={session.onSelectAllCategories}
      onClearCategorySelection={session.onClearCategorySelection}
      onPushAll={session.onPushAll}
    />
  );
}
