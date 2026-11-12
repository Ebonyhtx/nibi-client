import { CheckIcon, Loader2Icon } from "lucide-react";
import { Progress } from "@/components/ui/progress.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsSyncSelectionStep } from "@/settings-sync/SettingsSyncSelectionStep.js";
import type { useSettingsSync } from "@/hooks/useSettingsSync.js";
import {
  ExternalAgentImportSelectionPanel,
  type ExternalAgentImportCategoryState,
  type ImportResourceCategory,
} from "@/settings/ExternalAgentImportDialog.js";

export { OnboardingWelcomeView } from "@/onboarding/OnboardingWelcomeView.js";
export { MigrationSessionsStep as OnboardingSessionsStep } from "@/components/wizard/MigrationSessionsStep.js";
export type { MigrationWorkspaceCandidate as OnboardingWorkspaceCandidate } from "@/components/wizard/MigrationSessionsStep.js";

export interface MigrationFailureDetail {
  category: "session" | "skills" | "mcpServers" | "commands" | "agentsFile";
  label: string;
  reason: string;
}

export interface FinishExecutionState {
  started: boolean;
  running: boolean;
  finished: boolean;
  sessionCompletedCount: number;
  sessionTotalCount: number;
  sessionImportedCount: number;
  sessionSkippedCount: number;
  sessionFailedCount: number;
  agentsFileCompletedCount: number;
  agentsFileTotalCount: number;
  agentsFileImportedCount: number;
  agentsFileSkippedCount: number;
  agentsFileFailedCount: number;
  currentTaskLabel: string | null;
  error: string | null;
  /** 会话 / AGENTS.md 的阶段失败明细；设置导入明细由调用方从导入结果汇总。 */
  failureDetails: MigrationFailureDetail[];
}

export function createInitialFinishExecutionState(): FinishExecutionState {
  return {
    started: false,
    running: false,
    finished: false,
    sessionCompletedCount: 0,
    sessionTotalCount: 0,
    sessionImportedCount: 0,
    sessionSkippedCount: 0,
    sessionFailedCount: 0,
    agentsFileCompletedCount: 0,
    agentsFileTotalCount: 0,
    agentsFileImportedCount: 0,
    agentsFileSkippedCount: 0,
    agentsFileFailedCount: 0,
    currentTaskLabel: null,
    error: null,
    failureDetails: [],
  };
}

export function OnboardingAgentSettingsStep(props: {
  settingsSync: ReturnType<typeof useSettingsSync>;
}) {
  const { intl } = useZCodeIntl();

  const { discovery, loading, error } = props.settingsSync.state;

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col rounded-xl bg-background border border-border overflow-y-auto">
      <div className="flex min-h-0 flex-1 flex-col gap-1 border-b border-border p-2">
        {discovery ? (
          <SettingsSyncSelectionStep
            discovery={discovery}
            selectedKeys={props.settingsSync.state.selectedKeys}
            onToggleSelection={props.settingsSync.actions.toggleSelection}
            onSetCategorySelectionAllAgents={
              props.settingsSync.actions.setCategorySelectionAllAgents
            }
          />
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-ui-base text-foreground-subtle">
            <Loader2Icon className="size-4 animate-spin" />
            <span>{intl.formatMessage({ id: "common.loading" })}</span>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-foreground">
            {error}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border bg-background-alt px-4 py-8 text-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "onboarding.agentSettings.empty" })}
          </div>
        )}
      </div>
    </div>
  );
}

export function OnboardingExternalAgentImportStep(props: {
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

export function OnboardingMigrationStep(props: {
  overallProgress: number;
  finishExecution: FinishExecutionState;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex h-full min-h-0 flex-col justify-center">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-5 rounded-xl bg-background border border-border px-6 py-6">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-ui-base text-foreground-subtle">
            <span>
              {intl.formatMessage({
                id: "settingsSync.importing.progressLabel",
              })}
            </span>
            <span>{props.overallProgress}%</span>
          </div>
          <Progress value={props.overallProgress} className="h-2 rounded-full bg-card" />
        </div>

        <div className="flex gap-3">
          <Loader2Icon className="size-5 animate-spin" />
          <div>
            <div className="text-ui-base font-medium text-foreground">
              {intl.formatMessage(
                { id: "onboarding.migration.progress" },
                { progress: String(props.overallProgress) },
              )}
            </div>
            <div className="mt-1 text-ui-base text-foreground-subtle">
              {props.finishExecution.currentTaskLabel ??
                intl.formatMessage({ id: "onboarding.migration.ready" })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function OnboardingFinishStep(props: {
  overallProgress: number;
  finishExecution: FinishExecutionState;
  settingsImportedCount: number;
  settingsSkippedCount: number;
  settingsFailedCount: number;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex h-full min-h-0 flex-col gap-8 pt-8">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-success text-success-foreground">
          <CheckIcon className="size-7" />
        </div>
        <div className="text-2xl font-medium text-foreground">
          {intl.formatMessage({ id: "onboarding.finish.done" })}
        </div>
        <div className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "onboarding.finish.ready" })}
        </div>
        {props.finishExecution.error ? (
          <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-ui-base text-foreground">
            {props.finishExecution.error}
          </div>
        ) : null}
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-xl border border-border bg-card px-4 py-4">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "onboarding.finish.summary.sessions" })}
          </div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.imported" })}</span>
            <span>{props.finishExecution.sessionImportedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.skipped" })}</span>
            <span>{props.finishExecution.sessionSkippedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.failed" })}</span>
            <span>{props.finishExecution.sessionFailedCount}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-4">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "onboarding.finish.summary.agentsFile" })}
          </div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.imported" })}</span>
            <span>{props.finishExecution.agentsFileImportedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.skipped" })}</span>
            <span>{props.finishExecution.agentsFileSkippedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.failed" })}</span>
            <span>{props.finishExecution.agentsFileFailedCount}</span>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card px-4 py-4">
          <div className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "onboarding.finish.summary.settings" })}
          </div>
          <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.imported" })}</span>
            <span>{props.settingsImportedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.skipped" })}</span>
            <span>{props.settingsSkippedCount}</span>
            <span>{intl.formatMessage({ id: "onboarding.finish.summary.label.failed" })}</span>
            <span>{props.settingsFailedCount}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
