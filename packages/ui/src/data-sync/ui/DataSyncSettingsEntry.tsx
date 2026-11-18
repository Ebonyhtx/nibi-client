import { UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import type { DataSyncCategoryId, DataSyncDevice } from "@/data-sync/contract.js";
import { useOpenDataSyncDialog } from "@/data-sync/ui/DataSyncDialogContext.js";
import { DataSyncEmptyState } from "@/data-sync/ui/DataSyncSectionView.js";

/**
 * 设置页的数据同步入口。
 *
 * 同步页不再内联在设置滚动容器里：点击只打开窗口级弹窗，离开设置页或最小化都不会
 * 卸载在途推送。`initialCategory` 仍由旧导航意图传入，用来定位弹窗初始分类。
 */
export function DataSyncSettingsEntry({
  devices,
  initialCategory,
  onConnectDevice,
}: {
  devices: readonly DataSyncDevice[];
  initialCategory?: DataSyncCategoryId;
  /** 空态「连接设备」：沿用设置页现有的远程连接入口。 */
  onConnectDevice?: () => void;
}) {
  const { intl } = useNibiIntl();
  const openDialog = useOpenDataSyncDialog();

  if (devices.length === 0) {
    return <DataSyncEmptyState {...(onConnectDevice ? { onConnectDevice } : {})} />;
  }

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"
      data-testid="settings-data-sync-entry"
    >
      <div className="min-w-0 space-y-1">
        <div className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.dataSync.device.label" })}
        </div>
        <p className="truncate text-ui-base text-foreground-subtle">
          {devices.map((device) => device.name).join(" · ")}
        </p>
      </div>
      <Button
        type="button"
        size="lg"
        disabled={!openDialog}
        data-testid="settings-data-sync-entry-open"
        onClick={() => openDialog?.(initialCategory ? { category: initialCategory } : {})}
      >
        <UploadCloud />
        {intl.formatMessage({ id: "settings.dataSync.actions.open" })}
      </Button>
    </div>
  );
}
