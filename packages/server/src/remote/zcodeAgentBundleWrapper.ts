// 远端 ZCode Agent 以「独立 node + 编译产物 nibi.cjs」的形态运行，而不是各平台内嵌 node 的原生二进制。
// 远端部署时本来就有一份独立 node（用于跑 zcode-server.cjs），agent 复用它执行 nibi.cjs 即可。
//
// 部署布局：把 nibi.cjs 放到 agents/<provider>/nibi.cjs，再写一个同名 wrapper —— 就是 resolver
// 期望找到的可执行入口（如 agents/glm/zcode-agent）—— 由它用远端 node 执行 nibi.cjs。
// 这样 provider runtime resolver 不需要区分原生/JS，照旧找 zcode-agent 这个可执行文件即可。
// 开发态与生产态共用同一份 wrapper 语义。

export const REMOTE_AGENT_BUNDLE_NAME = "nibi.cjs";

export function buildRemoteAgentBundleWrapper(runtimeResourceDir: string): string {
  return [
    "#!/bin/sh",
    "set -eu",
    'runtime_root="${NIBI_SERVER_RUNTIME_ROOT:-$HOME/.nibi/server}"',
    `exec "$runtime_root/node" "$HOME/.nibi/server/agents/${runtimeResourceDir}/${REMOTE_AGENT_BUNDLE_NAME}" "$@"`,
    "",
  ].join("\n");
}

export function isRemoteAgentBundleWrapperCurrent(
  content: string,
  runtimeResourceDir: string,
): boolean {
  return content.replace(/\r\n/g, "\n") === buildRemoteAgentBundleWrapper(runtimeResourceDir);
}
