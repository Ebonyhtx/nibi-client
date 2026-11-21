import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const PLUGIN_SOURCE_CLEANUP_RETRY_DELAYS_MS = [0, 25, 100] as const;
export const NIBI_PLUGIN_EXTENSION_KEY = "com.nibistudio.nibi";
export const NATIVE_PLUGIN_MANIFEST_FILE = "plugin.json";

/** 原生清单位置：Agent Plugins 根 `plugin.json`。 */
export function findNativePluginManifest(rootPath: string): string | null {
  const path = join(rootPath, NATIVE_PLUGIN_MANIFEST_FILE);
  return fileExists(path) ? path : null;
}

/**
 * 读原生清单并摊平成内部 `PluginManifest` 形状。
 *
 * - Agent Plugins 根 `plugin.json`：根保留身份/元数据，NIBI 组件在
 *   `extensions["com.nibistudio.nibi"]`；这里把扩展字段摊平，旧代码继续读同一组字段。
 * - `mcp.json` 不在这里合并，MCP loader 单独读根文件。
 */
export function readNativePluginManifest(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Plugin manifest must be a JSON object");
  const extensions = isRecord(parsed.extensions) ? parsed.extensions : null;
  const extension = extensions && isRecord(extensions[NIBI_PLUGIN_EXTENSION_KEY])
    ? extensions[NIBI_PLUGIN_EXTENSION_KEY]
    : null;
  if (!extension) return parsed;
  return {
    ...extension,
    name: parsed.name,
    version: parsed.version,
    description: parsed.description,
    author: parsed.author,
    homepage: parsed.homepage,
    repository: parsed.repository,
    license: parsed.license,
    keywords: parsed.keywords,
    ...(isRecord(extension.descriptionI18n)
      ? { description_i18n: extension.descriptionI18n }
      : {}),
  };
}

export function resolveInside(rootPath: string, rawPath: string): string | null {
  if (isAbsolute(rawPath)) return null;
  const resolved = resolve(rootPath, rawPath);
  const rel = relative(rootPath, resolved);
  if (rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`))) return resolved;
  return null;
}

export function sanitizePluginId(pluginId: string): string {
  return pluginId.replace(/[^a-zA-Z0-9_.@-]/g, "-");
}

export function parsePathList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

export function isPluginOptionValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 「路径缺失」只认 ENOENT/ENOTDIR（stat 的精确错误码）。EACCES 等权限错误
 * 不是缺失——调用方不得据此发「不存在」诊断，避免把权限问题误报成 manifest 配错。
 */
export function isMissingPath(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT" || code === "ENOTDIR";
  }
}

export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export async function cleanupPluginSourceBestEffort(
  cleanup: (() => Promise<void>) | undefined,
  retryDelaysMs: readonly number[] = PLUGIN_SOURCE_CLEANUP_RETRY_DELAYS_MS,
): Promise<unknown> {
  if (!cleanup) return undefined;
  let cleanupError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
    try {
      await cleanup();
      return undefined;
    } catch (error) {
      cleanupError = error;
    }
  }
  return cleanupError;
}

export function appendPluginSourceCleanupError(
  primaryError: unknown,
  cleanupError: unknown,
): unknown {
  if (cleanupError === undefined || !(primaryError instanceof Error)) return primaryError;
  const cleanupMessage =
    cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
  // 临时目录删除失败只能作为附加诊断，不能覆盖下载、校验或解压的原始错误。
  primaryError.message = `${primaryError.message}; plugin source cleanup also failed: ${cleanupMessage}`;
  return primaryError;
}

export function throwIfAborted(options: { signal?: AbortSignal } | undefined): void {
  if (options?.signal?.aborted) throw new Error("Plugin operation cancelled");
}
