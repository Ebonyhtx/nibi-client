import { AlertTriangle, Inbox, RefreshCw, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import type { DataSyncCategoryController } from "@/data-sync/app/useDataSyncCategory.js";
import type {
  DataSyncDevice,
  DataSyncPagePhase,
  DataSyncPushAllSummary,
  DataSyncTabId,
} from "@/data-sync/contract.js";
import {
  DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE,
  DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE,
  DATA_SYNC_CATEGORIES,
} from "@/data-sync/contract.js";
import { categoryLabel } from "@/data-sync/ui/DataSyncLabels.js";
import { OverviewPanel } from "@/data-sync/ui/DataSyncOverview.js";
import {
  DataSyncRowItem,
  blockedReasonLabel,
  type DataSyncIntl,
} from "@/data-sync/ui/DataSyncRowItem.js";

type Intl = DataSyncIntl;

/** 门禁错误优先用稳定 code 选文案；其它错误仍显示原始 message，保持既有排障信息。 */
function categoryErrorTitle(intl: Intl, state: DataSyncCategoryController): string {
  if (state.errorCode === DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE) {
    return intl.formatMessage({ id: "settings.dataSync.error.remoteAgentOutdatedTitle" });
  }
  if (state.errorCode === DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE) {
    return intl.formatMessage({
      id: "settings.dataSync.error.remoteAgentCapabilityUnverifiedTitle",
    });
  }
  return intl.formatMessage({ id: "settings.dataSync.category.errorTitle" });
}

function categoryErrorText(intl: Intl, state: DataSyncCategoryController): string {
  if (state.errorCode === DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE) {
    return intl.formatMessage({ id: "settings.dataSync.error.remoteAgentOutdated" });
  }
  if (state.errorCode === DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE) {
    return intl.formatMessage({ id: "settings.dataSync.error.remoteAgentCapabilityUnverified" });
  }
  return (
    state.errorMessage ?? intl.formatMessage({ id: "settings.dataSync.phase.errorDescription" })
  );
}

function CategoryTab({
  id,
  label,
  active,
  badge,
  badgeTone,
  onSelect,
}: {
  id: DataSyncTabId;
  label: string;
  active: boolean;
  badge?: string;
  badgeTone?: string;
  onSelect(id: DataSyncTabId): void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls="settings-data-sync-panel"
      data-testid={`settings-data-sync-category-tab-${id}`}
      onClick={() => onSelect(id)}
      className={`flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-ui-base font-medium transition-colors ${
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-foreground-subtle hover:text-foreground"
      }`}
    >
      <span className="whitespace-nowrap">{label}</span>
      {badge ? (
        <span
          className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-ui-xs font-medium ${badgeTone ?? "bg-surface text-foreground-subtle"}`}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}

/** 分类标签栏：窄窗口横向滚动，避免挤压设置页正文。 */
function CategoryTabs({
  categories,
  activeTab,
  onSelect,
}: {
  categories: readonly DataSyncCategoryController[];
  activeTab: DataSyncTabId;
  onSelect(id: DataSyncTabId): void;
}) {
  const { intl } = useNibiIntl();
  const totalChanged = categories.reduce((total, category) => total + category.changedCount, 0);
  return (
    <div
      role="tablist"
      aria-label={intl.formatMessage({ id: "settings.dataSync.category.tabsLabel" })}
      className="flex gap-1 overflow-x-auto rounded-full bg-surface p-0.5"
      data-testid="settings-data-sync-tabs"
    >
      <CategoryTab
        id="overview"
        label={intl.formatMessage({ id: "settings.dataSync.overview.tab" })}
        active={activeTab === "overview"}
        {...(totalChanged > 0
          ? {
              badge: intl.formatMessage(
                { id: "settings.dataSync.overview.changed" },
                { count: totalChanged },
              ),
              badgeTone: "bg-warning-surface text-warning-surface-foreground",
            }
          : {})}
        onSelect={onSelect}
      />
      {DATA_SYNC_CATEGORIES.map((categoryId) => {
        const controller = categories.find((category) => category.category === categoryId);
        const badge = controller ? categoryBadge(intl, controller) : undefined;
        return (
          <CategoryTab
            key={categoryId}
            id={categoryId}
            label={categoryLabel(intl, categoryId)}
            active={activeTab === categoryId}
            {...(badge ? { badge: badge.text, badgeTone: badge.tone } : {})}
            onSelect={onSelect}
          />
        );
      })}
    </div>
  );
}

function categoryBadge(intl: Intl, controller: DataSyncCategoryController) {
  if (controller.phase === "error") {
    return {
      text: intl.formatMessage({ id: "settings.dataSync.overview.error" }),
      tone: "bg-destructive/10 text-destructive",
    };
  }
  if (controller.phase !== "ready") return undefined;
  if (controller.importBlockedReason) {
    return {
      text: intl.formatMessage({ id: "settings.dataSync.category.blockedBadge" }),
      tone: "bg-surface text-foreground-subtle",
    };
  }
  if (controller.changedCount > 0) {
    return {
      text: intl.formatMessage(
        { id: "settings.dataSync.category.pushable" },
        { count: controller.changedCount },
      ),
      tone: "bg-warning-surface text-warning-surface-foreground",
    };
  }
  return {
    text: intl.formatMessage({ id: "settings.dataSync.category.inSync" }),
    tone: "bg-success-surface text-success-surface-foreground",
  };
}

function CategoryPanel({ state, busy }: { state: DataSyncCategoryController; busy: boolean }) {
  const { intl } = useNibiIntl();
  if (state.phase === "loading") {
    return (
      <div role="status" className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.dataSync.category.loading" })}
      </div>
    );
  }
  if (state.phase === "connecting") {
    return (
      <div role="status" className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.dataSync.phase.connecting" })}
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div
        role="alert"
        className="flex items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
      >
        <div className="space-y-1">
          <div className="text-ui-base font-medium text-foreground">
            {categoryErrorTitle(intl, state)}
          </div>
          <div className="text-ui-base text-foreground-subtle">
            {categoryErrorText(intl, state)}
          </div>
        </div>
        <Button type="button" variant="outline" size="lg" onClick={state.reload}>
          {intl.formatMessage({ id: "settings.dataSync.actions.retry" })}
        </Button>
      </div>
    );
  }
  if (state.phase !== "ready") return null;
  return (
    <>
      {state.importBlockedReason ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4"
          data-testid="settings-data-sync-category-blocked"
        >
          <AlertTriangle className="mt-0.5 size-4 text-warning" />
          <div className="space-y-1">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.dataSync.category.blockedTitle" })}
            </div>
            <div className="text-ui-base text-foreground-subtle">
              {blockedReasonLabel(intl, state.importBlockedReason)}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.dataSync.category.remoteOnly" },
            { count: state.remoteOnlyCount },
          )}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || Boolean(state.importBlockedReason)}
            onClick={state.selectAll}
          >
            {intl.formatMessage({ id: "settings.dataSync.actions.selectAll" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={state.clearSelection}
          >
            {intl.formatMessage({ id: "settings.dataSync.actions.clearSelection" })}
          </Button>
        </div>
      </div>

      {state.rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface px-4 py-6 text-ui-base text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.dataSync.category.empty" },
            { category: categoryLabel(intl, state.category) },
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {state.rows.map((row) => (
            <DataSyncRowItem
              key={row.key}
              row={row}
              selected={state.selectedKeys.has(row.key)}
              disabled={state.pushing || busy}
              outcome={state.summary?.outcomes[row.key]}
              onToggle={state.toggleItem}
            />
          ))}
        </div>
      )}

      {state.summary ? (
        <div className="space-y-2 rounded-lg border border-border bg-surface p-4">
          <div className="text-ui-base text-foreground">
            {intl.formatMessage(
              { id: "settings.dataSync.push.summary" },
              {
                succeeded: state.summary.succeeded,
                failed: state.summary.failed,
                skipped: state.summary.skipped,
              },
            )}
          </div>
          {state.failures.length > 0 ? (
            <div className="space-y-1">
              {state.failures.map((failure) => (
                <div key={failure.key} className="text-ui-sm text-destructive" role="alert">
                  {failure.name}:{" "}
                  {failure.status === "conflict"
                    ? intl.formatMessage({ id: "settings.dataSync.result.conflict" })
                    : intl.formatMessage({ id: "settings.dataSync.result.failed" })}
                  {failure.error ? ` — ${failure.error}` : ""}
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={state.pushing}
                onClick={() => void state.retryFailed()}
                data-testid="settings-data-sync-retry"
              >
                {intl.formatMessage(
                  { id: "settings.dataSync.actions.retryFailed" },
                  { count: state.failures.length },
                )}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {state.errorMessage ? (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3">
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.dataSync.push.failed" },
              { error: categoryErrorText(intl, state) },
            )}
          </div>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <span className="text-ui-base text-foreground-subtle">
          {state.selectedCount > 0
            ? intl.formatMessage(
                { id: "settings.dataSync.category.selection.count" },
                { count: state.selectedCount },
              )
            : intl.formatMessage({ id: "settings.dataSync.category.selection.none" })}
        </span>
        <Button
          type="button"
          size="lg"
          disabled={busy || !state.canPush}
          onClick={() => void state.push()}
          data-testid="settings-data-sync-push"
        >
          <UploadCloud />
          {state.pushing
            ? intl.formatMessage({ id: "settings.dataSync.actions.pushing" })
            : intl.formatMessage(
                { id: "settings.dataSync.actions.push" },
                { count: state.selectedCount },
              )}
        </Button>
      </div>
    </>
  );
}

export interface DataSyncSectionViewProps {
  devices: readonly DataSyncDevice[];
  selectedDeviceId: string | undefined;
  onSelectDevice(sourceServerId: string): void;
  pagePhase: DataSyncPagePhase;
  categories: readonly DataSyncCategoryController[];
  activeTab: DataSyncTabId;
  onSelectCategory(id: DataSyncTabId): void;
  onRefresh(): void;
  attachmentError?: string;
  onRetryAttachment(): void;
  /** 概览跨分类勾选总数与「推送全部」状态。 */
  selectedTotal: number;
  canPushAll: boolean;
  pushAllRunning: boolean;
  pushAllSummary?: DataSyncPushAllSummary;
  onSelectAllCategories(): void;
  onClearCategorySelection(): void;
  onPushAll(): void;
}

/**
 * 纯展示层：设备选择、分类标签栏、概览、三态列表、勾选、推送与逐项结果。
 * 状态由各分类的 `useDataSyncCategory` 拥有；概览负责跨类全选与「推送全部」的入口和汇总。
 */
export function DataSyncSectionView({
  devices,
  selectedDeviceId,
  onSelectDevice,
  pagePhase,
  categories,
  activeTab,
  onSelectCategory,
  onRefresh,
  attachmentError,
  onRetryAttachment,
  selectedTotal,
  canPushAll,
  pushAllRunning,
  pushAllSummary,
  onSelectAllCategories,
  onClearCategorySelection,
  onPushAll,
}: DataSyncSectionViewProps) {
  const { intl } = useNibiIntl();
  const activeCategory =
    activeTab === "overview"
      ? undefined
      : categories.find((category) => category.category === activeTab);
  // 推送全部期间禁止刷新 / 换设备：分类 reload 会换代 generation，使排队中的推送结果被丢弃。
  const reloadDisabled =
    pagePhase !== "ready" || pushAllRunning || categories.some((category) => category.pushing);
  return (
    <div className="space-y-6" data-testid="settings-data-sync">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.dataSync.device.label" })}
        </span>
        <Select value={selectedDeviceId} onValueChange={onSelectDevice} disabled={pushAllRunning}>
          <SelectTrigger
            size="lg"
            className="w-64 min-w-0 justify-between"
            aria-label={intl.formatMessage({ id: "settings.dataSync.device.label" })}
            data-testid="settings-data-sync-device"
          >
            <SelectValue
              placeholder={intl.formatMessage({ id: "settings.dataSync.device.placeholder" })}
            />
          </SelectTrigger>
          <SelectContent>
            {devices.map((device) => (
              <SelectItem key={device.sourceServerId} value={device.sourceServerId}>
                {device.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={reloadDisabled}
          onClick={onRefresh}
          data-testid="settings-data-sync-refresh"
        >
          <RefreshCw
            className={
              pagePhase === "connecting" ||
              categories.some((category) => category.phase === "loading")
                ? "animate-spin"
                : undefined
            }
          />
          {intl.formatMessage({ id: "settings.dataSync.actions.refresh" })}
        </Button>
      </div>

      {pagePhase === "offline" ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4"
        >
          <AlertTriangle className="mt-0.5 size-4 text-warning" />
          <div className="space-y-1">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.dataSync.phase.offlineTitle" })}
            </div>
            <div className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.dataSync.category.offlineDescription" })}
            </div>
          </div>
        </div>
      ) : pagePhase === "connecting" ? (
        <div role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.dataSync.phase.connecting" })}
        </div>
      ) : pagePhase === "error" ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
        >
          <div className="space-y-1">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.dataSync.category.errorTitle" })}
            </div>
            <div className="text-ui-base text-foreground-subtle">
              {attachmentError ??
                intl.formatMessage({ id: "settings.dataSync.phase.errorDescription" })}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {attachmentError ? (
              <Button type="button" variant="outline" size="lg" onClick={onRetryAttachment}>
                {intl.formatMessage({ id: "settings.dataSync.actions.retryConnection" })}
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="lg" onClick={onRefresh}>
              {intl.formatMessage({ id: "settings.dataSync.actions.retry" })}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <CategoryTabs categories={categories} activeTab={activeTab} onSelect={onSelectCategory} />
          <div id="settings-data-sync-panel" role="tabpanel">
            {activeCategory ? (
              <CategoryPanel state={activeCategory} busy={pushAllRunning} />
            ) : (
              <OverviewPanel
                categories={categories}
                onSelectCategory={onSelectCategory}
                selectedTotal={selectedTotal}
                canPushAll={canPushAll}
                pushAllRunning={pushAllRunning}
                pushAllSummary={pushAllSummary}
                onSelectAll={onSelectAllCategories}
                onClearSelection={onClearCategorySelection}
                onPushAll={onPushAll}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 空态按上游做成居中的虚线卡片：图标 + 标题 + 说明 + 主按钮。
 * 不再套灰色大底板，避免整页只剩一块深色区域。
 */
export function DataSyncEmptyState({ onConnectDevice }: { onConnectDevice?: () => void }) {
  const { intl } = useNibiIntl();
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border px-6 py-12 text-center"
      data-testid="settings-data-sync-empty"
    >
      <span className="flex size-10 items-center justify-center rounded-full bg-surface text-foreground-subtle">
        <Inbox className="size-5" aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <p className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.dataSync.phase.noDevicesTitle" })}
        </p>
        <p className="max-w-md text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.dataSync.phase.noDevices" })}
        </p>
      </div>
      {onConnectDevice ? (
        <Button type="button" size="lg" onClick={onConnectDevice}>
          {intl.formatMessage({ id: "settings.dataSync.phase.connectDevice" })}
        </Button>
      ) : null}
    </div>
  );
}
