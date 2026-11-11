import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, RefreshCw, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import {
  ensureSourceSettingsServices,
  useSourceSettingsServices,
} from "@/store/sourceSettingsServiceStore.js";
import type { DataSyncCategoryController } from "@/data-sync/app/useDataSyncCategory.js";
import { useDataSyncCategory } from "@/data-sync/app/useDataSyncCategory.js";
import type {
  DataSyncCategoryId,
  DataSyncDevice,
  DataSyncPagePhase,
} from "@/data-sync/contract.js";
import { DATA_SYNC_CATEGORIES } from "@/data-sync/contract.js";
import {
  DataSyncRowItem,
  blockedReasonLabel,
  type DataSyncIntl,
} from "@/data-sync/ui/DataSyncRowItem.js";

type Intl = DataSyncIntl;
type DataSyncTabId = DataSyncCategoryId | "overview";

const CATEGORY_LABEL_IDS: Record<DataSyncCategoryId, string> = {
  skills: "settings.dataSync.category.skills",
  mcp: "settings.dataSync.category.mcp",
  commands: "settings.dataSync.category.commands",
  hooks: "settings.dataSync.category.hooks",
  subagents: "settings.dataSync.category.subagents",
  plugins: "settings.dataSync.category.plugins",
};

function categoryLabel(intl: Intl, category: DataSyncCategoryId): string {
  return intl.formatMessage({ id: CATEGORY_LABEL_IDS[category] });
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
  const { intl } = useZCodeIntl();
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

function OverviewPanel({
  categories,
  onSelectCategory,
}: {
  categories: readonly DataSyncCategoryController[];
  onSelectCategory(id: DataSyncCategoryId): void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="space-y-3">
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "settings.dataSync.overview.hint" })}
      </p>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {categories.map((controller) => (
          <OverviewRow
            key={controller.category}
            controller={controller}
            onSelect={onSelectCategory}
          />
        ))}
      </div>
    </div>
  );
}

function CategoryPanel({ state }: { state: DataSyncCategoryController }) {
  const { intl } = useZCodeIntl();
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
            {intl.formatMessage({ id: "settings.dataSync.category.errorTitle" })}
          </div>
          <div className="text-ui-base text-foreground-subtle">
            {state.errorMessage ??
              intl.formatMessage({ id: "settings.dataSync.phase.errorDescription" })}
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
            disabled={Boolean(state.importBlockedReason)}
            onClick={state.selectAll}
          >
            {intl.formatMessage({ id: "settings.dataSync.actions.selectAll" })}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={state.clearSelection}>
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
              disabled={state.pushing}
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
              { error: state.errorMessage },
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
          disabled={!state.canPush}
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
}

/**
 * 纯展示层：设备选择、分类标签栏、概览、三态列表、勾选、推送与逐项结果。
 * 状态由各分类的 `useDataSyncCategory` 拥有；概览只读统计，不提供跨类全选或推送全部。
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
}: DataSyncSectionViewProps) {
  const { intl } = useZCodeIntl();
  const activeCategory =
    activeTab === "overview"
      ? undefined
      : categories.find((category) => category.category === activeTab);
  const reloadDisabled = pagePhase !== "ready" || categories.some((category) => category.pushing);
  return (
    <div className="space-y-6" data-testid="settings-data-sync">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.dataSync.category.description" })}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.dataSync.device.label" })}
        </span>
        <Select value={selectedDeviceId} onValueChange={onSelectDevice}>
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
              <CategoryPanel state={activeCategory} />
            ) : (
              <OverviewPanel categories={categories} onSelectCategory={onSelectCategory} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 设置页内容：设备选择 + 该设备 source-settings attachment + 六个用户级分类的同步状态。 */
export function DataSyncSection({ devices }: { devices: readonly DataSyncDevice[] }) {
  const request = useOptionalPlatform()?.requestSourceSettingsAttachment;
  const sourceServices = useBaseWorkspaceServices();
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>(
    devices[0]?.sourceServerId,
  );
  const [attachmentError, setAttachmentError] = useState<string>();
  const [attachmentAttempt, setAttachmentAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState<DataSyncTabId>("overview");
  const selectedDevice = devices.find((device) => device.sourceServerId === selectedDeviceId);
  const targetServices = useSourceSettingsServices(selectedDevice?.sourceServerId);

  useEffect(() => {
    if (!devices.some((device) => device.sourceServerId === selectedDeviceId)) {
      setSelectedDeviceId(devices[0]?.sourceServerId);
    }
  }, [devices, selectedDeviceId]);

  useEffect(() => {
    setAttachmentError(undefined);
    if (!selectedDevice || targetServices || !request) return;
    let active = true;
    ensureSourceSettingsServices(selectedDevice.sourceServerId, request).catch((error: unknown) => {
      logger.warn("[data-sync] 申请设备配置连接失败", {
        sourceServerId: selectedDevice.sourceServerId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (active) {
        setAttachmentError(error instanceof Error ? error.message : String(error));
      }
    });
    return () => {
      active = false;
    };
  }, [attachmentAttempt, request, selectedDevice, targetServices]);

  const online = Boolean(selectedDevice);
  const categoryParams = {
    sourceServices,
    targetServices,
    online,
    ...(attachmentError ? { attachmentError } : {}),
  };
  const skills = useDataSyncCategory({ ...categoryParams, category: "skills" });
  const mcp = useDataSyncCategory({ ...categoryParams, category: "mcp" });
  const commands = useDataSyncCategory({ ...categoryParams, category: "commands" });
  const hooks = useDataSyncCategory({ ...categoryParams, category: "hooks" });
  const subagents = useDataSyncCategory({ ...categoryParams, category: "subagents" });
  const plugins = useDataSyncCategory({ ...categoryParams, category: "plugins" });
  const categories: DataSyncCategoryController[] = [
    skills,
    mcp,
    commands,
    hooks,
    subagents,
    plugins,
  ];
  const categoriesRef = useRef(categories);
  categoriesRef.current = categories;
  const previousTabRef = useRef<DataSyncTabId>(activeTab);

  // 切换分类时清空旧分类的勾选：分类页只展示当前分类的结果，不回带上一类的选择。
  useEffect(() => {
    const previous = previousTabRef.current;
    previousTabRef.current = activeTab;
    if (previous === activeTab || previous === "overview") return;
    categoriesRef.current.find((category) => category.category === previous)?.clearSelection();
  }, [activeTab]);

  const pagePhase: DataSyncPagePhase = !selectedDevice
    ? "offline"
    : attachmentError
      ? "error"
      : !sourceServices || !targetServices
        ? "connecting"
        : "ready";

  const reload = useCallback(() => {
    const targets =
      activeTab === "overview"
        ? categoriesRef.current
        : categoriesRef.current.filter((category) => category.category === activeTab);
    for (const target of targets) target.reload();
  }, [activeTab]);

  const retryAttachment = useCallback(() => {
    setAttachmentError(undefined);
    setAttachmentAttempt((attempt) => attempt + 1);
  }, []);
  const selectDevice = useCallback((sourceServerId: string) => {
    setSelectedDeviceId(sourceServerId);
  }, []);
  const selectCategory = useCallback((id: DataSyncTabId) => {
    setActiveTab(id);
  }, []);

  if (devices.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-4 py-6 text-ui-base text-foreground-subtle">
        <DataSyncEmptyState />
      </div>
    );
  }

  return (
    <DataSyncSectionView
      devices={devices}
      selectedDeviceId={selectedDevice?.sourceServerId}
      onSelectDevice={selectDevice}
      pagePhase={pagePhase}
      categories={categories}
      activeTab={activeTab}
      onSelectCategory={selectCategory}
      onRefresh={reload}
      {...(attachmentError ? { attachmentError } : {})}
      onRetryAttachment={retryAttachment}
    />
  );
}

function DataSyncEmptyState() {
  const { intl } = useZCodeIntl();
  return <>{intl.formatMessage({ id: "settings.dataSync.phase.noDevices" })}</>;
}
