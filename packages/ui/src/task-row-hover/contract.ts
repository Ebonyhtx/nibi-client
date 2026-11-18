import type { ReactElement } from "react";
import type { NibiTaskMeta } from "@nibi/shared";

/**
 * 会话行悬浮卡片的输入契约。
 *
 * 卡片只读，不修改任务、workspace 或 Git 状态；调用方提供任务事实和行内显示名，
 * 卡片自己按任务 workspacePath 查询一次性 Git 快照。
 */
export interface TaskRowIdentityHoverCardProps {
  /** 会话行对应的任务事实；路径、最近活动和变更统计都从它派生。 */
  task: NibiTaskMeta;
  /** 会话行当前显示的工作区名；为空时回退到 workspacePath 的叶子目录。 */
  workspaceLabel: string;
  /** 远程会话的 Host session；用于把 home 缩写和 Git 查询路由到远端。 */
  remoteSessionId?: string;
  /**
   * 当前表面不应出现悬停卡片时显式禁用（例如 Web remote 的分组行、分组拖拽）。
   * 远程未连接不是禁用条件：卡片仍显示已知路径和活动时间，只跳过 RPC。
   */
  disabled?: boolean;
  /** 触发器必须是一个元素，Radix HoverCardTrigger 会合并到该元素上。 */
  children: ReactElement;
}
