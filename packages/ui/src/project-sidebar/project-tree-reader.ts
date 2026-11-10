import type {
  IProjectService,
  IRemoteProjectService,
  ProjectTree,
} from "@/project-sidebar/contract.js";
import { mergeProjectTrees, resolveEntryProject } from "@/project-sidebar/view.js";

/** Host 入口列表是可见集合的权威；网络结果不能恢复已移除的成员实例。 */
export async function readProjectSidebarTree(input: {
  projectService: IProjectService;
  remoteProjectService?: IRemoteProjectService;
}) {
  const before = (await input.remoteProjectService?.readDirectory()) ?? { hosts: [], entries: [] };
  // 根因：离线/连接中的主机 readTree 只会在本地立即失败，却每轮都占一次 RPC。
  // 离线设备仍由入口缓存展示（mergeProjectTrees 补齐），这里只读读取开始时在线的主机；
  // 读取期间断线仍按失败处理，避免连接过程中误显示“连接失败”。
  const onlineHosts = before.hosts.filter((host) => host.connectionStatus === "online");
  const [local, results] = await Promise.all([
    input.projectService.readTree({ includeDeleted: true, includeDeletedTasks: true }),
    Promise.allSettled(
      onlineHosts.map((host) =>
        input.projectService.readTree({
          hostId: host.id,
          includeDeleted: true,
          includeDeletedTasks: true,
        }),
      ),
    ),
  ]);
  const remote = new Map<string, ProjectTree>();
  const errors = new Map<string, string>();
  for (let index = 0; index < results.length; index++) {
    const result = results[index]!;
    const host = onlineHosts[index]!;
    if (result.status === "fulfilled") remote.set(host.id, result.value);
    else errors.set(host.id, String(result.reason));
  }
  for (const entry of before.entries) {
    const tree = remote.get(entry.hostId);
    const project = tree && resolveEntryProject(entry, tree);
    if (project && input.remoteProjectService)
      await input.remoteProjectService.refreshEntry({
        entryId: entry.id,
        expectedLastSyncedAt: entry.lastSyncedAt,
        project: { projectId: project.id, name: project.name, roots: project.roots },
      });
  }
  const directory = (await input.remoteProjectService?.readDirectory()) ?? before;
  for (const [hostId] of remote) {
    const original = before.hosts.find((host) => host.id === hostId);
    if (
      !directory.hosts.some(
        (host) => host.id === hostId && host.membershipId === original?.membershipId,
      )
    )
      remote.delete(hostId);
  }
  return { ...mergeProjectTrees(local, directory, remote), directory, errors };
}
