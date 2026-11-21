import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CanonicalPlugin,
  PluginAdapterId,
  PluginAdapterInfo,
  PluginManifest,
  PluginPermission,
  PluginPermissionProfile,
  PluginTrustLevel,
} from "@nibi/contracts";
import { NIBI_INLINE_PLUGIN_MARKETPLACE, NIBI_OFFICIAL_PLUGIN_MARKETPLACE } from "@nibi/contracts";
import type { PluginCandidate } from "./types.js";

const PLUGIN_SOURCE_CLEANUP_RETRY_DELAYS_MS = [0, 25, 100] as const;
export const NIBI_PLUGIN_EXTENSION_KEY = "com.nibistudio.nibi";
export const NATIVE_PLUGIN_MANIFEST_FILE = "plugin.json";

export interface DetectedPluginManifest {
  adapterId: PluginAdapterId;
  path: string;
}

export interface ParsedPluginManifestDocument {
  /** 最终生态归属：根清单是否带 NIBI/Codex 扩展会改写检测结果。 */
  adapterId: PluginAdapterId;
  manifest: Record<string, unknown>;
}

const PLUGIN_MANIFEST_CANDIDATES = [
  { adapterId: "native", relativePath: "plugin.json" },
  { adapterId: "claude", relativePath: join(".claude-plugin", "plugin.json") },
  { adapterId: "codex", relativePath: join(".codex-plugin", "plugin.json") },
  { adapterId: "zcode", relativePath: join(".zcode-plugin", "plugin.json") },
] as const satisfies ReadonlyArray<{
  adapterId: PluginAdapterId;
  relativePath: string;
}>;

/**
 * 发现插件清单并按特异性选择适配器：
 * 原生 > Agent Plugins > Claude > Codex > ZCode > DSH。
 * 根 `plugin.json` 先按 native 命中，读取时再依据扩展命名空间细分为
 * native / agent-plugins / codex（见 {@link readPluginManifestDocument}）。
 * DSH 组合包没有独立清单：只认 `package.json` 里真的声明了 `dsh.bundle` 的目录，
 * 避免把普通 npm 包当插件。外来目录只读，不复制、不改写。
 */
export function findPluginManifest(rootPath: string): DetectedPluginManifest | null {
  for (const candidate of PLUGIN_MANIFEST_CANDIDATES) {
    const path = join(rootPath, candidate.relativePath);
    if (fileExists(path)) return { adapterId: candidate.adapterId, path };
  }
  const dshPackagePath = join(rootPath, "package.json");
  if (hasDshBundle(dshPackagePath)) return { adapterId: "dsh", path: dshPackagePath };
  return null;
}

function hasDshBundle(path: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) && isRecord(parsed.dsh) && parsed.dsh.bundle !== undefined;
  } catch {
    return false;
  }
}

/** 兼容旧调用点：返回清单路径（含外来生态）。 */
export function findNativePluginManifest(rootPath: string): string | null {
  return findPluginManifest(rootPath)?.path ?? null;
}

/**
 * 读清单并按生态归一化。
 *
 * - 根 `plugin.json`：带 `extensions["com.nibistudio.nibi"]` 是 native；带 Codex 扩展
 *   （`com.openai` / `openai`）是 codex；否则是通用 Agent Plugins。
 * - `.claude-plugin` / `.codex-plugin` / `.zcode-plugin` 清单保持各自适配器归属。
 * - NIBI 扩展字段摊平到根：旧代码继续读同一组字段，核心不感知扩展命名空间。
 * - `mcp.json` 不在这里合并，MCP loader 单独读根文件。
 */
export function readPluginManifestDocument(
  path: string,
  detectedAdapterId: PluginAdapterId,
): ParsedPluginManifestDocument {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("Plugin manifest must be a JSON object");
  const extensions = isRecord(parsed.extensions) ? parsed.extensions : null;
  const extension =
    extensions && isRecord(extensions[NIBI_PLUGIN_EXTENSION_KEY])
      ? extensions[NIBI_PLUGIN_EXTENSION_KEY]
      : null;
  if (!extension) {
    return {
      adapterId:
        detectedAdapterId === "native" ? inferRootManifestAdapter(extensions) : detectedAdapterId,
      manifest: parsed,
    };
  }
  return {
    adapterId: detectedAdapterId,
    manifest: {
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
    },
  };
}

function inferRootManifestAdapter(
  extensions: Record<string, unknown> | null,
): PluginAdapterId {
  if (!extensions) return "agent-plugins";
  if (isRecord(extensions["com.openai"]) || isRecord(extensions.openai)) return "codex";
  return "agent-plugins";
}

/** 兼容旧调用点：只返回摊平后的清单，不关心生态归属。 */
export function readNativePluginManifest(path: string): Record<string, unknown> {
  return readPluginManifestDocument(path, "native").manifest;
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

// ── Canonical 模型归一化 ────────────────────────────────────────────────────

/**
 * 各适配器「识别但不运行」的清单组件。全部进 `adapter.skipped`，
 * 详情页只显示一行原因，不假装已支持。
 */
const ADAPTER_SKIPPED_COMPONENTS: Record<PluginAdapterId, readonly string[]> = {
  native: [],
  "agent-plugins": [],
  claude: [],
  // Codex 的 apps/connectors 是宿主侧连接器，没有 NIBI 运行时映射。
  codex: ["apps", "connectors"],
  zcode: [],
  // Cordis 插件可替换内核，属于架构非目标；DSH 只做声明式子集。
  dsh: ["cordis"],
};

/** 所有生态一致只做诊断、不参与运行的组件。 */
const DIAGNOSTIC_ONLY_COMPONENTS = ["channels", "lspServers", "outputStyles", "settings"] as const;

const KNOWN_PERMISSIONS = new Set<string>([
  "filesystem.read",
  "filesystem.write",
  "network",
  "process",
  "full-access",
] satisfies PluginPermission[]);

/**
 * 归一化适配器元数据。`skipped` 只记录**清单里真的声明了**的组件：
 * 没声明就不算损失，避免把「没用到」误报成「部分不可用」。
 */
export function describePluginAdapter(input: {
  adapterId: PluginAdapterId;
  manifest: PluginManifest;
  manifestPath: string;
  rootPath: string;
}): PluginAdapterInfo {
  const declared = [
    ...DIAGNOSTIC_ONLY_COMPONENTS,
    ...ADAPTER_SKIPPED_COMPONENTS[input.adapterId],
  ].filter((key, index, all) => all.indexOf(key) === index && key in input.manifest);
  // DSH 的代码面是 package.json 里的 `dsh.bundle`（Cordis patch），不是清单里的
  // 组件字段；识别到就明确标成不运行，而不是让用户以为组合包被加载了。
  if (input.adapterId === "dsh" && "dsh" in input.manifest) {
    declared.push("dsh.bundle");
  }
  return {
    adapterId: input.adapterId,
    compatibility: declared.length > 0 ? "partial" : "full",
    manifestPath: toPosixRelative(input.rootPath, input.manifestPath),
    skipped: declared,
  };
}

/**
 * 权限请求值：只保留闭集内的能力，未知声明忽略（不是静默授权）。
 * 重复项去重，顺序保持清单声明顺序。
 */
export function resolvePluginPermissions(manifest: PluginManifest): PluginPermissionProfile {
  if (!Array.isArray(manifest.permissions)) return { requested: [] };
  const requested: PluginPermission[] = [];
  for (const value of manifest.permissions) {
    if (typeof value === "string" && KNOWN_PERMISSIONS.has(value)) {
      requested.push(value as PluginPermission);
    }
  }
  return { requested: [...new Set(requested)] };
}

/** 信任来源由候选生成处决定：内置、官方缓存、第三方市场、本地目录。 */
export function resolvePluginTrust(candidate: PluginCandidate): PluginTrustLevel {
  return candidate.trust;
}

/** 只有市场 id 可用时的信任推断（describe/validate 等发现前路径）。 */
export function resolveMarketplaceTrust(marketplace: string): PluginTrustLevel {
  if (marketplace === NIBI_INLINE_PLUGIN_MARKETPLACE) return "local";
  if (marketplace === NIBI_OFFICIAL_PLUGIN_MARKETPLACE) return "official";
  return "community";
}

export function createCanonicalPlugin(input: {
  adapterId: PluginAdapterId;
  manifest: PluginManifest;
  manifestPath: string;
  rootPath: string;
  trust: PluginTrustLevel;
}): CanonicalPlugin {
  return {
    adapter: describePluginAdapter(input),
    manifest: input.manifest,
    permissions: resolvePluginPermissions(input.manifest),
    rootPath: input.rootPath,
    trust: input.trust,
  };
}

function toPosixRelative(rootPath: string, path: string): string {
  const rel = relative(rootPath, path);
  if (rel === "" || rel.startsWith("..")) return path.split(sep).join("/");
  return rel.split(sep).join("/");
}
