// 把云端项目 broker 能力令牌只注入数模插件的 MCP server，而不是 agent 全局 env。
//
// 与 CUA 的 socket/token 同一套纪律：全局 env 会被所有 MCP server 与 Bash 子进程继承，
// 能力令牌一旦全局化就变成 confused deputy（任何插件都能读写用户当前工作区的云端项目）。
// 所以 broker 地址/令牌只在解析 `plugin:math-modeling:*` 这一条 MCP 配置时追加。
import type { ZCodeAgentMcpServer } from "@nibi/shared";
import type { CloudProjectBroker } from "./cloudProjectBroker.js";

export interface CloudProjectMcpServerResolver {
  resolveMcpServers(
    servers: ZCodeAgentMcpServer[],
    context: { workspacePath: string },
  ): Promise<ZCodeAgentMcpServer[]>;
}

const MATH_MODELING_SERVER_PREFIX = "plugin:math-modeling:";

function isMathModelingServer(
  server: ZCodeAgentMcpServer,
): server is Extract<ZCodeAgentMcpServer, { env: Array<{ name: string; value: string }> }> {
  return server.name.startsWith(MATH_MODELING_SERVER_PREFIX) && "env" in server;
}

function mergeEnv(
  server: Extract<ZCodeAgentMcpServer, { env: Array<{ name: string; value: string }> }>,
  additions: Record<string, string>,
): typeof server {
  const env = [...server.env];
  for (const [name, value] of Object.entries(additions)) {
    const index = env.findIndex((entry) => entry.name === name);
    if (index >= 0) env[index] = { name, value };
    else env.push({ name, value });
  }
  return { ...server, env };
}

export function createCloudProjectMcpServerResolver(options: {
  broker: CloudProjectBroker;
  onError?: (message: string, error: unknown) => void;
}): CloudProjectMcpServerResolver {
  return {
    async resolveMcpServers(servers, context) {
      const targets = servers.filter(isMathModelingServer);
      if (targets.length === 0) return servers;
      if (!context.workspacePath.trim()) return servers;
      let brokerEnv: Record<string, string>;
      try {
        brokerEnv = await options.broker.envForWorkspace(context.workspacePath);
      } catch (error) {
        // 云端协作是可选能力：broker 起不来时保持原样，插件工具会回“宿主没有提供 broker 凭据”。
        options.onError?.("cloud project broker unavailable during mcp resolve", error);
        return servers;
      }
      return servers.map((server) =>
        isMathModelingServer(server) ? mergeEnv(server, brokerEnv) : server,
      );
    },
  };
}
