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
  // 字节相同 = 没有可更新的内容。这条必须放在版本轴之前：发布方 bump 了目录版本却忘了
  // 改包内 plugin.json 时（2026-11-12 lark-cli 等 6 个包实测），版本轴会永远报「有更新」，
  // 用户点多少次都只是在重装同一份字节。指纹相同就说明装的就是目录最新包。
  if (latestSha && installedSha && latestSha === installedSha) return "none";
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

/** 撤销列表版本约束的前缀运算符；顺序保证 `<=`/`>=` 先于 `<`/`>` 匹配。 */
const VERSION_CONSTRAINT_PREFIXES = ["<=", ">=", "<", ">", "="] as const;

type VersionConstraintOperator = (typeof VERSION_CONSTRAINT_PREFIXES)[number] | "";

/**
 * 把 semver 能识别的版本归一成可比较形式；识别不了返回 undefined。
 * 与 comparePluginVersions 同口径（先 coerce 再 valid），避免「1.2」在更新检测里算
 * 1.2.0、在撤销匹配里却算不可比较的两套判定。
 */
function parseComparableVersion(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return semver.valid(semver.coerce(trimmed) ?? trimmed) ?? undefined;
}

/**
 * 解析一条撤销版本约束：可选前缀 `< <= > >= =`，其余部分为目标版本。
 * 空约束、只有前缀没有版本都视为无效（返回 null），由调用方丢弃。
 */
function parseVersionConstraint(
  raw: string,
): { operator: VersionConstraintOperator; target: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  for (const prefix of VERSION_CONSTRAINT_PREFIXES) {
    if (!trimmed.startsWith(prefix)) continue;
    const target = trimmed.slice(prefix.length).trim();
    return target ? { operator: prefix, target } : null;
  }
  return { operator: "", target: trimmed };
}

/**
 * 判断单个版本是否命中一条撤销约束。
 *
 * - 无前缀（或 `=`）：精确匹配；两侧都能按 semver 解析时按 semver 相等比较（1.2 == 1.2.0），
 *   否则退回字符串精确比较（外部生态的版本号并不保证是 semver）。
 * - `< <= > >=`：仅在两侧都能解析时下结论；无法比较返回 false —— 撤销条目是精确的
 *   安全名单，拿不可比的自定义版本号硬套大小关系只会误伤/漏放，调用方仍可用 sha256 条目兜底。
 */
export function matchesPluginVersionRange(version: string | undefined, range: string): boolean {
  if (version === undefined) return false;
  const constraint = parseVersionConstraint(range);
  if (!constraint) return false;
  const installed = version.trim();
  if (!installed) return false;
  if (constraint.operator === "" || constraint.operator === "=") {
    const left = parseComparableVersion(installed);
    const right = parseComparableVersion(constraint.target);
    if (left && right) return semver.eq(left, right);
    return installed === constraint.target.trim();
  }
  const left = parseComparableVersion(installed);
  const right = parseComparableVersion(constraint.target);
  if (!left || !right) return false;
  switch (constraint.operator) {
    case "<":
      return semver.lt(left, right);
    case "<=":
      return semver.lte(left, right);
    case ">":
      return semver.gt(left, right);
    case ">=":
      return semver.gte(left, right);
  }
  return false;
}

/**
 * 条目可声明多个版本约束（string 或 string[]）：任意一条命中即视为版本命中。
 * 空数组 / 全无效约束 → false，不会把「写错的约束」当成全版本撤销。
 */
export function matchesPluginVersionRanges(
  version: string | undefined,
  ranges: string | readonly string[],
): boolean {
  const list = typeof ranges === "string" ? [ranges] : ranges;
  return list.some((range) => matchesPluginVersionRange(version, range));
}
