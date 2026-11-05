import type {
  IPlatformService,
  LoadCliMcpFromUserDirectoryRequest,
  NativeMcpServerRecord,
  SaveCliMcpToUserDirectoryRequest,
} from "@nibi/shared";
import type { IMcpSyncService } from "@nibi/services";
import { logger } from "@/logger.js";

export type McpPlatformService = Pick<
  IPlatformService,
  "loadMcpFromUserDirectory" | "saveMcpToUserDirectory"
>;

export type McpDirectoryService = Pick<
  IMcpSyncService,
  "loadMcpFromUserDirectory" | "saveMcpToUserDirectory"
>;

export async function persistCliMcpToUserDirectory(
  platform: McpPlatformService | null,
  payload: SaveCliMcpToUserDirectoryRequest,
  directoryService?: McpDirectoryService | null,
): Promise<boolean> {
  if (directoryService) {
    await directoryService.saveMcpToUserDirectory(payload);
    return true;
  }
  if (!platform?.saveMcpToUserDirectory) {
    logger.warn(
      "[mcpStore] platform MCP save unavailable, skip persisting CLI MCP to user directory",
    );
    return false;
  }

  const result = await platform.saveMcpToUserDirectory(payload);
  if (!result?.success) {
    throw new Error(result?.error ?? "Failed to persist MCP config");
  }
  return true;
}

export async function fetchNativeMcpServers(
  platform: McpPlatformService | null,
  payload?: LoadCliMcpFromUserDirectoryRequest,
  directoryService?: McpDirectoryService | null,
): Promise<NativeMcpServerRecord[]> {
  if (directoryService) {
    const result = await directoryService.loadMcpFromUserDirectory(payload);
    return result.servers ?? [];
  }
  if (!platform?.loadMcpFromUserDirectory) {
    return [];
  }
  const result = await platform.loadMcpFromUserDirectory(payload);
  return result.servers ?? [];
}

