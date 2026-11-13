/**
 * Nibi Agent Slash Commands 便捷 hook
 *
 * 返回当前 workspace 下 Agent 广播的可用 slash commands 列表。
 */
import { useNibiSessionStore, selectWorkspaceNibiState } from "../store/nibiSessionStore.js";

export function useSlashCommands(workspacePath: string, workspaceIdentity?: string) {
  return useNibiSessionStore(
    (state) => selectWorkspaceNibiState(state, workspacePath, workspaceIdentity).slashCommands,
  );
}
