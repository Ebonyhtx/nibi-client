import semver from "semver";

export type PluginUpdateStatus = "none" | "update-available" | "version-changed";

/**
 * Compare an installed plugin version against the latest manifest version.
 * - semver.gt(latest, installed) -> "update-available"
 * - parseable + not greater (equal or older) -> "none"
 * - unparseable but differing -> "version-changed" (we can't prove it's newer)
 * - unparseable + equal, or either missing -> "none"
 */
export function comparePluginVersions(input: {
  installed: string | undefined;
  latest: string | undefined;
}): PluginUpdateStatus {
  const { installed, latest } = input;
  if (!installed || !latest) return "none";
  const installedValid = semver.valid(semver.coerce(installed) ?? installed);
  const latestValid = semver.valid(semver.coerce(latest) ?? latest);
  if (installedValid && latestValid) {
    return semver.gt(latestValid, installedValid) ? "update-available" : "none";
  }
  return installed === latest ? "none" : "version-changed";
}

/**
 * 本机安装的版本是否**严格高于**目录条目：两者都可解析时才下结论。
 * 用来把「本机更新」（测试版、回滚到旧目录条目）与「版本相同」区分开 ——
 * 只有后者才该让指纹轴决定是否提示更新，否则会把降级包装成更新推给用户。
 */
function isInstalledVersionNewer(
  installed: string | undefined,
  latest: string | undefined,
): boolean {
  if (!installed || !latest) return false;
  const installedValid = semver.valid(semver.coerce(installed) ?? installed);
  const latestValid = semver.valid(semver.coerce(latest) ?? latest);
  if (!installedValid || !latestValid) return false;
  return semver.gt(installedValid, latestValid);
}

/**
 * 按最新目录条目实际提供的比较轴判断更新状态：优先比较可解析的 version，缺失时比较
 * source identity pin；两者都缺失时保持 none，避免把无法证明的新旧关系误报为更新。
 *
 * version 相同时（或无法比较时）继续比 source identity pin：商店重发了**同版本但内容不同**
 * 的包（发布方改了字节而没动版本号 —— 例如受哈希保护的包改不了版本号，或只换内容的重发）
 * 时，只比版本会让修好的字节永远送不到用户。版本轴给不出结论而两侧指纹都在且不同，
 * 判为 version-changed（我们无法证明它更新，但可以肯定内容不一样）。
 * 只在两侧都有指纹时才比，避免把没有指纹的本地 seed 安装误报成可更新。
 */
export function comparePluginUpdate(input: {
  installedVersion: string | undefined;
  installedSha: string | undefined;
  latestVersion: string | undefined;
  latestSha: string | undefined;
}): PluginUpdateStatus {
  const { installedVersion, installedSha, latestVersion, latestSha } = input;
  if (latestVersion) {
    const byVersion = comparePluginVersions({ installed: installedVersion, latest: latestVersion });
    if (byVersion !== "none") return byVersion;
    // 本机比目录新时指纹不同也不能提示更新：那不是更新，是降级。
    if (isInstalledVersionNewer(installedVersion, latestVersion)) return "none";
    if (latestSha && installedSha) {
      return installedSha === latestSha ? "none" : "version-changed";
    }
    return "none";
  }
  if (latestSha) {
    if (!installedSha) return "version-changed";
    return installedSha === latestSha ? "none" : "update-available";
  }
  return "none";
}
