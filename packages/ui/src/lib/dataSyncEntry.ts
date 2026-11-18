import type { RemoteTarget } from "@nibi/shared";
import {
  setPendingSettingsSectionIntent,
  type SettingsDataSyncCategoryTarget,
} from "@/lib/settingsNavigation.js";

export type DataSyncEntryClientMode = "desktop-continuous" | "web-remote-replayable";

/**
 * 远端同步入口的统一可见性。
 *
 * 根因：旧实现按 SSH/WSL 弹窗能力分别判断入口，导致设置页、工作区头部和项目侧栏
 * 各自维护一套条件，最终又各自打开不同的同步弹窗。现在数据同步只有设置页一个页面，
 * 入口只判断「是否有可操作的远端会话」和「本机是否具备源服务」。
 */
export function shouldShowDataSyncEntry(params: {
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  clientMode?: DataSyncEntryClientMode;
  hasLocalSourceService?: boolean;
}): boolean {
  // Web 远控只回放远端画面，不能申请 source-settings attachment，也无法写入本机配置。
  if (params.clientMode === "web-remote-replayable") {
    return false;
  }
  if (params.hasLocalSourceService === false) {
    return false;
  }
  return Boolean(params.remoteSessionId?.trim() && params.remoteTarget);
}

/**
 * 窗口级 provider 不可用时的回退：发设置分区意图，落到设置页的数据同步入口。
 * 桌面窗口由 `useOpenDataSyncSettings` 直接打开 DataSyncDialogProvider 的弹窗；
 * 这里仍只负责导航意图，不接触同步服务，避免出现第二条写入路径。
 */
export function openDataSyncSettings(category?: SettingsDataSyncCategoryTarget): void {
  setPendingSettingsSectionIntent(
    "dataSync",
    category ? { dataSyncCategory: category } : {},
  );
}
