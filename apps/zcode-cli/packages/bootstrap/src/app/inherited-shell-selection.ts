import type { AgentRuntime, AgentRuntimeConfig } from "@nibi/core";

/**
 * 子会话（expert workflow / script workflow / dwf actor）构造配置里要补上的 Bash shell 选择。
 *
 * 这些 builder 都从 `deps.runtimeConfig` 拷贝执行配置，而那是 create-app **构造时**的那份
 * 对象：AgentRuntime 构造器会 `{...config}` 出一份新 config，`bashShellSelection` 与刷新后的
 * `envInfo` 都写在 `runtime.config` 上（见 create-app 里 dynamicWorkflowEnabled 那条同类注释）。
 * 拿不到选择的子会话只能在 env 段落退回 `basename($SHELL)`（context-source 的 detectEnvInfo），
 * 于是模型被告知 `Shell: fish` 而 Bash 实际跑 zsh —— 正是 session-shell-environment 注释里
 * 要避免的"模型看到的 Shell 与 Bash 执行 shell 分叉"。
 *
 * 父 runtime 尚未在"首次真实用户执行"边界解析过 shell 时返回空对象：此时子会话与父会话
 * 一样退回默认探测，不会凭空造出一个父会话没有的选择。
 */
export function inheritedShellSelection(
  runtime: AgentRuntime,
): Pick<AgentRuntimeConfig, "bashShellSelection"> | Record<string, never> {
  const selection = runtime.getSessionShellSelection();
  return selection ? { bashShellSelection: selection } : {};
}
