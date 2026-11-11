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
 * 打开统一数据同步页。
 *
 * 根因：旧同步弹窗与数据同步页曾各自维护写入路径，插件市场重装也只能走弹窗。
 * 所有入口必须先发设置分区意图（只负责预选分类），由设置页统一挂载 DataSyncSection；
 * 入口本身不再接触同步服务，避免出现第二条写入路径。
 */
export function openDataSyncSettings(category?: SettingsDataSyncCategoryTarget): void {
  setPendingSettingsSectionIntent(
    "dataSync",
    category ? { dataSyncCategory: category } : {},
  );
}
