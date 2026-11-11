import { useCallback } from "react";
import { RefreshCw } from "lucide-react";
import {
  buildRemoteHostWorkspaceIdentity,
  type ProjectRowAction,
  type ProjectSidebarProps,
  type RemoteProjectDirectory,
  type VirtualProject,
} from "@/project-sidebar/contract.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useOpenDataSyncSettings } from "@/hooks/useOpenDataSyncSettings.js";
import { shouldShowDataSyncEntry } from "@/lib/dataSyncEntry.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

type Kind = "skills" | "mcp" | "plugins";

/**
 * 项目侧栏的同步动作。
 *
 * 根因：旧实现为每条远程项目单独挂载同步弹窗，项目断连后弹窗虽然卸载，
 * 写入路径仍与设置页数据同步并存。现在动作只负责跳到统一数据同步页并预选分类。
 */
export function useProjectRemoteSync(
  props: Pick<ProjectSidebarProps, "isWebRemoteControl">,
  directory: RemoteProjectDirectory,
) {
  const base = useBaseWorkspaceServices();
  const sessions = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const { intl } = useZCodeIntl();
  const openDataSync = useOpenDataSyncSettings();
  const hasLocalSourceService = Boolean(base.skillSyncService);
  const actions = useCallback(
    (project: VirtualProject): ProjectRowAction[] => {
      const host = directory.hosts.find(
        (item) => item.id === project.hostId && item.connectionStatus === "online",
      );
      if (!host) return [];
      return project.roots.flatMap((root, index) => {
        const identity = buildRemoteHostWorkspaceIdentity(host.id, root.rootPath);
        const session = Object.values(sessions).find((item) => item.workspaceIdentity === identity);
        if (
          !shouldShowDataSyncEntry({
            remoteSessionId: session?.sessionId,
            remoteTarget: host.target,
            clientMode: props.isWebRemoteControl ? "web-remote-replayable" : "desktop-continuous",
            hasLocalSourceService,
          }) ||
          !session
        )
          return [];
        return (["skills", "mcp", "plugins"] as const).map((kind: Kind) => ({
          id: `sync-${kind}-${index}`,
          icon: RefreshCw,
          label: `${intl.formatMessage({ id: { skills: "remote.syncSkills", mcp: "remote.syncMcp", plugins: "remote.syncPlugins" }[kind] })}${project.roots.length > 1 ? ` · ${root.rootPath}` : ""}`,
          run: () => openDataSync(kind),
        }));
      });
    },
    [directory.hosts, sessions, props.isWebRemoteControl, hasLocalSourceService, intl, openDataSync],
  );
  return { actions };
}
