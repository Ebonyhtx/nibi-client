import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClaudeSessionMigration } from "@/hooks/useClaudeSessionMigration.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOnboardingAgentsFileMigration } from "@/onboarding/useOnboardingAgentsFileMigration.js";
import {
  shouldAutoScanSessions,
  useOnboardingMigration,
} from "@/onboarding/useOnboardingMigration.js";
import { useExternalAgentImportCategoryState } from "@/settings/ExternalAgentImportDialog.js";
import { useWorkspaceSessionSelection } from "@/components/wizard/useWorkspaceSessionSelection.js";
import {
  aggregateSettingsImportResult,
  buildMigrationWizardSelectionSummary,
  collectSettingsFailureDetails,
  getMigrationWizardUnsupportedNoticeId,
  getMigrationWizardStepDescriptionId,
  getMigrationWizardStepIndex,
  getMigrationWizardInfoNoticeIds,
  getNextMigrationWizardStep,
  groupSessionCandidatesByWorkspace,
  MIGRATION_WIZARD_STEP_DEFINITIONS,
  resolveAgentsFileOutcome,
  resolveMigrationWizardFooterState,
  resolveMigrationWizardProgress,
  type MigrationWizardStep,
} from "@/settings/migration-wizard/migrationWizardState.js";
import { useMigrationWizardSettingsImport } from "@/settings/migration-wizard/useMigrationWizardSettingsImport.js";

export function useMigrationWizard(params: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop: boolean;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const { settingsSyncService } = useServices();
  const [step, setStep] = useState<MigrationWizardStep>("session");
  const autoScannedSessionStepRef = useRef(false);

  const sessionMigration = useClaudeSessionMigration({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    isDesktop: params.isDesktop,
  });

  // 只有进入对应步骤才启用扫描，避免一开弹窗就全量扫描 skills / MCP / commands。
  const skillsImportState = useExternalAgentImportCategoryState({
    category: "skills",
    enabled: params.isDesktop && step === "skills",
    settingsSyncService,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });
  const mcpImportState = useExternalAgentImportCategoryState({
    category: "mcpServers",
    enabled: params.isDesktop && step === "mcp",
    settingsSyncService,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });
  const commandsImportState = useExternalAgentImportCategoryState({
    category: "commands",
    enabled: params.isDesktop && step === "commands",
    settingsSyncService,
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });
  const agentsFileMigration = useOnboardingAgentsFileMigration({
    enabled: params.isDesktop && step === "agentsFile",
    workspacePath: params.workspacePath ?? undefined,
    workspaceIdentity: params.workspaceIdentity,
  });

  const settingsImport = useMigrationWizardSettingsImport({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  });

  const externalImportSelections = useMemo(
    () => [
      ...skillsImportState.selections,
      ...mcpImportState.selections,
      ...commandsImportState.selections,
    ],
    [commandsImportState.selections, mcpImportState.selections, skillsImportState.selections],
  );

  const workspaceCandidates = useMemo(
    () => groupSessionCandidatesByWorkspace(sessionMigration.candidates),
    [sessionMigration.candidates],
  );
  const workspaceSelection = useWorkspaceSessionSelection(sessionMigration.candidates);

  const { finishExecution, startUnifiedMigration } = useOnboardingMigration(
    "wizard",
    "migration",
    workspaceSelection.selectedWorkspacePaths,
    externalImportSelections,
    sessionMigration,
    agentsFileMigration,
    settingsImport,
    { includeSettingsSelections: false, autoStart: false },
  );

  useEffect(() => {
    if (step !== "session") {
      autoScannedSessionStepRef.current = false;
      return;
    }

    if (
      !shouldAutoScanSessions({
        isSessionStep: true,
        supported: sessionMigration.supportState.supported,
        isScanning: sessionMigration.isScanning,
        candidateCount: sessionMigration.candidates.length,
        scanError: sessionMigration.scanError,
        hasAutoScannedInCurrentEntry: autoScannedSessionStepRef.current,
      })
    ) {
      return;
    }

    autoScannedSessionStepRef.current = true;
    void sessionMigration.scan();
  }, [
    sessionMigration.candidates.length,
    sessionMigration.isScanning,
    sessionMigration.scan,
    sessionMigration.scanError,
    sessionMigration.supportState.supported,
    step,
  ]);

  const selectionSummary = useMemo(
    () =>
      buildMigrationWizardSelectionSummary({
        selectedWorkspacePaths: workspaceSelection.selectedWorkspacePaths,
        skillsCount: skillsImportState.selectedCount,
        mcpCount: mcpImportState.selectedCount,
        commandsCount: commandsImportState.selectedCount,
        agentsFileSelected: agentsFileMigration.selected,
      }),
    [
      agentsFileMigration.selected,
      commandsImportState.selectedCount,
      mcpImportState.selectedCount,
      skillsImportState.selectedCount,
      workspaceSelection.selectedWorkspacePaths,
    ],
  );

  const capabilities = useMemo(
    () => ({
      isDesktop: params.isDesktop,
      agentsFileLoading: agentsFileMigration.loading,
      agentsFileSupported: agentsFileMigration.status?.supported === true,
    }),
    [agentsFileMigration.loading, agentsFileMigration.status?.supported, params.isDesktop],
  );

  const unsupportedNoticeId = getMigrationWizardUnsupportedNoticeId(step, capabilities);
  const infoNoticeIds = getMigrationWizardInfoNoticeIds(step);
  const footerState = resolveMigrationWizardFooterState({
    step,
    running: finishExecution.running,
    finished: finishExecution.finished,
    canStart: selectionSummary.canStart,
  });

  const settingsSummary = useMemo(
    () => aggregateSettingsImportResult(settingsImport.state.result),
    [settingsImport.state.result],
  );
  const failureDetails = useMemo(
    () => [
      ...finishExecution.failureDetails,
      ...collectSettingsFailureDetails(settingsImport.state.result),
    ],
    [finishExecution.failureDetails, settingsImport.state.result],
  );
  const agentsFileOutcome = resolveAgentsFileOutcome({
    selected: agentsFileMigration.selected,
    importedCount: finishExecution.agentsFileImportedCount,
    skippedCount: finishExecution.agentsFileSkippedCount,
    failedCount: finishExecution.agentsFileFailedCount,
  });
  const externalImportSelected = externalImportSelections.length > 0;
  const externalImportCompleted =
    externalImportSelected &&
    (settingsImport.state.result !== null || finishExecution.error !== null);
  const overallProgress = resolveMigrationWizardProgress({
    sessionCompletedCount: finishExecution.sessionCompletedCount,
    sessionTotalCount: finishExecution.sessionTotalCount,
    agentsFileSelected: agentsFileMigration.selected,
    agentsFileCompleted: finishExecution.agentsFileCompletedCount > 0,
    externalImportSelected,
    externalImportCompleted,
    finished: finishExecution.finished,
  });

  const stepDescriptionId = getMigrationWizardStepDescriptionId(step);
  const stepTitleId =
    MIGRATION_WIZARD_STEP_DEFINITIONS.find((item) => item.key === step)?.titleId ??
    "settings.dataSync.migration.step.session";

  const goToNextStep = useCallback(() => {
    setStep((current) => getNextMigrationWizardStep(current) ?? current);
  }, []);

  const goToStep = useCallback(
    (target: MigrationWizardStep) => {
      if (finishExecution.running || finishExecution.finished) {
        return;
      }
      setStep((current) =>
        getMigrationWizardStepIndex(target) < getMigrationWizardStepIndex(current)
          ? target
          : current,
      );
    },
    [finishExecution.finished, finishExecution.running],
  );

  const beginMigration = useCallback(async () => {
    if (finishExecution.started || finishExecution.running || !selectionSummary.canStart) {
      return;
    }

    if (agentsFileMigration.selected) {
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({
          id: "settings.dataSync.migration.agentsFile.confirmTitle",
        }),
        description: intl.formatMessage(
          { id: "settings.dataSync.migration.agentsFile.confirmDescription" },
          {
            source: agentsFileMigration.status?.sourcePath ?? "~/.claude/CLAUDE.md",
            target: agentsFileMigration.status?.targetPath ?? "~/.nibi/AGENTS.md",
          },
        ),
        confirmLabel: intl.formatMessage({
          id: "settings.dataSync.migration.agentsFile.confirmAction",
        }),
        cancelLabel: intl.formatMessage({
          id: "settings.dataSync.migration.footer.cancel",
        }),
      });
      if (!confirmed) {
        return;
      }
    }

    await startUnifiedMigration();
  }, [
    agentsFileMigration.selected,
    agentsFileMigration.status?.sourcePath,
    agentsFileMigration.status?.targetPath,
    confirmDialog,
    finishExecution.running,
    finishExecution.started,
    intl,
    selectionSummary.canStart,
    startUnifiedMigration,
  ]);

  return {
    step,
    stepTitleId,
    stepDescriptionId,
    goToNextStep,
    goToStep,
    sessionMigration,
    workspaceCandidates,
    workspaceSelection,
    skillsImportState,
    mcpImportState,
    commandsImportState,
    agentsFileMigration,
    externalImportSelections,
    selectionSummary,
    unsupportedNoticeId,
    infoNoticeIds,
    footerState,
    finishExecution,
    settingsSummary,
    settingsImportError: settingsImport.state.error,
    failureDetails,
    agentsFileOutcome,
    overallProgress,
    externalImportSelected,
    externalImportCompleted,
    beginMigration,
  };
}

export type MigrationWizardController = ReturnType<typeof useMigrationWizard>;
