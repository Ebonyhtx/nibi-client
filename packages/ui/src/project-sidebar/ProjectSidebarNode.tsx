import { memo } from "react";
import { shallow } from "zustand/shallow";
import { Plug } from "lucide-react";
import type {
  IProjectService,
  IRemoteProjectService,
  ProjectRowAction,
  ProjectSidebarProps,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { buildRemoteHostWorkspaceIdentity } from "@/project-sidebar/contract.js";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import type { ProjectNodeProps } from "@/project-sidebar/ProjectNodeContent.js";
import { projectSourceServerId } from "@/project-sidebar/view.js";
import { projectDataCleanupAvailable } from "@/project-sidebar/project-data-cleanup.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";

export function runProjectAction(body: () => Promise<void>) {
  void body().catch((cause) => {
    logger.error("[project-sidebar] 操作失败", cause);
    toast(String(cause));
  });
}

type Props = Pick<
  ProjectNodeProps,
  | "project"
  | "remoteHost"
  | "deviceLabel"
  | "diagnostics"
  | "expanded"
  | "hasUnread"
  | "availability"
  | "tasks"
  | "onSelect"
  | "refresh"
> &
  Pick<
    ProjectSidebarProps,
    "isDesktop" | "isWebRemoteControl" | "onCreateTask" | "onReconnectRemoteWorkspace"
  > & {
    service?: IProjectService;
    remoteService?: IRemoteProjectService;
    onExpandedChange(project: VirtualProject, expanded: boolean): void;
    onEdit(value: { project: VirtualProject }): void;
    onViewFiles(project: VirtualProject, rootPath: string): Promise<void>;
    remoteActions(project: VirtualProject): ProjectRowAction[];
    /** 本机项目删除与数据清理共用同一对话框；远端项目仍走原有即时删除。 */
    onOpenProjectData?(project: VirtualProject, mode: "delete" | "cleanup"): void;
    /** 旧内核明确不支持时 false；未知/支持都显示入口。 */
    dataCleanupSupported?: boolean | "unknown";
  };

// Bug 根因：任务活动每秒更新目录，父组件随之重建所有项目的菜单与回调，穿透内容层 memo。
// 按项目隔离装配；数组只比较元素与顺序，其余属性完整比较，真实状态和回调变化仍需更新。
export const ProjectSidebarNode = memo(
  function ProjectSidebarNode({
    project,
    remoteHost,
    service,
    remoteService,
    isDesktop,
    isWebRemoteControl,
    onCreateTask,
    onReconnectRemoteWorkspace,
    onExpandedChange,
    onEdit,
    onViewFiles,
    remoteActions,
    onOpenProjectData,
    dataCleanupSupported,
    ...display
  }: Props) {
    const { intl } = useZCodeIntl();
    const confirm = useConfirmDialog();
    const tabStore = useTabStoreApi();
    const msg = (id: string) => intl.formatMessage({ id: `project.${id}` });
    const sourceServerId = projectSourceServerId(project);
    const { refresh, availability } = display;
    const localProject = project.hostId === "local" && project.legacySingleRoot !== true;
    const cleanupAvailable =
      projectDataCleanupAvailable({ project, supported: dataCleanupSupported }) &&
      availability?.online !== false;
    return (
      <ProjectNode
        {...display}
        project={project}
        remoteHost={remoteHost}
        onOpenDeviceSettings={
          isDesktop && sourceServerId
            ? () => {
                setPendingSettingsSectionIntent("remoteDevices", { sourceServerId });
                tabStore.getState().openSettingsTab();
              }
            : undefined
        }
        additionalActions={[
          ...remoteActions(project),
          ...(remoteHost && remoteHost.connectionStatus !== "online"
            ? [
                {
                  id: "connect",
                  label: msg("connect"),
                  icon: Plug,
                  run: () =>
                    runProjectAction(async () => {
                      // 远端连接仍经现有意图分派，保留缺凭据、安装和升级流程。
                      if (isDesktop && project.roots[0]) {
                        await onReconnectRemoteWorkspace(
                          buildRemoteHostWorkspaceIdentity(
                            project.hostId,
                            project.roots[0].rootPath,
                          ),
                        );
                      } else {
                        await remoteService!.connectHost(project.hostId);
                      }
                      await refresh();
                    }),
                },
              ]
            : []),
        ]}
        onExpandedChange={(expanded) => onExpandedChange(project, expanded)}
        onRemoveEntry={() =>
          runProjectAction(async () => {
            const entryId = availability?.entryId;
            if (!entryId || !remoteService) throw new Error("remote-project.entry-not-found");
            await remoteService.removeEntry(entryId);
            await refresh();
          })
        }
        onCreate={() =>
          runProjectAction(async () => {
            onCreateTask({
              projectId: project.id,
              taskGroupId: null,
              ...(isWebRemoteControl || remoteHost ? { hostId: project.hostId } : {}),
            });
          })
        }
        onEdit={() => onEdit({ project })}
        onViewFiles={(rootPath) => runProjectAction(() => onViewFiles(project, rootPath))}
        onDelete={() => {
          // 本机项目删除提供数据清理选项；远端项目没有本机数据面，保持原有即时软删除。
          if (localProject && onOpenProjectData) {
            onOpenProjectData(project, "delete");
            return;
          }
          runProjectAction(async () => {
            await service!.deleteProject(project.id, project.hostId);
            await refresh();
          });
        }}
        onCleanupData={
          cleanupAvailable && onOpenProjectData
            ? () => onOpenProjectData(project, "cleanup")
            : undefined
        }
        onPin={() =>
          runProjectAction(async () => {
            await service!.saveProject({
              id: project.id,
              hostId: project.hostId,
              pinned: !project.pinned,
            });
            await refresh();
          })
        }
        onMove={(task) =>
          runProjectAction(async () => {
            if (!service) return;
            try {
              await service.moveTask({ task, projectId: project.id, hostId: project.hostId });
            } catch (cause) {
              if (
                project.hostId !== "local" ||
                !String(cause).includes("project.root-confirmation-required")
              )
                throw cause;
              if (!(await confirm({ title: msg("addFolder"), description: task.workspacePath })))
                return;
              await service.moveTask({
                task,
                projectId: project.id,
                hostId: project.hostId,
                addMissingRoot: true,
              });
            }
            await refresh();
          })
        }
      />
    );
  },
  (previous, next) => {
    const { tasks: previousTasks, ...previousProps } = previous;
    const { tasks: nextTasks, ...nextProps } = next;
    return shallow(previousProps, nextProps) && shallow(previousTasks, nextTasks);
  },
);
