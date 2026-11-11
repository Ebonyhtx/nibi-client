import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, UploadCloud } from "lucide-react";
import type { DataSyncBlockedReason } from "@nibi/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
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
import type {
  DataSyncDevice,
  DataSyncPushOutcome,
  DataSyncRowNote,
  DataSyncRowStatus,
  DataSyncSkillRow,
} from "@/data-sync/contract.js";
import {
  useDataSyncSkills,
  type DataSyncSkillsController,
} from "@/data-sync/app/useDataSyncSkills.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_CLASS: Record<DataSyncRowStatus, string> = {
  push: "bg-success-surface text-success-surface-foreground",
  update: "bg-progress-surface text-progress-surface-foreground",
  difference: "bg-warning-surface text-warning-surface-foreground",
  synced: "bg-surface text-foreground-subtle",
  remoteOnly: "bg-surface text-foreground-subtle",
  blocked: "bg-surface text-foreground-subtle",
};

function StatusBadge({ status }: { status: DataSyncRowStatus }) {
  const { intl } = useZCodeIntl();
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-ui-xs font-medium ${STATUS_CLASS[status]}`}
    >
      {intl.formatMessage({ id: `settings.dataSync.status.${status}` })}
    </span>
  );
}

function blockedReasonLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  reason: DataSyncBlockedReason,
) {
  switch (reason) {
    case "size-limit":
      return intl.formatMessage({ id: "settings.dataSync.blocked.sizeLimit" });
    case "contains-symlink":
      return intl.formatMessage({ id: "settings.dataSync.blocked.containsSymlink" });
    case "target-symlink":
      return intl.formatMessage({ id: "settings.dataSync.blocked.targetSymlink" });
    case "compat-directory":
      return intl.formatMessage({ id: "settings.dataSync.blocked.compatDirectory" });
  }
}

function noteLabel(intl: ReturnType<typeof useZCodeIntl>["intl"], note: DataSyncRowNote): string {
  switch (note.kind) {
    case "sourceOnly":
      return intl.formatMessage({ id: "settings.dataSync.note.sourceOnly" });
    case "version":
      return intl.formatMessage(
        { id: "settings.dataSync.note.version" },
        { from: note.from, to: note.to },
      );
    case "sourceOlder":
      return intl.formatMessage({ id: "settings.dataSync.note.sourceOlder" });
    case "contentDiffers":
      return intl.formatMessage({ id: "settings.dataSync.note.contentDiffers" });
    case "synced":
      return intl.formatMessage({ id: "settings.dataSync.note.synced" });
    case "remoteOnly":
      return intl.formatMessage({ id: "settings.dataSync.note.remoteOnly" });
    case "blocked":
      return blockedReasonLabel(intl, note.reason);
  }
}

function resultLabel(intl: ReturnType<typeof useZCodeIntl>["intl"], outcome: DataSyncPushOutcome) {
  switch (outcome.status) {
    case "created":
      return intl.formatMessage({ id: "settings.dataSync.result.created" });
    case "updated":
      return intl.formatMessage({ id: "settings.dataSync.result.updated" });
    case "failed":
      return intl.formatMessage({ id: "settings.dataSync.result.failed" });
    case "conflict":
      return intl.formatMessage({ id: "settings.dataSync.result.conflict" });
    case "skipped":
      return intl.formatMessage({ id: "settings.dataSync.result.skipped" });
  }
}

function SkillRow({
  row,
  selected,
  disabled,
  outcome,
  onToggle,
}: {
  row: DataSyncSkillRow;
  selected: boolean;
  disabled: boolean;
  outcome: DataSyncPushOutcome | undefined;
  onToggle(key: string, selected: boolean): void;
}) {
  const { intl } = useZCodeIntl();
  const localSummary = row.sourceSignature
    ? intl.formatMessage(
        { id: "settings.dataSync.summary.local" },
        {
          files: row.sourceSignature.fileCount,
          size: formatBytes(row.sourceSignature.totalBytes),
        },
      )
    : intl.formatMessage({ id: "settings.dataSync.summary.localMissing" });
  const remoteSummary = row.targetSignature
    ? intl.formatMessage(
        { id: "settings.dataSync.summary.remote" },
        {
          files: row.targetSignature.fileCount,
          size: formatBytes(row.targetSignature.totalBytes),
        },
      )
    : intl.formatMessage({ id: "settings.dataSync.summary.remoteMissing" });
  const resultText = outcome ? resultLabel(intl, outcome) : null;
  const rowPath = row.path ?? row.directoryName ?? row.targetPath ?? row.targetDirectoryName;
  const resultTone =
    outcome?.status === "created" || outcome?.status === "updated"
      ? "bg-success-surface text-success-surface-foreground"
      : outcome?.status === "skipped"
        ? "bg-surface text-foreground-subtle"
        : "bg-destructive/10 text-destructive";
  return (
    <div
      data-testid={`settings-data-sync-row-${row.key}`}
      className="flex items-start gap-3 border-t border-border/60 px-4 py-3 first:border-t-0"
    >
      <Checkbox
        className="mt-0.5"
        aria-label={row.name}
        checked={selected}
        disabled={disabled || !row.selectable}
        onCheckedChange={(value) => onToggle(row.key, value === true)}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-ui-base font-medium text-foreground">{row.name}</span>
          <StatusBadge status={row.status} />
          {resultText ? (
            <span
              className={`inline-flex items-center rounded-md px-2 py-0.5 text-ui-xs font-medium ${resultTone}`}
            >
              {resultText}
            </span>
          ) : null}
        </div>
        {rowPath ? (
          <div className="truncate text-ui-sm text-foreground-subtle">{rowPath}</div>
        ) : null}
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-ui-sm text-foreground-subtle">
          <span>{localSummary}</span>
          <span>{remoteSummary}</span>
        </div>
        <div className="text-ui-sm text-foreground-subtle">{noteLabel(intl, row.note)}</div>
        {outcome?.error ? (
          <div className="text-ui-sm text-destructive" role="alert">
            {outcome.error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export interface DataSyncSectionViewProps {
  devices: readonly DataSyncDevice[];
  selectedDeviceId: string | undefined;
  onSelectDevice(sourceServerId: string): void;
  state: DataSyncSkillsController;
  attachmentError?: string;
  onRetryAttachment(): void;
}

/** 纯展示层：设备选择、三态列表、勾选、推送与逐项结果。状态由 `useDataSyncSkills` 拥有。 */
export function DataSyncSectionView({
  devices,
  selectedDeviceId,
  onSelectDevice,
  state,
  attachmentError,
  onRetryAttachment,
}: DataSyncSectionViewProps) {
  const { intl } = useZCodeIntl();
  const blocked = state.phase === "offline" || state.phase === "connecting";
  const reloadDisabled = state.pushing || blocked;
  return (
    <div className="space-y-6" data-testid="settings-data-sync">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.dataSync.description" })}
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
          onClick={state.reload}
          data-testid="settings-data-sync-refresh"
        >
          <RefreshCw className={state.phase === "loading" ? "animate-spin" : undefined} />
          {intl.formatMessage({ id: "settings.dataSync.actions.refresh" })}
        </Button>
      </div>

      {state.phase === "offline" ? (
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
              {intl.formatMessage({ id: "settings.dataSync.phase.offlineDescription" })}
            </div>
          </div>
        </div>
      ) : state.phase === "connecting" ? (
        <div role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.dataSync.phase.connecting" })}
        </div>
      ) : state.phase === "loading" ? (
        <div role="status" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.dataSync.phase.loading" })}
        </div>
      ) : state.phase === "error" ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-4"
        >
          <div className="space-y-1">
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.dataSync.phase.errorTitle" })}
            </div>
            <div className="text-ui-base text-foreground-subtle">
              {attachmentError ??
                state.errorMessage ??
                intl.formatMessage({ id: "settings.dataSync.phase.errorDescription" })}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            {attachmentError ? (
              <Button type="button" variant="outline" size="lg" onClick={onRetryAttachment}>
                {intl.formatMessage({ id: "settings.dataSync.actions.retryConnection" })}
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="lg" onClick={state.reload}>
              {intl.formatMessage({ id: "settings.dataSync.actions.retry" })}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
              <span>
                {intl.formatMessage(
                  { id: "settings.dataSync.remoteOnly" },
                  { count: state.remoteOnlyCount },
                )}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={state.selectAll}>
                {intl.formatMessage({ id: "settings.dataSync.actions.selectAll" })}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={state.clearSelection}>
                {intl.formatMessage({ id: "settings.dataSync.actions.clearSelection" })}
              </Button>
            </div>
          </div>

          {state.rows.length === 0 ? (
            <div className="rounded-lg border border-border bg-surface px-4 py-6 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.dataSync.empty" })}
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              {state.rows.map((row) => (
                <SkillRow
                  key={row.key}
                  row={row}
                  selected={state.selectedKeys.has(row.key)}
                  disabled={state.pushing}
                  outcome={state.summary?.outcomes[row.key]}
                  onToggle={state.toggleSkill}
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
            <div
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/10 p-3"
            >
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
                    { id: "settings.dataSync.selection.count" },
                    { count: state.selectedCount },
                  )
                : intl.formatMessage({ id: "settings.dataSync.selection.none" })}
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
      )}
    </div>
  );
}

/** 设置页内容：设备选择 + 该设备 source-settings attachment + 技能同步状态。 */
export function DataSyncSection({ devices }: { devices: readonly DataSyncDevice[] }) {
  const request = useOptionalPlatform()?.requestSourceSettingsAttachment;
  const sourceServices = useBaseWorkspaceServices();
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | undefined>(
    devices[0]?.sourceServerId,
  );
  const [attachmentError, setAttachmentError] = useState<string>();
  const [attachmentAttempt, setAttachmentAttempt] = useState(0);
  const selectedDevice = useMemo(
    () => devices.find((device) => device.sourceServerId === selectedDeviceId),
    [devices, selectedDeviceId],
  );
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

  const state = useDataSyncSkills({
    sourceServices,
    targetServices,
    online: Boolean(selectedDevice),
    ...(attachmentError ? { attachmentError } : {}),
  });
  const retryAttachment = useCallback(() => {
    setAttachmentError(undefined);
    setAttachmentAttempt((attempt) => attempt + 1);
  }, []);
  const selectDevice = useCallback((sourceServerId: string) => {
    setSelectedDeviceId(sourceServerId);
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
      state={state}
      {...(attachmentError ? { attachmentError } : {})}
      onRetryAttachment={retryAttachment}
    />
  );
}

function DataSyncEmptyState() {
  const { intl } = useZCodeIntl();
  return <>{intl.formatMessage({ id: "settings.dataSync.phase.noDevices" })}</>;
}
