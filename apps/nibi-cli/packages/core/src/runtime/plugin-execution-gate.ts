/**
 * 插件执行期门禁（Node 侧）。
 *
 * Rust 内核的 `PaidPluginGate` 在工具、命令、技能、子代理执行前都会复核授权；Node 侧过去
 * 只在**发现层**裁剪一次工具表。会员在会话中途到期、被服务端撤销、或切换账号后，
 * 工具/技能/命令仍在内存里，不拦的话过期会员能一直用到进程重启。
 *
 * 这里提供三处执行入口共用的判定：
 * - 工具上下文（`ToolExecutionContext.assertPluginExecutionAllowed`）→ Skill 工具；
 * - 子代理派发（agent type → 声明它的插件）；
 * - 自定义命令展开（命令根携带的 `plugin.id`）。
 *
 * 设计取向：**只拦不放**。判定依赖 bootstrap 注入的 `paidPluginGate`（缺省不拦，进程内嵌
 * 入方没有 license 概念）；一旦注入，任何拿不到插件身份的路径都按「非付费」放行——
 * 与发现层一致，避免把普通 MCP/技能误伤成付费件。
 */
import type { PluginReferenceCatalog } from "@nibi/contracts";
import type { AgentRuntimeConfig } from "./types.js";

export type PaidPluginExecutionGate = AgentRuntimeConfig["paidPluginGate"];

function splitPluginId(
  pluginId: string,
): { id: string; marketplace: string; name: string } | null {
  const at = pluginId.lastIndexOf("@");
  if (at <= 0 || at === pluginId.length - 1) return null;
  return {
    id: pluginId,
    marketplace: pluginId.slice(at + 1),
    name: pluginId.slice(0, at),
  };
}

/**
 * 复核某个插件此刻是否仍被授权执行。
 *
 * 抛错是刻意的：调用方（工具 handler / 子代理派发 / 命令展开）都已有统一的错误呈现链路，
 * 静默返回空结果会让模型以为「工具没数据」，用户也看不到「会员已到期」。
 */
export function assertPaidPluginExecutionAllowed(
  gate: PaidPluginExecutionGate,
  pluginId: string | undefined,
): void {
  if (!gate || !pluginId) return;
  const identity = splitPluginId(pluginId);
  if (!identity) return;
  const verdict = gate(identity);
  if (!verdict.allowed) {
    throw new Error(verdict.message ?? "Plugin requires an active NIBI membership");
  }
}

/**
 * 子代理名字 → 声明它的插件 id。
 *
 * 插件子代理的运行时名字是 `<pluginName>:<agentName>`（与 Skill 的 qualified name 同规则）。
 * 同名冲突时 catalog 已经把冲突写进 `conflictingPluginIds`；这种时候**不猜**归属：
 * 返回多个候选，由调用方逐个复核（任一未授权即拒绝），避免用弱名字匹配绕过付费门禁。
 */
export function resolvePluginAgentOwnerIds(
  catalog: PluginReferenceCatalog | undefined,
  agentType: string,
): string[] {
  if (!catalog) return [];
  const owners: string[] = [];
  for (const plugin of catalog.plugins) {
    if (!plugin.subagentNames.includes(agentType)) continue;
    owners.push(plugin.pluginId);
  }
  return owners;
}

/** 子代理派发前的统一门禁：对每个声明该 agent 的插件复核（含同名冲突）。 */
export function assertPluginAgentExecutionAllowed(
  gate: PaidPluginExecutionGate,
  catalog: PluginReferenceCatalog | undefined,
  agentType: string,
): void {
  for (const pluginId of resolvePluginAgentOwnerIds(catalog, agentType)) {
    assertPaidPluginExecutionAllowed(gate, pluginId);
  }
}

/**
 * 由 runtime config 生成工具上下文用的门禁函数。
 *
 * 每次调用都重新问一次 gate：bootstrap 注入的是 `cacheCredentials: false` 的实现，
 * 因此会员中途到期会在下一次工具/技能调用立刻生效。
 */
export function createToolPluginExecutionGate(
  gate: PaidPluginExecutionGate,
): ((pluginId: string) => void) | undefined {
  if (!gate) return undefined;
  return (pluginId: string) => assertPaidPluginExecutionAllowed(gate, pluginId);
}
