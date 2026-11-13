import type {
  CustomCommandRoot,
  HookEventName,
  HookMatcherConfig,
  McpServerConfig,
  PluginAcceptanceContract,
  PluginAcceptanceParseResult,
  PluginHookDetail,
  PluginManifest,
  PluginSource,
  SkillRoot,
} from "@nibi/contracts";

export interface PluginCandidate {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
  source: PluginSource;
}

export interface LoadedPlugin {
  /** 校验通过的验收合同与解析诊断；在此处解析一次，供 metadata 与门禁共用。 */
  acceptance?: PluginAcceptanceContract;
  acceptanceDiagnostics?: PluginAcceptanceParseResult;
  id: string;
  manifest: PluginManifest;
  manifestPath: string;
  marketplace: string;
  rootPath: string;
  source: PluginSource;
}

export interface PluginComponents {
  commandRoots: CustomCommandRoot[];
  hooks: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  hookDetails: PluginHookDetail[];
  mcpServers: Record<string, McpServerConfig>;
  skillCount: number;
  skillRoots: SkillRoot[];
}

export interface PluginAbortOptions {
  signal?: AbortSignal;
}
