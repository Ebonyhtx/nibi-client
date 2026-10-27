import { loadBuiltinProviderConfig } from "../../../../../scripts/builtin-provider-config.mjs";

export const SEA_NIBI_BUILTIN_PROVIDER_CONFIG_ASSET_KEY = "nibi-provider/nibi-builtin.json";

export const collectSeaProviderConfigAssets = async ({ root, env = process.env }) => {
  const { sourcePath } = await loadBuiltinProviderConfig({ root, env });
  return {
    [SEA_NIBI_BUILTIN_PROVIDER_CONFIG_ASSET_KEY]: sourcePath,
  };
};
