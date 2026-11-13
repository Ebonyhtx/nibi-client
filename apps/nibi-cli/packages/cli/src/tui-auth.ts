import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import type { RunDependencies } from "./cli-types.js";
import type { CommandCenterLoginOptions } from "./command-center/types.js";

/**
 * TUI 里的 `/login`、`/logout`：与 `nibi login` 共用同一套 NIBI Device Flow 后端。
 * 命令中心只负责把设备码与结果渲染出来，不做任何 provider 选择——分家后只有一个账号生态。
 */
export async function loginForTui(
  deps: RunDependencies,
  options?: CommandCenterLoginOptions,
) {
  const env = await loadLoginEnv(deps);
  const login = deps.loginNibiAccount ?? (await loadBootstrapModule()).loginNibiAccount;
  return await login({
    abortSignal: options?.abortSignal,
    env,
    onBrowserOpen: options?.onBrowserOpen,
    onDeviceCode: options?.onDeviceCode,
  });
}

export async function logoutForTui(deps: RunDependencies) {
  const env = await loadLoginEnv(deps);
  const logout = deps.logoutNibiAccount ?? (await loadBootstrapModule()).logoutNibiAccount;
  return await logout({ env });
}

async function loadLoginEnv(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({
    cwd: workingDirectory,
    env,
  });

  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }
  return env;
}
