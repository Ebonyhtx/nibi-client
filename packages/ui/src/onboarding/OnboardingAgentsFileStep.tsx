import { AgentsFileMigrationStep } from "@/components/wizard/AgentsFileMigrationStep.js";
import type { OnboardingAgentsFileMigrationState } from "@/onboarding/useOnboardingAgentsFileMigration.js";

export function OnboardingAgentsFileStep(props: { migration: OnboardingAgentsFileMigrationState }) {
  return (
    <AgentsFileMigrationStep
      migration={props.migration}
      labels={{
        copyTitleId: "onboarding.agentsFile.copyTitle",
        sourceLabelId: "onboarding.agentsFile.sourceLabel",
        targetLabelId: "onboarding.agentsFile.targetLabel",
        loadingId: "onboarding.agentsFile.loading",
        missingSourceId: "onboarding.agentsFile.missingSource",
        errorId: "onboarding.agentsFile.error",
      }}
    />
  );
}
