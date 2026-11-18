import { useCallback } from "react";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { openDataSyncSettings } from "@/lib/dataSyncEntry.js";
import { useOpenDataSyncDialog } from "@/data-sync/ui/DataSyncDialogContext.js";
import type { SettingsDataSyncCategoryTarget } from "@/lib/settingsNavigation.js";

/**
 * 组件入口：优先打开窗口级数据同步弹窗并定位分类，已有实例则恢复。
 * 没有 provider（Web 远控等）时回退到设置页数据同步入口，保持旧导航可用。
 */
export function useOpenDataSyncSettings(): (category?: SettingsDataSyncCategoryTarget) => void {
  const openDialog = useOpenDataSyncDialog();
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  return useCallback(
    (category?: SettingsDataSyncCategoryTarget) => {
      if (openDialog) {
        openDialog(category ? { category } : {});
        return;
      }
      openDataSyncSettings(category);
      openSettingsTab();
    },
    [openDialog, openSettingsTab],
  );
}
