import type { HostQuitBlocker } from "@nibi/shared";

export type AppShutdownKind = "normal" | "update-install";

export interface AppShutdownPolicy {
  forceKillDelayMs: number;
  waitTimeoutMs: number;
}

export interface AppShutdownPolicySelection {
  kind: AppShutdownKind;
  policy: AppShutdownPolicy;
  upgraded: boolean;
}

const STRICT_SHUTDOWN_POLICY: AppShutdownPolicy = {
  forceKillDelayMs: 7_500,
  waitTimeoutMs: 9_000,
};

export function resolveAppShutdownPolicy(
  _kind: AppShutdownKind,
  _platform: NodeJS.Platform,
): AppShutdownPolicy {
  // 普通退出与更新安装共用同一严格上界。Windows 普通退出的 4s/4.5s 短预算会让
  // Host 内部 3.5s 进程树兜底与远程 Host 的最长 6s connection dispose 被迫截断，
  // 可能留下 runtime/agent 残留；统一到 7.5s/9s 后，退出等待仍是有界兜底，
  // 提前完成的 Host 会立即释放退出屏障，不会每次固定等满。
  return STRICT_SHUTDOWN_POLICY;
}

export function selectAppShutdownPolicy(
  activeKind: AppShutdownKind | null,
  requestedKind: AppShutdownKind,
  platform: NodeJS.Platform,
): AppShutdownPolicySelection {
  // 更新安装的优先级只增不减：已启动的普通退出屏障不重建，更新仍沿用同一严格
  // 上界，保证“可能残留”不会升级成“无法更新”。
  const kind =
    activeKind === "update-install" || requestedKind === "update-install"
      ? "update-install"
      : "normal";
  return {
    kind,
    policy: resolveAppShutdownPolicy(kind, platform),
    upgraded: activeKind === "normal" && kind === "update-install",
  };
}

/**
 * 上游 3.18.2 的 HostQuitBlocker 只有 `worktree-creating` 一种；缺数据按 0 处理，
 * 避免某条畸形/未知阻塞项把退出永久卡住。
 */
export function countCreatingWorktreeBlockers(
  blockers: readonly HostQuitBlocker[] | undefined,
): number {
  let total = 0;
  for (const blocker of blockers ?? []) {
    if (blocker.kind === "worktree-creating") total += blocker.count;
  }
  return total;
}

/**
 * 按 Host 过滤统计正在创建受管 worktree 的数量。
 * 窗口关闭路径只传本窗口的 Host，避免其它窗口的 worktree 阻塞本窗口；
 * 应用退出路径不传 hosts，默认统计全部 Host。
 */
export function getCreatingWorktreeCount<K>(
  hostQuitBlockersMap: ReadonlyMap<K, readonly HostQuitBlocker[]>,
  hosts: Iterable<K | undefined> = hostQuitBlockersMap.keys(),
): number {
  let total = 0;
  for (const host of hosts) {
    if (host === undefined || host === null) continue;
    total += countCreatingWorktreeBlockers(hostQuitBlockersMap.get(host));
  }
  return total;
}

/**
 * 退出确认判定：production 下的运行中会话沿用旧行为；
 * “正在创建 worktree”在任何环境都要确认，因为退出会丢掉尚未完成创建的任务。
 */
export function shouldConfirmAppQuitForCounts(options: {
  isProduction: boolean;
  runningAgentSessionCount: number;
  creatingWorktreeCount: number;
}): boolean {
  return (
    (options.isProduction && options.runningAgentSessionCount > 0) ||
    options.creatingWorktreeCount > 0
  );
}

/** 主进程退出确认的 detail 文案；没有对应阻塞项时不加行。 */
export function buildAppQuitConfirmationDetail(options: {
  isZh: boolean;
  runningAgentSessionCount: number;
  creatingWorktreeCount: number;
}): string {
  const lines: string[] = [];
  if (options.runningAgentSessionCount > 0) {
    lines.push(
      options.isZh
        ? `正在进行的会话：${options.runningAgentSessionCount} 个，退出后会被中断。`
        : `In-progress sessions: ${options.runningAgentSessionCount}. They will be interrupted after quitting.`,
    );
  }
  if (options.creatingWorktreeCount > 0) {
    lines.push(
      options.isZh
        ? `正在新 worktree 中启动的任务：${options.creatingWorktreeCount} 个，关闭后会丢失。`
        : `Tasks starting in new worktrees: ${options.creatingWorktreeCount}. They will be lost after quitting.`,
    );
  }
  return lines.join("\n");
}

export interface AppQuitDialogOptions {
  type: "question";
  buttons: string[];
  defaultId: number;
  cancelId: number;
  title: string;
  message: string;
  detail: string;
}

/** 只负责文案与按钮；窗口和图标由 main 注入的 showMessageBoxSync 处理。 */
export function confirmAppQuitWithDialog(options: {
  isZh: boolean;
  runningAgentSessionCount: number;
  creatingWorktreeCount: number;
  showMessageBoxSync: (dialogOptions: AppQuitDialogOptions) => number;
}): boolean {
  const { isZh } = options;
  return (
    options.showMessageBoxSync({
      type: "question",
      buttons: isZh ? ["退出", "取消"] : ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: isZh ? "退出确认" : "Confirm Quit",
      message: isZh ? "确认退出 NIBI?" : "Quit NIBI?",
      detail: buildAppQuitConfirmationDetail(options),
    }) === 0
  );
}
