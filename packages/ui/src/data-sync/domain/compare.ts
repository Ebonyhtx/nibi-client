import {
  compareSemverVersions,
  type DataSyncBlockedReason,
  type DataSyncImportItem,
  type DataSyncImportResultItem,
  type DataSyncListItem,
} from "@nibi/shared";
import type {
  DataSyncCategoryId,
  DataSyncPushFailure,
  DataSyncPushOutcome,
  DataSyncPushSummary,
  DataSyncRow,
  DataSyncRowNote,
  DataSyncRowStatus,
} from "@/data-sync/contract.js";

/**
 * 数据同步的纯比较逻辑（docs/remote/data-sync.md「行状态与默认选择」）。
 * 六种分类共用同一套行状态；不做 IO；远端独有项不进入推送，也永不删除。
 *
 * 比较顺序：
 * 1. 两端都有版本时按版本：本机新 → update，远端新 → difference，相同 → synced。
 * 2. 无版本（或版本不能解析）：两端 list 都带 contentHash 时直接比；
 *    否则签名不同 → difference，签名相同才使用按需计算的 contentHashes 判断「已同步」。
 */

const STATUS_ORDER: Record<DataSyncRowStatus, number> = {
  push: 0,
  update: 1,
  difference: 2,
  synced: 3,
  remoteOnly: 4,
  blocked: 5,
};

export interface DataSyncHashRequests {
  sourceKeys: string[];
  targetKeys: string[];
}

export interface DataSyncCheckState {
  checked: boolean;
  indeterminate: boolean;
}

function signatureKey(item: DataSyncListItem): string {
  return item.signature ? `${item.signature.fileCount}:${item.signature.totalBytes}` : "";
}

/**
 * 两端都有版本号时比较。返回 null 表示版本缺失或不能解析，需要回落到内容比较；
 * 0 表示版本相同，直接视为已同步。
 */
function compareVersions(source: DataSyncListItem, target: DataSyncListItem): number | null {
  if (!source.version || !target.version) return null;
  return compareSemverVersions(source.version, target.version);
}

function isComparable(source: DataSyncListItem, target: DataSyncListItem | undefined): boolean {
  return Boolean(target) && !source.exportBlockedReason && !target!.overwriteBlockedReason;
}

/**
 * 哈希请求：只针对两端都有且能同步的项。
 * - 目标端：列表没给 contentHash 时计算，作为覆盖时的 expectedTargetHash。
 * - 来源端：只在版本不能决定、签名相同且列表没给 contentHash 时计算，用于判断「已同步 / 内容不同」。
 * - JSON 类条目（钩子 / 命令 / 子智能体）list 自带 contentHash，两端都有时不会发请求。
 */
export function selectSkillHashRequests(
  sourceItems: readonly DataSyncListItem[],
  targetItems: readonly DataSyncListItem[],
  targetBlockedReason?: DataSyncBlockedReason,
): DataSyncHashRequests {
  if (targetBlockedReason) return { sourceKeys: [], targetKeys: [] };
  const targetByKey = new Map(targetItems.map((item) => [item.key, item]));
  const sourceKeys: string[] = [];
  const targetKeys: string[] = [];
  for (const source of sourceItems) {
    const target = targetByKey.get(source.key);
    if (!target || !isComparable(source, target)) continue;
    const versionResult = compareVersions(source, target);
    // 版本相同直接是已同步，不需要任何哈希。
    if (versionResult === 0) continue;
    if (!target.contentHash) targetKeys.push(source.key);
    // 版本不同已经能决定行状态；来源哈希只用于内容比较。
    if (versionResult !== null) continue;
    if (!source.contentHash && signatureKey(source) === signatureKey(target)) {
      sourceKeys.push(source.key);
    }
  }
  return { sourceKeys, targetKeys };
}

/** 通用别名：所有分类共用同一套哈希请求选择。 */
export const selectDataSyncHashRequests = selectSkillHashRequests;

function rowBase(
  source: DataSyncListItem,
  category: DataSyncCategoryId,
): Omit<
  DataSyncRow,
  "status" | "note" | "selectable" | "defaultSelected" | "importMode" | "expectedTargetHash"
> {
  return {
    category,
    key: source.key,
    name: source.name,
    ...(source.description ? { description: source.description } : {}),
    ...(source.signature ? { sourceSignature: source.signature } : {}),
    ...(source.directoryName ? { directoryName: source.directoryName } : {}),
    ...(source.path ? { path: source.path } : {}),
    ...(source.parentKey ? { parentKey: source.parentKey } : {}),
    ...(source.dependencies ? { dependencies: source.dependencies } : {}),
    totalBytes: source.signature?.totalBytes ?? 0,
  };
}

function blockedRow(
  source: DataSyncListItem,
  target: DataSyncListItem | undefined,
  reason: DataSyncBlockedReason,
  category: DataSyncCategoryId,
): DataSyncRow {
  return {
    ...rowBase(source, category),
    ...(target?.signature ? { targetSignature: target.signature } : {}),
    status: "blocked",
    note: { kind: "blocked", reason },
    selectable: false,
    defaultSelected: false,
  };
}

/**
 * 内容是否一致：
 * - 两端 list 都带 contentHash：直接比较，不再发哈希请求；
 * - 否则签名不同：内容必然不同；
 * - 签名相同：使用两端按需返回的 contentHashes。
 */
function isSameContent(
  source: DataSyncListItem,
  target: DataSyncListItem,
  sourceHashes: Readonly<Record<string, string>>,
  targetHashes: Readonly<Record<string, string>>,
): boolean {
  if (source.contentHash && target.contentHash) {
    return source.contentHash === target.contentHash;
  }
  if (signatureKey(source) !== signatureKey(target)) return false;
  const sourceHash = source.contentHash ?? sourceHashes[source.key];
  const targetHash = target.contentHash ?? targetHashes[source.key];
  return Boolean(sourceHash) && sourceHash === targetHash;
}

function compareRow(
  source: DataSyncListItem,
  target: DataSyncListItem | undefined,
  sourceHashes: Readonly<Record<string, string>>,
  targetHashes: Readonly<Record<string, string>>,
  targetBlockedReason: DataSyncBlockedReason | undefined,
  category: DataSyncCategoryId,
): DataSyncRow {
  const blockedReason =
    targetBlockedReason ?? source.exportBlockedReason ?? target?.overwriteBlockedReason;
  if (blockedReason) return blockedRow(source, target, blockedReason, category);
  if (!target) {
    return {
      ...rowBase(source, category),
      status: "push",
      note: { kind: "sourceOnly" },
      selectable: true,
      defaultSelected: true,
      importMode: "createOnly",
    };
  }
  const expectedTargetHash = target.contentHash ?? targetHashes[source.key];
  const overwrite = {
    importMode: "overwrite" as const,
    ...(expectedTargetHash ? { expectedTargetHash } : {}),
  };
  const versionResult = compareVersions(source, target);
  if (versionResult !== null) {
    if (versionResult === 0) {
      return {
        ...rowBase(source, category),
        ...(target.signature ? { targetSignature: target.signature } : {}),
        status: "synced",
        note: { kind: "synced" },
        selectable: false,
        defaultSelected: false,
      };
    }
    return versionResult > 0
      ? {
          ...rowBase(source, category),
          ...(target.signature ? { targetSignature: target.signature } : {}),
          status: "update",
          note: { kind: "version", from: target.version!, to: source.version! },
          selectable: true,
          defaultSelected: true,
          ...overwrite,
        }
      : {
          ...rowBase(source, category),
          ...(target.signature ? { targetSignature: target.signature } : {}),
          status: "difference",
          note: { kind: "sourceOlder" },
          selectable: true,
          defaultSelected: false,
          ...overwrite,
        };
  }
  const sameContent = isSameContent(source, target, sourceHashes, targetHashes);
  return {
    ...rowBase(source, category),
    ...(target.signature ? { targetSignature: target.signature } : {}),
    ...(sameContent
      ? {
          status: "synced" as const,
          note: { kind: "synced" as const } satisfies DataSyncRowNote,
          selectable: false,
          defaultSelected: false,
        }
      : {
          status: "difference" as const,
          note: { kind: "contentDiffers" as const } satisfies DataSyncRowNote,
          selectable: true,
          defaultSelected: true,
          ...overwrite,
        }),
  };
}

function remoteOnlyRow(target: DataSyncListItem, category: DataSyncCategoryId): DataSyncRow {
  return {
    category,
    key: target.key,
    name: target.name,
    ...(target.description ? { description: target.description } : {}),
    ...(target.signature ? { targetSignature: target.signature } : {}),
    ...(target.directoryName ? { targetDirectoryName: target.directoryName } : {}),
    ...(target.path ? { targetPath: target.path } : {}),
    ...(target.dependencies ? { dependencies: target.dependencies } : {}),
    totalBytes: 0,
    status: "remoteOnly",
    note: { kind: "remoteOnly" },
    selectable: false,
    defaultSelected: false,
  };
}

/**
 * 生成本机条目的行，并附带远端独有行（不可勾选、永不删除）。
 * `category` 决定行归属与技能专属的父子信息；不传时保持旧技能调用方的默认值。
 * 排序：推送 → 更新 → 差异 → 已同步 → 远端独有 → 不能同步；同状态按名称。
 */
export function compareSkillRows(params: {
  sourceItems: readonly DataSyncListItem[];
  targetItems: readonly DataSyncListItem[];
  sourceHashes: Readonly<Record<string, string>>;
  targetHashes: Readonly<Record<string, string>>;
  targetBlockedReason?: DataSyncBlockedReason;
  /** 分类，默认 `skills`（兼容既有技能调用方）。 */
  category?: DataSyncCategoryId;
}): DataSyncRow[] {
  const category = params.category ?? "skills";
  const targetByKey = new Map(params.targetItems.map((item) => [item.key, item]));
  const sourceKeys = new Set(params.sourceItems.map((item) => item.key));
  return [
    ...params.sourceItems.map((source) =>
      compareRow(
        source,
        targetByKey.get(source.key),
        params.sourceHashes,
        params.targetHashes,
        params.targetBlockedReason,
        category,
      ),
    ),
    ...params.targetItems
      .filter((item) => !sourceKeys.has(item.key))
      .map((item) => remoteOnlyRow(item, category)),
  ].sort(
    (left, right) =>
      STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || left.name.localeCompare(right.name),
  );
}

/** 分类明确时的比较入口；与 `compareSkillRows` 等价，便于多分类调用点表达意图。 */
export function compareCategoryRows(
  params: Parameters<typeof compareSkillRows>[0] & { category: DataSyncCategoryId },
): DataSyncRow[] {
  return compareSkillRows(params);
}

/** 远端独有数量：用于推送结果里的「跳过」计数；这些 key 永不进入 import items。 */
export function countRemoteOnlyItems(
  sourceItems: readonly DataSyncListItem[],
  targetItems: readonly DataSyncListItem[],
): number {
  const sourceKeys = new Set(sourceItems.map((item) => item.key));
  return targetItems.filter((item) => !sourceKeys.has(item.key)).length;
}

/** 分类勾选三态：全部可勾选项已选 / 部分 / 未选。 */
export function resolveSkillCheckState(
  rows: readonly DataSyncRow[],
  selected: ReadonlySet<string>,
): DataSyncCheckState {
  const selectable = rows.filter((row) => row.selectable);
  const count = selectable.filter((row) => selected.has(row.key)).length;
  if (count === 0) return { checked: false, indeterminate: false };
  return { checked: count === selectable.length, indeterminate: count < selectable.length };
}

/**
 * 按「最上层的已选上级」分组：沿 parentKey 链向上走（链上未选中的中间项也穿过），
 * 取链上最上层的已选项作为组头。组内按层级排序，上级在前；组的字节取组头的字节。
 * 非技能分类没有 parentKey，每行自成一个组。
 */
function groupRowsByTopSelectedAncestor(
  rows: readonly DataSyncRow[],
  allRows: readonly DataSyncRow[],
): Array<{ rows: DataSyncRow[]; totalBytes: number }> {
  const parentByKey = new Map(allRows.map((row) => [row.key, row.parentKey]));
  const selectedByKey = new Map(rows.map((row) => [row.key, row]));
  const groups = new Map<string, { head: DataSyncRow; members: Array<[DataSyncRow, number]> }>();
  for (const row of rows) {
    let head = row;
    let depth = 0;
    let depthToHead = 0;
    const visited = new Set([row.key]);
    for (
      let cursor = parentByKey.get(row.key);
      cursor && !visited.has(cursor);
      cursor = parentByKey.get(cursor)
    ) {
      visited.add(cursor);
      depth += 1;
      const ancestor = selectedByKey.get(cursor);
      if (ancestor) {
        head = ancestor;
        depthToHead = depth;
      }
    }
    let group = groups.get(head.key);
    if (!group) {
      group = { head, members: [] };
      groups.set(head.key, group);
    }
    group.members.push([row, depthToHead]);
  }
  return [...groups.values()].map(({ head, members }) => ({
    rows: members.sort((left, right) => left[1] - right[1]).map(([member]) => member),
    totalBytes: head.totalBytes,
  }));
}

/**
 * 按来源字节数分批，单批不超过上限；父子技能同一批、上级在前。
 * 父目录字节已包含子目录，所以组字节取组头；单项上限由服务端标为不能同步。
 * JSON 类条目没有字节签名，天然落在同一批。
 */
export function chunkSkillRows(
  rows: readonly DataSyncRow[],
  maxBatchBytes: number | undefined,
  allRows: readonly DataSyncRow[] = rows,
): DataSyncRow[][] {
  const groups = groupRowsByTopSelectedAncestor(rows, allRows);
  if (!maxBatchBytes) return rows.length > 0 ? [groups.flatMap((group) => group.rows)] : [];
  const batches: DataSyncRow[][] = [];
  let current: DataSyncRow[] = [];
  let currentBytes = 0;
  for (const group of groups) {
    if (current.length > 0 && currentBytes + group.totalBytes > maxBatchBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(...group.rows);
    currentBytes += group.totalBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 导出/导入请求：只包含用户勾选的项，overwrite 带上列表时的目标端基线哈希。 */
export function resolveSkillImportItems(rows: readonly DataSyncRow[]): DataSyncImportItem[] {
  return rows
    .filter((row) => row.status !== "remoteOnly")
    .map((row) => ({
      key: row.key,
      mode: row.importMode ?? "createOnly",
      ...(row.expectedTargetHash ? { expectedTargetHash: row.expectedTargetHash } : {}),
    }));
}

export function summarizePushOutcomes(params: {
  outcomes: Readonly<Record<string, DataSyncPushOutcome>>;
  remoteOnlyCount: number;
}): DataSyncPushSummary {
  const values = Object.values(params.outcomes);
  return {
    succeeded: values.filter(
      (outcome) => outcome.status === "created" || outcome.status === "updated",
    ).length,
    failed: values.filter((outcome) => outcome.status === "failed" || outcome.status === "conflict")
      .length,
    skipped: params.remoteOnlyCount,
    outcomes: params.outcomes,
  };
}

export function findPushFailures(
  rows: readonly DataSyncRow[],
  outcomes: Readonly<Record<string, DataSyncPushOutcome>>,
): DataSyncPushFailure[] {
  return rows.flatMap((row) => {
    const outcome = outcomes[row.key];
    if (outcome?.status !== "failed" && outcome?.status !== "conflict") return [];
    return [
      {
        key: row.key,
        name: row.name,
        status: outcome.status,
        ...(outcome.error ? { error: outcome.error } : {}),
      },
    ];
  });
}

/** 成功项在本地直接标为已同步；失败/冲突项保留，便于重试。 */
export function mergePushOutcomesIntoRows(
  rows: readonly DataSyncRow[],
  outcomes: Readonly<Record<string, DataSyncPushOutcome>>,
): DataSyncRow[] {
  return rows.map((row) => {
    const status = outcomes[row.key]?.status;
    if (status !== "created" && status !== "updated") return row;
    return {
      ...row,
      status: "synced",
      note: { kind: "synced" },
      selectable: false,
      defaultSelected: false,
      importMode: undefined,
      expectedTargetHash: undefined,
    };
  });
}

export function importResultToOutcome(result: DataSyncImportResultItem): DataSyncPushOutcome {
  return {
    key: result.key,
    status: result.status,
    ...(result.error ? { error: result.error } : {}),
  };
}
