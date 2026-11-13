import {
  NIBI_AGENT_PROVIDER,
  NIBI_COMMAND_AGENT_SOURCES,
  type NibiProvider,
  type CommandAgentSource,
} from "@nibi/shared";

export const COMMAND_AGENT_SOURCES = [
  ...NIBI_COMMAND_AGENT_SOURCES,
] as const satisfies readonly CommandAgentSource[];

export const COMMAND_AGENT_SOURCE_META: Record<
  CommandAgentSource,
  {
    labelId: string;
    provider: NibiProvider;
    pathHint: string;
  }
> = {
  nibiAgent: {
    labelId: "settings.commands.source.nibiAgent",
    pathHint: "~/.nibi/commands",
    provider: NIBI_AGENT_PROVIDER,
  },
};
