import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { INibiTaskService } from "@nibi/services";
import type { NibiTaskSnapshot } from "@nibi/shared";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

type GetTaskSnapshotParams = Parameters<INibiTaskService["getTaskSnapshot"]>[0];
type GetTaskSnapshotResult = Promise<NibiTaskSnapshot | null>;
type GetTaskSnapshotWithEtagParams = Parameters<INibiTaskService["getTaskSnapshotWithEtag"]>[0];

type MemorySnapshotCacheEntry = {
  etag: string;
  snapshot: NibiTaskSnapshot;
  sizeBytes: number;
};

const nibiTaskServiceProxyCache = new WeakMap<INibiTaskService, INibiTaskService>();
const snapshotInflightRequestsByService = new WeakMap<
  INibiTaskService,
  Map<string, GetTaskSnapshotResult>
>();
const snapshotCacheByService = new WeakMap<
  INibiTaskService,
  Map<string, MemorySnapshotCacheEntry>
>();
const MEMORY_SNAPSHOT_CACHE_MAX_ENTRIES = 16;
const MEMORY_SNAPSHOT_CACHE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_CACHE_STORAGE_KEY = "nibi-task-snapshot-cache:v1";
const SNAPSHOT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
const SNAPSHOT_CACHE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_CACHE_MAX_ENTRIES = 20;
type PersistedSnapshotCacheEntry = {
  key: string;
  etag: string;
  snapshot: NibiTaskSnapshot;
  updatedAt: number;
  sizeBytes: number;
};
let persistedSnapshotCacheLoaded = false;
const persistedSnapshotCache = new Map<string, PersistedSnapshotCacheEntry>();
// WeakRef 诊断引用：不阻碍已释放 service 实例的快照缓存被 GC 回收。
let latestSnapshotCacheRef: WeakRef<Map<string, MemorySnapshotCacheEntry>> | undefined;
uiMemoryDiagnosticsRegistry.register("taskSnapshotCache", () => ({
  entries: latestSnapshotCacheRef?.deref()?.size ?? 0,
  persisted: persistedSnapshotCache.size,
}));

export function buildSnapshotDedupeKey(params: GetTaskSnapshotParams): string {
  return [
    params.workspacePath,
    params.workspaceIdentity ?? "",
    params.taskId,
    typeof params.messageLimit === "number" ? String(params.messageLimit) : "",
    typeof params.byteBudget === "number" ? String(params.byteBudget) : "",
    typeof params.toolLimit === "number" ? String(params.toolLimit) : "",
    // desktop continuous 和手机 remote replayable 的 snapshot 可能经过不同恢复逻辑。
    // 缓存 key 必须区分 clientMode，否则会把某一端的快照复用到另一端。
    params.clientMode ?? "desktop-continuous",
    // 手机只读恢复会刻意跳过 task-index 模型回填。
    // 策略不同代表 host 端恢复语义不同，不能共用同一份 snapshot cache。
    params.resumeModelPolicy ?? "task-index",
    // 手机首屏恢复会用历史模型 hint 激活 session。
    // 同一 task 若模型 hint 不同，context window 也可能不同，缓存必须隔离。
    params.model ?? "",
    // replayable snapshot 现在会携带 session settings 投影出的 configOptions。
    // 同一模型下 thoughtLevel 不同也会改变 toolbar 配置和后续发送 hint，不能复用旧快照。
    params.thoughtLevel ?? "",
  ].join("::");
}

function getOrCreateSnapshotInflightMap(
  service: INibiTaskService,
): Map<string, GetTaskSnapshotResult> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotInflightRequestsByService.get(service);
  if (existing) {
    return existing;
  }
  const created = new Map<string, GetTaskSnapshotResult>();
  snapshotInflightRequestsByService.set(service, created);
  return created;
}

function estimateSnapshotBytes(snapshot: NibiTaskSnapshot): number {
  try {
    return JSON.stringify(snapshot).length * 2;
  } catch {
    return 1024;
  }
}

function touchMemorySnapshotCache(
  cache: Map<string, MemorySnapshotCacheEntry>,
  key: string,
): { etag: string; snapshot: NibiTaskSnapshot } | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function writeMemorySnapshotCache(
  cache: Map<string, MemorySnapshotCacheEntry>,
  key: string,
  etag: string,
  snapshot: NibiTaskSnapshot,
): void {
  const sizeBytes = estimateSnapshotBytes(snapshot);
  cache.delete(key);
  cache.set(key, { etag, snapshot, sizeBytes });

  let totalBytes = 0;
  for (const item of cache.values()) {
    totalBytes += item.sizeBytes;
  }
  while (
    cache.size > 1 &&
    (cache.size > MEMORY_SNAPSHOT_CACHE_MAX_ENTRIES ||
      totalBytes > MEMORY_SNAPSHOT_CACHE_MAX_TOTAL_BYTES)
  ) {
    const oldest = cache.entries().next();
    if (oldest.done || oldest.value[0] === key) break;
    totalBytes -= oldest.value[1].sizeBytes;
    cache.delete(oldest.value[0]);
  }
}

function getOrCreateSnapshotCacheMap(
  service: INibiTaskService,
): Map<string, MemorySnapshotCacheEntry> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotCacheByService.get(service);
  if (existing) {
    latestSnapshotCacheRef = new WeakRef(existing);
    return existing;
  }
  const created = new Map<string, MemorySnapshotCacheEntry>();
  snapshotCacheByService.set(service, created);
  latestSnapshotCacheRef = new WeakRef(created);
  return created;
}

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ensurePersistedSnapshotCacheLoaded() {
  if (persistedSnapshotCacheLoaded) {
    return;
  }
  persistedSnapshotCacheLoaded = true;
  const storage = getBrowserStorage();
  const raw = storage?.getItem(SNAPSHOT_CACHE_STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as {
      entries?: PersistedSnapshotCacheEntry[];
    };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (
        typeof entry?.key !== "string" ||
        typeof entry?.etag !== "string" ||
        !entry.snapshot ||
        typeof entry.updatedAt !== "number" ||
        typeof entry.sizeBytes !== "number"
      ) {
        continue;
      }
      persistedSnapshotCache.set(entry.key, entry);
    }
  } catch {
    // ignore storage parse errors
  }
}

function flushPersistedSnapshotCache() {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      SNAPSHOT_CACHE_STORAGE_KEY,
      JSON.stringify({ entries: [...persistedSnapshotCache.values()] }),
    );
  } catch {
    // ignore storage write errors (quota/private mode)
  }
}

function prunePersistedSnapshotCache() {
  const entries = [...persistedSnapshotCache.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const nextEntries: PersistedSnapshotCacheEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (nextEntries.length >= SNAPSHOT_CACHE_MAX_ENTRIES) {
      continue;
    }
    if (totalBytes + entry.sizeBytes > SNAPSHOT_CACHE_MAX_TOTAL_BYTES) {
      continue;
    }
    nextEntries.push(entry);
    totalBytes += entry.sizeBytes;
  }
  persistedSnapshotCache.clear();
  for (const entry of nextEntries) {
    persistedSnapshotCache.set(entry.key, entry);
  }
}

function readPersistedSnapshotEntry(key: string) {
  ensurePersistedSnapshotCacheLoaded();
  const entry = persistedSnapshotCache.get(key);
  if (!entry) {
    return null;
  }
  return { etag: entry.etag, snapshot: entry.snapshot };
}

function writePersistedSnapshotEntry(
  key: string,
  etag: string,
  snapshot: NibiTaskSnapshot,
): void {
  ensurePersistedSnapshotCacheLoaded();
  const serializedSnapshot = JSON.stringify(snapshot);
  const sizeBytes = new TextEncoder().encode(serializedSnapshot).byteLength;
  if (sizeBytes > SNAPSHOT_CACHE_MAX_ENTRY_BYTES) {
    // 大消息 task 的快照若直接写 localStorage，会很快触发配额上限并拖慢主线程。
    // 这里只持久化小体积快照，超限时删除旧缓存，避免“为了加速加载反而造成存储压力”。
    persistedSnapshotCache.delete(key);
    flushPersistedSnapshotCache();
    return;
  }

  persistedSnapshotCache.set(key, {
    key,
    etag,
    snapshot,
    updatedAt: Date.now(),
    sizeBytes,
  });
  prunePersistedSnapshotCache();
  flushPersistedSnapshotCache();
}

function deletePersistedSnapshotEntry(key: string): void {
  ensurePersistedSnapshotCacheLoaded();
  persistedSnapshotCache.delete(key);
  flushPersistedSnapshotCache();
}

function createNibiTaskServiceProxy(service: INibiTaskService): INibiTaskService {
  const inflight = getOrCreateSnapshotInflightMap(service);
  const snapshotCache = getOrCreateSnapshotCacheMap(service);

  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop !== "getTaskSnapshot") {
        return Reflect.get(target, prop, receiver);
      }

      return (params: GetTaskSnapshotParams) => {
        const requestKey = buildSnapshotDedupeKey(params);
        const existing = inflight.get(requestKey);
        if (existing) {
          return existing;
        }
        const cachedSnapshotEntry =
          touchMemorySnapshotCache(snapshotCache, requestKey) ??
          readPersistedSnapshotEntry(requestKey);
        if (cachedSnapshotEntry && !snapshotCache.has(requestKey)) {
          writeMemorySnapshotCache(
            snapshotCache,
            requestKey,
            cachedSnapshotEntry.etag,
            cachedSnapshotEntry.snapshot,
          );
        }

        // 远控首屏恢复时，多个 hook 会并发请求同一 task snapshot，
        // 导致 host 连续执行多次 getTaskSnapshot，并把超大快照重复回传到 relay。
        // 这里按“同一 service + 同一参数”做并发去重，命中时复用同一个 Promise，
        // 保证同一时刻只发起一次 RPC；同时携带 if-none-match，未变化时复用本地缓存快照，
        // 避免重复下发大 JSON。
        const request = (async () => {
          const firstResult = await target.getTaskSnapshotWithEtag({
            ...(params as GetTaskSnapshotWithEtagParams),
            ...(cachedSnapshotEntry?.etag ? { ifNoneMatch: cachedSnapshotEntry.etag } : {}),
          });
          if (firstResult.notModified) {
            if (cachedSnapshotEntry?.snapshot) {
              return cachedSnapshotEntry.snapshot;
            }
            // 仅持久化了 etag 但没有可用快照正文时，不能把 notModified 直接透传给上层，
            // 否则首屏会拿到空数据。这里回退一次“无 if-none-match”硬拉取，确保数据完整性优先。
            const fallbackResult = await target.getTaskSnapshotWithEtag(
              params as GetTaskSnapshotWithEtagParams,
            );
            if (fallbackResult.snapshot && fallbackResult.etag) {
              writeMemorySnapshotCache(
                snapshotCache,
                requestKey,
                fallbackResult.etag,
                fallbackResult.snapshot,
              );
              writePersistedSnapshotEntry(
                requestKey,
                fallbackResult.etag,
                fallbackResult.snapshot,
              );
            }
            return fallbackResult.snapshot;
          }
          if (firstResult.snapshot && firstResult.etag) {
            writeMemorySnapshotCache(
              snapshotCache,
              requestKey,
              firstResult.etag,
              firstResult.snapshot,
            );
            writePersistedSnapshotEntry(
              requestKey,
              firstResult.etag,
              firstResult.snapshot,
            );
          } else if (!firstResult.snapshot) {
            snapshotCache.delete(requestKey);
            deletePersistedSnapshotEntry(requestKey);
          }
          return firstResult.snapshot;
        })().finally(() => {
          if (inflight.get(requestKey) === request) {
            inflight.delete(requestKey);
          }
        });
        inflight.set(requestKey, request);
        return request;
      };
    },
  });
}

/** 获取 Nibi task wrapper 服务实例 */
export function useNibiTaskService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): INibiTaskService {
  // Nibi task 服务按 workspace 身份解析，保证所有 task RPC 都落到对应的 host。
  const services = workspacePath
    ? useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    : useServices();
  const rawService = services.nibiTaskService;
  if (!rawService || typeof rawService !== "object") {
    return rawService;
  }
  const cachedProxy = nibiTaskServiceProxyCache.get(rawService);
  if (cachedProxy) {
    return cachedProxy;
  }
  const nextProxy = createNibiTaskServiceProxy(rawService);
  nibiTaskServiceProxyCache.set(rawService, nextProxy);
  return nextProxy;
}
