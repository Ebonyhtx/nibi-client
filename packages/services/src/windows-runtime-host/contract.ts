import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** EOF 后原生 helper 保留的正常收尾窗口（毫秒），与 `scripts/windows-runtime-host/main.cpp` 一致。 */
export const WINDOWS_RUNTIME_HOST_EOF_GRACE_MS = 1_800;

/** Host 启动 helper 时允许的最长握手时间（ready + resume）。 */
export const WINDOWS_RUNTIME_HOST_STARTUP_TIMEOUT_MS = 10_000;

/**
 * Windows 上 CLI 的内核进程归属边界。
 *
 * helper 独占 Job 句柄；`child` 是 helper 进程本身，它的 stdio 原样转给 CLI。
 * `child.pid` 是 helper PID，不是 CLI PID；CLI 身份必须用 `ready()` 返回的 `runtimePid`。
 */
export interface WindowsRuntimeHost {
  /** stdio 属于 CLI；ChildProcess 的 pid/exit 属于原生托管程序，不能当成 CLI 身份。 */
  readonly child: ChildProcessWithoutNullStreams;
  /** 启动握手完成前 PID 未知，但调用方已经拥有 child 与 close，不能漏记启动中的进程。 */
  readonly runtimePid: number | undefined;
  ready(): Promise<number>;
  /** 调用方安装协议和生命周期监听后才允许 CLI 开始运行；重复调用共享结果。 */
  start(): Promise<void>;
  /** EOF 后保留原生 1800ms 收尾窗口；仅在 Job 清空且 helper 退出后成功。失败可重新等待。 */
  close(deadlineAtMs: number): Promise<void>;
  /** 根退出与整棵 Job 清空是不同事实；该事件只报告根生命周期。 */
  onRootExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface WindowsRuntimeHostSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

/** 只暴露结构化日志，避免服务层把 logger 实现绑进契约。 */
export interface WindowsRuntimeHostLog {
  info?(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
}

/** Host 启动入口的可注入依赖；生产调用不传，测试用它固定平台和 helper 路径。 */
export interface WindowsRuntimeHostLaunchOptions extends WindowsRuntimeHostSpawnOptions {
  platform?: NodeJS.Platform;
  log?: WindowsRuntimeHostLog;
  resolveHelper?: () => Promise<string>;
}

/** helper 不可用时返回 null，调用方必须记录并退回既有进程树清理路径。 */
export type WindowsRuntimeHostLaunchResult = WindowsRuntimeHost | null;
