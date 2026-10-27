/**
 * NIBI 账号中心（Zitadel）的公开常量。
 *
 * 桌面端、CLI/TUI 与官网登录都指向同一个账号中心；客户端里出现第二份客户端 id
 * 或 scope 拼装，就会在"桌面能登录、CLI 说令牌无效"这类问题上浪费排查时间。
 * client id 属于 OIDC 公开标识，不是密钥。
 */

/** 账号中心 origin（auth.nibistudio.top 的 OIDC/Device Flow 入口） */
export const NIBI_AUTH_ORIGIN = "https://auth.nibistudio.top";

/** Zitadel 项目 id：access token 的 aud 必须带它，服务端 verifyBearer 才认。 */
export const NIBI_OIDC_PROJECT_ID = "393742195619790852";

/** OIDC native app：桌面端（授权码 + PKCE，nibi:// 深链回调） */
export const NIBI_DESKTOP_OIDC_CLIENT_ID = "393742196089552900";

/** OIDC native app：CLI/TUI（Device Authorization Grant） */
export const NIBI_TUI_OIDC_CLIENT_ID = "393742196290879492";

/**
 * OIDC SPA app：手机远控 Web 页（授权码 + PKCE，无 client secret）。
 * 回调必须与页面同源：`{endpointOrigin}/remote/v4`。Zitadel 要求 redirect_uri 与登记值
 * **完全一致**，所以二维码参数只能放在 state 里，不能拼到回调地址上。
 */
export const NIBI_WEB_OIDC_CLIENT_ID = "396486558825381892";

/**
 * NIBI 登录 scope。
 * offline_access 用来拿 refresh_token；project aud scope 让 access token 带上项目 audience，
 * 否则 api.nibistudio.top 的鉴权会以"令牌无效"拒掉一个完全正常的登录。
 */
export const NIBI_OIDC_SCOPE = [
  "openid",
  "profile",
  "email",
  "offline_access",
  `urn:zitadel:iam:org:project:id:${NIBI_OIDC_PROJECT_ID}:aud`,
].join(" ");

/** 读环境变量覆盖（联调与自建账号中心用；空值按未设置处理）。 */
export function resolveNibiAuthOrigin(
  env: Record<string, string | undefined> = {},
): string {
  const configured = env.NIBI_AUTH_ORIGIN?.trim();
  return (configured || NIBI_AUTH_ORIGIN).replace(/\/+$/u, "");
}
