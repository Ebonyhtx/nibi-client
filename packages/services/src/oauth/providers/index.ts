import {
  NIBI_PROVIDER_ID,
  type ApiClient,
} from "@nibi/shared";
import type { OAuthRuntimeConfig } from "../runtimeConfig.js";
import { NibiProviderAdapter } from "./nibiProviderAdapter.js";
import type { OAuthProviderAdapter } from "./providerAdapter.js";

/** 根据运行时配置创建可用 provider adapter。 */
export function createOAuthProviderAdapters(
  config: OAuthRuntimeConfig,
  options: { apiClient?: ApiClient } = {},
): OAuthProviderAdapter[] {
  const adapters: OAuthProviderAdapter[] = [];
  const apiClient = options.apiClient;
  if (!apiClient) {
    throw new Error(
      "ApiClient 注入缺失：OAuth provider adapters 必须通过 Providers 传入 apiClient",
    );
  }

  for (const providerConfig of config.providers) {
    switch (providerConfig.id) {
      case NIBI_PROVIDER_ID:
        adapters.push(new NibiProviderAdapter(providerConfig, apiClient));
        break;
      default:
        // 未知 provider 直接忽略，避免单个配置错误拖垮全部登录能力。
        break;
    }
  }

  return adapters;
}

export type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";
