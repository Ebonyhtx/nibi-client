/**
 * 旧 R2 组件安装器的远端组件 id；R3 Source Server 使用 descriptor/archive，不再读它。
 *
 * 部署耦合（B03）：当前 CDN manifest 只发布这个旧 id（artifact
 * `components/<arch>/<id>.tar.gz`，mount `<id>/<arch>`）。`nibi-agent` 是已预留、
 * 但尚未进入 ACTIVE 集合的下一版 id。切换前置条件：CDN 先发布 id 为 `nibi-agent`
 * 的 manifest 组件（mount `nibi-agent/<arch>`），且远端安装器/启动器接受该目录；
 * 之后才能把这个常量与 ACTIVE 列表同批改为 `"nibi-agent"`，不要只改客户端。
 */
export const NIBI_AGENT_REMOTE_COMPONENT_ID = "glm" as const;

export const REMOTE_RESOURCE_PACKAGE_IDS = [
  "server-bundle",
  "node-runtime",
  "node-pty",
  NIBI_AGENT_REMOTE_COMPONENT_ID,
  "nibi-agent",
  "bfs",
  "ripgrep",
  "ugrep",
] as const;

export type RemoteResourcePackageId = (typeof REMOTE_RESOURCE_PACKAGE_IDS)[number];

export const ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS = [
  "server-bundle",
  "node-runtime",
  "node-pty",
  NIBI_AGENT_REMOTE_COMPONENT_ID,
  "bfs",
  "ripgrep",
  "ugrep",
] as const satisfies readonly RemoteResourcePackageId[];

export const REQUIRED_REMOTE_RESOURCE_PACKAGE_IDS = [
  "server-bundle",
  "node-runtime",
] as const satisfies readonly RemoteResourcePackageId[];

export const REMOTE_RESOURCE_PACKAGE_DEPENDENCIES: Partial<
  Record<RemoteResourcePackageId, readonly RemoteResourcePackageId[]>
> = {};

export const OPTIONAL_REMOTE_RESOURCE_PACKAGE_IDS = ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS.filter(
  (id) =>
    !REQUIRED_REMOTE_RESOURCE_PACKAGE_IDS.includes(
      id as (typeof REQUIRED_REMOTE_RESOURCE_PACKAGE_IDS)[number],
    ),
);

export interface RemoteResourcePackageSelection {
  selectedPackageIds?: string[];
}

const REMOTE_RESOURCE_PACKAGE_ID_SET = new Set<RemoteResourcePackageId>(
  REMOTE_RESOURCE_PACKAGE_IDS,
);

const ACTIVE_REMOTE_RESOURCE_PACKAGE_ID_SET = new Set<RemoteResourcePackageId>(
  ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS,
);

const REQUIRED_REMOTE_RESOURCE_PACKAGE_ID_SET = new Set<RemoteResourcePackageId>(
  REQUIRED_REMOTE_RESOURCE_PACKAGE_IDS,
);

export function normalizeRemoteResourcePackageSelection(
  _selection?: RemoteResourcePackageSelection | null,
): RemoteResourcePackageId[] {
  // 当前分支只保留一个 Nibi Agent，历史 SSH 资源包选择已经没有业务意义。
  // 无论旧配置里保存过什么选择，新版本都统一部署完整 active 资源集，避免重连时沿用过时裁剪。
  return [...ACTIVE_REMOTE_RESOURCE_PACKAGE_IDS];
}

export function isActiveRemoteResourcePackage(packageId: RemoteResourcePackageId): boolean {
  return ACTIVE_REMOTE_RESOURCE_PACKAGE_ID_SET.has(packageId);
}

export function isKnownRemoteResourcePackageId(packageId: string): boolean {
  return REMOTE_RESOURCE_PACKAGE_ID_SET.has(packageId as RemoteResourcePackageId);
}

export function isRequiredRemoteResourcePackage(packageId: RemoteResourcePackageId): boolean {
  return REQUIRED_REMOTE_RESOURCE_PACKAGE_ID_SET.has(packageId);
}

export function getRemoteResourcePackageDependencies(
  packageId: RemoteResourcePackageId,
): readonly RemoteResourcePackageId[] {
  return REMOTE_RESOURCE_PACKAGE_DEPENDENCIES[packageId] ?? [];
}

export function isRemoteResourcePackageSelectedAsDependency(
  packageId: RemoteResourcePackageId,
  selectedPackageIds: readonly RemoteResourcePackageId[],
): boolean {
  const selectedPackages = new Set(selectedPackageIds);
  return selectedPackageIds.some((selectedPackageId) =>
    getRemoteResourcePackageDependencies(selectedPackageId).some(
      (dependencyId) => dependencyId === packageId && selectedPackages.has(dependencyId),
    ),
  );
}
