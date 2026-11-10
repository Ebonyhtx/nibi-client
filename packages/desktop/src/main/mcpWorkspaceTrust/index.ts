/**
 * 工作区 MCP 信任（A5/A6）：Host 唯一 owner。
 *
 * 项目级 MCP 声明（`.nibi/config.json` 与 `.agents/mcp.json` fallback）在用户逐条审核前不装载；
 * 授权按「工作区身份 + server 名 + 声明内容摘要」持久化到用户域
 * `<存储根>/security/workspace-mcp-trust-v1.json`，Rust 内核只读同一份文件。
 *
 * 写入复用 `updateJsonObjectFile`（严格读取、写前重读、临时文件 + rename、0600），只改本文件
 * 自己的 `schemaVersion` / `records`，不碰 `config.json`。损坏、离线与未注册工作区一律 fail closed。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";
import {
  type McpServerConfig,
  type NativeMcpServerRecord,
  type WorkspaceMcpTrustDecision,
} from "@nibi/shared";
import { updateJsonObjectFile } from "@nibi/services/node";
import {
  parseWorkspaceMcpTrustStoreContent,
  parseWorkspaceMcpTrustStoreObject,
} from "./storeFile.js";
import type {
  WorkspaceMcpRegistration,
  WorkspaceMcpTrustDecideInput,
  WorkspaceMcpTrustFilterInput,
  WorkspaceMcpTrustHost,
  WorkspaceMcpTrustInspectInput,
  WorkspaceMcpTrustInspectResult,
  WorkspaceMcpTrustRegistry,
  WorkspaceMcpTrustReviewView,
  WorkspaceMcpTrustStoreLoad,
} from "./contract.js";

export type {
  WorkspaceMcpTrustDecision,
  WorkspaceMcpTrustReasonCode,
  WorkspaceMcpTrustReview,
  WorkspaceMcpTrustReviewView,
  WorkspaceMcpTrustLoadResult,
} from "./contract.js";
export type {
  WorkspaceMcpRegistration,
  WorkspaceMcpTrustHost,
  WorkspaceMcpTrustInspectResult,
  WorkspaceMcpTrustRegistry,
  WorkspaceMcpTrustStoreLoad,
} from "./contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePathForLookup(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export const WORKSPACE_MCP_TRUST_STORE_FILE = "workspace-mcp-trust-v1.json";
const SECURITY_DIRECTORY = "security";
const DIGEST_VERSION = 1;

type CanonicalTransport = "stdio" | "http" | "sse";
type CanonicalProtocol = "auto" | "legacy" | "2026-07-28";

interface CanonicalDeclaration {
  alwaysLoad: boolean;
  oauth: Record<string, string> | null;
  protocolVersion: CanonicalProtocol;
  timeoutMs: number | null;
  type: CanonicalTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
  url?: string;
  headers?: Record<string, string>;
}

export class WorkspaceMcpTrustStoreCorruptError extends Error {
  constructor(readonly storePath: string) {
    super("workspace_mcp_trust_store_corrupt");
    this.name = "WorkspaceMcpTrustStoreCorruptError";
  }
}

/** 存储根：`NIBI_STORAGE_DIR` → 用户配置 `storage.dir` → `~/.nibi`（与 Rust `StoragePaths` 同序）。 */
export function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

function expandConfiguredRoot(value: string, home: string): string {
  if (value.startsWith("~/")) return join(home, value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(home, value);
}

async function readConfiguredStorageDir(home: string): Promise<string | undefined> {
  const userConfigPath = join(home, ".nibi", "cli", "config.json");
  try {
    const parsed = JSON.parse(await readFile(userConfigPath, "utf8")) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.storage)) return undefined;
    const value = parsed.storage.dir;
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  } catch {
    // 用户配置读不到时按缺省存储根处理；trust store 自己的损坏才影响授权结论。
    return undefined;
  }
}

export async function resolveWorkspaceMcpTrustStorePath(options?: {
  storageRoot?: string;
}): Promise<string> {
  const home = resolveUserHomeDir();
  const envRoot = process.env.NIBI_STORAGE_DIR?.trim();
  const configuredRoot =
    options?.storageRoot?.trim() || envRoot || (await readConfiguredStorageDir(home));
  const storageRoot = configuredRoot ? expandConfiguredRoot(configuredRoot, home) : join(home, ".nibi");
  return join(storageRoot, SECURITY_DIRECTORY, WORKSPACE_MCP_TRUST_STORE_FILE);
}

// ———— 声明摘要（v1） ————

function canonicalStringMap(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) return null;
  const result: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (typeof item !== "string") return null;
    result[key] = item;
  }
  return result;
}

function canonicalProtocol(value: unknown): CanonicalProtocol | null {
  if (value === undefined || value === null || value === "auto") return "auto";
  if (value === "legacy") return "legacy";
  if (value === "2026-07-28") return "2026-07-28";
  return null;
}

function canonicalOAuth(value: unknown, transport: CanonicalTransport): Record<string, string> | null {
  if (value === undefined || value === null) return null;
  if (transport === "stdio") return null;
  if (!isRecord(value)) return null;
  const text = (key: string): string | undefined => {
    const item = value[key];
    return typeof item === "string" && item.trim().length > 0 ? item.trim() : undefined;
  };
  const type = value.type;
  if (type === "client_credentials") {
    const clientId = text("clientId");
    const clientSecret = text("clientSecret");
    if (!clientId || !clientSecret) return null;
    const result: Record<string, string> = { clientId, clientSecret };
    const clientName = text("clientName");
    const scope = text("scope");
    if (clientName) result.clientName = clientName;
    if (scope) result.scope = scope;
    result.type = "client_credentials";
    return result;
  }
  if (type === "authorization_code") {
    const result: Record<string, string> = {};
    for (const key of ["clientId", "clientName", "clientSecret", "redirectPath", "scope"]) {
      const item = text(key);
      if (item) result[key] = item;
    }
    result.type = "authorization_code";
    return result;
  }
  return null;
}

/**
 * 归一化项目声明为参与摘要的执行配置（与 Rust `crates/ext/src/mcp/trust.rs` 同一算法）。
 * 无法归一化（缺 command/url、字段类型不对、未知协议版本）时返回 null：该声明不可审核。
 */
export function canonicalizeMcpDeclaration(
  config: McpServerConfig,
  transportHint?: CanonicalTransport,
): CanonicalDeclaration | null {
  const raw: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  // 与 Rust `node_config::normalize` 相同的别名收敛。
  if (!("env" in raw) && "environment" in raw) raw.env = raw.environment;
  delete raw.environment;
  delete raw.enable;
  delete raw.enabled;
  delete raw.timeout;
  delete raw.startup_timeout_sec;

  let type = typeof raw.type === "string" ? raw.type : undefined;
  if (type === "remote") type = "http";
  if (!type) {
    const command = typeof raw.command === "string" && raw.command.trim().length > 0;
    const url = typeof raw.url === "string" && raw.url.trim().length > 0;
    type = command ? "stdio" : url ? "http" : undefined;
  }
  if (type !== "stdio" && type !== "http" && type !== "sse") return null;
  if (transportHint && type !== transportHint) return null;
  if (type !== "stdio" && !("headers" in raw) && "http_headers" in raw) {
    raw.headers = raw.http_headers;
  }
  delete raw.http_headers;

  const protocolVersion = canonicalProtocol(raw.protocolVersion);
  if (protocolVersion === null) return null;
  const oauth = canonicalOAuth(raw.oauth, type);

  const alwaysLoad = raw.alwaysLoad;
  if (alwaysLoad !== undefined && typeof alwaysLoad !== "boolean") return null;
  const timeout = raw.timeoutMs;
  if (timeout !== undefined && !(typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0)) {
    return null;
  }
  const timeoutMs = typeof timeout === "number" ? Math.ceil(timeout) : null;

  if (type === "stdio") {
    const command = raw.command;
    if (typeof command !== "string" || command.length === 0) return null;
    if (raw.oauth !== undefined && raw.oauth !== null) return null;
    const argsValue = raw.args;
    let args: string[] = [];
    if (argsValue !== undefined) {
      if (!Array.isArray(argsValue) || argsValue.some((item) => typeof item !== "string")) return null;
      args = [...(argsValue as string[])];
    }
    const env = canonicalStringMap(raw.env);
    if (env === null) return null;
    const cwdValue = raw.cwd;
    let cwd: string | null = null;
    if (cwdValue !== undefined && cwdValue !== null) {
      if (typeof cwdValue !== "string" || cwdValue.length === 0) return null;
      cwd = cwdValue;
    }
    return {
      alwaysLoad: alwaysLoad === true,
      oauth: null,
      protocolVersion,
      timeoutMs,
      type,
      command,
      args,
      env,
      cwd,
    };
  }

  const url = raw.url;
  if (typeof url !== "string" || url.length === 0) return null;
  const headers = canonicalStringMap(raw.headers);
  if (headers === null) return null;
  return {
    alwaysLoad: alwaysLoad === true,
    oauth,
    protocolVersion,
    timeoutMs,
    type,
    url,
    headers,
  };
}

/** 按 JSON 键排序的稳定序列化（与 `JSON.stringify` 对同一对象的字符输出一致，键序固定）。 */
export function stableStringify(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item as Record<string, unknown>)
          .sort()
          .map((key) => [key, sort((item as Record<string, unknown>)[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

export function computeWorkspaceMcpDeclarationDigest(input: {
  workspaceIdentity: string;
  serverName: string;
  config: McpServerConfig;
}): string | null {
  const config = canonicalizeMcpDeclaration(input.config);
  if (!config) return null;
  return createHash("sha256")
    .update(
      stableStringify({
        version: DIGEST_VERSION,
        workspaceIdentity: input.workspaceIdentity,
        serverName: input.serverName,
        config,
      }),
      "utf8",
    )
    .digest("hex");
}

// ———— 用户域记录 ————

export async function readWorkspaceMcpTrustStore(
  storePath: string,
): Promise<WorkspaceMcpTrustStoreLoad> {
  let content: string;
  try {
    content = await readFile(storePath, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { status: "missing" };
    return { status: "corrupt" };
  }
  const parsed = parseWorkspaceMcpTrustStoreContent(content);
  if (parsed.status !== "ok") return { status: "corrupt" };
  return { status: "ok", records: parsed.file.records };
}

/** 写入一条决定：严格读取（损坏即拒绝并保留原文件）→ 只改本文件 records → 原子替换。 */
export async function writeWorkspaceMcpTrustDecision(input: {
  storePath: string;
  workspaceIdentity: string;
  serverName: string;
  declarationDigest: string;
  trusted: boolean;
  grantedAt?: string;
}): Promise<void> {
  await updateJsonObjectFile(input.storePath, (current) => {
    const parsed = Object.keys(current).length === 0 ? undefined : parseWorkspaceMcpTrustStoreObject(current);
    if (Object.keys(current).length > 0 && !parsed) {
      throw new WorkspaceMcpTrustStoreCorruptError(input.storePath);
    }
    const records = (parsed?.records ?? []).filter(
      (record) =>
        !(
          record.workspaceIdentity === input.workspaceIdentity &&
          record.serverName === input.serverName &&
          record.declarationDigest === input.declarationDigest
        ),
    );
    if (input.trusted) {
      records.push({
        workspaceIdentity: input.workspaceIdentity,
        serverName: input.serverName,
        declarationDigest: input.declarationDigest,
        grantedAt: input.grantedAt ?? new Date().toISOString(),
      });
    }
    // 只改自己的两个字段；本文件是专用存储，未知顶层字段会在上面的 strict 解析里判损坏。
    return { ...current, schemaVersion: 1, records };
  });
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

// ———— 审核状态 ————

const SECRET_ARG_FLAGS =
  /(--?(?:token|api[-_]?key|secret|password|passwd|auth|bearer|access[-_]?token|client[-_]?secret)[=\s]+)(?:"[^"]*"|'[^']*'|\S+)/giu;
const AUTH_HEADER = /((?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)?\s*)(\S+)/giu;

function sanitizeDisplayText(value: string): string {
  return value.replace(SECRET_ARG_FLAGS, "$1***").replace(AUTH_HEADER, "$1***");
}

function displayConfig(
  config: McpServerConfig,
  canonical: CanonicalDeclaration,
  workspacePath: string,
): string {
  if (canonical.type === "stdio") {
    return JSON.stringify(
      {
        command: sanitizeDisplayText([canonical.command ?? "", ...(canonical.args ?? [])].join(" ")),
        cwd: canonical.cwd ?? workspacePath,
        env: Object.keys(canonical.env ?? {}).sort(),
      },
      null,
      2,
    );
  }
  let url: URL | undefined;
  try {
    url = new URL(canonical.url ?? "");
  } catch {
    url = undefined;
  }
  if (url) {
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
  }
  return JSON.stringify(
    {
      type: canonical.type,
      url: url ? url.toString() : sanitizeDisplayText(canonical.url ?? ""),
      headers: Object.keys(canonical.headers ?? {}).sort(),
      oauth: canonical.oauth?.type,
    },
    null,
    2,
  );
}

export async function inspectWorkspaceMcpTrust(
  input: WorkspaceMcpTrustInspectInput,
): Promise<WorkspaceMcpTrustInspectResult> {
  const workspaceIdentity = input.workspaceIdentity?.trim() || input.workspacePath;
  const registered = input.registeredWorkspaces?.resolve(
    input.workspacePath,
    input.workspaceIdentity,
  );
  if (input.registeredWorkspaces && !registered) return { reviews: {}, unreviewable: [] };
  if (input.online === false || registered?.online === false) {
    return { reviews: {}, unreviewable: [] };
  }
  const projectRecords = input.records
    .filter(
      (record) => record.scope === "workspace" && record.source === "zcodeagentmcp",
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const reviews: Record<string, WorkspaceMcpTrustReviewView> = {};
  const unreviewable: string[] = [];
  if (projectRecords.length === 0) return { reviews, unreviewable };

  const storePath = input.storePath ?? (await resolveWorkspaceMcpTrustStorePath(input));
  const load = await readWorkspaceMcpTrustStore(storePath);
  const trustedRecords = load.status === "ok" ? load.records : [];

  for (const record of projectRecords) {
    const canonical = canonicalizeMcpDeclaration(record.config);
    const digest = computeWorkspaceMcpDeclarationDigest({
      workspaceIdentity,
      serverName: record.name,
      config: record.config,
    });
    if (!canonical || !digest) {
      unreviewable.push(record.name);
      continue;
    }
    const trusted = trustedRecords.some(
      (item) =>
        item.workspaceIdentity === workspaceIdentity &&
        item.serverName === record.name &&
        item.declarationDigest === digest,
    );
    // 旧摘要记录仍在用户域存储里 = 声明已变化、旧授权失效；这是 Host 的读取结论，
    // 设置页直接展示「需重新信任」，不自行比较摘要。
    const declarationChanged =
      !trusted &&
      trustedRecords.some(
        (item) =>
          item.workspaceIdentity === workspaceIdentity &&
          item.serverName === record.name &&
          item.declarationDigest !== digest,
      );
    reviews[record.name] = {
      declarationDigest: digest,
      configuredEnabled: record.enabled !== false,
      transport: canonical.type,
      sourcePaths: record.file?.filePath
        ? [record.file.filePath]
        : record.location?.directoryPath
          ? [record.location.directoryPath]
          : [],
      display: displayConfig(record.config, canonical, input.workspacePath),
      trusted,
      declarationChanged,
    };
  }
  return { reviews, unreviewable };
}

/**
 * 过滤掉不能装载的项目 MCP：未信任、不可审核或没有审核结果的项目声明一律不进入 Agent。
 * 用户级/插件级记录原样保留。
 */
export function filterTrustedProjectMcpRecords(
  input: WorkspaceMcpTrustFilterInput,
): NativeMcpServerRecord[] {
  const unreviewable = new Set(input.unreviewable ?? []);
  return input.records.filter((record) => {
    if (record.scope !== "workspace" || record.source !== "zcodeagentmcp") return true;
    const review = input.reviews[record.name];
    return review?.trusted === true && !unreviewable.has(record.name);
  });
}

// ———— A6：已注册工作区 ————

function registrationKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || normalizePathForLookup(workspacePath);
}

export function createWorkspaceMcpTrustRegistry(): WorkspaceMcpTrustRegistry {
  const entries = new Map<string, WorkspaceMcpRegistration>();
  return {
    register(entry) {
      entries.set(registrationKey(entry.workspacePath, entry.workspaceIdentity), entry);
    },
    unregister(workspacePath, workspaceIdentity) {
      entries.delete(registrationKey(workspacePath, workspaceIdentity));
    },
    resolve(workspacePath, workspaceIdentity) {
      return (
        entries.get(registrationKey(workspacePath, workspaceIdentity)) ??
        entries.get(registrationKey(workspacePath))
      );
    },
  };
}

/**
 * 窗口登记表检查（A6）：只有本窗口真正打开过的工作区才允许读取项目 MCP 配置。
 * 未登记 / 没有窗口 / 路径不符都返回 false（调用方只返回用户级 MCP）。
 */
export function isWorkspaceRegisteredForMcpInspection(
  windows: ReadonlyMap<number, ReadonlySet<string>>,
  windowId: number | undefined,
  workspacePath: string | undefined,
): boolean {
  if (windowId === undefined || !workspacePath?.trim()) return false;
  const registered = windows.get(windowId);
  if (!registered) return false;
  const wanted = normalizePathForLookup(workspacePath);
  for (const path of registered) {
    if (normalizePathForLookup(path) === wanted) return true;
  }
  return false;
}

/** 工作区根的规范化形式（注册表与窗口登记表共用的比较键）。 */
export function normalizeWorkspacePathForTrust(workspacePath: string): string {
  return normalizePathForLookup(normalize(workspacePath.trim()));
}

// ———— 决定（供 Host 服务/测试使用；UI 评审弹窗未接线） ————

export async function decideWorkspaceMcpTrust(
  input: WorkspaceMcpTrustDecideInput,
): Promise<WorkspaceMcpTrustDecision> {
  const workspaceIdentity = input.workspaceIdentity?.trim() || input.workspacePath;
  const registered = input.registeredWorkspaces?.resolve(
    input.workspacePath,
    input.workspaceIdentity,
  );
  if (input.registeredWorkspaces && !registered) {
    return { accepted: false, reasonCode: "workspace_mcp_workspace_not_registered" };
  }
  if (input.online === false || registered?.online === false) {
    return { accepted: false, reasonCode: "workspace_mcp_workspace_offline" };
  }
  const inspected = await inspectWorkspaceMcpTrust({
    records: input.records,
    workspacePath: input.workspacePath,
    workspaceIdentity,
    ...(input.storePath ? { storePath: input.storePath } : {}),
    ...(input.storageRoot ? { storageRoot: input.storageRoot } : {}),
  });
  const review = inspected.reviews[input.serverName];
  // 重读后的精确摘要必须与用户审核的那一条一致；声明已变化时拒绝旧摘要。
  if (!review || review.declarationDigest !== input.declarationDigest) {
    return { accepted: false, reasonCode: "workspace_mcp_declaration_changed" };
  }
  try {
    await writeWorkspaceMcpTrustDecision({
      storePath:
        input.storePath ??
        (await resolveWorkspaceMcpTrustStorePath(
          input.storageRoot ? { storageRoot: input.storageRoot } : undefined,
        )),
      workspaceIdentity,
      serverName: input.serverName,
      declarationDigest: input.declarationDigest,
      trusted: input.trusted,
    });
    return { accepted: true };
  } catch {
    return { accepted: false, reasonCode: "workspace_mcp_trust_unavailable" };
  }
}

/** 窄接口装配：Host 服务或测试按需取用，避免调用方各自拼装摘要与存储路径。 */
export function createWorkspaceMcpTrustHost(): WorkspaceMcpTrustHost {
  return {
    resolveStorePath: resolveWorkspaceMcpTrustStorePath,
    inspect: inspectWorkspaceMcpTrust,
    decide: decideWorkspaceMcpTrust,
    filterTrustedRecords: filterTrustedProjectMcpRecords,
  };
}
