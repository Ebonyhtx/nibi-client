import { randomUUID } from "node:crypto";
import {
  appendFileSync,
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
      plugins[pluginId] = {
        grantedAt: typeof value.grantedAt === "string" ? value.grantedAt : "",
        permissions: [...new Set(permissions)],
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
  permissions: readonly PluginPermission[];
  pluginId: string;
  storageRoot: string;
  version: string;
}): PluginConsentRecord {
  const state = readPluginConsents(input.storageRoot);
  const record: PluginConsentRecord = {
    grantedAt: input.at ?? new Date().toISOString(),
    permissions: [...new Set(input.permissions)],
    version: input.version,
  };
  state.plugins[input.pluginId] = record;
  const target = consentFilePath(input.storageRoot);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
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
  const target = consentFilePath(storageRoot);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
  appendPluginAuditEvent(storageRoot, {
    at: new Date().toISOString(),
    pluginId,
    type: "consent_revoked",
  });
  return true;
}

/** 同意必须同时覆盖当前版本与全部 required 权限；版本变化视为权限可能变化。 */
export function pluginConsentCovers(
  record: PluginConsentRecord | undefined,
  version: string,
  required: readonly PluginPermission[],
): boolean {
  if (!record) return false;
  if (record.version !== version) return false;
  const granted = new Set(record.permissions);
  return required.every((permission) => granted.has(permission));
}

export function appendPluginAuditEvent(
  storageRoot: string,
  event: {
    at: string;
    capability?: string;
    permissions?: readonly PluginPermission[];
    pluginId: string;
    type:
      | "capability_denied"
      | "capability_invoked"
      | "consent_granted"
      | "consent_revoked"
      | "consent_required"
      | "grants_updated"
      | "grants_revoked";
    version?: string;
  },
): void {
  try {
    mkdirSync(storageRoot, { recursive: true });
    appendFileSync(join(storageRoot, PLUGIN_AUDIT_FILE), `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // 审计写入失败不能反过来让安装/启用失败；诊断链会给出 consent 缺失。
  }
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
