import { Button } from "@/components/ui/button.js";
import {
  WizardStepHeader,
  WizardStepSidebar,
} from "@/components/wizard/WizardChrome.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";

export type OnboardingView = "welcome" | "wizard";
export type OnboardingWizardStep =
  | "session"
  | "skills-import"
  | "mcp-import"
  // 插件导入步骤未启用。
  // | "plugins-import"
  | "commands-import"
  | "agents-file"
  | "migration";

const WIZARD_STEPS: Array<{
  key: OnboardingWizardStep;
  index: number;
  titleId: string;
}> = [
  { key: "session", index: 1, titleId: "onboarding.step.session" },
  { key: "skills-import", index: 2, titleId: "onboarding.step.skillsImport" },
  { key: "mcp-import", index: 3, titleId: "onboarding.step.mcpImport" },
  // 插件导入步骤未启用。
  // { key: "plugins-import", index: 4, titleId: "onboarding.step.pluginsImport" },
  { key: "commands-import", index: 4, titleId: "onboarding.step.commandsImport" },
  { key: "agents-file", index: 5, titleId: "onboarding.step.agentsFile" },
  { key: "migration", index: 6, titleId: "onboarding.step.migration" },
];

export function getOnboardingStepMessageKey(step: OnboardingWizardStep): string {
  switch (step) {
    case "session":
      return "session";
    case "skills-import":
      return "skillsImport";
    case "mcp-import":
      return "mcpImport";
    case "commands-import":
      return "commandsImport";
    case "agents-file":
      return "agentsFile";

    case "migration":
      return "migration";
  }
}

export function OnboardingWizardSidebar(props: { currentStep: OnboardingWizardStep }) {
  return (
    <WizardStepSidebar
      steps={WIZARD_STEPS}
      currentStep={props.currentStep}
      labelId="onboarding.wizard.label"
      className="w-56"
    />
  );
}

export function OnboardingWizardHeader(props: { title: string; description: string }) {
  return <WizardStepHeader title={props.title} description={props.description} />;
}

export function OnboardingWizardFooter(props: {
  currentStep: OnboardingWizardStep;
  selectedWorkspaceCount: number;
  settingsTaskCount: number;
  finishRunning: boolean;
  finishReady: boolean;
  onBackToWelcome: () => void;
  onBackStep: () => void;
  onNextStep: () => void;
  onBeginMigration: () => void;
  onFinish: () => void;
  /** 未选任何会话或外部导入项时禁用「开始迁移」 */
  beginMigrationDisabled?: boolean;
}) {
  const { intl } = useNibiIntl();
  const isExternalImportStep = isOnboardingExternalImportStep(props.currentStep);

  const helperText =
    props.currentStep === "session"
      ? intl.formatMessage(
          { id: "onboarding.footer.workspaceSelection" },
          { count: String(props.selectedWorkspaceCount) },
        )
      : /*
         * 暂时隐藏数据迁移向导里的代理设置步骤，保留原 helper 文案分支以便后续恢复。
         * : props.currentStep === "agent-settings"
         *   ? intl.formatMessage(
         *       { id: "onboarding.footer.selection" },
         *       { count: String(props.settingsTaskCount) },
         *     )
         */
        intl.formatMessage({ id: "onboarding.footer.helper" });

  /*
   * 暂时隐藏数据迁移向导里的代理设置步骤，批量选择按钮随步骤一起隐藏。
   * const showAgentSettingsBulk =
   *   props.currentStep === "agent-settings" && props.onAgentSettingsBulkToggle;
   */

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="min-w-0 truncate text-ui-base text-foreground-subtle">{helperText}</span>
        {/*
          暂时隐藏数据迁移向导里的代理设置步骤，保留原批量选择按钮以便后续恢复。
          {showAgentSettingsBulk ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-ui-base text-foreground-subtle hover:text-foreground"
              disabled={props.agentSettingsBulkToggleDisabled}
              onClick={props.onAgentSettingsBulkToggle}
            >
              {intl.formatMessage({
                id: props.agentSettingsBulkIsClear
                  ? "settingsSync.selection.clearAll"
                  : "settingsSync.selection.selectAll",
              })}
            </Button>
          ) : null}
        */}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {props.currentStep === "session" ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={props.onBackToWelcome}
            >
              {intl.formatMessage({ id: "common.back" })}
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={props.onNextStep}
            >
              {intl.formatMessage({ id: "onboarding.action.continue" })}
            </Button>
          </>
        ) : null}

        {isExternalImportStep ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={props.onBackStep}
            >
              {intl.formatMessage({ id: "common.back" })}
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={props.onNextStep}
            >
              {intl.formatMessage({ id: "onboarding.action.continue" })}
            </Button>
          </>
        ) : null}

        {/*
          暂时隐藏数据迁移向导里的代理设置步骤，保留原开始迁移按钮分支以便后续恢复。
          {props.currentStep === "agent-settings" ? (
            <>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                className="h-10 min-w-0 px-5"
                onClick={props.onBackStep}
              >
                {intl.formatMessage({ id: "common.back" })}
              </Button>
              <Button
                type="button"
                size="lg"
                className="h-10 min-w-0 px-5"
                disabled={props.beginMigrationDisabled}
                onClick={props.onBeginMigration}
              >
                {intl.formatMessage({ id: "onboarding.action.beginMigration" })}
              </Button>
            </>
          ) : null}
        */}

        {props.currentStep === "agents-file" ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="lg"
              className="h-10 min-w-0 px-5"
              onClick={props.onBackStep}
            >
              {intl.formatMessage({ id: "common.back" })}
            </Button>
            <Button
              type="button"
              size="lg"
              className="h-10 min-w-0 px-5"
              disabled={props.beginMigrationDisabled}
              onClick={props.onBeginMigration}
            >
              {intl.formatMessage({ id: "onboarding.action.beginMigration" })}
            </Button>
          </>
        ) : null}

        {props.currentStep === "migration" && props.finishReady ? (
          <Button
            type="button"
            size="lg"
            className="h-10 min-w-0 px-5"
            disabled={props.finishRunning}
            onClick={props.onFinish}
          >
            {intl.formatMessage({ id: "settingsSync.action.finish" })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function isOnboardingExternalImportStep(step: OnboardingWizardStep): boolean {
  return (
    step === "skills-import" ||
    step === "mcp-import" ||
    // 插件导入步骤未启用。
    // step === "plugins-import" ||
    step === "commands-import"
  );
}
