import { materializeNibiBuiltinProviderConfig } from "@nibi/services/node";

declare const __NIBI_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export interface MaterializeBundledNibiBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** 返回构建时嵌入远端 Server 的 Nibi Built-in Provider Config。 */
export function readBundledNibiBuiltinProviderConfig(): string {
  if (typeof __NIBI_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    throw new Error("当前构建未嵌入 Nibi Built-in Provider Config");
  }
  return __NIBI_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * 将 Nibi Built-in Config 原子物化到所属环境的固定资源副本。
 * 升级前退出旧进程；不保留按内容 hash 增长的历史文件。
 */
export async function materializeBundledNibiBuiltinProviderConfig(
  options: MaterializeBundledNibiBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeNibiBuiltinProviderConfig(options);
}
