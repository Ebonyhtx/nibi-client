function parseVersion(version) {
  const match =
    typeof version === "string" &&
    version.match(
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
    );
  const prerelease = match && match[4] ? match[4].split(".") : [];
  if (!match || match[0] !== version || prerelease.some((part) => /^0\d+$/.test(part))) {
    throw new Error("Expected a package version such as 3.12.2");
  }
  return { core: match.slice(1, 4).map(BigInt), prerelease };
}

/** 构建与发布共用版本解析；随 packages/web 复制进 Docker，避免依赖未复制的根 scripts。 */
export function resolveRemoteFrontendVersion(packageVersion, override) {
  const version = override?.trim() || packageVersion;
  parseVersion(version);
  return version;
}

/** SemVer 优先级：主版本号逐段数值比较，正式版高于预发布，忽略 build metadata。 */
export function compareRemoteFrontendVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  for (let index = 0; index < 3; index += 1) {
    const order = compare(left.core[index], right.core[index]);
    if (order) return order;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length ? -1 : right.prerelease.length ? 1 : 0;
  }
  for (
    let index = 0;
    index < Math.min(left.prerelease.length, right.prerelease.length);
    index += 1
  ) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    const order =
      numericA && numericB
        ? compare(BigInt(a), BigInt(b))
        : numericA !== numericB
          ? numericA
            ? -1
            : 1
          : compare(a, b);
    if (order) return order;
  }
  return compare(left.prerelease.length, right.prerelease.length);
}

/**
 * 给部署后的 SPA 一个可机器读取的版本标记：页面 `<meta name="nibi-release-*">`
 * 与 `/remote/v4/release.json`、`/cn/share/release.json`。发布台账优先读页面
 * meta，因为两个 SPA 的 index.html 都是 no-cache；release.json 是辅助机器可读副本。
 *
 * 只写构建产物，不参与运行时；`build` 命令之外（dev server）不会生成。
 */
export function releaseJsonPlugin({ surface, version, environment, commit }) {
  if (!surface || !version) throw new Error("releaseJsonPlugin requires surface and version");
  const resolvedCommit = commit || "unknown";
  return {
    name: "nibi-release-json",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { name: "nibi-release-version", content: version },
          injectTo: "head",
        },
        {
          tag: "meta",
          attrs: { name: "nibi-release-surface", content: surface },
          injectTo: "head",
        },
        {
          tag: "meta",
          attrs: { name: "nibi-release-commit", content: resolvedCommit },
          injectTo: "head",
        },
      ];
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "release.json",
        source: `${JSON.stringify(
          {
            schemaVersion: 1,
            surface,
            version,
            environment,
            commit: resolvedCommit,
          },
          null,
          2,
        )}\n`,
      });
    },
  };
}
