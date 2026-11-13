import type { OAuthProviderId } from "@nibi/shared";
import { createNibiProviderRuntimeConfig } from "./providers/nibiProviderConfig.js";

/** Provider 运行时配置（仅 host process 可见） */
export interface OAuthProviderRuntimeConfig {
  id: OAuthProviderId;
  displayName: string;
  enabled: boolean;
  order: number;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  appId: string;
  redirectUri: string;
  businessLoginUrl?: string;
  appSecret?: string;
}

/** OAuth 全局运行时配置 */
export interface OAuthRuntimeConfig {
  providers: OAuthProviderRuntimeConfig[];
}

/**
 * 从运行时环境变量生成 OAuth 配置。
 *
 * NIBI 只登录自家账号中心；智谱 Z.ai / BigModel 的账号 OAuth 已整体删除。
 * 模型接入仍保留 API Key / Coding Plan API Key 模板，与账号登录是两条链。
 */
export function createOAuthRuntimeConfig(env: NodeJS.ProcessEnv = process.env): OAuthRuntimeConfig {
  return {
    providers: [createNibiProviderRuntimeConfig(env)],
  };
}
