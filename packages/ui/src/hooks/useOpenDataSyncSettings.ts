import { useCallback } from "react";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { openDataSyncSettings } from "@/lib/dataSyncEntry.js";
import type { SettingsDataSyncCategoryTarget } from "@/lib/settingsNavigation.js";

/**
 * 组件入口：切到设置页的数据同步分区并预选分类。
 * 设置页已打开时 openSettingsTab 只会激活现有 tab，具体分区切换由导航事件完成。
 */
export function useOpenDataSyncSettings(): (category?: SettingsDataSyncCategoryTarget) => void {
  const openSettingsTab = useOptionalTabStore((state) => state.openSettingsTab);
  return useCallback(
    (category?: SettingsDataSyncCategoryTarget) => {
      openDataSyncSettings(category);
      openSettingsTab();
    },
    [openSettingsTab],
  );
}
