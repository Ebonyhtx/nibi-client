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
