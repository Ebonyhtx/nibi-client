import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveForceUpdateRequirement,
  type ForceUpdateRequirement,
} from "@nibi/shared";

/**
 * 强更裁决的磁盘 last-known-good。
 *
 * 只在“远端 /client/configs 成功且 code=0”时写入；读取只在本次网络失败/超时后发生。
 * 它不替代启动时的网络检查，也不缓存“跳过强更”的结论——网络成功时永远以远端为准。
 * 作用是把“弱网/离线时完全 fail-open”收窄为“按最近一次成功裁决执行”，并带过期上限。
 */
export const FORCE_UPDATE_LKG_FILENAME = "force-update-lkg.json";
export const FORCE_UPDATE_LKG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredForceUpdateLkg {
  version: 1;
  /** 最近一次成功响应里的 minimal_version；没有该字段时为 null。 */
  minimalVersion: string | null;
  fetchedAt: number;
}

export interface ForceUpdateLkg {
  minimalVersion: string | null;
  fetchedAt: number;
  fresh: boolean;
}

function isStoredForceUpdateLkg(value: unknown): value is StoredForceUpdateLkg {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<StoredForceUpdateLkg>;
  return (
    candidate.version === 1 &&
    (candidate.minimalVersion === null || typeof candidate.minimalVersion === "string") &&
    typeof candidate.fetchedAt === "number" &&
    Number.isFinite(candidate.fetchedAt) &&
    candidate.fetchedAt > 0
  );
}

export async function readForceUpdateLkg(
  directory: string,
  now = Date.now(),
): Promise<ForceUpdateLkg | null> {
  try {
    const raw = await readFile(join(directory, FORCE_UPDATE_LKG_FILENAME), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isStoredForceUpdateLkg(parsed)) return null;
    const age = now - parsed.fetchedAt;
    return {
      fresh: age >= 0 && age <= FORCE_UPDATE_LKG_MAX_AGE_MS,
      fetchedAt: parsed.fetchedAt,
      minimalVersion: parsed.minimalVersion,
    };
  } catch {
    return null;
  }
}

export async function writeForceUpdateLkg(
  directory: string,
  minimalVersion: string | null,
  now = Date.now(),
): Promise<void> {
  const stored: StoredForceUpdateLkg = {
    version: 1,
    minimalVersion: minimalVersion && minimalVersion.trim() ? minimalVersion : null,
    fetchedAt: now,
  };
  const target = join(directory, FORCE_UPDATE_LKG_FILENAME);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
  } catch {
    // 写失败只影响下一次弱网降级，不能影响启动。
  }
}

/** 网络失败/超时后的降级：只有新鲜 LKG 且确实要求强更时才拦截。 */
export function resolveForceUpdateRequirementFromLkg(input: {
  currentVersion: string;
  lkg: ForceUpdateLkg | null;
}): ForceUpdateRequirement | null {
  if (!input.lkg?.fresh || !input.lkg.minimalVersion) return null;
  return resolveForceUpdateRequirement({
    currentVersion: input.currentVersion,
    forceUpdate: { minimalVersion: input.lkg.minimalVersion },
  });
}
