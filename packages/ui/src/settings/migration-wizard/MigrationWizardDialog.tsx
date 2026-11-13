import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { AgentsFileMigrationStep } from "@/components/wizard/AgentsFileMigrationStep.js";
import { MigrationSessionsStep } from "@/components/wizard/MigrationSessionsStep.js";
import { WizardStepHeader, WizardStepSidebar } from "@/components/wizard/WizardChrome.js";
import {
  MigrationExternalImportStep,
  MigrationWizardNotice,
  MigrationWizardReviewStep,
  MigrationWizardRunStep,
  MigrationWizardSummaryStep,
  MigrationWizardUnsupportedStep,
} from "@/settings/migration-wizard/MigrationWizardSteps.js";
import {
  getMigrationWizardFooterSelectionCount,
  MIGRATION_WIZARD_STEP_DEFINITIONS,
  type MigrationWizardStep,
} from "@/settings/migration-wizard/migrationWizardState.js";
import {
  useMigrationWizard,
  type MigrationWizardController,
} from "@/settings/migration-wizard/useMigrationWizard.js";

export function MigrationWizardDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  const { intl } = useNibiIntl();
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (!props.open) {
      setRunning(false);
    }
  }, [props.open]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(nextOpen) => {
        // 执行中禁用遮罩点击、Esc 和右上角关闭。
        if (!nextOpen && running) {
          return;
        }
        props.onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        showCloseButton={!running}
        className="h-[600px] max-h-[calc(100vh-2rem)] w-full max-w-[900px] gap-0 overflow-hidden rounded-2xl p-0"
        data-testid="settings-data-sync-migration-dialog"
      >
        <DialogTitle className="sr-only">
          {intl.formatMessage({ id: "settings.dataSync.migrationTitle" })}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {intl.formatMessage({ id: "settings.dataSync.migrationDescription" })}
        </DialogDescription>
        <MigrationWizardContent
          workspacePath={props.workspacePath}
          workspaceIdentity={props.workspaceIdentity}
          isDesktop={Boolean(props.isDesktop)}
          onClose={() => props.onOpenChange(false)}
          onRunningChange={setRunning}
        />
      </DialogContent>
    </Dialog>
  );
}

function MigrationWizardContent(props: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop: boolean;
  onClose: () => void;
  onRunningChange: (running: boolean) => void;
}) {
  const { intl } = useNibiIntl();
  const wizard = useMigrationWizard({
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
    isDesktop: props.isDesktop,
  });

  useEffect(() => {
    props.onRunningChange(wizard.finishExecution.running);
  }, [props.onRunningChange, wizard.finishExecution.running]);

  useEffect(() => () => props.onRunningChange(false), [props.onRunningChange]);

  const body = renderWizardStepBody(wizard, props);
  const footer = wizard.footerState;
  const helperText =
    wizard.step === "session"
      ? intl.formatMessage(
          { id: "settings.dataSync.migration.footer.workspaceSelection" },
          { count: String(wizard.workspaceSelection.selectedWorkspaceCount) },
        )
      : intl.formatMessage(
          { id: "settings.dataSync.migration.footer.itemSelection" },
          {
            count: String(
              getMigrationWizardFooterSelectionCount(wizard.step, wizard.selectionSummary),
            ),
          },
        );
  const primaryLabelId =
    footer.primaryAction === "finish"
      ? "settings.dataSync.migration.footer.finish"
      : footer.primaryAction === "begin"
        ? "settings.dataSync.migration.footer.begin"
        : "settings.dataSync.migration.footer.continue";

  return (
    <div className="flex h-full min-h-0 min-w-0">
      <WizardStepSidebar
        steps={MIGRATION_WIZARD_STEP_DEFINITIONS}
        currentStep={wizard.step}
        labelId="settings.dataSync.migration.wizardLabel"
        className="w-[200px]"
        currentStepBordered
        onSelectStep={wizard.goToStep}
        navigationDisabled={footer.navigationDisabled}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-hidden p-6">
        <WizardStepHeader
          title={intl.formatMessage({ id: wizard.stepTitleId })}
          description={intl.formatMessage({ id: wizard.stepDescriptionId })}
        />
        <div className="min-h-0 flex-1 overflow-hidden">{body}</div>
        <div className="shrink-0 border-t border-border pt-4">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-ui-base text-foreground-subtle">
              {helperText}
            </span>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="h-10 min-w-0 px-5"
                disabled={footer.cancelDisabled}
                onClick={props.onClose}
              >
                {intl.formatMessage({ id: "settings.dataSync.migration.footer.cancel" })}
              </Button>
              <Button
                type="button"
                size="lg"
                className="h-10 min-w-0 px-5"
                disabled={footer.primaryDisabled}
                onClick={() => {
                  if (footer.primaryAction === "continue") {
                    wizard.goToNextStep();
                    return;
                  }
                  if (footer.primaryAction === "begin") {
                    void wizard.beginMigration();
                    return;
                  }
                  props.onClose();
                }}
              >
                {intl.formatMessage({ id: primaryLabelId })}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function renderWizardStepBody(
  wizard: MigrationWizardController,
  props: { workspacePath: string | null; isDesktop: boolean },
) {
  switch (wizard.step) {
    case "session":
      return (
        <MigrationSessionsStep
          migration={wizard.sessionMigration}
          workspaceCandidates={wizard.workspaceCandidates}
          selectedWorkspacePaths={wizard.workspaceSelection.selectedWorkspacePaths}
          labels={{
            emptyId: "settings.dataSync.migration.sessions.empty",
            countId: "settings.dataSync.migration.sessions.count",
            unlimitedId: "settings.dataSync.migration.sessions.unlimited",
            chooseWorkspaceId: "settings.dataSync.migration.sessions.chooseWorkspace",
          }}
          onToggleWorkspace={wizard.workspaceSelection.toggleWorkspace}
          onSelectAll={wizard.workspaceSelection.selectAllWorkspaces}
          onClearSelection={wizard.workspaceSelection.clearWorkspaceSelection}
          noticeId={wizard.unsupportedNoticeId ?? wizard.infoNoticeIds[0]}
          showRowIcon
        />
      );
    case "skills":
    case "mcp":
    case "commands":
      return renderExternalImportStep(wizard, props);
    case "agentsFile":
      if (!props.isDesktop) {
        return (
          <MigrationWizardUnsupportedStep
            messageId={
              wizard.unsupportedNoticeId ??
              "settings.dataSync.migration.notice.unsupportedDesktopOnly"
            }
          />
        );
      }
      return (
        <AgentsFileMigrationStep
          migration={wizard.agentsFileMigration}
          labels={{
            copyTitleId: "settings.dataSync.migration.agentsFile.copyTitle",
            sourceLabelId: "settings.dataSync.migration.agentsFile.sourceLabel",
            targetLabelId: "settings.dataSync.migration.agentsFile.targetLabel",
            loadingId: "settings.dataSync.migration.agentsFile.loading",
            missingSourceId: "settings.dataSync.migration.agentsFile.missingSource",
            errorId: "settings.dataSync.migration.agentsFile.error",
          }}
          noticeId={wizard.infoNoticeIds[0]}
        />
      );
    case "migration":
      if (wizard.finishExecution.finished) {
        return (
          <MigrationWizardSummaryStep
            finishExecution={wizard.finishExecution}
            settingsSummary={wizard.settingsSummary}
            agentsFileOutcome={wizard.agentsFileOutcome}
            failureDetails={wizard.failureDetails}
            settingsImportError={wizard.settingsImportError}
          />
        );
      }
      if (wizard.finishExecution.started) {
        return (
          <MigrationWizardRunStep
            overallProgress={wizard.overallProgress}
            finishExecution={wizard.finishExecution}
            agentsFileSelected={wizard.agentsFileMigration.selected}
            externalImportSelected={wizard.externalImportSelected}
            externalImportCompleted={wizard.externalImportCompleted}
          />
        );
      }
      return (
        <MigrationWizardReviewStep
          workspaceCount={wizard.workspaceSelection.selectedWorkspaceCount}
          skillsCount={wizard.skillsImportState.selectedCount}
          mcpCount={wizard.mcpImportState.selectedCount}
          commandsCount={wizard.commandsImportState.selectedCount}
          agentsFileSelected={wizard.agentsFileMigration.selected}
        />
      );
  }
}

function renderExternalImportStep(
  wizard: MigrationWizardController,
  props: { workspacePath: string | null; isDesktop: boolean },
) {
  if (!props.isDesktop) {
    return (
      <MigrationWizardUnsupportedStep
        messageId={
          wizard.unsupportedNoticeId ?? "settings.dataSync.migration.notice.unsupportedDesktopOnly"
        }
      />
    );
  }

  const step: Extract<MigrationWizardStep, "skills" | "mcp" | "commands"> =
    wizard.step === "skills" ? "skills" : wizard.step === "mcp" ? "mcp" : "commands";
  const category = step === "skills" ? "skills" : step === "mcp" ? "mcpServers" : "commands";
  const state =
    step === "skills"
      ? wizard.skillsImportState
      : step === "mcp"
        ? wizard.mcpImportState
        : wizard.commandsImportState;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {wizard.infoNoticeIds.map((messageId) => (
        <MigrationWizardNotice key={messageId} messageId={messageId} />
      ))}
      <div className="min-h-0 flex-1">
        <MigrationExternalImportStep
          category={category}
          state={state}
          workspacePath={props.workspacePath}
        />
      </div>
    </div>
  );
}
