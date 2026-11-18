import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import type { DataSyncSessionController } from "@/data-sync/app/useDataSyncSession.js";
import {
  DataSyncMinimizeButton,
  DataSyncMinimizedProgress,
} from "@/data-sync/ui/DataSyncMinimizedProgress.js";
import { DataSyncEmptyState, DataSyncSectionView } from "@/data-sync/ui/DataSyncSectionView.js";

export interface DataSyncDialogProps {
  open: boolean;
  /** 最小化只隐藏模态内容；session 由 provider 持有，推送继续。 */
  minimized: boolean;
  onMinimizedChange(minimized: boolean): void;
  onClose(): void;
  session: DataSyncSessionController;
}

/**
 * 数据同步弹窗外壳：标题、最小化、六分类正文与状态条。
 * 推送中禁止关闭（没有全局取消），但允许最小化。
 */
export function DataSyncDialog({
  open,
  minimized,
  onMinimizedChange,
  onClose,
  session,
}: DataSyncDialogProps) {
  const { intl } = useNibiIntl();
  const pushing = session.pushing;
  const blockedClose = (event: Event) => {
    if (pushing) event.preventDefault();
  };
  const deviceName =
    session.selectedDevice?.name ??
    intl.formatMessage({ id: "settings.dataSync.device.placeholder" });
  const statusCategory = session.minimizedCategory;
  const selectedInStatusCategory = statusCategory
    ? session.categories.find((category) => category.category === statusCategory)?.selectedCount
    : undefined;
  const pendingCount = selectedInStatusCategory ?? session.selectedTotal;

  return (
    <>
      {open && minimized ? (
        <DataSyncMinimizedProgress
          deviceName={deviceName}
          pushing={pushing}
          failed={session.pushFailed}
          finished={session.pushFinished}
          {...(statusCategory ? { category: statusCategory } : {})}
          pendingCount={pendingCount}
          succeeded={session.lastPush?.succeeded ?? 0}
          failedCount={session.lastPush?.failed ?? 0}
          skipped={session.lastPush?.skipped ?? 0}
          onRestore={() => onMinimizedChange(false)}
        />
      ) : null}
      <Dialog
        open={open && !minimized}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && pushing) return;
          if (!nextOpen) onClose();
        }}
      >
        <DialogContent
          data-testid="data-sync-dialog"
          className="max-h-[calc(100vh-4rem)] max-w-4xl overflow-y-auto"
          showCloseButton={!pushing}
          onEscapeKeyDown={blockedClose}
          onInteractOutside={blockedClose}
        >
          {!minimized ? (
            <DataSyncMinimizeButton onMinimize={() => onMinimizedChange(true)} />
          ) : null}
          <DialogHeader className="pr-16">
            <DialogTitle>{intl.formatMessage({ id: "settings.dataSync.title" })}</DialogTitle>
            <DialogDescription>
              {intl.formatMessage({ id: "settings.dataSync.headerDescription" })}
            </DialogDescription>
          </DialogHeader>
          {session.devices.length === 0 ? (
            <DataSyncEmptyState />
          ) : (
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
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
