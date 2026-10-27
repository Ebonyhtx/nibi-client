export const NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "NIBI_BUILTIN_PROVIDER_CONFIG_FILE";
export const NIBI_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  "NIBI_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
export const NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "NIBI_PERSONAL_PROVIDER_CONFIG_FILE";
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = "provider_config.json";

export interface NodeProviderRuntimePaths {
  readonly nibiBuiltinFilePath: string;
  readonly personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return {
    [NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: paths.nibiBuiltinFilePath,
    [NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: paths.personalFilePath,
  };
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const nibiBuiltinFilePath = env[NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!nibiBuiltinFilePath && !personalFilePath) return null;
  if (!nibiBuiltinFilePath || !personalFilePath) {
    throw new Error("ZCode Built-in 与 Personal Provider Config 路径必须同时提供");
  }
  return Object.freeze({ nibiBuiltinFilePath, personalFilePath });
}
