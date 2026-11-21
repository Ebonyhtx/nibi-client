/**
 * Nibi Agent 的远端组件 id。R3 Source Server 使用 descriptor/archive；该 id 只用于
 * 旧 R2 组件安装器与本地 runtime 资源目录，不再接受历史别名。
 */
export const NIBI_AGENT_REMOTE_COMPONENT_ID = "nibi-agent" as const;

export const NIBI_AGENT_REMOTE_COMPONENT_IDS = [
  NIBI_AGENT_REMOTE_COMPONENT_ID,
] as const;

export type NibiAgentRemoteComponentId = (typeof NIBI_AGENT_REMOTE_COMPONENT_IDS)[number];

export const REMOTE_RESOURCE_PACKAGE_IDS = [
  "server-bundle",
  "node-runtime",
  "node-pty",
  ...NIBI_AGENT_REMOTE_COMPONENT_IDS,
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
> = {
  // Agent bundle 由远端已部署的 node 执行 nibi.cjs。
  [NIBI_AGENT_REMOTE_COMPONENT_ID]: ["node-runtime"],
};

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

export function isNibiAgentRemoteComponentId(
  packageId: string,
): packageId is NibiAgentRemoteComponentId {
  return (NIBI_AGENT_REMOTE_COMPONENT_IDS as readonly string[]).includes(packageId);
}

/**
 * 从 manifest 实际发布的组件 id 中选择 Nibi Agent 组件。
 *
 * 只有 manifest 明确发布某个 id 时才返回它；两个 id 都不存在时返回 null，
 * 由调用方 fail-closed（不能默认回退到未发布的组件）。
 */
export function selectNibiAgentRemoteComponentId(
  publishedComponentIds: Iterable<string>,
): NibiAgentRemoteComponentId | null {
  const published = new Set(publishedComponentIds);
  for (const componentId of NIBI_AGENT_REMOTE_COMPONENT_IDS) {
    if (published.has(componentId)) {
      return componentId;
    }
  }
  return null;
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
