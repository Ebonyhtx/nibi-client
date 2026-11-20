/**
 * 旧 R2 组件安装器的远端组件 id；R3 Source Server 使用 descriptor/archive，不再读它。
 *
 * B03 双读迁移：客户端优先使用 `nibi-agent`，但只有 manifest 明确发布该 id
 * （artifact `components/<arch>/<id>.tar.gz`，mount `<id>/<arch>`）时才采用；
 * 旧 CDN 只发布 `glm` 时自动回退到 `glm`。新客户端必须继续能读 4.1.3 时代的
 * 旧 manifest（只含 `glm`），4.1.3 客户端也必须能读同时发布两个 id 的新 manifest。
 *
 * 因此发布顺序必须是：先让 CDN 同时发布 `glm` 与 `nibi-agent`，并保持一段时间；
 * 确认存量客户端已升级后，才能停止发布 `glm`。发布侧没有完成双发时，客户端仍会
 * 回退旧 id，不会把全部远程用户切到不存在的组件上。
 */
export const NIBI_AGENT_REMOTE_COMPONENT_ID = "nibi-agent" as const;

/** 双读回退 id：仅当 manifest 未发布 `nibi-agent` 时使用。 */
export const NIBI_AGENT_REMOTE_COMPONENT_FALLBACK_ID = "glm" as const;

export const NIBI_AGENT_REMOTE_COMPONENT_IDS = [
  NIBI_AGENT_REMOTE_COMPONENT_ID,
  NIBI_AGENT_REMOTE_COMPONENT_FALLBACK_ID,
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
  // Agent bundle 由远端已部署的 node 执行 nibi.cjs；两个 id 只是同一制品在
  // manifest 里的新旧别名，依赖相同的 node-runtime。
  [NIBI_AGENT_REMOTE_COMPONENT_ID]: ["node-runtime"],
  [NIBI_AGENT_REMOTE_COMPONENT_FALLBACK_ID]: ["node-runtime"],
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
