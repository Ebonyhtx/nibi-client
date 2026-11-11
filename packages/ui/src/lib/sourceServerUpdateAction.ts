import {
  compareSemverVersions,
  SOURCE_SERVER_LIFECYCLE_CONTROL_MIN_VERSION,
  SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE,
  type SourceServerRunningTask,
  type SourceServerRunningTasksResult,
  type SourceServerManagementSnapshot,
  type SourceServerUpdateTarget,
} from "@nibi/shared";
import type { ISourceServerManagementService } from "@nibi/services";
import type { RemoteConnectionStatus } from "@/lib/remoteConnectionPresentation.js";
import { logger } from "@/logger.js";

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Host 无法静默取得连接凭据（例如 SSH 密码未保存且设备离线）时的管理错误码。 */
export function isSourceServerCredentialsRequiredError(error: unknown): boolean {
  return getErrorCode(error) === "credentials-required";
}

export type SourceServerLifecycleActionAvailability =
  | { visible: false }
  | { visible: true; enabled: boolean; requiresRemoteUpdate: boolean };

/**
 * 设备卡「更多」中远端服务生命周期操作（重启与停止）共用的可用状态（RDLC-01）：
 * 需要处理（五态 pending）时隐藏；最近握手的远端版本低于首个支持版本或未知时禁用并提示更新；
 * 连接中、更新中或本设备有其他操作时禁用；已连接、未连接、连接失败时可用。
 */
export function resolveSourceServerLifecycleActionAvailability(input: {
  status: RemoteConnectionStatus;
  deviceBusy: boolean;
  lastSeenVersion?: string;
}): SourceServerLifecycleActionAvailability {
  if (input.status === "pending") return { visible: false };
  // 不发命令试探能力：旧 CLI 会把未知命令转交 TUI，或把 `stop --wait` 当成 ack 型 stop。
  const comparison = input.lastSeenVersion
    ? compareSemverVersions(input.lastSeenVersion, SOURCE_SERVER_LIFECYCLE_CONTROL_MIN_VERSION)
    : null;
  const requiresRemoteUpdate = comparison === null || comparison < 0;
  return {
    visible: true,
    requiresRemoteUpdate,
    enabled: !requiresRemoteUpdate && !input.deviceBusy && input.status !== "connecting",
  };
}

export async function runSourceServerUpdate(options: {
  management: ISourceServerManagementService;
  profileId: string;
  expectedTarget?: SourceServerUpdateTarget;
  confirmForce: () => Promise<boolean>;
}): Promise<SourceServerManagementSnapshot | null> {
  try {
    return await options.management.updateSource({
      profileId: options.profileId,
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
      force: false,
    });
  } catch (error) {
    if (getErrorCode(error) !== SOURCE_SERVER_UPDATE_RUNNING_TASKS_ERROR_CODE) {
      throw error;
    }
    // Bug 原因：版本 required 过去直接等价为 force update，会绕过运行中 Task guard。
    // 先受 guard 拒绝，再由用户明确确认中断，才能发送 force=true。
    if (!(await options.confirmForce())) return null;
    return await options.management.updateSource({
      profileId: options.profileId,
      ...(options.expectedTarget ? { expectedTarget: options.expectedTarget } : {}),
      force: true,
    });
  }
}

/** guard 拒绝后读取 Host 的活动投影；旧远端不支持时明确告知清单不可用。 */
export async function getSourceServerForceUpdateDescription(
  management: ISourceServerManagementService,
  profileId: string,
  formatMessage: (id: string) => string,
): Promise<string> {
  const snapshot = await management.getSnapshot();
  const tasks = snapshot.states.find((state) => state.profileId === profileId)?.runningTasks;
  return (
    formatMessage("settings.source.forceUpdateDescription") +
    "\n\n" +
    (tasks?.length
      ? formatSourceServerRunningTasks(tasks)
      : formatMessage("remote.runningTasksUnavailable"))
  );
}

/** 运行中任务清单的展示（强制更新与停止 / 重启远端服务共用）：每行 `sessionId — workspacePath`。 */
export function formatSourceServerRunningTasks(tasks: readonly SourceServerRunningTask[]): string {
  return tasks.map((task) => `${task.sessionId} — ${task.workspacePath}`).join("\n");
}

/**
 * 停止 / 重启确认前读取设备上的运行中任务（RDLC-01）。凭据不可静默取得时原样抛出，由调用方给出补充
 * 凭据提示且不打开确认；其他读取失败不能当作“没有任务”，按清单不可用继续确认。
 */
export async function readSourceServerRunningTasksForConfirmation(
  management: ISourceServerManagementService,
  sourceServerId: string,
): Promise<SourceServerRunningTasksResult> {
  try {
    return await management.getSourceRunningTasks(sourceServerId);
  } catch (error) {
    if (isSourceServerCredentialsRequiredError(error)) throw error;
    logger.warn(
      "[SourceServerLifecycle] running tasks read failed; showing the list as unavailable",
      {
        sourceServerId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return { available: false };
  }
}

/**
 * 停止 / 重启远端服务的危险确认说明（RDLC-01），依次为：中断说明；任务清单（不可用时说明设备未提供，
 * 为空时说明没有运行中的任务）；其他电脑上的 NIBI 可能重新启动远端服务；仅停止且「启动时自动重连」
 * 开启时，下次打开 NIBI 会重新启动远端服务。
 */
export function getRemoteServiceLifecycleDescription(input: {
  action: "restart" | "stop";
  runningTasks: SourceServerRunningTasksResult;
  startupAutoReconnect: boolean;
  formatMessage: (id: string) => string;
}): string {
  const { runningTasks, formatMessage } = input;
  const taskSection = !runningTasks.available
    ? formatMessage("settings.source.remoteServiceRunningTasksUnavailable")
    : runningTasks.tasks.length > 0
      ? formatSourceServerRunningTasks(runningTasks.tasks)
      : formatMessage("settings.source.remoteServiceNoRunningTasks");
  return [
    formatMessage("settings.source.remoteServiceInterruptionDescription"),
    taskSection,
    formatMessage("settings.source.remoteServiceOtherClientsNotice"),
    ...(input.action === "stop" && input.startupAutoReconnect
      ? [formatMessage("settings.source.stopRemoteServiceStartupReconnectNotice")]
      : []),
  ].join("\n\n");
}
