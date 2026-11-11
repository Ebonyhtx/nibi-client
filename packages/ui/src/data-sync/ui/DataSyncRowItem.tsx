import type { DataSyncBlockedReason } from "@nibi/shared";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  DataSyncPushOutcome,
  DataSyncRow,
  DataSyncRowNote,
  DataSyncRowStatus,
} from "@/data-sync/contract.js";

/** 设置页各分类共用的 intl 类型，避免每个 helper 重复推导。 */
export type DataSyncIntl = ReturnType<typeof useZCodeIntl>["intl"];

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

export function blockedReasonLabel(intl: DataSyncIntl, reason: DataSyncBlockedReason) {
  switch (reason) {
    case "size-limit":
      return intl.formatMessage({ id: "settings.dataSync.blocked.sizeLimit" });
    case "contains-symlink":
      return intl.formatMessage({ id: "settings.dataSync.blocked.containsSymlink" });
    case "target-symlink":
      return intl.formatMessage({ id: "settings.dataSync.blocked.targetSymlink" });
    case "compat-directory":
      return intl.formatMessage({ id: "settings.dataSync.blocked.compatDirectory" });
    case "external-directory":
      return intl.formatMessage({ id: "settings.dataSync.blocked.externalDirectory" });
    case "target-compat-config":
      return intl.formatMessage({ id: "settings.dataSync.blocked.targetCompatConfig" });
  }
}

function noteLabel(intl: DataSyncIntl, note: DataSyncRowNote): string {
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

function resultLabel(intl: DataSyncIntl, outcome: DataSyncPushOutcome) {
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

/** 行内依赖提示只做展示：不参与行状态与勾选，也不阻断推送。 */
function DependenciesNote({ row }: { row: DataSyncRow }) {
  const { intl } = useZCodeIntl();
  const mcpServers = row.dependencies?.mcpServers ?? [];
  const skills = row.dependencies?.skills ?? [];
  if (mcpServers.length === 0 && skills.length === 0) return null;
  return (
    <div
      className="space-y-0.5 text-ui-sm text-foreground-subtle"
      data-testid={`settings-data-sync-dependencies-${row.key}`}
    >
      {mcpServers.length > 0 ? (
        <div>
          {intl.formatMessage(
            { id: "settings.dataSync.category.dependencies.mcp" },
            { names: mcpServers.join(", ") },
          )}
        </div>
      ) : null}
      {skills.length > 0 ? (
        <div>
          {intl.formatMessage(
            { id: "settings.dataSync.category.dependencies.skills" },
            { names: skills.join(", ") },
          )}
        </div>
      ) : null}
    </div>
  );
}

/** 分类页的单行：勾选、状态、路径 / 文件摘要、依赖提示、差异原因与逐项推送结果。 */
export function DataSyncRowItem({
  row,
  selected,
  disabled,
  outcome,
  onToggle,
}: {
  row: DataSyncRow;
  selected: boolean;
  disabled: boolean;
  outcome: DataSyncPushOutcome | undefined;
  onToggle(key: string, selected: boolean): void;
}) {
  const { intl } = useZCodeIntl();
  const showSummary = Boolean(row.sourceSignature || row.targetSignature);
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
        {showSummary ? (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-ui-sm text-foreground-subtle">
            <span>{localSummary}</span>
            <span>{remoteSummary}</span>
          </div>
        ) : null}
        <DependenciesNote row={row} />
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
