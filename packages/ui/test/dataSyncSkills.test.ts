// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@nibi/services";
import type { DataSyncListItem, DataSyncListResult, SkillDataSyncPayload } from "@nibi/shared";
import { useDataSyncSkills } from "@/data-sync/index.js";
import {
  chunkSkillRows,
  compareSkillRows,
  countRemoteOnlyItems,
  findPushFailures,
  resolveSkillCheckState,
  resolveSkillImportItems,
  selectSkillHashRequests,
  summarizePushOutcomes,
} from "@/data-sync/domain/compare.js";
import type { DataSyncPushOutcome } from "@/data-sync/contract.js";

function item(overrides: Partial<DataSyncListItem> & { key: string }): DataSyncListItem {
  return {
    name: overrides.key,
    enabled: true,
    signature: { fileCount: 1, totalBytes: 10 },
    ...overrides,
  };
}

function accessorFor(service: object): IServiceAccessor {
  return { skillSyncService: service } as unknown as IServiceAccessor;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function listResult(items: DataSyncListItem[]): DataSyncListResult {
  return { items, homeDir: "/home/test" };
}

function skillService(overrides: {
  listSyncItems?: () => Promise<DataSyncListResult>;
  getSyncContentHashes?: (params: { keys: string[] }) => Promise<{
    hashes: Record<string, string>;
  }>;
  checkSyncWriteAccess?: () => Promise<{ ok: boolean; path: string; error?: string }>;
  exportSyncItems?: (params: { keys: string[] }) => Promise<SkillDataSyncPayload>;
  importSyncItems?: (params: {
    payload: SkillDataSyncPayload;
    items: Array<{ key: string; mode: string; expectedTargetHash?: string }>;
  }) => Promise<{ results: Array<{ key: string; status: string; error?: string }> }>;
}) {
  const service = {
    listSyncItems: vi.fn(overrides.listSyncItems ?? (async () => listResult([]))),
    getSyncContentHashes: vi.fn(
      overrides.getSyncContentHashes ?? (async () => ({ hashes: {} as Record<string, string> })),
    ),
    checkSyncWriteAccess: vi.fn(
      overrides.checkSyncWriteAccess ?? (async () => ({ ok: true, path: "/remote/skills" })),
    ),
    exportSyncItems: vi.fn(
      overrides.exportSyncItems ??
        (async () => ({
          archive: new Uint8Array([1]),
          sourceHomeDir: "/home/test",
          items: [],
        })),
    ),
    importSyncItems: vi.fn(overrides.importSyncItems ?? (async () => ({ results: [] }))),
  };
  return { service, accessor: accessorFor(service) };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("data sync skill comparison", () => {
  it("derives push / difference / synced / remote-only rows and default selection", () => {
    const sourceItems = [
      item({ key: "only-local" }),
      item({ key: "same" }),
      item({ key: "different" }),
    ];
    const targetItems = [
      item({ key: "same" }),
      item({ key: "different" }),
      item({ key: "only-remote" }),
    ];
    const requests = selectSkillHashRequests(sourceItems, targetItems);
    expect(requests.sourceKeys.sort()).toEqual(["different", "same"]);
    expect(requests.targetKeys.sort()).toEqual(["different", "same"]);

    const rows = compareSkillRows({
      sourceItems,
      targetItems,
      sourceHashes: { same: "aaa", different: "bbb" },
      targetHashes: { same: "aaa", different: "ccc" },
    });
    const byKey = new Map(rows.map((row) => [row.key, row]));

    expect(byKey.get("only-local")).toMatchObject({
      status: "push",
      defaultSelected: true,
      importMode: "createOnly",
    });
    expect(byKey.get("same")).toMatchObject({ status: "synced", selectable: false });
    expect(byKey.get("different")).toMatchObject({
      status: "difference",
      note: { kind: "contentDiffers" },
      defaultSelected: true,
      importMode: "overwrite",
      expectedTargetHash: "ccc",
    });
    expect(byKey.get("only-remote")).toMatchObject({
      status: "remoteOnly",
      selectable: false,
      defaultSelected: false,
    });
    expect(countRemoteOnlyItems(sourceItems, targetItems)).toBe(1);
    expect(resolveSkillImportItems([byKey.get("only-remote")!])).toEqual([]);

    const selected = new Set(rows.filter((row) => row.defaultSelected).map((row) => row.key));
    expect([...selected].sort()).toEqual(["different", "only-local"]);
    expect(resolveSkillCheckState(rows, selected)).toEqual({
      checked: true,
      indeterminate: false,
    });
  });

  it("does not preselect a row when the remote version is newer", () => {
    const sourceItems = [item({ key: "versioned", version: "1.0.0" })];
    const targetItems = [item({ key: "versioned", version: "2.0.0" })];
    const rows = compareSkillRows({
      sourceItems,
      targetItems,
      sourceHashes: {},
      targetHashes: {},
    });
    expect(rows[0]).toMatchObject({
      status: "difference",
      note: { kind: "sourceOlder" },
      selectable: true,
      defaultSelected: false,
    });
  });

  it("keeps selected parent and child in one batch with the parent first", () => {
    const items = [
      item({ key: "parent", parentKey: undefined }),
      item({ key: "child", parentKey: "parent" }),
      item({ key: "grandchild", parentKey: "child" }),
    ];
    const rows = compareSkillRows({
      sourceItems: items,
      targetItems: [],
      sourceHashes: {},
      targetHashes: {},
    });
    const child = rows.find((row) => row.key === "child")!;
    const parent = rows.find((row) => row.key === "parent")!;
    const batches = chunkSkillRows([child, parent], 20 * 1024 * 1024, rows);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((row) => row.key)).toEqual(["parent", "child"]);
  });

  it("summarizes outcomes and keeps only failed/conflict rows retryable", () => {
    const rows = compareSkillRows({
      sourceItems: [item({ key: "a" }), item({ key: "b" })],
      targetItems: [],
      sourceHashes: {},
      targetHashes: {},
    });
    const outcomes: Record<string, DataSyncPushOutcome> = {
      a: { key: "a", status: "created" },
      b: { key: "b", status: "failed", error: "disk full" },
    };
    const summary = summarizePushOutcomes({ outcomes, remoteOnlyCount: 2 });
    expect(summary).toMatchObject({ succeeded: 1, failed: 1, skipped: 2 });
    expect(findPushFailures(rows, outcomes)).toEqual([
      { key: "b", name: "b", status: "failed", error: "disk full" },
    ]);
    expect(resolveSkillImportItems(rows)).toEqual([
      { key: "a", mode: "createOnly" },
      { key: "b", mode: "createOnly" },
    ]);
  });
});

describe("useDataSyncSkills", () => {
  const sourceItem = item({ key: "review", path: "/home/test/.nibi/skills/review/SKILL.md" });

  it("fails closed while offline and does not read either side", async () => {
    const { service, accessor } = skillService({});
    const source = { accessor, service };
    const { result } = renderHook(() =>
      useDataSyncSkills({
        sourceServices: source.accessor,
        targetServices: source.accessor,
        online: false,
      }),
    );
    await waitFor(() => expect(result.current.phase).toBe("offline"));
    expect(result.current.rows).toEqual([]);
    expect(result.current.selectedKeys.size).toBe(0);
    expect(service.listSyncItems).not.toHaveBeenCalled();
  });

  it("loads both sides and discards a late result after the target generation changes", async () => {
    const first = deferred<DataSyncListResult>();
    const second = deferred<DataSyncListResult>();
    let listCalls = 0;
    const source = skillService({
      listSyncItems: () => {
        listCalls += 1;
        return listCalls === 1 ? first.promise : second.promise;
      },
    });
    const targetA = skillService({
      listSyncItems: async () => listResult([]),
    });
    const targetB = skillService({
      listSyncItems: async () => listResult([]),
    });
    const { result, rerender } = renderHook(
      ({ target }: { target: IServiceAccessor }) =>
        useDataSyncSkills({
          sourceServices: source.accessor,
          targetServices: target,
          online: true,
        }),
      { initialProps: { target: targetA.accessor } },
    );
    await waitFor(() => expect(listCalls).toBe(1));

    rerender({ target: targetB.accessor });
    await waitFor(() => expect(listCalls).toBe(2));
    await act(async () => {
      second.resolve(listResult([sourceItem]));
    });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.rows.map((row) => row.key)).toEqual(["review"]);

    // 旧一代的迟到结果必须在 generation 检查处被丢弃，不能覆盖新设备的列表。
    await act(async () => {
      first.resolve(listResult([{ ...sourceItem, key: "stale", name: "stale" }]));
    });
    expect(result.current.rows.map((row) => row.key)).toEqual(["review"]);
  });

  it("pushes only selected rows, reports per-item failures, and retries failed rows", async () => {
    const source = skillService({
      listSyncItems: async () => listResult([sourceItem, item({ key: "other" })]),
      exportSyncItems: async ({ keys }) => ({
        archive: new Uint8Array([1]),
        sourceHomeDir: "/home/test",
        items: keys.map((key) => ({ key, name: key, directoryName: key, enabled: true })),
      }),
    });
    let importCalls = 0;
    const target = skillService({
      listSyncItems: async () => listResult([{ ...sourceItem, key: "remote-only" }]),
      getSyncContentHashes: async () => ({ hashes: {} }),
      importSyncItems: async ({ items }) => {
        importCalls += 1;
        return {
          results: items.map((entry) =>
            importCalls === 1 && entry.key === "review"
              ? { key: entry.key, status: "failed", error: "temporary" }
              : { key: entry.key, status: "created" },
          ),
        };
      },
    });
    const { result } = renderHook(() =>
      useDataSyncSkills({
        sourceServices: source.accessor,
        targetServices: target.accessor,
        online: true,
      }),
    );
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    expect(result.current.selectedCount).toBe(2);
    expect(result.current.remoteOnlyCount).toBe(1);

    await act(async () => {
      await result.current.push();
    });
    expect(target.service.importSyncItems).toHaveBeenCalledTimes(1);
    expect(target.service.importSyncItems.mock.calls[0]?.[0].items).toEqual([
      { key: "other", mode: "createOnly" },
      { key: "review", mode: "createOnly" },
    ]);
    expect(result.current.summary).toMatchObject({ succeeded: 1, failed: 1, skipped: 1 });
    expect(result.current.failures).toEqual([
      { key: "review", name: "review", status: "failed", error: "temporary" },
    ]);
    expect([...result.current.selectedKeys]).toEqual(["review"]);

    await act(async () => {
      await result.current.retryFailed();
    });
    expect(target.service.importSyncItems).toHaveBeenCalledTimes(2);
    expect(result.current.summary).toMatchObject({ succeeded: 1, failed: 0 });
    expect(result.current.failures).toEqual([]);
    expect(result.current.selectedKeys.size).toBe(0);
  });

  it("does not write when the write-access preflight fails", async () => {
    const source = skillService({
      listSyncItems: async () => listResult([sourceItem]),
    });
    const target = skillService({
      listSyncItems: async () => listResult([]),
      checkSyncWriteAccess: async () => ({ ok: false, path: "/remote/skills", error: "read-only" }),
    });
    const { result } = renderHook(() =>
      useDataSyncSkills({
        sourceServices: source.accessor,
        targetServices: target.accessor,
        online: true,
      }),
    );
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    await act(async () => {
      await result.current.push();
    });
    expect(target.service.importSyncItems).not.toHaveBeenCalled();
    expect(source.service.exportSyncItems).not.toHaveBeenCalled();
    expect(result.current.errorMessage).toBe("read-only");
  });
});
