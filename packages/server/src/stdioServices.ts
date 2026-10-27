import { createLocalServices, type ZCodeAgentCommandResolver } from "@nibi/services/node";
import type { IChannel } from "@nibi/rpc";
import {
  parseServiceAuthorityMode,
  NIBI_REMOTE_HTTP_PROXY_ENV_KEY,
  NIBI_REMOTE_HTTP_PROXY_MODE_ENV_KEY,
  NIBI_REMOTE_NO_PROXY_ENV_KEY,
  NIBI_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
} from "@nibi/shared";

export interface CreateStdioServicesOptions {
  topicResourceRelayChannel?: () => IChannel;
  env?: Record<string, string | undefined>;
  nibiBuiltinProviderConfigFilePath: string;
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
}

export interface RemoteAgentNetworkOptions {
  httpProxy?: string;
  httpProxyMode?: "system" | "manual";
  noProxy?: string;
}

export function resolveRemoteAgentNetworkFromEnv(
  env: Record<string, string | undefined>,
): RemoteAgentNetworkOptions | undefined {
  if (env[NIBI_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY]?.trim() !== "1") {
    return undefined;
  }
  const mode = env[NIBI_REMOTE_HTTP_PROXY_MODE_ENV_KEY]?.trim();
  return {
    httpProxy: env[NIBI_REMOTE_HTTP_PROXY_ENV_KEY]?.trim() || undefined,
    ...(mode === "system" || mode === "manual" ? { httpProxyMode: mode } : {}),
    noProxy: env[NIBI_REMOTE_NO_PROXY_ENV_KEY]?.trim() || undefined,
  };
}

export function createStdioServices(options: CreateStdioServicesOptions) {
  const env = options.env ?? process.env;
  const authorityModeParseResult = parseServiceAuthorityMode(env);
  const remoteAgentNetwork = resolveRemoteAgentNetworkFromEnv(env);
  // 远程 Desktop 的呈现能力必须从 stdio 入口收到的 authority mode 进入 Services 推导链。
  // 测试注入 resolver 只用于在 spawn 前观察最终命令，不改变生产默认 resolver。
  const services = createLocalServices({
    nibiBuiltinProviderConfigFilePath: options.nibiBuiltinProviderConfigFilePath,
    topicResourceRelayChannel: options.topicResourceRelayChannel,
    serviceAuthorityMode: authorityModeParseResult.mode,
    zcodeAgentCommandResolver: options.zcodeAgentCommandResolver,
    remoteAgentNetwork,
  });

  return {
    authorityModeParseResult,
    services,
  };
}
