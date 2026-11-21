import type {
  CanonicalPlugin,
  CustomCommandRoot,
  HookMatcherConfig,
  McpServerConfig,
  PluginAcceptanceContract,
  PluginAcceptanceParseResult,
  PluginHookDetail,
  PluginHookEventName,
  PluginManifest,
  PluginRuntimeDeclaration,
  PluginSource,
  PluginTrustLevel,
  SkillRoot,
} from "@nibi/contracts";

export interface PluginCandidate {
  defaultEnabled: boolean;
  marketplace: string;
  rootPath: string;
  source: PluginSource;
  /** 发现来源的信任等级，随插件元数据下发（P2 能力网关的上限依据）。 */
  trust: PluginTrustLevel;
}

/** 组件读取器需要的最小清单来源；不要求已完成 canonical 归一化。 */
export interface PluginManifestSource {
  id: string;
  manifest: PluginManifest;
  manifestPath: string;
  marketplace: string;
  rootPath: string;
  /** 校验通过的扩展代码入口；未声明或声明非法时缺省。 */
  runtime?: PluginRuntimeDeclaration;
  source: PluginSource;
}

export interface LoadedPlugin extends PluginManifestSource {
  /** 校验通过的验收合同与解析诊断；在此处解析一次，供 metadata 与门禁共用。 */
  acceptance?: PluginAcceptanceContract;
  acceptanceDiagnostics?: PluginAcceptanceParseResult;
  /** 归一化后的唯一内部模型；核心只消费它，不再看生态清单。 */
  canonical: CanonicalPlugin;
}

export interface PluginComponents {
  commandRoots: CustomCommandRoot[];
  hooks: Partial<Record<PluginHookEventName, HookMatcherConfig[]>>;
  hookDetails: PluginHookDetail[];
  mcpServers: Record<string, McpServerConfig>;
  skillCount: number;
  skillRoots: SkillRoot[];
}

export interface PluginAbortOptions {
  signal?: AbortSignal;
}
