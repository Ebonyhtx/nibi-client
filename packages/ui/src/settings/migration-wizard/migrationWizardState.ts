import type { SettingsSyncImportResult, NibiImportableSessionCandidate } from "@nibi/shared";
import type { MigrationWorkspaceCandidate } from "@/components/wizard/MigrationSessionsStep.js";
import type { MigrationFailureDetail } from "@/onboarding/OnboardingFlowParts.js";
import { getPathLeaf } from "@/lib/path.js";

export type MigrationWizardStep =
  | "session"
  | "skills"
  | "mcp"
  | "commands"
  | "agentsFile"
  | "migration";

export const MIGRATION_WIZARD_STEP_ORDER: readonly MigrationWizardStep[] = [
  "session",
  "skills",
  "mcp",
  "commands",
  "agentsFile",
  "migration",
] as const;

export interface MigrationWizardStepDefinition {
  key: MigrationWizardStep;
  titleId: string;
}

/** 左侧导航固定六步；插件步骤不在此展示。 */
export const MIGRATION_WIZARD_STEP_DEFINITIONS: readonly MigrationWizardStepDefinition[] = [
  { key: "session", titleId: "settings.dataSync.migration.step.session" },
  { key: "skills", titleId: "settings.dataSync.migration.step.skills" },
  { key: "mcp", titleId: "settings.dataSync.migration.step.mcp" },
  { key: "commands", titleId: "settings.dataSync.migration.step.commands" },
  { key: "agentsFile", titleId: "settings.dataSync.migration.step.agentsFile" },
  { key: "migration", titleId: "settings.dataSync.migration.step.migration" },
];

export function getMigrationWizardStepDescriptionId(step: MigrationWizardStep): string {
  switch (step) {
    case "session":
      return "settings.dataSync.migration.stepDescription.session";
    case "skills":
      return "settings.dataSync.migration.stepDescription.skills";
    case "mcp":
      return "settings.dataSync.migration.stepDescription.mcp";
    case "commands":
      return "settings.dataSync.migration.stepDescription.commands";
    case "agentsFile":
      return "settings.dataSync.migration.stepDescription.agentsFile";
    case "migration":
      return "settings.dataSync.migration.stepDescription.migration";
  }
}

export function getNextMigrationWizardStep(
  step: MigrationWizardStep,
): MigrationWizardStep | null {
  const index = MIGRATION_WIZARD_STEP_ORDER.indexOf(step);
  return MIGRATION_WIZARD_STEP_ORDER[index + 1] ?? null;
}

export function getPreviousMigrationWizardStep(
  step: MigrationWizardStep,
): MigrationWizardStep | null {
  const index = MIGRATION_WIZARD_STEP_ORDER.indexOf(step);
  return index > 0 ? (MIGRATION_WIZARD_STEP_ORDER[index - 1] ?? null) : null;
}

export function getMigrationWizardStepIndex(step: MigrationWizardStep): number {
  return MIGRATION_WIZARD_STEP_ORDER.indexOf(step);
}

export function groupSessionCandidatesByWorkspace(
  candidates: ReadonlyArray<Pick<NibiImportableSessionCandidate, "workspacePath">>,
): MigrationWorkspaceCandidate[] {
  const byWorkspace = new Map<string, MigrationWorkspaceCandidate>();

  for (const candidate of candidates) {
    const current = byWorkspace.get(candidate.workspacePath);
    if (current) {
      current.sessionCount += 1;
      continue;
    }

    byWorkspace.set(candidate.workspacePath, {
      workspacePath: candidate.workspacePath,
      label: getPathLeaf(candidate.workspacePath),
      sessionCount: 1,
    });
  }

  return [...byWorkspace.values()].sort((left, right) => right.sessionCount - left.sessionCount);
}

export interface MigrationWizardCapabilities {
  isDesktop: boolean;
  agentsFileLoading: boolean;
  agentsFileSupported: boolean;
}

/**
 * 不可用的能力必须显式说明，不把空列表伪装成“没有可迁移内容”。
 * 插件步骤不进入向导；MCP 说明来源；非 Claude 会话来源不存在。
 */
export function getMigrationWizardUnsupportedNoticeId(
  step: MigrationWizardStep,
  capabilities: MigrationWizardCapabilities,
): string | null {
  if (!capabilities.isDesktop) {
    return "settings.dataSync.migration.notice.unsupportedDesktopOnly";
  }

  if (
    step === "agentsFile" &&
    !capabilities.agentsFileLoading &&
    !capabilities.agentsFileSupported
  ) {
    return "settings.dataSync.migration.agentsFile.missingSource";
  }

  return null;
}

export function getMigrationWizardInfoNoticeIds(step: MigrationWizardStep): string[] {
  switch (step) {
    case "session":
      return ["settings.dataSync.migration.notice.sessionClaudeOnly"];
    case "skills":
      return ["settings.dataSync.migration.notice.skillsPluginsUnavailable"];
    case "mcp":
      return ["settings.dataSync.migration.notice.mcpSources"];
    case "commands":
      return [];
    case "agentsFile":
      return ["settings.dataSync.migration.notice.agentsFileOverwrite"];
    case "migration":
      return [];
  }
}

export interface MigrationWizardSelectionInput {
  selectedWorkspacePaths: readonly string[];
  skillsCount: number;
  mcpCount: number;
  commandsCount: number;
  agentsFileSelected: boolean;
}

export interface MigrationWizardSelectionSummary {
  workspaceCount: number;
  externalItemCount: number;
  agentsFileCount: number;
  /** 非会话步骤底部展示的“已选择 N 项”。 */
  totalItemCount: number;
  /** 末步“开始迁移”至少需要一项选择。 */
  canStart: boolean;
}

export function buildMigrationWizardSelectionSummary(
  input: MigrationWizardSelectionInput,
): MigrationWizardSelectionSummary {
  const externalItemCount = input.skillsCount + input.mcpCount + input.commandsCount;
  const agentsFileCount = input.agentsFileSelected ? 1 : 0;
  return {
    workspaceCount: input.selectedWorkspacePaths.length,
    externalItemCount,
    agentsFileCount,
    totalItemCount: externalItemCount + agentsFileCount,
    canStart: input.selectedWorkspacePaths.length > 0 || externalItemCount + agentsFileCount > 0,
  };
}

export function getMigrationWizardFooterSelectionCount(
  step: MigrationWizardStep,
  summary: MigrationWizardSelectionSummary,
): number {
  // 会话步骤按工作区计数；其余步骤按“本次会迁移的全部条目”计数，避免只选会话时显示 0 项。
  return step === "session" ? summary.workspaceCount : summary.workspaceCount + summary.totalItemCount;
}

export type MigrationWizardPrimaryAction = "continue" | "begin" | "finish";

export interface MigrationWizardFooterState {
  primaryAction: MigrationWizardPrimaryAction;
  primaryDisabled: boolean;
  cancelDisabled: boolean;
  navigationDisabled: boolean;
}

/**
 * 每步“继续”即使无选择也可进入下一步（上游行为）。
 * 执行中禁用取消、关闭与左侧回看；末步“开始迁移”才要求至少一项选择。
 */
export function resolveMigrationWizardFooterState(params: {
  step: MigrationWizardStep;
  running: boolean;
  finished: boolean;
  canStart: boolean;
}): MigrationWizardFooterState {
  if (params.finished) {
    return {
      primaryAction: "finish",
      primaryDisabled: false,
      cancelDisabled: false,
      navigationDisabled: false,
    };
  }

  if (params.running) {
    return {
      primaryAction: params.step === "migration" ? "begin" : "continue",
      primaryDisabled: true,
      cancelDisabled: true,
      navigationDisabled: true,
    };
  }

  if (params.step === "migration") {
    return {
      primaryAction: "begin",
      primaryDisabled: !params.canStart,
      cancelDisabled: false,
      navigationDisabled: false,
    };
  }

  return {
    primaryAction: "continue",
    primaryDisabled: false,
    cancelDisabled: false,
    navigationDisabled: false,
  };
}

export function canCloseMigrationWizard(running: boolean): boolean {
  return !running;
}

export interface MigrationWizardCategoryCounts {
  imported: number;
  skipped: number;
  failed: number;
}

export interface MigrationWizardSettingsSummary {
  skills: MigrationWizardCategoryCounts;
  mcpServers: MigrationWizardCategoryCounts;
  commands: MigrationWizardCategoryCounts;
}

function createEmptyCategoryCounts(): MigrationWizardCategoryCounts {
  return { imported: 0, skipped: 0, failed: 0 };
}

export function aggregateSettingsImportResult(
  result: SettingsSyncImportResult | null,
): MigrationWizardSettingsSummary {
  const summary: MigrationWizardSettingsSummary = {
    skills: createEmptyCategoryCounts(),
    mcpServers: createEmptyCategoryCounts(),
    commands: createEmptyCategoryCounts(),
  };

  for (const task of result?.taskResults ?? []) {
    const target =
      task.category === "skills"
        ? summary.skills
        : task.category === "mcpServers"
          ? summary.mcpServers
          : task.category === "commands"
            ? summary.commands
            : null;
    if (!target) {
      continue;
    }
    target.imported += task.importedCount;
    target.skipped += task.skippedCount;
    target.failed += task.failedCount;
  }

  return summary;
}

/** 设置导入的失败明细需要从 taskResults 的逐项结果里提取。 */
export function collectSettingsFailureDetails(
  result: SettingsSyncImportResult | null,
): MigrationFailureDetail[] {
  const details: MigrationFailureDetail[] = [];

  for (const task of result?.taskResults ?? []) {
    const category =
      task.category === "skills"
        ? ("skills" as const)
        : task.category === "mcpServers"
          ? ("mcpServers" as const)
          : task.category === "commands"
            ? ("commands" as const)
            : null;
    if (!category) {
      continue;
    }
    const items =
      category === "skills"
        ? (task.skillResults ?? [])
        : category === "mcpServers"
          ? (task.mcpServerResults ?? [])
          : (task.commandResults ?? []);
    for (const item of items) {
      if (item.status !== "failed") {
        continue;
      }
      details.push({
        category,
        label: item.name,
        reason: item.skipReason ? `${item.path} (${item.skipReason})` : item.path,
      });
    }
  }

  return details;
}

export type MigrationWizardAgentsFileOutcome = "copied" | "skipped" | "failed" | "notSelected";

export function resolveAgentsFileOutcome(params: {
  selected: boolean;
  importedCount: number;
  skippedCount: number;
  failedCount: number;
}): MigrationWizardAgentsFileOutcome {
  if (!params.selected) {
    return "notSelected";
  }
  if (params.failedCount > 0) {
    return "failed";
  }
  if (params.importedCount > 0) {
    return "copied";
  }
  if (params.skippedCount > 0) {
    return "skipped";
  }
  return "notSelected";
}

export function resolveMigrationWizardProgress(params: {
  sessionCompletedCount: number;
  sessionTotalCount: number;
  agentsFileSelected: boolean;
  agentsFileCompleted: boolean;
  externalImportSelected: boolean;
  externalImportCompleted: boolean;
  finished: boolean;
}): number {
  const totalTaskCount =
    params.sessionTotalCount +
    (params.agentsFileSelected ? 1 : 0) +
    (params.externalImportSelected ? 1 : 0);

  if (totalTaskCount === 0) {
    return params.finished ? 100 : 0;
  }

  const completedTaskCount =
    params.sessionCompletedCount +
    (params.agentsFileSelected && params.agentsFileCompleted ? 1 : 0) +
    (params.externalImportSelected && params.externalImportCompleted ? 1 : 0);

  return Math.round((completedTaskCount / totalTaskCount) * 100);
}
