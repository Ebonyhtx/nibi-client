import { z } from "zod";
import {
  parseNibiBuiltinModelConfigRules,
  parseNibiBuiltinProviderConfigRules,
  type ModelConfigRules,
  type ProviderConfigMap,
  type ProviderTemplateMap,
} from "@nibi/provider";

export const NIBI_BUILTIN_RELEASE_SCHEMA_VERSION = 1 as const;
const RETIRED_ZAPI_PROVIDER_ID = "builtin:zapi";

export interface NibiBuiltinConfigContent {
  readonly providers: ProviderConfigMap;
  readonly providerTemplates: ProviderTemplateMap;
  readonly modelConfigRules: ModelConfigRules;
}

export interface NibiBuiltinRelease {
  readonly schemaVersion: typeof NIBI_BUILTIN_RELEASE_SCHEMA_VERSION;
  readonly revision: number;
  readonly config: NibiBuiltinConfigContent;
}

const releaseSchema = z
  .object({
    schemaVersion: z.literal(NIBI_BUILTIN_RELEASE_SCHEMA_VERSION),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    config: z
      .object({
        providerConfigRules: z.unknown(),
        modelConfigRules: z.unknown(),
      })
      .strict(),
  })
  .strict();

export function decodeNibiBuiltinRelease(input: unknown): NibiBuiltinRelease {
  const parsed = releaseSchema.parse(input);
  const { providers, providerTemplates } = parseNibiBuiltinProviderConfigRules(
    parsed.config.providerConfigRules,
  );
  // ZAPI 已退出产品，旧 Remote Release 或 LKG 不能在 Renderer 静态入口删除后
  // 又通过目标 Host Registry 将它重新发布。拒绝整份不兼容 Release，让 Source 回落到兼容候选。
  if (providers.has(RETIRED_ZAPI_PROVIDER_ID)) {
    throw new Error(`Nibi Built-in Release 包含已退出的 Provider: ${RETIRED_ZAPI_PROVIDER_ID}`);
  }
  return Object.freeze({
    schemaVersion: NIBI_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: parsed.revision,
    config: Object.freeze({
      providers,
      providerTemplates,
      modelConfigRules: parseNibiBuiltinModelConfigRules(parsed.config.modelConfigRules),
    }),
  });
}

export function encodeNibiBuiltinRelease(release: NibiBuiltinRelease): object {
  return {
    schemaVersion: NIBI_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: release.revision,
    config: {
      providerConfigRules: {
        templateRules: release.config.providerTemplates.toJSON(),
        providerRules: release.config.providers.toJSON(),
      },
      modelConfigRules: release.config.modelConfigRules.toNibiBuiltinJSON(),
    },
  };
}

export function serializeNibiBuiltinRelease(release: NibiBuiltinRelease): string {
  return JSON.stringify(encodeNibiBuiltinRelease(release));
}
