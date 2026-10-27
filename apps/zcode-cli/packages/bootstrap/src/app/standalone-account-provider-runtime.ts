import { createHash } from "node:crypto";
import {
  SHARED_NIBI_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "@nibi/adapters/auth";
import type { ProviderRuntimeHeadersPort } from "@nibi/core";
import {
  createAccountProviderConfigSnapshot,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type AccountProviderConfigSnapshot,
  type ProviderConfigLayerSnapshot,
} from "@nibi/provider";
import {
  NodeZCodeBuiltinProviderConfigSource,
  NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@nibi/provider-node";
import type { ProviderFamilyDomain } from "@nibi/shared";

export interface StandaloneCodingPlanProvider {
  readonly family: ProviderFamilyDomain;
  readonly modelId: string;
  readonly providerId: string;
}

export async function readStandaloneCodingPlanProviders(
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly StandaloneCodingPlanProvider[]> {
  return (await readStandaloneCodingPlanCatalog(env)).providers;
}

async function readStandaloneCodingPlanCatalog(
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<{
  readonly nibiBuiltinRevision: string;
  readonly providers: readonly StandaloneCodingPlanProvider[];
}> {
  if (config)
    return {
      nibiBuiltinRevision: config.revision,
      providers: config.providers.entries().flatMap(([providerId, provider]) => {
        const access = provider.access;
        const modelId = provider.builtinModelIds?.find((candidate) => candidate.trim())?.trim();
        return access?.type === "zhipu-account" &&
          access.mode === "individual-coding-plan" &&
          access.accountType &&
          modelId
          ? [{ family: access.accountType, modelId, providerId }]
          : [];
      }),
    };
  const filePath = env[NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!filePath) {
    throw new Error(`${NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV} is required for login`);
  }
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: filePath,
    watch: false,
  });
  try {
    const snapshot = await source.read();
    return readStandaloneCodingPlanCatalog(env, snapshot);
  } finally {
    source.dispose();
  }
}

export async function resolveStandaloneCodingPlanProvider(
  family: ProviderFamilyDomain,
  env: Readonly<Record<string, string | undefined>>,
): Promise<StandaloneCodingPlanProvider> {
  const matches = (await readStandaloneCodingPlanProviders(env)).filter(
    (provider) => provider.family === family,
  );
  if (matches.length !== 1) {
    throw new Error(
      `ZCode Built-in Config 必须为 ${family} 声明唯一 Individual Coding Plan Provider`,
    );
  }
  return matches[0]!;
}

export function standaloneAccountIdentityCredentialKey(providerId: string): string {
  const normalized = providerId.trim();
  if (!normalized) throw new Error("Standalone Account Provider ID 不能为空");
  return `account-provider:${normalized}:identity`;
}

export function standaloneAccountAuthSourceCredentialKey(providerId: string): string {
  return `account-provider:${providerId}:auth-source`;
}
function oauthCredentialKey(family: ProviderFamilyDomain): string {
  return family === "zai"
    ? SHARED_NIBI_CREDENTIAL_KEYS.zaiAccessToken
    : SHARED_NIBI_CREDENTIAL_KEYS.bigmodelAccessToken;
}

/** Standalone Credential Store 私有键；不得进入 Provider Config、Model 或 Protocol。 */
export function standaloneAccountProviderCredentialKey(input: {
  readonly providerId: string;
  readonly accountIdentity: string;
}): string {
  const providerId = input.providerId.trim();
  const accountIdentity = input.accountIdentity.trim();
  if (!providerId) throw new Error("Standalone Account Provider ID 不能为空");
  if (!accountIdentity) throw new Error("Standalone Account Identity 不能为空");
  return `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

/** 没有账号 Profile 的手工 Key 登录使用稳定、不可逆的连接身份。 */
export function createStandaloneAccountIdentityFromSecret(secret: string): string {
  const normalized = secret.trim();
  if (!normalized) throw new Error("Standalone Account Secret 不能为空");
  return `key-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export async function readStandaloneAccountProviderConfigSnapshot(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<AccountProviderConfigSnapshot> {
  const catalog = await readStandaloneCodingPlanCatalog(env, config);
  const configuredProviders = catalog.providers;
  const identityKeys = configuredProviders.map(({ providerId }) =>
    standaloneAccountIdentityCredentialKey(providerId),
  );
  const identities = await credentialStore.loadMany(identityKeys);
  const candidates = configuredProviders.flatMap(({ family, providerId }) => {
    const accountIdentity = identities[standaloneAccountIdentityCredentialKey(providerId)]?.trim();
    if (!accountIdentity) return [];
    const credentialKey = standaloneAccountProviderCredentialKey({
      providerId,
      accountIdentity,
    });
    return [{ accountIdentity, credentialKey, family, providerId }] as const;
  });
  const sources = await credentialStore.loadMany(
    candidates.map(({ providerId }) => standaloneAccountAuthSourceCredentialKey(providerId)),
  );
  // 先按来源选择读取范围；OAuth 不解密旧 Key，手工模式也不依赖无关 OAuth 密文。
  const credentials = await credentialStore.loadMany(
    candidates.map(({ credentialKey, providerId, family }) =>
      sources[standaloneAccountAuthSourceCredentialKey(providerId)] === "manual"
        ? credentialKey
        : oauthCredentialKey(family),
    ),
  );
  const candidateByProviderId = new Map(
    candidates.map((candidate) => [candidate.providerId, candidate]),
  );
  const providers = new ProviderConfigMap(
    configuredProviders.map(({ family, providerId }) => {
      const candidate = candidateByProviderId.get(providerId);
      const source = sources[standaloneAccountAuthSourceCredentialKey(providerId)];
      const requestCredentialKey =
        source === "manual" ? candidate?.credentialKey : oauthCredentialKey(family);
      const authorized = Boolean(requestCredentialKey && credentials[requestCredentialKey]?.trim());
      if (!candidate || !authorized) {
        // Bug 根因：账号 Overlay 缺少成员表示“不覆盖”，不能表达账号已断开；必须显式
        // entitled=false，才能让 Built-in 账号 Provider 在凭据删除后从 Registry 退出。
        return [
          providerId,
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({ entitled: false }),
          }),
        ] as const;
      }
      return [
        providerId,
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
        }),
      ] as const;
    }),
  );
  return createAccountProviderConfigSnapshot(catalog.nibiBuiltinRevision, providers);
}

export async function hasStandaloneCodingPlanAccess(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
  env: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  return (await readStandaloneAccountProviderConfigSnapshot(credentialStore, env)).providers
    .entries()
    .some(([, provider]) =>
      provider.access?.type === "zhipu-account" ? provider.access.entitled === true : false,
    );
}

export function createStandaloneProviderRuntimeHeadersPort(
  _credentialStore: Pick<SharedZCodeCredentialStore, "load" | "loadMany" | "save" | "delete">,
  _env: Readonly<Record<string, string | undefined>>,
): ProviderRuntimeHeadersPort & {
  clearProjectTokens(): void;
  invalidateChangedCredentials(): Promise<void>;
} {
  // 上游 Coding Plan / Team Plan 已移除；账号型 Provider 不再有请求期凭据投影。
  return {
    clearProjectTokens() {},
    async invalidateChangedCredentials() {},
    shouldRefreshBeforeModelRequest() {
      return false;
    },
    async refreshBeforeModelRequest(input) {
      throw new Error(`Standalone Account Provider 套餐鉴权已移除: ${input.providerId}`);
    },
  };
}
