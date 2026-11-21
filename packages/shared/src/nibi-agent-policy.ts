import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { NibiProvider } from "./nibi-task-types-core.js";

export const NIBI_AGENT_PROVIDER = "nibi-agent" satisfies NibiProvider;
export const NIBI_AGENT_PROVIDER_LABEL = "NIBI Agent";
/** 内置 GLM 模型在模型 provider 配置里的 id；与 agent lane 值无关，不能随 lane 改名。 */
export const NIBI_NATIVE_MODEL_PROVIDER_ID = "glm" as const;
export const NIBI_COMMAND_AGENT_SOURCE = "nibiAgent" satisfies CommandAgentSource;

/** 持久化/relay 数据里的 agent provider：只接受当前唯一值。 */
export const nibiAgentProviderSchema = z.literal(NIBI_AGENT_PROVIDER);

export const NIBI_ENABLED_AGENT_PROVIDERS = [
  NIBI_AGENT_PROVIDER,
] as const satisfies readonly NibiProvider[];

export const NIBI_COMMAND_AGENT_SOURCES = [
  NIBI_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToNibiAgent(
  _provider?: NibiProvider | null,
): NibiProvider {
  return NIBI_AGENT_PROVIDER;
}

export function normalizeAgentProvidersToNibiAgent(
  _providers?: ReadonlyArray<NibiProvider> | null,
): NibiProvider[] {
  return [...NIBI_ENABLED_AGENT_PROVIDERS];
}

export function normalizeCommandAgentSourceToNibiAgent(
  _agentSource?: CommandAgentSource | null,
): CommandAgentSource {
  return NIBI_COMMAND_AGENT_SOURCE;
}

export function isNibiAgentProvider(
  provider: NibiProvider | string | null | undefined,
): provider is typeof NIBI_AGENT_PROVIDER {
  return provider === NIBI_AGENT_PROVIDER;
}
