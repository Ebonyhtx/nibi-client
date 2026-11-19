import { useState } from "react";

/** 分组身份描述：rowIds 用于跨重投影/补页继承 identity。 */
export interface ContinuousGroupDescriptor {
  kind: string;
  rowIds: readonly number[];
  /** 已有稳定 key 的独立行；分组自身不提供 key，避免误继承。 */
  key?: string;
}

export interface ContinuousGroupIdentity<T> {
  items: readonly T[];
  keys: string[];
  nextId: number;
}

export function reconcileContinuousGroupIdentity<T>(
  items: readonly T[],
  describe: (item: T) => ContinuousGroupDescriptor,
  previous?: ContinuousGroupIdentity<T>,
): ContinuousGroupIdentity<T> {
  const previousRows = new Map<number, { kind: string; key: string }>();
  previous?.items.forEach((item, index) => {
    const group = describe(item);
    // 独立行没有分组组件；不能让新增的分组误继承独立行身份。
    if (group.key !== undefined) return;
    const identity = { kind: group.kind, key: previous.keys[index]! };
    for (const rowId of group.rowIds) previousRows.set(rowId, identity);
  });
  const usedKeys = new Set<string>();
  let nextId = previous?.nextId ?? 0;
  const keys = items.map((item) => {
    const group = describe(item);
    if (group.key !== undefined) return group.key;
    const inherited = group.rowIds
      .map((rowId) => previousRows.get(rowId))
      .find((identity) => identity?.kind === group.kind && !usedKeys.has(identity.key));
    const key = inherited?.key ?? `${group.kind}:${group.rowIds[0]}:${nextId++}`;
    usedKeys.add(key);
    return key;
  });
  return { items, keys, nextId };
}

/**
 * 为连续分组保留跨渲染的稳定身份。
 *
 * 首行会随补页变化，右边界会随追加变化。工作段和内层摘要都按共有行延续身份；
 * 拆分时原 key 仅复用一次。条件式 render state 让 React 一起提交/丢弃投影与身份，
 * 避免 effect 闪帧及 ref 并发污染；各列表只持有上一版身份，随列表卸载释放。
 */
export function useContinuousGroupKeys<T>(
  items: readonly T[],
  describe: (item: T) => ContinuousGroupDescriptor,
): string[] {
  const [previous, setIdentity] = useState(() => reconcileContinuousGroupIdentity(items, describe));
  const identity =
    previous.items === items
      ? previous
      : reconcileContinuousGroupIdentity(items, describe, previous);
  if (identity !== previous) setIdentity(identity);
  return identity.keys;
}
