import { Emitter } from "@nibi/rpc";

/** 深层展示组件到 App 顶层导航 owner 的跳转意图（不新增第二条导航路径）。 */
export interface TaskNavigationRequest {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

const taskNavigationRequested = new Emitter<TaskNavigationRequest>();

/**
 * 入站跳转请求通道：会话气泡的「来自会话 X」等组件只发意图，由
 * useWorkspaceTaskNavigation（handleSelectTask 的唯一持有者）订阅并执行。
 */
export const onTaskNavigationRequested = taskNavigationRequested.event;

export function requestTaskNavigation(target: TaskNavigationRequest): void {
  taskNavigationRequested.fire(target);
}