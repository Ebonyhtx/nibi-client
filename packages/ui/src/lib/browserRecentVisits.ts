import { useSyncExternalStore } from "react";
import { readNibiStorage, removeNibiStorage, writeNibiStorage } from "@/lib/nibiStorage.js";

/** 最近访问只保存在本机 NIBI 命名空间，不进入版本控制、不跨设备同步。 */
export const BROWSER_RECENT_VISITS_STORAGE_KEY = "nibi:browser-recent-visits-v1";
export const BROWSER_RECENT_VISITS_LIMIT = 20;

export interface BrowserRecentVisit {
  url: string;
  title?: string;
  faviconUrl?: string;
  visitedAt: number;
  /** 访问发生时的 workspace 标识；无法确定时为 "unscoped"。 */
  workspaceKey: string;
}

const EMPTY_VISITS: readonly BrowserRecentVisit[] = [];
const listeners = new Set<() => void>();

let cachedRaw: string | null = null;
let cachedVisits: BrowserRecentVisit[] = [];
let cacheReady = false;

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function readOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeStoredVisit(value: unknown): BrowserRecentVisit | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string" || !isHttpUrl(record.url)) return null;
  if (typeof record.workspaceKey !== "string") return null;
  const visitedAt =
    typeof record.visitedAt === "number" && Number.isFinite(record.visitedAt)
      ? record.visitedAt
      : 0;
  const title = readOptionalText(record.title);
  const faviconUrl = readOptionalText(record.faviconUrl);
  return {
    url: record.url,
    visitedAt,
    workspaceKey: record.workspaceKey,
    ...(title === undefined ? {} : { title }),
    ...(faviconUrl === undefined ? {} : { faviconUrl }),
  };
}

function parseVisits(raw: string | null): BrowserRecentVisit[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const visits: BrowserRecentVisit[] = [];
  for (const candidate of parsed) {
    const visit = normalizeStoredVisit(candidate);
    if (!visit || seen.has(visit.url)) continue;
    seen.add(visit.url);
    visits.push(visit);
    if (visits.length >= BROWSER_RECENT_VISITS_LIMIT) break;
  }
  return visits;
}

function getSnapshot(): readonly BrowserRecentVisit[] {
  const raw = readNibiStorage(BROWSER_RECENT_VISITS_STORAGE_KEY);
  // localStorage 是不可变字符串来源；只有内容变化才重建快照，满足 useSyncExternalStore
  // 对同一份数据必须返回同一引用的要求。
  if (!cacheReady || raw !== cachedRaw) {
    cachedRaw = raw;
    cachedVisits = parseVisits(raw);
    cacheReady = true;
  }
  return cachedVisits;
}

function getServerSnapshot(): readonly BrowserRecentVisit[] {
  return EMPTY_VISITS;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(next: BrowserRecentVisit[]): void {
  const limited = next.slice(0, BROWSER_RECENT_VISITS_LIMIT);
  const serialized = JSON.stringify(limited);
  cachedVisits = limited;
  cachedRaw = serialized;
  cacheReady = true;
  writeNibiStorage(BROWSER_RECENT_VISITS_STORAGE_KEY, serialized);
  for (const listener of listeners) listener();
}

/** 最近访问的唯一读取入口；UI 通过 useSyncExternalStore 跟随写入更新。 */
export function useBrowserRecentVisits(): readonly BrowserRecentVisit[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * 记录一次访问。只接受 http/https；同 URL 去重并移到最前。
 *
 * title/favicon 可能随后续页面事件分批到达：缺省字段沿用既有条目，避免标题或图标被清空。
 */
export function recordBrowserRecentVisit(input: {
  url: string;
  workspaceKey: string;
  title?: string | null;
  faviconUrl?: string | null;
  visitedAt?: number;
}): void {
  const url = input.url.trim();
  if (!isHttpUrl(url)) return;

  const visits = getSnapshot();
  const existing = visits.find((visit) => visit.url === url);
  const title = readOptionalText(input.title) ?? existing?.title;
  const faviconUrl = readOptionalText(input.faviconUrl) ?? existing?.faviconUrl;
  const entry: BrowserRecentVisit = {
    url,
    workspaceKey: existing?.workspaceKey || input.workspaceKey,
    visitedAt: input.visitedAt ?? Date.now(),
    ...(title === undefined ? {} : { title }),
    ...(faviconUrl === undefined ? {} : { faviconUrl }),
  };
  commit([entry, ...visits.filter((visit) => visit.url !== url)]);
}

export function removeBrowserRecentVisit(url: string): void {
  const visits = getSnapshot();
  if (!visits.some((visit) => visit.url === url)) return;
  commit(visits.filter((visit) => visit.url !== url));
}

export function clearBrowserRecentVisits(): void {
  removeNibiStorage(BROWSER_RECENT_VISITS_STORAGE_KEY);
  cachedRaw = null;
  cachedVisits = [];
  cacheReady = true;
  for (const listener of listeners) listener();
}

/** 设置页“清理浏览器数据”后的联动：只有“全部站点数据”成功才清历史，清缓存不动。 */
export function clearBrowserRecentVisitsAfterDataClear(
  mode: "cache" | "all",
  success: boolean,
): void {
  if (mode === "all" && success) clearBrowserRecentVisits();
}
