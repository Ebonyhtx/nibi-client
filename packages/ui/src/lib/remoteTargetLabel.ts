import type { RemoteTarget } from "@nibi/shared";

/**
 * 远端目标 + 工作区路径的展示文案。
 *
 * 该格式化逻辑原先挂在旧技能同步弹窗里，设置页的「当前远端工作区」提示复用了它；
 * 弹窗删除后保留为中性工具，避免页面文案依赖已删除的同步组件。
 */
export function formatRemoteTargetLabel(
  remoteTarget: RemoteTarget,
  workspacePath: string,
): string {
  const target =
    remoteTarget.kind === "ssh"
      ? `${remoteTarget.username}@${remoteTarget.host}${remoteTarget.port ? `:${remoteTarget.port}` : ""}`
      : remoteTarget.kind === "wsl"
        ? ["WSL", remoteTarget.distro, remoteTarget.user?.trim()].filter(Boolean).join(" · ")
        : remoteTarget.kind;
  return workspacePath ? `${target} · ${workspacePath}` : target;
}
