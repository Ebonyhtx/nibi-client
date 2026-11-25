import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CanonicalPlugin,
  PluginAdapterId,
  PluginAdapterInfo,
  PluginCapabilityGrant,
  PluginCapabilityId,
  PluginCapabilityProfile,
  PluginCapabilityScope,
  PluginManifest,
  PluginPermission,
  PluginPermissionProfile,
  PluginRuntimeDeclaration,
  PluginTrustLevel,
} from "@nibi/contracts";
import {
  NIBI_INLINE_PLUGIN_MARKETPLACE,
  NIBI_OFFICIAL_PLUGIN_MARKETPLACE,
  PLUGIN_CAPABILITY_IDS,
} from "@nibi/contracts";
import { isPluginPackageHash } from "./package-hash.js";
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
  "code",
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
  // 扩展代码只支持 NIBI 根清单布局；外来生态的代码面无法在不改写目录的前提下运行。
  if (
    input.manifest.runtime !== undefined &&
    input.adapterId !== "native" &&
    input.adapterId !== "agent-plugins"
  ) {
    declared.push("runtime");
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
  if (!Array.isArray(manifest.permissions)) return { requested: [], required: [] };
  const requested: PluginPermission[] = [];
  for (const value of manifest.permissions) {
    if (typeof value === "string" && KNOWN_PERMISSIONS.has(value)) {
      requested.push(value as PluginPermission);
    }
  }
  return { requested: [...new Set(requested)], required: [] };
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

// ── 插件权限同意与审计 ──────────────────────────────────────────────────────

export const PLUGIN_CONSENT_FILE = "plugin-consents.json";
export const PLUGIN_AUDIT_FILE = "plugin-audit.ndjson";

export interface PluginConsentRecord {
  grantedAt: string;
  permissions: PluginPermission[];
  /**
   * 同意时绑定的包内容 hash（`sha256:<64hex>`）。旧记录可能没有这个字段：
   * 迁移期先按「覆盖」处理，首次校验时再 backfill（见 backfillPluginConsentHash）。
   */
  packageHash?: string;
  /** 同意时的插件版本；版本变化或权限变多都要重新确认。 */
  version: string;
}

export interface PluginConsentFile {
  plugins: Record<string, PluginConsentRecord>;
  version: 1;
}

function consentFilePath(storageRoot: string): string {
  return join(storageRoot, PLUGIN_CONSENT_FILE);
}

/** 同意文件统一走「临时文件 + rename」原子替换，避免半截 JSON 被读到。 */
function writeConsentFile(storageRoot: string, state: PluginConsentFile): void {
  const target = consentFilePath(storageRoot);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

export function readPluginConsents(storageRoot: string): PluginConsentFile {
  try {
    const parsed = JSON.parse(readFileSync(consentFilePath(storageRoot), "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.plugins)) return { plugins: {}, version: 1 };
    const plugins: Record<string, PluginConsentRecord> = {};
    for (const [pluginId, value] of Object.entries(parsed.plugins)) {
      if (!isRecord(value) || typeof value.version !== "string") continue;
      const permissions = Array.isArray(value.permissions)
        ? value.permissions.filter(
            (item): item is PluginPermission =>
              typeof item === "string" && KNOWN_PERMISSIONS.has(item),
          )
        : [];
      // 非法 hash 格式直接丢弃字段（记录本身保留），避免拿脏值做绑定校验。
      const packageHash =
        typeof value.packageHash === "string" && isPluginPackageHash(value.packageHash)
          ? value.packageHash
          : undefined;
      plugins[pluginId] = {
        grantedAt: typeof value.grantedAt === "string" ? value.grantedAt : "",
        permissions: [...new Set(permissions)],
        ...(packageHash !== undefined ? { packageHash } : {}),
        version: value.version,
      };
    }
    return { plugins, version: 1 };
  } catch {
    // 文件缺失/损坏按「没有同意」处理；发现层会给出 plugin_consent_required，
    // 不能把损坏的同意文件当成全部授权。
    return { plugins: {}, version: 1 };
  }
}

export function writePluginConsent(input: {
  at?: string;
  /** 同意时计算的包内容 hash；非法格式不入库。 */
  packageHash?: string;
  permissions: readonly PluginPermission[];
  pluginId: string;
  storageRoot: string;
  version: string;
}): PluginConsentRecord {
  const state = readPluginConsents(input.storageRoot);
  const packageHash =
    input.packageHash !== undefined && isPluginPackageHash(input.packageHash)
      ? input.packageHash
      : undefined;
  const record: PluginConsentRecord = {
    grantedAt: input.at ?? new Date().toISOString(),
    permissions: [...new Set(input.permissions)],
    ...(packageHash !== undefined ? { packageHash } : {}),
    version: input.version,
  };
  state.plugins[input.pluginId] = record;
  writeConsentFile(input.storageRoot, state);
  appendPluginAuditEvent(input.storageRoot, {
    at: record.grantedAt,
    permissions: record.permissions,
    pluginId: input.pluginId,
    type: "consent_granted",
    version: record.version,
  });
  return record;
}

export function revokePluginConsent(storageRoot: string, pluginId: string): boolean {
  const state = readPluginConsents(storageRoot);
  if (!state.plugins[pluginId]) return false;
  delete state.plugins[pluginId];
  writeConsentFile(storageRoot, state);
  appendPluginAuditEvent(storageRoot, {
    at: new Date().toISOString(),
    pluginId,
    type: "consent_revoked",
  });
  return true;
}

/**
 * 同意必须同时覆盖当前版本与全部 required 权限；版本变化视为权限可能变化。
 *
 * `packageHash` 传入时做内容绑定校验：
 * - 记录带 hash 且不同 → 不覆盖（同版本换了内容）；
 * - 记录没有 hash（旧记录）→ 视为覆盖，留给迁移期 backfill；
 * - 未传 `packageHash` → 只做版本/权限校验。
 */
export function pluginConsentCovers(
  record: PluginConsentRecord | undefined,
  version: string,
  required: readonly PluginPermission[],
  packageHash?: string,
): boolean {
  if (!record) return false;
  if (record.version !== version) return false;
  const granted = new Set(record.permissions);
  if (!required.every((permission) => granted.has(permission))) return false;
  if (
    packageHash !== undefined &&
    record.packageHash !== undefined &&
    record.packageHash !== packageHash
  ) {
    return false;
  }
  return true;
}

/**
 * 为旧同意记录补写包 hash。
 *
 * 只在「记录存在、版本相同、尚无 hash、hash 格式合法」时原子补写；
 * 不触发审计（补写不是用户动作），返回是否真的写入。
 * `at` 仅用于调用点语义对齐：补写不会改写 `grantedAt`，也不会写审计。
 */
export function backfillPluginConsentHash(input: {
  at?: string;
  packageHash: string;
  pluginId: string;
  storageRoot: string;
  version: string;
}): boolean {
  if (!isPluginPackageHash(input.packageHash)) return false;
  const state = readPluginConsents(input.storageRoot);
  const record = state.plugins[input.pluginId];
  if (!record) return false;
  if (record.version !== input.version) return false;
  if (record.packageHash !== undefined) return false;
  state.plugins[input.pluginId] = { ...record, packageHash: input.packageHash };
  try {
    writeConsentFile(input.storageRoot, state);
    return true;
  } catch {
    // 补写失败不改变「没有绑定」的事实；调用方按 hash_missing 处理。
    return false;
  }
}

export interface PluginContentTrustResult {
  allowed: boolean;
  reason?: "consent_missing" | "hash_mismatch" | "hash_missing";
}

/**
 * 解析「这段插件内容是否被当前同意覆盖」。
 *
 * `requireHashBound=false` 退回纯 consent 校验（兼容旧记录）；
 * `true` 时要求同意记录绑定当前包 hash：旧记录先尝试 backfill，
 * 补写不了（没有当前 hash 或格式非法）则返回 hash_missing。
 */
export function resolvePluginContentTrust(input: {
  packageHash?: string;
  pluginId: string;
  requiredPermissions: readonly PluginPermission[];
  requireHashBound: boolean;
  storageRoot: string;
  version: string;
}): PluginContentTrustResult {
  const record = readPluginConsents(input.storageRoot).plugins[input.pluginId];
  const baseCovers = (candidate: PluginConsentRecord | undefined): boolean => {
    if (!candidate) return false;
    if (candidate.version !== input.version) return false;
    const granted = new Set(candidate.permissions);
    return input.requiredPermissions.every((permission) => granted.has(permission));
  };
  if (!input.requireHashBound) {
    if (pluginConsentCovers(record, input.version, input.requiredPermissions, input.packageHash)) {
      return { allowed: true };
    }
    return { allowed: false, reason: baseCovers(record) ? "hash_mismatch" : "consent_missing" };
  }
  if (!baseCovers(record)) return { allowed: false, reason: "consent_missing" };
  const recordPackageHash = record?.packageHash;
  if (input.packageHash !== undefined) {
    if (recordPackageHash !== undefined) {
      return recordPackageHash === input.packageHash
        ? { allowed: true }
        : { allowed: false, reason: "hash_mismatch" };
    }
    const backfilled = backfillPluginConsentHash({
      packageHash: input.packageHash,
      pluginId: input.pluginId,
      storageRoot: input.storageRoot,
      version: input.version,
    });
    return backfilled ? { allowed: true } : { allowed: false, reason: "hash_missing" };
  }
  // 调用方没有当前 hash：已有绑定视为满足，旧记录无法补写。
  return recordPackageHash !== undefined
    ? { allowed: true }
    : { allowed: false, reason: "hash_missing" };
}

// ── 审计：保留 30 天，详情页读最近 10 条 ───────────────────────────────────

/** 审计保留窗口（天）；过期行在 prune 时删除。 */
export const PLUGIN_AUDIT_RETENTION_DAYS = 30;

/** append 内置 prune 节流：同一审计文件每 6 小时最多清理一次。 */
export const PLUGIN_AUDIT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export const PLUGIN_AUDIT_EVENT_TYPES = [
  "capability_denied",
  "capability_invoked",
  "consent_granted",
  "consent_revoked",
  "consent_required",
  "grants_updated",
  "grants_revoked",
] as const;

export type PluginAuditEventType = (typeof PLUGIN_AUDIT_EVENT_TYPES)[number];

const PLUGIN_AUDIT_EVENT_TYPE_SET: ReadonlySet<string> = new Set(PLUGIN_AUDIT_EVENT_TYPES);

export interface PluginAuditEvent {
  at: string;
  capability?: string;
  permissions?: readonly PluginPermission[];
  pluginId: string;
  type: PluginAuditEventType;
  version?: string;
}

/** 审计文件按行读取；缺失/不可读按空文件处理（视图为空而不是报错）。 */
function readPluginAuditLines(storageRoot: string): string[] {
  try {
    return readFileSync(join(storageRoot, PLUGIN_AUDIT_FILE), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
}

/** 单行解析：坏 JSON、缺字段、未知事件类型、无效时间都按坏行丢弃。 */
function parsePluginAuditLine(line: string): PluginAuditEvent | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { at, pluginId, type } = parsed;
  if (typeof at !== "string" || typeof pluginId !== "string" || typeof type !== "string") {
    return null;
  }
  if (!PLUGIN_AUDIT_EVENT_TYPE_SET.has(type)) return null;
  if (Number.isNaN(Date.parse(at))) return null;
  const event: PluginAuditEvent = { at, pluginId, type: type as PluginAuditEventType };
  if (typeof parsed.capability === "string") event.capability = parsed.capability;
  if (typeof parsed.version === "string") event.version = parsed.version;
  if (Array.isArray(parsed.permissions)) {
    const permissions = parsed.permissions.filter(
      (item): item is PluginPermission =>
        typeof item === "string" && KNOWN_PERMISSIONS.has(item),
    );
    event.permissions = [...new Set(permissions)];
  }
  return event;
}

/**
 * 读取最近的审计事件：坏行跳过，按 `at` 倒序（同一时间后写入的排前面），最多 limit 条。
 */
export function readRecentPluginAuditEvents(
  storageRoot: string,
  limit = 10,
): PluginAuditEvent[] {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10;
  if (max === 0) return [];
  const parsed: Array<{ event: PluginAuditEvent; index: number; time: number }> = [];
  const lines = readPluginAuditLines(storageRoot);
  for (const [index, line] of lines.entries()) {
    const event = parsePluginAuditLine(line);
    if (!event) continue;
    parsed.push({ event, index, time: Date.parse(event.at) });
  }
  parsed.sort((left, right) => right.time - left.time || right.index - left.index);
  return parsed.slice(0, max).map((item) => item.event);
}

/**
 * 按保留窗口清理审计文件：保留窗口内且结构合法的行，坏行丢弃，原子重写。
 * 返回被删除的行数（含坏行）；文件不存在或没有可删内容时返回 0 且不重写。
 */
export function prunePluginAuditEvents(
  storageRoot: string,
  options: { now?: number | Date; retentionDays?: number } = {},
): number {
  const retentionDays =
    typeof options.retentionDays === "number" &&
    Number.isFinite(options.retentionDays) &&
    options.retentionDays >= 0
      ? options.retentionDays
      : PLUGIN_AUDIT_RETENTION_DAYS;
  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : typeof options.now === "number" && Number.isFinite(options.now)
        ? options.now
        : Date.now();
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  const target = join(storageRoot, PLUGIN_AUDIT_FILE);
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return 0;
  }
  const kept: string[] = [];
  let deleted = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = parsePluginAuditLine(line);
    if (!event) {
      deleted += 1;
      continue;
    }
    if (Date.parse(event.at) < cutoff) {
      deleted += 1;
      continue;
    }
    kept.push(JSON.stringify(event));
  }
  if (deleted === 0) return 0;
  try {
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf8");
    renameSync(temporary, target);
  } catch {
    // 清理失败不影响调用方；下一次 append 会再试。
    return 0;
  }
  return deleted;
}

const pluginAuditPruneTimes = new Map<string, number>();

/** 仅测试用：清空 prune 节流状态，让下一次 append 立即尝试清理。 */
export function resetPluginAuditPruneThrottleForTests(): void {
  pluginAuditPruneTimes.clear();
}

function maybePrunePluginAudit(storageRoot: string): void {
  const key = join(storageRoot, PLUGIN_AUDIT_FILE);
  const now = Date.now();
  const last = pluginAuditPruneTimes.get(key);
  if (last !== undefined && now - last < PLUGIN_AUDIT_PRUNE_INTERVAL_MS) return;
  // 先记时间再执行：清理失败也遵守节流，避免每次 append 都做一次昂贵失败。
  pluginAuditPruneTimes.set(key, now);
  try {
    prunePluginAuditEvents(storageRoot);
  } catch {
    // 审计保留是后台维护，失败不能反过来让 append 失败。
  }
}

export function appendPluginAuditEvent(
  storageRoot: string,
  event: PluginAuditEvent,
): void {
  try {
    mkdirSync(storageRoot, { recursive: true });
    appendFileSync(join(storageRoot, PLUGIN_AUDIT_FILE), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // 审计写入失败不能反过来让安装/启用失败；诊断链会给出 consent 缺失。
    return;
  }
  maybePrunePluginAudit(storageRoot);
}

/**
 * 运行时真正需要的能力 = 清单请求 ∪ 组件推导：
 * hooks 与 MCP 都会启动子进程，保守地同时要求 `network`（MCP 可能访问网络且无法静态判定）。
 * community/local 永远拿不到 `full-access`：请求保留给 UI 展示，但不算 required。
 */
export function resolveRequiredPluginPermissions(
  manifest: PluginManifest,
  input: { hasCode: boolean; hasHooks: boolean; hasMcp: boolean; trust: PluginTrustLevel },
): PluginPermission[] {
  const required = new Set<PluginPermission>(resolvePluginPermissions(manifest).requested);
  if (input.hasHooks || input.hasMcp) required.add("process");
  if (input.hasMcp) required.add("network");
  if (input.hasCode) required.add("code");
  if (input.trust === "community" || input.trust === "local") required.delete("full-access");
  return [...required];
}

// ── NIBI Extension 能力与扩展代码声明 ──────────────────────────────────────

const CAPABILITY_IDS = new Set<string>(PLUGIN_CAPABILITY_IDS);
const SENSITIVE_CAPABILITIES = new Set<string>([
  "nibi.sessions.read",
  "nibi.workspace.files.read",
]);

/** 需要用户确认的能力；UI/设置/通知属于低风险，安装即生效。 */
export function isSensitivePluginCapability(id: string): boolean {
  return SENSITIVE_CAPABILITIES.has(id);
}

export function resolvePluginCapabilities(
  manifest: PluginManifest,
  trust: PluginTrustLevel,
): { problems: string[]; profile: PluginCapabilityProfile } {
  const requested: PluginCapabilityGrant[] = [];
  const problems: string[] = [];
  if (manifest.capabilities === undefined) return { problems, profile: { granted: [], requested } };
  if (!Array.isArray(manifest.capabilities)) {
    return {
      problems: ["`capabilities` must be an array"],
      profile: { granted: [], requested },
    };
  }
  const seen = new Set<string>();
  for (const [index, raw] of manifest.capabilities.entries()) {
    const parsed =
      typeof raw === "string"
        ? { id: raw.trim(), scope: "workspace" as PluginCapabilityScope }
        : isRecord(raw) && typeof raw.id === "string"
          ? {
              id: raw.id.trim(),
              scope:
                raw.scope === "project" || raw.scope === "host" || raw.scope === "workspace"
                  ? raw.scope
                  : ("workspace" as PluginCapabilityScope),
            }
          : null;
    if (!parsed || !parsed.id) {
      problems.push(`capabilities[${index}] must be a capability id or { id, scope }`);
      continue;
    }
    if (!CAPABILITY_IDS.has(parsed.id)) {
      problems.push(`capabilities[${index}] is not supported by this Nibi runtime: ${parsed.id}`);
      continue;
    }
    if (parsed.scope === "host" && trust !== "builtin" && trust !== "official") {
      problems.push(`capabilities[${index}] requests host scope, which is official-only: ${parsed.id}`);
      continue;
    }
    const key = `${parsed.id}\u0000${parsed.scope}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requested.push({ id: parsed.id as PluginCapabilityId, scope: parsed.scope });
  }
  return { problems, profile: { granted: [], requested } };
}

export function resolvePluginRuntime(manifest: PluginManifest): {
  problem?: string;
  runtime?: PluginRuntimeDeclaration;
} {
  if (manifest.runtime === undefined) return {};
  if (!isRecord(manifest.runtime)) return { problem: "`runtime` must be an object" };
  const raw = manifest.runtime;
  if (raw.apiVersion !== "1") return { problem: "`runtime.apiVersion` must be \"1\"" };
  const entry = typeof raw.entry === "string" ? raw.entry.trim() : "";
  if (!entry || isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) {
    return { problem: "`runtime.entry` must be a relative path inside the plugin root" };
  }
  const platforms =
    Array.isArray(raw.platforms) && raw.platforms.every((item) => typeof item === "string")
      ? (raw.platforms as string[])
      : undefined;
  const runtime: PluginRuntimeDeclaration = {
    apiVersion: "1",
    entry,
    ...(typeof raw.node === "string" && raw.node.trim() ? { node: raw.node.trim() } : {}),
    ...(typeof raw.native === "boolean" ? { native: raw.native } : {}),
    ...(typeof raw.napi === "number" && Number.isInteger(raw.napi) && raw.napi > 0
      ? { napi: raw.napi }
      : {}),
    ...(platforms ? { platforms } : {}),
  };
  return { runtime };
}

// ── 能力授权（与插件权限同意分开存储） ─────────────────────────────────────

export const PLUGIN_GRANTS_FILE = "plugin-grants.json";

export interface PluginGrantRecord {
  capabilityGrants: PluginCapabilityGrant[];
  consentedAt: string;
  consentedVersion: string;
  epoch: number;
}

export interface PluginGrantFile {
  plugins: Record<string, PluginGrantRecord>;
  version: 1;
}

function grantFilePath(storageRoot: string): string {
  return join(storageRoot, PLUGIN_GRANTS_FILE);
}

export function readPluginGrants(storageRoot: string): PluginGrantFile {
  try {
    const parsed = JSON.parse(readFileSync(grantFilePath(storageRoot), "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.plugins)) return { plugins: {}, version: 1 };
    const plugins: Record<string, PluginGrantRecord> = {};
    for (const [pluginId, value] of Object.entries(parsed.plugins)) {
      if (!isRecord(value)) continue;
      const grants: PluginCapabilityGrant[] = [];
      if (Array.isArray(value.capabilityGrants)) {
        for (const raw of value.capabilityGrants) {
          if (!isRecord(raw) || typeof raw.id !== "string" || !CAPABILITY_IDS.has(raw.id)) continue;
          const scope =
            raw.scope === "project" || raw.scope === "host" || raw.scope === "workspace"
              ? raw.scope
              : "workspace";
          grants.push({ id: raw.id as PluginCapabilityId, scope });
        }
      }
      plugins[pluginId] = {
        capabilityGrants: grants,
        consentedAt: typeof value.consentedAt === "string" ? value.consentedAt : "",
        consentedVersion:
          typeof value.consentedVersion === "string" ? value.consentedVersion : "",
        epoch: typeof value.epoch === "number" && Number.isInteger(value.epoch) ? value.epoch : 0,
      };
    }
    return { plugins, version: 1 };
  } catch {
    // 损坏的授权文件按「没有授权」处理；不能把损坏当成全部放行。
    return { plugins: {}, version: 1 };
  }
}

function writeGrantFile(storageRoot: string, state: PluginGrantFile): void {
  const target = grantFilePath(storageRoot);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

export function writePluginGrants(input: {
  at?: string;
  grants: readonly PluginCapabilityGrant[];
  pluginId: string;
  storageRoot: string;
  version: string;
}): PluginGrantRecord {
  const state = readPluginGrants(input.storageRoot);
  const previous = state.plugins[input.pluginId];
  const record: PluginGrantRecord = {
    capabilityGrants: [...input.grants],
    consentedAt: input.at ?? new Date().toISOString(),
    consentedVersion: input.version,
    epoch: (previous?.epoch ?? 0) + 1,
  };
  state.plugins[input.pluginId] = record;
  writeGrantFile(input.storageRoot, state);
  appendPluginAuditEvent(input.storageRoot, {
    at: record.consentedAt,
    pluginId: input.pluginId,
    type: "grants_updated",
    version: input.version,
  });
  return record;
}

export function revokePluginGrants(storageRoot: string, pluginId: string): boolean {
  const state = readPluginGrants(storageRoot);
  const previous = state.plugins[pluginId];
  if (!previous) return false;
  // 保留 epoch 让在途调用可被父进程识别为过期；授权集合清空。
  state.plugins[pluginId] = {
    capabilityGrants: [],
    consentedAt: new Date().toISOString(),
    consentedVersion: previous.consentedVersion,
    epoch: previous.epoch + 1,
  };
  writeGrantFile(storageRoot, state);
  appendPluginAuditEvent(storageRoot, {
    at: new Date().toISOString(),
    pluginId,
    type: "grants_revoked",
    version: previous.consentedVersion,
  });
  return true;
}

export function pluginGrantsCover(
  record: PluginGrantRecord | undefined,
  version: string,
  required: readonly PluginCapabilityGrant[],
): boolean {
  if (!record) return required.length === 0;
  if (record.consentedVersion !== version) return false;
  return required.every((wanted) =>
    record.capabilityGrants.some((grant) => grant.id === wanted.id && grant.scope === wanted.scope),
  );
}

export function sensitivePluginCapabilityGrants(
  profile: PluginCapabilityProfile,
): PluginCapabilityGrant[] {
  return profile.requested.filter((grant) => SENSITIVE_CAPABILITIES.has(grant.id));
}

/**
 * 插件数据目录统一用 0700 创建（计划 A §5.5）。
 *
 * 为什么必须显式收紧：`mkdir` 只受 umask 约束，常见 umask 022 会建出 0755，
 * 同机其他用户能读到插件的 settings.json / 生成命令。已有目录也要补一次 `chmod`：
 * 旧版本已经按 0755 建过的目录不会因为这次改动自动变严。
 *
 * Windows 没有 POSIX 权限位，`chmod` 只映射只读位；忽略失败即可，不影响目录可用性。
 */
export function ensurePluginDataDir(dataPath: string): void {
  mkdirSync(dataPath, { mode: 0o700, recursive: true });
  try {
    chmodSync(dataPath, 0o700);
  } catch {
    // 平台不支持（如 Windows）或目录被并发删除：交给后续写入报真实错误。
  }
}
