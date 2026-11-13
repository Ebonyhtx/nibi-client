import type { NibiSessionStateSnapshot } from "@nibi/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { repairImportedClaudeSessionSnapshot } from "#src/session/claude-native/importedClaudeHistoryRepair.js";
import type { INibiAgentService } from "#src/nibi-agent/nibiAgent.js";
import type {
  NibiSessionReadParams,
  NibiSessionResumeParams,
} from "#src/nibi-session/nibiSession.js";

const logger = createServiceLogger("nibi-session-service");

export async function repairEmptyImportedClaudeSessionSnapshot(params: {
  agentService: INibiAgentService;
  snapshot: NibiSessionStateSnapshot;
  target: NibiSessionResumeParams | NibiSessionReadParams;
}): Promise<NibiSessionStateSnapshot> {
  const repaired = await repairImportedClaudeSessionSnapshot({
    snapshot: params.snapshot,
    target: {
      workspacePath: params.target.workspacePath,
      workspaceIdentity: params.target.workspaceIdentity,
      taskId: params.target.sessionId,
      ...("mcpServers" in params.target && params.target.mcpServers
        ? { mcpServers: params.target.mcpServers }
        : {}),
    },
    createSession: (input) => params.agentService.createSession(input),
    onRepair: (history) => {
      logger.warn(
        undefined,
        `[nibi-session-service] Claude 导入 session 历史异常，按 ${history.source} 回填 taskId=${params.target.sessionId}`,
      );
    },
  });
  return repaired ?? params.snapshot;
}
