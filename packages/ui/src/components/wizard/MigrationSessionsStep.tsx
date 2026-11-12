import { CheckIcon, FolderIcon, Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { useClaudeSessionMigration } from "@/hooks/useClaudeSessionMigration.js";
import {
  type ClaudeMigrationRange,
  UNLIMITED_SCAN_LIMIT_INPUT,
} from "@/hooks/useClaudeSessionMigration.js";

export interface MigrationWorkspaceCandidate {
  workspacePath: string;
  label: string;
  sessionCount: number;
}

export interface MigrationSessionsStepLabels {
  emptyId: string;
  countId: string;
  unlimitedId: string;
  chooseWorkspaceId: string;
}

/**
 * 会话步骤：按 workspace 分组展示候选会话，支持整组勾选。
 * 首启与设置页迁移向导共用；步骤文案由调用方传入独立 message id。
 */
export function MigrationSessionsStep(props: {
  migration: ReturnType<typeof useClaudeSessionMigration>;
  workspaceCandidates: MigrationWorkspaceCandidate[];
  selectedWorkspacePaths: string[];
  labels: MigrationSessionsStepLabels;
  onToggleWorkspace: (workspacePath: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  /** 可选的步骤级说明（例如“仅支持 Claude Code”或桌面端限制）。 */
  noticeId?: string;
  /** 设置页按上游样式在每行工作区名前展示文件夹图标；首启保持原观感。 */
  showRowIcon?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const selectedCount = props.selectedWorkspacePaths.length;
  const totalCount = props.workspaceCandidates.length;
  const allSelected = totalCount > 0 && selectedCount === totalCount;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={props.migration.range}
          onValueChange={(value) => props.migration.setRange(value as ClaudeMigrationRange)}
        >
          <SelectTrigger size="lg" className="h-9 justify-between text-ui-base">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">
              {intl.formatMessage({ id: "settings.migration.range.7d" })}
            </SelectItem>
            <SelectItem value="30d">
              {intl.formatMessage({ id: "settings.migration.range.30d" })}
            </SelectItem>
            <SelectItem value="90d">
              {intl.formatMessage({ id: "settings.migration.range.90d" })}
            </SelectItem>
            <SelectItem value="all">
              {intl.formatMessage({ id: "settings.migration.range.all" })}
            </SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={props.migration.limitInput}
          onValueChange={(value) => {
            props.migration.setLimitInput(value);
          }}
        >
          <SelectTrigger size="lg" className="h-9 justify-between text-ui-base">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["30", "50", "100", UNLIMITED_SCAN_LIMIT_INPUT].map((value) => (
              <SelectItem key={value} value={value}>
                {value === UNLIMITED_SCAN_LIMIT_INPUT
                  ? intl.formatMessage({ id: props.labels.unlimitedId })
                  : intl.formatMessage({ id: props.labels.countId }, { count: value })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-9 min-w-0 px-4 text-ui-base"
          disabled={!props.migration.supportState.supported || props.migration.isScanning}
          onClick={() => {
            void props.migration.scan();
          }}
        >
          {props.migration.isScanning ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {intl.formatMessage({ id: "settings.migration.scan" })}
        </Button>
      </div>

      {props.noticeId ? (
        <div className="rounded-xl border border-border bg-surface px-4 py-3 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: props.noticeId })}
        </div>
      ) : null}

      {props.migration.scanError ? (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground">
          {intl.formatMessage(
            { id: "settings.migration.scanFailedDescription" },
            { error: props.migration.scanError },
          )}
        </div>
      ) : null}

      <div className="flex min-h-0 w-full flex-1 flex-col rounded-xl border border-border bg-background">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface/50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <FolderIcon className="size-4 shrink-0 text-foreground-subtle" />
            <div className="flex min-w-0 items-center gap-2">
              <div className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: props.labels.chooseWorkspaceId })}
              </div>
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={totalCount === 0}
            onClick={allSelected ? props.onClearSelection : props.onSelectAll}
          >
            {allSelected
              ? intl.formatMessage({ id: "settingsSync.selection.clearAll" })
              : intl.formatMessage({ id: "settingsSync.selection.selectAll" })}
          </Button>
        </div>
        {props.workspaceCandidates.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: props.labels.emptyId })}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
            {props.workspaceCandidates.map((workspace) => {
              const checked = props.selectedWorkspacePaths.includes(workspace.workspacePath);

              return (
                <button
                  key={workspace.workspacePath}
                  type="button"
                  onClick={() => props.onToggleWorkspace(workspace.workspacePath)}
                  className="flex w-full min-w-0 items-start gap-3 rounded-lg bg-background p-3 pl-3 text-left transition-colors hover:bg-surface-hover/50"
                >
                  <div className="flex size-5 shrink-0 items-center justify-center">
                    <div
                      className={`flex size-4 items-center justify-center rounded-sm border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-transparent"}`}
                    >
                      <CheckIcon className="size-3.5" />
                    </div>
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-3">
                      {props.showRowIcon ? (
                        <FolderIcon className="size-4 shrink-0 text-foreground-subtle" />
                      ) : null}
                      <div className="min-w-0 truncate text-ui-base font-medium text-foreground">
                        {workspace.label}
                      </div>
                      <Badge variant="outline">
                        {intl.formatMessage(
                          { id: props.labels.countId },
                          { count: String(workspace.sessionCount) },
                        )}
                      </Badge>
                    </div>
                    {/* 长路径是连续文本，父级 flex 子项如果不允许收缩，会把整张卡片横向撑出容器。 */}
                    <div className="w-full truncate text-ui-base text-foreground-subtlest">
                      {workspace.workspacePath}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
