import {
  NIBI_AUTH_ORIGIN,
  NIBI_DESKTOP_OIDC_CLIENT_ID,
  NIBI_OIDC_PROJECT_ID,
  NIBI_OIDC_SCOPE,
  NIBI_PROVIDER_ID,
} from "@nibi/shared";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import { readBoolean, readEnv } from "./configUtils.js";

/** 账号中心常量由 @nibi/shared 单点维护（CLI/TUI 也读同一份）；这里只保留桌面端别名。 */
export { NIBI_AUTH_ORIGIN, NIBI_OIDC_PROJECT_ID, NIBI_OIDC_SCOPE };

/** OIDC native app（Zitadel 控制台里叫 nibi-desktop） */
export const NIBI_OIDC_CLIENT_ID = NIBI_DESKTOP_OIDC_CLIENT_ID;

/** 业务 API 与会员页（客户端内嵌收银台用；环境变量可覆盖，便于本地联调）。 */
export const NIBI_API_BASE_URL = "https://api.nibistudio.top";
export const NIBI_MEMBERSHIP_SITE_URL = "https://nibistudio.top/membership/";

export const NIBI_OAUTH_PROVIDER_CONFIG: Omit<OAuthProviderRuntimeConfig, "appSecret"> = {
  id: NIBI_PROVIDER_ID,
  displayName: "NIBI",
  enabled: true,
  order: 0,
  authorizeUrl: `${NIBI_AUTH_ORIGIN}/oauth/v2/authorize`,
  tokenUrl: `${NIBI_AUTH_ORIGIN}/oauth/v2/token`,
  userinfoUrl: `${NIBI_AUTH_ORIGIN}/oidc/v1/userinfo`,
  appId: NIBI_OIDC_CLIENT_ID,
  redirectUri: "nibi://oauth/callback",
};

export function createNibiProviderRuntimeConfig(
  env: NodeJS.ProcessEnv,
): OAuthProviderRuntimeConfig {
  return {
    ...NIBI_OAUTH_PROVIDER_CONFIG,
    enabled: readBoolean(env, "NIBI_OAUTH_ENABLED", NIBI_OAUTH_PROVIDER_CONFIG.enabled),
    authorizeUrl:
      readEnv(env, "NIBI_OAUTH_AUTHORIZE_URL") ?? NIBI_OAUTH_PROVIDER_CONFIG.authorizeUrl,
    tokenUrl: readEnv(env, "NIBI_OAUTH_TOKEN_URL") ?? NIBI_OAUTH_PROVIDER_CONFIG.tokenUrl,
    userinfoUrl: readEnv(env, "NIBI_OAUTH_USERINFO_URL") ?? NIBI_OAUTH_PROVIDER_CONFIG.userinfoUrl,
    appId: readEnv(env, "NIBI_OAUTH_CLIENT_ID") ?? NIBI_OAUTH_PROVIDER_CONFIG.appId,
    redirectUri: readEnv(env, "NIBI_OAUTH_REDIRECT_URI") ?? NIBI_OAUTH_PROVIDER_CONFIG.redirectUri,
  };
}
