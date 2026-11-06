import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

function pathApiForPlatform(platform) {
  return platform === "win32" ? win32 : posix;
}

/**
 * 复用**我们自己的**正式版缓存：打包态 NIBI 的 userData 目录名就是 `NIBI`
 * （见 `packages/desktop/src/main/desktopRuntimeEnv.ts` 的 production 应用名），
 * `dev:desktop:remote-prod` 读它才不会重复下载同一批远端资产。
 *
 * 这里原先指向上游的 `ZCode/`：同机装了上游产品时，等于拿**别的产品**的缓存来跑我们的链路，
 * 与"除插件外不得与上游有关系"直接冲突。显式 `NIBI_REMOTE_ASSET_CACHE_DIR` 仍可覆盖。
 */
export function resolveProductionRemoteAssetCacheDir(
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
) {
  const pathApi = pathApiForPlatform(platform);
  if (platform === "darwin") {
    return pathApi.join(homeDir, "Library", "Application Support", "NIBI", "remote-assets-cache");
  }

  if (platform === "win32") {
    const appDataDir = env.APPDATA?.trim() || pathApi.join(homeDir, "AppData", "Roaming");
    return pathApi.join(appDataDir, "NIBI", "remote-assets-cache");
  }

  const configDir = env.XDG_CONFIG_HOME?.trim() || pathApi.join(homeDir, ".config");
  return pathApi.join(configDir, "NIBI", "remote-assets-cache");
}

export function buildDesktopRemoteProdEnv(
  baseEnv = process.env,
  platform = process.platform,
  homeDir = homedir(),
) {
  const cacheDir =
    baseEnv.NIBI_REMOTE_ASSET_CACHE_DIR?.trim() ||
    resolveProductionRemoteAssetCacheDir(baseEnv, platform, homeDir);

  return {
    ...baseEnv,
    // remote CDN 基址现在跟随 NIBI_ENV 分流；该脚本用于复现生产态下载链路，
    // 因此需要同时强制 production 和 CDN 开关，避免默认 test 环境落到测试资源 CDN。
    NIBI_ENV: "production",
    NIBI_DEV_REMOTE_ASSET_USE_CDN: "1",
    NIBI_REMOTE_ASSET_CACHE_DIR: cacheDir,
  };
}

export function resolvePnpmCommand(platform = process.platform) {
  return platform === "win32" ? "pnpm.cmd" : "pnpm";
}

export function runDesktopRemoteProdDev() {
  const repoRoot = resolve(import.meta.dirname, "..");
  const child = spawn(resolvePnpmCommand(), ["--filter", "@nibi/desktop", "dev"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: buildDesktopRemoteProdEnv(),
    windowsHide: true,
  });

  child.on("close", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error("[dev:desktop:remote-prod] failed to start pnpm:", error);
    process.exit(1);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDesktopRemoteProdDev();
}
