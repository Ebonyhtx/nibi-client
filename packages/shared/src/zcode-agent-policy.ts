import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";

export const NIBI_AGENT_PROVIDER = "glm" satisfies ZCodeProvider;
export const NIBI_AGENT_PROVIDER_LABEL = "NIBI Agent";
export const NIBI_COMMAND_AGENT_SOURCE = "zcodeAgent" satisfies CommandAgentSource;

/**
 * 解析持久化/relay 数据时的 provider 归一 schema：
 * 已移除的第三方 provider 历史值仅作为归一化输入保留，统一收敛为 glm；
 * 其它非法值保持拒绝，与收窄前的校验边界一致。
 */
export const legacyZCodeProviderSchema = z
  .enum(["claude", "opencode", "gemini", "codex", "glm"])
  .transform((): typeof NIBI_AGENT_PROVIDER => NIBI_AGENT_PROVIDER);

export const NIBI_ENABLED_AGENT_PROVIDERS = [
  NIBI_AGENT_PROVIDER,
] as const satisfies readonly ZCodeProvider[];

export const NIBI_COMMAND_AGENT_SOURCES = [
  NIBI_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToZCodeAgent(
  _provider?: ZCodeProvider | null,
): ZCodeProvider {
  return NIBI_AGENT_PROVIDER;
}

export function normalizeAgentProvidersToZCodeAgent(
  _providers?: ReadonlyArray<ZCodeProvider> | null,
): ZCodeProvider[] {
  return [...NIBI_ENABLED_AGENT_PROVIDERS];
}

export function normalizeCommandAgentSourceToZCodeAgent(
  _agentSource?: CommandAgentSource | null,
): CommandAgentSource {
  return NIBI_COMMAND_AGENT_SOURCE;
}

export function isZCodeAgentProvider(
  provider: ZCodeProvider | null | undefined,
): provider is typeof NIBI_AGENT_PROVIDER {
  return provider === NIBI_AGENT_PROVIDER;
}
