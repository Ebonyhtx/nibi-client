import { join } from "node:path";
import {
  NodeProviderConfigRuntime,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  type PersonalProviderConfigRecoveryEvent,
  type NodeProviderConfigRuntimeOptions,
} from "@nibi/provider-node";
import { getAppConfigDir } from "../paths.js";

export interface ProviderConfigRuntimeOptions {
  readonly nibiBuiltinFilePath: string;
  readonly nibiBuiltinActiveFilePath?: string;
  readonly nibiBuiltinRemote?: NodeProviderConfigRuntimeOptions["nibiBuiltinRemote"];
  readonly nibiBuiltinEnvironment?: NodeProviderConfigRuntimeOptions["nibiBuiltinEnvironment"];
  readonly onZCodeBuiltinRefreshError?: (error: unknown) => void;
  readonly onPersonalConfigRecovery?: (event: PersonalProviderConfigRecoveryEvent) => void;
  readonly onPersonalConfigPollingError?: (error: unknown) => void;
  readonly personalFilePath?: string;
  readonly personalPollingIntervalMs?: number | false;
  readonly watch?: boolean;
}

/**
 * Services 装配层：把 App 配置目录接给 @nibi/provider-node。
 *
 * 没有「从旧 config.json 导入」这一步：NIBI 4.0 是分家后的新起点，没有需要迁移的历史数据。
 * 个人 provider 配置只认 `provider_config.json`；文件不存在就是空配置。
 */
export class ProviderConfigRuntime {
  readonly configService: NodeProviderConfigRuntime["configService"];
  readonly #runtime: NodeProviderConfigRuntime;

  constructor(options: ProviderConfigRuntimeOptions) {
    const runtimeOptions: NodeProviderConfigRuntimeOptions = {
      nibiBuiltinFilePath: options.nibiBuiltinFilePath,
      nibiBuiltinActiveFilePath: options.nibiBuiltinActiveFilePath,
      nibiBuiltinRemote: options.nibiBuiltinRemote,
      nibiBuiltinEnvironment: options.nibiBuiltinEnvironment,
      onZCodeBuiltinRefreshError: options.onZCodeBuiltinRefreshError,
      onPersonalConfigRecovery: options.onPersonalConfigRecovery,
      onPersonalConfigPollingError: options.onPersonalConfigPollingError,
      personalFilePath:
        options.personalFilePath ?? join(getAppConfigDir(), PERSONAL_PROVIDER_CONFIG_FILE_NAME),
      personalPollingIntervalMs: options.personalPollingIntervalMs,
      watch: options.watch,
    };
    this.#runtime = new NodeProviderConfigRuntime(runtimeOptions);
    this.configService = this.#runtime.configService;
  }

  start(): Promise<void> {
    return this.#runtime.start();
  }

  get personalRepository(): NodeProviderConfigRuntime["personalRepository"] {
    return this.#runtime.personalRepository;
  }

  resolveZCodeBuiltinActiveFilePath(): Promise<string> {
    return this.#runtime.resolveZCodeBuiltinActiveFilePath();
  }

  refreshZCodeBuiltin(options?: { readonly force?: boolean }) {
    return this.#runtime.refreshZCodeBuiltin(options);
  }

  onDidCheckZCodeBuiltin(listener: () => Promise<void>): () => void {
    return this.#runtime.onDidCheckZCodeBuiltin(listener);
  }

  dispose(): void {
    this.#runtime.dispose();
  }
}

export function createProviderConfigRuntime(
  options: ProviderConfigRuntimeOptions,
): ProviderConfigRuntime {
  return new ProviderConfigRuntime(options);
}
