import { createPortal } from "react-dom";
import { Minus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import type { DataSyncCategoryId } from "@/data-sync/contract.js";
import { categoryLabel } from "@/data-sync/ui/DataSyncLabels.js";

export interface DataSyncMinimizedProgressProps {
  deviceName: string;
  pushing: boolean;
  failed: boolean;
  finished: boolean;
  /** 当前或上次推送分类；概览「推送全部」为空。 */
  category?: DataSyncCategoryId;
  /** 当前分类的待写入数（推送中）或最近一次推送汇总。 */
  pendingCount?: number;
  succeeded?: number;
  failedCount?: number;
  skipped?: number;
  onRestore(): void;
}

/**
 * 非模态状态条始终挂在窗口根部，不受设置页滚动容器或页面卸载影响。
 * 点击整条恢复同一个弹窗实例；在途推送由 provider 持有，不因最小化中断。
 */
export function DataSyncMinimizedProgress({
  deviceName,
  pushing,
  failed,
  finished,
  category,
  pendingCount,
  succeeded = 0,
  failedCount = 0,
  skipped = 0,
  onRestore,
}: DataSyncMinimizedProgressProps) {
  const { intl } = useNibiIntl();
  const status = pushing
    ? "settings.dataSync.minimized.pushing"
    : failed
      ? "settings.dataSync.minimized.failed"
      : finished
        ? "settings.dataSync.minimized.finished"
        : "settings.dataSync.minimized.restore";
  const categoryText = category ? categoryLabel(intl, category) : undefined;
  const progress = pushing
    ? category
      ? intl.formatMessage(
          { id: "settings.dataSync.category.selection.count" },
          { count: pendingCount ?? 0 },
        )
      : intl.formatMessage({ id: "settings.dataSync.overview.pushingAll" })
    : finished
      ? intl.formatMessage(
          { id: "settings.dataSync.push.summary" },
          { succeeded, failed: failedCount, skipped },
        )
      : undefined;

  return createPortal(
    <button
      type="button"
      data-testid="data-sync-minimized-progress"
      onClick={onRestore}
      aria-label={intl.formatMessage({ id: "settings.dataSync.minimized.restore" })}
      className="fixed right-4 bottom-4 left-4 z-50 flex items-center gap-3 rounded-xl border border-popover-border bg-popover px-4 py-3 text-left text-foreground shadow-md sm:left-auto sm:max-w-sm [app-region:no-drag]"
    >
      <RefreshCw className={cn("size-4 shrink-0", pushing && "animate-spin")} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui-base font-medium">
          {intl.formatMessage({ id: "settings.dataSync.title" })} · {deviceName}
        </span>
        <span className="block text-ui-sm text-foreground-subtle" role="status">
          {intl.formatMessage({ id: status })}
        </span>
        {categoryText || progress ? (
          <span className="block truncate text-ui-xs text-foreground-subtle">
            {[categoryText, progress].filter(Boolean).join(" · ")}
          </span>
        ) : null}
      </span>
    </button>,
    document.body,
  );
}

/** 弹窗右上角的最小化按钮；推送中仍可最小化，写入不中断。 */
export function DataSyncMinimizeButton({ onMinimize }: { onMinimize(): void }) {
  const { intl } = useNibiIntl();
  const label = intl.formatMessage({ id: "settings.dataSync.dialog.minimize" });
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      data-testid="data-sync-minimize"
      className="absolute top-4 right-12 z-20 hover:bg-surface-hover"
      title={label}
      aria-label={label}
      onClick={onMinimize}
    >
      <Minus aria-hidden="true" />
    </Button>
  );
}
