import type { ReactNode } from "react";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { Badge } from "@/components/ui/badge.js";
import { Progress } from "@/components/ui/progress.js";
import { cn } from "@/components/lib/utils.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import {
  ExternalAgentImportSelectionPanel,
  type ExternalAgentImportCategoryState,
  type ImportResourceCategory,
} from "@/settings/ExternalAgentImportDialog.js";
import type { FinishExecutionState, MigrationFailureDetail } from "@/onboarding/OnboardingFlowParts.js";
import type {
  MigrationWizardAgentsFileOutcome,
  MigrationWizardSettingsSummary,
} from "@/settings/migration-wizard/migrationWizardState.js";

export function MigrationWizardNotice(props: {
  messageId: string;
  tone?: "info" | "warning";
  values?: Record<string, string>;
}) {
  const { intl } = useNibiIntl();
  return (
    <div
      className={cn(
        "rounded-xl border px-4 py-3 text-ui-base leading-6",
        props.tone === "warning"
          ? "border-warning/40 bg-warning/10 text-foreground"
          : "border-border bg-surface text-foreground-subtle",
      )}
    >
      {intl.formatMessage({ id: props.messageId }, props.values)}
    </div>
  );
}

export function MigrationExternalImportStep(props: {
  category: ImportResourceCategory;
  state: ExternalAgentImportCategoryState;
  workspacePath: string | null | undefined;
}) {
  return (
    <ExternalAgentImportSelectionPanel
      category={props.category}
      state={props.state}
      workspacePath={props.workspacePath}
    />
  );
}

export function MigrationWizardUnsupportedStep(props: { messageId: string }) {
  const { intl } = useNibiIntl();
  return (
    <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-border bg-background-alt px-6 text-center text-ui-base text-foreground-subtle">
      {intl.formatMessage({ id: props.messageId })}
    </div>
  );
}

export function MigrationWizardReviewStep(props: {
  workspaceCount: number;
  skillsCount: number;
  mcpCount: number;
  commandsCount: number;
  agentsFileSelected: boolean;
}) {
  const { intl } = useNibiIntl();
  const rows: Array<{ labelId: string; value: string }> = [
    {
      labelId: "settings.dataSync.migration.review.sessions",
      value: intl.formatMessage(
        { id: "settings.dataSync.migration.review.workspaceCount" },
        { count: String(props.workspaceCount) },
      ),
    },
    {
      labelId: "settings.dataSync.migration.review.skills",
      value: intl.formatMessage(
        { id: "settings.dataSync.migration.review.itemCount" },
        { count: String(props.skillsCount) },
      ),
    },
    {
      labelId: "settings.dataSync.migration.review.mcp",
      value: intl.formatMessage(
        { id: "settings.dataSync.migration.review.itemCount" },
        { count: String(props.mcpCount) },
      ),
    },
    {
      labelId: "settings.dataSync.migration.review.commands",
      value: intl.formatMessage(
        { id: "settings.dataSync.migration.review.itemCount" },
        { count: String(props.commandsCount) },
      ),
    },
    {
      labelId: "settings.dataSync.migration.review.agentsFile",
      value: intl.formatMessage({
        id: props.agentsFileSelected
          ? "settings.dataSync.migration.review.agentsFileSelected"
          : "settings.dataSync.migration.review.agentsFileNotSelected",
      }),
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col justify-center">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5 rounded-xl border border-border bg-background px-6 py-6">
        <div className="space-y-2">
          {rows.map((row) => (
            <div
              key={row.labelId}
              className="flex items-center justify-between gap-4 border-b border-border pb-2 text-ui-base last:border-b-0 last:pb-0"
            >
              <span className="text-foreground-subtle">
                {intl.formatMessage({ id: row.labelId })}
              </span>
              <span className="font-medium text-foreground">{row.value}</span>
            </div>
          ))}
        </div>
        <div className="rounded-lg border border-border bg-surface px-3 py-3 text-ui-base leading-6 text-foreground-subtle">
          <div>{intl.formatMessage({ id: "settings.dataSync.migration.review.order" })}</div>
          <div className="mt-1">{intl.formatMessage({ id: "settings.dataSync.migration.review.note" })}</div>
        </div>
      </div>
    </div>
  );
}

export function MigrationWizardRunStep(props: {
  overallProgress: number;
  finishExecution: FinishExecutionState;
  agentsFileSelected: boolean;
  externalImportSelected: boolean;
  externalImportCompleted: boolean;
}) {
  const { intl } = useNibiIntl();
  const sessionFinished =
    props.finishExecution.sessionCompletedCount >= props.finishExecution.sessionTotalCount;
  const agentsFileFinished = props.finishExecution.agentsFileCompletedCount > 0;
  const currentLabelId = !sessionFinished
    ? "settings.dataSync.migration.run.currentSessions"
    : props.agentsFileSelected && !agentsFileFinished
      ? "settings.dataSync.migration.run.currentAgentsFile"
      : props.externalImportSelected && !props.externalImportCompleted
        ? "settings.dataSync.migration.run.currentImports"
        : "settings.dataSync.migration.run.ready";

  return (
    <div className="flex h-full min-h-0 flex-col justify-center">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5 rounded-xl border border-border bg-background px-6 py-6">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "settings.dataSync.migration.run.progressLabel" })}</span>
            <span>{props.overallProgress}%</span>
          </div>
          <Progress value={props.overallProgress} className="h-2 rounded-full bg-card" />
        </div>

        <div className="flex gap-3">
          <Loader2Icon className="size-5 animate-spin text-foreground-subtle" />
          <div>
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage(
                { id: "settings.dataSync.migration.run.progress" },
                { progress: String(props.overallProgress) },
              )}
            </div>
            <div className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: currentLabelId })}
            </div>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border bg-surface px-3 py-3 text-ui-base text-foreground-subtle">
          <div className="flex items-center justify-between gap-3">
            <span>{intl.formatMessage({ id: "settings.dataSync.migration.run.sessionsLabel" })}</span>
            <span>
              {props.finishExecution.sessionTotalCount === 0
                ? intl.formatMessage({ id: "settings.dataSync.migration.run.sessionsNone" })
                : intl.formatMessage(
                    { id: "settings.dataSync.migration.run.sessionsCount" },
                    {
                      completed: String(props.finishExecution.sessionCompletedCount),
                      total: String(props.finishExecution.sessionTotalCount),
                    },
                  )}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>{intl.formatMessage({ id: "settings.dataSync.migration.run.agentsFileLabel" })}</span>
            <span>
              {props.agentsFileSelected
                ? agentsFileFinished
                  ? intl.formatMessage({ id: "settings.dataSync.migration.run.stageDone" })
                  : intl.formatMessage({ id: "settings.dataSync.migration.run.stagePending" })
                : intl.formatMessage({ id: "settings.dataSync.migration.run.stageSkipped" })}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span>{intl.formatMessage({ id: "settings.dataSync.migration.run.importsLabel" })}</span>
            <span>
              {props.externalImportSelected
                ? props.externalImportCompleted
                  ? intl.formatMessage({ id: "settings.dataSync.migration.run.stageDone" })
                  : intl.formatMessage({ id: "settings.dataSync.migration.run.stagePending" })
                : intl.formatMessage({ id: "settings.dataSync.migration.run.stageSkipped" })}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryCounts(props: { counts: { imported: number; skipped: number; failed: number } }) {
  const { intl } = useNibiIntl();
  return (
    <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
      <span>{intl.formatMessage({ id: "settings.dataSync.migration.summary.imported" })}</span>
      <span>{props.counts.imported}</span>
      <span>{intl.formatMessage({ id: "settings.dataSync.migration.summary.skipped" })}</span>
      <span>{props.counts.skipped}</span>
      <span>{intl.formatMessage({ id: "settings.dataSync.migration.summary.failed" })}</span>
      <span>{props.counts.failed}</span>
    </div>
  );
}

function SummaryCard(props: { titleId: string; children: ReactNode }) {
  const { intl } = useNibiIntl();
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-4">
      <div className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: props.titleId })}
      </div>
      {props.children}
    </div>
  );
}

export function MigrationWizardSummaryStep(props: {
  finishExecution: FinishExecutionState;
  settingsSummary: MigrationWizardSettingsSummary;
  agentsFileOutcome: MigrationWizardAgentsFileOutcome;
  failureDetails: MigrationFailureDetail[];
  settingsImportError: string | null;
}) {
  const { intl } = useNibiIntl();
  const agentsFileStatusId =
    props.agentsFileOutcome === "copied"
      ? "settings.dataSync.migration.summary.agentsFile.copied"
      : props.agentsFileOutcome === "skipped"
        ? "settings.dataSync.migration.summary.agentsFile.skipped"
        : props.agentsFileOutcome === "failed"
          ? "settings.dataSync.migration.summary.agentsFile.failed"
          : "settings.dataSync.migration.summary.agentsFile.notSelected";

  return (
    <div className="flex h-full min-h-0 flex-col gap-5 overflow-y-auto">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-full bg-success text-success-foreground">
          <CheckIcon className="size-5" />
        </div>
        <div>
          <div className="text-lg font-medium text-foreground">
            {intl.formatMessage({ id: "settings.dataSync.migration.summary.title" })}
          </div>
          <div className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.dataSync.migration.summary.description" })}
          </div>
        </div>
      </div>

      {props.finishExecution.error || props.settingsImportError ? (
        <MigrationWizardNotice
          messageId="settings.dataSync.migration.summary.error"
          tone="warning"
          values={{
            error: props.finishExecution.error ?? props.settingsImportError ?? "",
          }}
        />
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <SummaryCard titleId="settings.dataSync.migration.summary.sessions">
          <SummaryCounts
            counts={{
              imported: props.finishExecution.sessionImportedCount,
              skipped: props.finishExecution.sessionSkippedCount,
              failed: props.finishExecution.sessionFailedCount,
            }}
          />
        </SummaryCard>
        <SummaryCard titleId="settings.dataSync.migration.summary.skills">
          <SummaryCounts counts={props.settingsSummary.skills} />
        </SummaryCard>
        <SummaryCard titleId="settings.dataSync.migration.summary.mcp">
          <SummaryCounts counts={props.settingsSummary.mcpServers} />
        </SummaryCard>
        <SummaryCard titleId="settings.dataSync.migration.summary.commands">
          <SummaryCounts counts={props.settingsSummary.commands} />
        </SummaryCard>
        <SummaryCard titleId="settings.dataSync.migration.summary.agentsFile">
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="outline">
              {intl.formatMessage({ id: agentsFileStatusId })}
            </Badge>
          </div>
        </SummaryCard>
      </div>

      {props.failureDetails.length > 0 ? (
        <details className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base">
          <summary className="cursor-pointer select-none font-medium text-foreground">
            {intl.formatMessage(
              { id: "settings.dataSync.migration.summary.failureDetails" },
              { count: String(props.failureDetails.length) },
            )}
          </summary>
          <ul className="mt-3 space-y-2">
            {props.failureDetails.map((detail, index) => (
              <li
                key={`${detail.category}:${detail.label}:${index}`}
                className="rounded-lg border border-border bg-background px-3 py-2"
              >
                <div className="font-medium text-foreground">{detail.label}</div>
                <div className="mt-1 break-all font-mono text-ui-xs text-foreground-subtle">
                  {detail.category === "session" &&
                  detail.reason === "session_not_found_or_workspace_mismatch"
                    ? intl.formatMessage({
                        id: "settings.migration.reason.session_not_found_or_workspace_mismatch",
                      })
                    : detail.reason}
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
