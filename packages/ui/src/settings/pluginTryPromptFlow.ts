import type { StorePluginItem } from "@/settings/pluginStoreListing.js";

/**
 * 商店「立即试用」的门禁编排。
 *
 * 产品语义与「启用」按钮保持同一套：会员专享插件没有权限时先弹开通页；普通/已授权插件
 * 处于暂停态时「先启用再试用」（与 UI 插件「暂停态先成功启用再打开」同义）。
 * 任何分支都不允许在插件不可用时启动草稿——这正是「插件没启用却把试用消息发进会话」的根因。
 */
export type PluginTryPromptIntent = "install" | "membership" | "enable" | "start";

export interface PluginTryPromptAccess {
  installed: boolean;
  /** 运行时 enabled 是唯一权威；已安装但未发现（无 info）一律按未启用处理。 */
  enabled: boolean;
  /** 会员专享（目录条目 paid=true）。 */
  paid: boolean;
}

export function resolvePluginTryPromptAccess(
  item: Pick<StorePluginItem, "installed" | "paid" | "info">,
): PluginTryPromptAccess {
  return {
    installed: item.installed,
    enabled: item.installed && item.info?.enabled === true,
    paid: item.paid,
  };
}

export function resolvePluginTryPromptIntent(
  access: PluginTryPromptAccess,
  canUsePaidPlugins: boolean,
): PluginTryPromptIntent {
  // 未安装仍沿用既有语义：先引导安装，留在详情页，不新建会话。
  if (!access.installed) return "install";
  // 付费插件无权限：与「启用」同一引导路径，不进入启用/草稿分支。
  if (access.paid && !canUsePaidPlugins) return "membership";
  if (!access.enabled) return "enable";
  return "start";
}

export type PluginTryPromptFlowResult =
  | "install"
  | "membership"
  | "enable_failed"
  | "started"
  | "blocked";

export interface PluginTryPromptFlowDeps {
  canUsePaidPlugins: boolean;
  /** 未安装：引导安装（既有 handleInstall）。 */
  install: () => void | Promise<void>;
  /** 会员引导：返回 true 表示已被拦下（开通页已弹出）。与「启用」按钮复用同一实现。 */
  requireMembership: () => boolean | Promise<boolean>;
  /** 启用插件：返回是否成功；失败时调用方负责 toast。 */
  enable: () => boolean | Promise<boolean>;
  /** 启动试用草稿（预填 mention，不自动发送）。 */
  start: () => void;
  /** 启动条件缺失（无 workspace / 无新建任务能力）时的兜底，便于区分「没有发送」。 */
  canStart?: () => boolean;
}

export async function runPluginTryPromptFlow(
  item: Pick<StorePluginItem, "installed" | "paid" | "info">,
  deps: PluginTryPromptFlowDeps,
): Promise<PluginTryPromptFlowResult> {
  const intent = resolvePluginTryPromptIntent(
    resolvePluginTryPromptAccess(item),
    deps.canUsePaidPlugins,
  );
  if (intent === "install") {
    await deps.install();
    return "install";
  }
  if (intent === "membership") {
    await deps.requireMembership();
    return "membership";
  }
  if (intent === "enable") {
    // 已授权的付费插件在「启用」时仍要按最新会员状态复核一次，避免缓存过期造成先建草稿。
    if (await deps.requireMembership()) return "membership";
    if (!(await deps.enable())) return "enable_failed";
  }
  if (deps.canStart && !deps.canStart()) return "blocked";
  deps.start();
  return "started";
}
