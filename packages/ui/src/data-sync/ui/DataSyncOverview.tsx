import { UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { DataSyncCategoryController } from "@/data-sync/app/useDataSyncCategory.js";
import type {
  DataSyncCategoryId,
  DataSyncCategoryPushResult,
  DataSyncPushAllSummary,
} from "@/data-sync/contract.js";
import {
  DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE,
  DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE,
} from "@/data-sync/contract.js";
import { hasPushAllCategoryFailure } from "@/data-sync/domain/pushQueue.js";
import { categoryLabel } from "@/data-sync/ui/DataSyncLabels.js";
import type { DataSyncIntl } from "@/data-sync/ui/DataSyncRowItem.js";

type Intl = DataSyncIntl;

/** 概览汇总只关心分类级失败原因；门禁错误优先用稳定 code 选文案。 */
function pushResultErrorText(intl: Intl, result: DataSyncCategoryPushResult): string | undefined {
  if (result.errorCode === DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE) {
    return intl.formatMessage({ id: "settings.dataSync.error.remoteAgentOutdated" });
  }
  if (result.errorCode === DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE) {
    return intl.formatMessage({ id: "settings.dataSync.error.remoteAgentCapabilityUnverified" });
  }
  return result.error;
}

function PushAllSummaryPanel({ summary }: { summary: DataSyncPushAllSummary }) {
  const { intl } = useZCodeIntl();
  const failedCategories = summary.results.filter(hasPushAllCategoryFailure);
  return (
    <div
      className="space-y-2 rounded-lg border border-border bg-surface p-4"
      data-testid="settings-data-sync-push-all-summary"
    >
      <div className="text-ui-base text-foreground">
        {intl.formatMessage(
          { id: "settings.dataSync.overview.pushSummary" },
          {
            succeeded: summary.succeeded,
            failed: summary.failed,
            skipped: summary.skipped,
          },
        )}
      </div>
      {failedCategories.map((result) => {
        const reason = pushResultErrorText(intl, result);
        return (
          <div
            key={result.category}
            className="space-y-1"
            data-testid={`settings-data-sync-push-all-failure-${result.category}`}
          >
            <div className="text-ui-sm font-medium text-foreground">
              {categoryLabel(intl, result.category)}
            </div>
            {reason ? (
              <div className="text-ui-sm text-destructive" role="alert">
                {reason}
              </div>
            ) : null}
            {result.failures.map((failure) => (
              <div key={failure.key} className="text-ui-sm text-destructive" role="alert">
                {failure.name}:{" "}
                {failure.status === "conflict"
                  ? intl.formatMessage({ id: "settings.dataSync.result.conflict" })
                  : intl.formatMessage({ id: "settings.dataSync.result.failed" })}
                {failure.error ? ` — ${failure.error}` : ""}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function OverviewRow({
  controller,
  onSelect,
}: {
  controller: DataSyncCategoryController;
  onSelect(id: DataSyncCategoryId): void;
}) {
  const { intl } = useZCodeIntl();
  const ready = controller.phase === "ready";
  const status = ready
    ? controller.importBlockedReason
      ? intl.formatMessage({ id: "settings.dataSync.category.blockedBadge" })
      : controller.changedCount > 0
        ? intl.formatMessage(
            { id: "settings.dataSync.overview.changed" },
            { count: controller.changedCount },
          )
        : intl.formatMessage({ id: "settings.dataSync.overview.inSync" })
    : controller.phase === "error"
      ? intl.formatMessage({ id: "settings.dataSync.overview.error" })
      : intl.formatMessage({ id: "settings.dataSync.overview.loading" });
  const statusTone =
    ready && !controller.importBlockedReason && controller.changedCount > 0
      ? "bg-warning-surface text-warning-surface-foreground"
      : ready && !controller.importBlockedReason
        ? "bg-success-surface text-success-surface-foreground"
        : "bg-surface text-foreground-subtle";
  return (
    <button
      type="button"
      data-testid={`settings-data-sync-overview-row-${controller.category}`}
      onClick={() => onSelect(controller.category)}
      className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 px-4 py-3 text-left first:border-t-0 hover:bg-surface/60"
    >
      <span className="min-w-40 flex-1 truncate text-ui-base font-medium text-foreground">
        {categoryLabel(intl, controller.category)}
      </span>
      {ready ? (
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-ui-sm text-foreground-subtle">
          <span>
            {intl.formatMessage(
              { id: "settings.dataSync.overview.local" },
              { count: controller.sourceCount },
            )}
          </span>
          <span>
            {intl.formatMessage(
              { id: "settings.dataSync.overview.remote" },
              { count: controller.targetCount },
            )}
          </span>
        </span>
      ) : null}
      <span
        className={`inline-flex items-center rounded-md px-2 py-0.5 text-ui-xs font-medium ${statusTone}`}
      >
        {status}
      </span>
    </button>
  );
}

/**
 * 概览：逐类统计 + 跨分类全选 / 取消全选 + 推送全部 + 结果汇总。
 * 概览只发号施令，勾选与推送结果仍归各分类的 `useDataSyncCategory`。
 */
export function OverviewPanel({
  categories,
  onSelectCategory,
  selectedTotal,
  canPushAll,
  pushAllRunning,
  pushAllSummary,
  onSelectAll,
  onClearSelection,
  onPushAll,
}: {
  categories: readonly DataSyncCategoryController[];
  onSelectCategory(id: DataSyncCategoryId): void;
  selectedTotal: number;
  canPushAll: boolean;
  pushAllRunning: boolean;
  pushAllSummary: DataSyncPushAllSummary | undefined;
  onSelectAll(): void;
  onClearSelection(): void;
  onPushAll(): void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="space-y-3">
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.dataSync.overview.hint" })}
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-ui-sm text-foreground-subtle">
          {selectedTotal > 0
            ? intl.formatMessage(
                { id: "settings.dataSync.overview.selection.count" },
                { count: selectedTotal },
              )
            : intl.formatMessage({ id: "settings.dataSync.overview.selection.none" })}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pushAllRunning}
            onClick={onSelectAll}
            data-testid="settings-data-sync-overview-select-all"
          >
            {intl.formatMessage({ id: "settings.dataSync.overview.selectAll" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pushAllRunning}
            onClick={onClearSelection}
            data-testid="settings-data-sync-overview-clear-selection"
          >
            {intl.formatMessage({ id: "settings.dataSync.overview.clearSelection" })}
          </Button>
          <Button
            type="button"
            size="lg"
            disabled={!canPushAll}
            onClick={onPushAll}
            data-testid="settings-data-sync-push-all"
          >
            <UploadCloud />
            {pushAllRunning
              ? intl.formatMessage({ id: "settings.dataSync.overview.pushingAll" })
              : intl.formatMessage(
                  { id: "settings.dataSync.overview.pushAll" },
                  { count: selectedTotal },
                )}
          </Button>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {categories.map((controller) => (
          <OverviewRow
            key={controller.category}
            controller={controller}
            onSelect={onSelectCategory}
          />
        ))}
      </div>

      {pushAllSummary ? <PushAllSummaryPanel summary={pushAllSummary} /> : null}
    </div>
  );
}
