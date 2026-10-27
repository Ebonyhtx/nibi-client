import type { ISkillsService } from "@nibi/services";
import {
  normalizeAgentProviderToZCodeAgent,
  NIBI_AGENT_PROVIDER,
  type ZCodeProvider,
} from "@nibi/shared";
import { useSkillStore } from "@/store/skillStore.js";

export async function refreshSharedSkillStoreForWorkspace(params: {
  workspacePath: string | null | undefined;
  workspaceIdentity?: string | null;
  skillsService: ISkillsService;
  provider?: ZCodeProvider;
}): Promise<void> {
  const workspacePath = params.workspacePath;
  if (!workspacePath) {
    return;
  }
  const skillStore = useSkillStore.getState();
  const normalizedWorkspaceIdentity = params.workspaceIdentity?.trim() || null;
  const normalizedProvider = normalizeAgentProviderToZCodeAgent(
    params.provider ?? NIBI_AGENT_PROVIDER,
  );
  const refreshes: Promise<void>[] = [];

  if (
    skillStore.workspacePath === workspacePath &&
    skillStore.workspaceIdentity === normalizedWorkspaceIdentity &&
    skillStore.loadedWorkspacePath === workspacePath &&
    skillStore.loadedWorkspaceIdentity === normalizedWorkspaceIdentity &&
    normalizeAgentProviderToZCodeAgent(skillStore.provider) === normalizedProvider &&
    skillStore.loadedProvider === normalizedProvider
  ) {
    refreshes.push(
      skillStore.refresh(params.skillsService, normalizedWorkspaceIdentity ?? undefined),
    );
  }

  await Promise.all(refreshes);
}
