import { NIBI_PROVIDER_ID } from "@nibi/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import { createNibiProviderRuntimeConfig } from "#src/oauth/providers/nibiProviderConfig.js";

function tryResolveHttpUrl(resolve: () => string | URL): URL | null {
  try {
    const url = new URL(resolve());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function resolveNibiUserinfoUrl(env: NodeJS.ProcessEnv): string {
  return createNibiProviderRuntimeConfig(env).userinfoUrl;
}

async function isCurrentNibiCredentialRequest(options: {
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;
  const provider = await options.credentialService.load("oauth:active_provider");
  if (provider !== NIBI_PROVIDER_ID) return false;
  const accessToken = (
    await options.credentialService.load(`oauth:${provider}:access_token`)
  )?.trim();
  if (!accessToken || (authorization !== accessToken && authorization !== `Bearer ${accessToken}`))
    return false;
  // 读取磁盘期间可能切换平台，不能拿上一平台残留 token 的 401 清理当前登录。
  return (await options.credentialService.load("oauth:active_provider")) === provider;
}

/** NIBI 的身份事实只有 userinfo 一条：401 复核只认它。 */
export async function isOAuthBusinessRequest(options: {
  input: string | URL;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  provider?: string | null;
}): Promise<boolean> {
  const provider =
    options.provider ?? (await options.credentialService.load("oauth:active_provider"));
  if (provider !== NIBI_PROVIDER_ID) return false;
  const env = options.env ?? process.env;
  const requestUrl = tryResolveHttpUrl(() => options.input);
  if (!requestUrl) return false;
  const nibiUserinfo = tryResolveHttpUrl(() => resolveNibiUserinfoUrl(env));
  return (
    nibiUserinfo !== null &&
    requestUrl.origin === nibiUserinfo.origin &&
    requestUrl.pathname === nibiUserinfo.pathname
  );
}

/** Host 私有的只读身份核验材料，不进入 RPC、配置或日志。 */
export async function resolveOAuthBusinessCredentialValidationRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<{ url: string; authorization: string; emptyBodyMeansInvalid: boolean } | null> {
  const provider = await options.credentialService.load("oauth:active_provider");
  if (provider !== NIBI_PROVIDER_ID) return null;
  if (!(await isCurrentNibiCredentialRequest(options))) return null;
  if ((await options.credentialService.load("oauth:active_provider")) !== provider) return null;
  const env = options.env ?? process.env;
  const url = tryResolveHttpUrl(() => resolveNibiUserinfoUrl(env));
  if (!url) return null;
  return {
    url: url.toString(),
    authorization: options.headers.get("authorization")!.trim(),
    emptyBodyMeansInvalid: false,
  };
}

export async function isCurrentOAuthBusinessCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  return isCurrentNibiCredentialRequest(options);
}

// 这里只判定候选请求；实际退出须由 OAuthService 在会话变更队列内复核，不能依赖异步旧快照。
export async function isCurrentOAuthCredentialRequest(options: {
  input: string | URL;
  headers: Headers;
  credentialService: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  if (!authorization) return false;
  const currentJwt = (await options.credentialService.load("nibi-jwttoken"))?.trim() ?? "";
  if (currentJwt && authorization === `Bearer ${currentJwt}`) return true;
  // NIBI access token 的 401 同样要进入失效判定（撤销/过期后 UI 不再伪登录）。
  return isCurrentNibiCredentialRequest(options);
}
