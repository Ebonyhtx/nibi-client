/**
 * Workspace MCP Trust store 文件格式（`workspace-mcp-trust-v1.json`）的 strict 解析。
 *
 * Host（本模块）是唯一写入者；Rust 内核（`crates/platform/src/mcp_trust.rs`）只读同一份用户域
 * 文件并做同样的 strict 校验：JSON 语法错误、未知版本、缺字段、多余的键或重复的
 * `(workspaceIdentity, serverName, declarationDigest)` 都让整份记录作废（fail closed），不能返回
 * 部分授信。
 */

export const WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION = 1 as const;

export interface WorkspaceMcpTrustRecord {
  workspaceIdentity: string;
  serverName: string;
  declarationDigest: string;
  grantedAt: string;
}

export interface WorkspaceMcpTrustStoreFile {
  schemaVersion: typeof WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION;
  records: WorkspaceMcpTrustRecord[];
}

export type WorkspaceMcpTrustStoreParseResult =
  | { status: "ok"; file: WorkspaceMcpTrustStoreFile }
  | { status: "invalid" };

const RECORD_KEYS = new Set([
  "workspaceIdentity",
  "serverName",
  "declarationDigest",
  "grantedAt",
]);
const STORE_KEYS = new Set(["schemaVersion", "records"]);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  const names = Object.keys(value);
  return names.length === keys.size && names.every((name) => keys.has(name));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseRecord(value: unknown): WorkspaceMcpTrustRecord | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, RECORD_KEYS)) return undefined;
  const { workspaceIdentity, serverName, declarationDigest, grantedAt } = value;
  if (!nonEmptyString(workspaceIdentity)) return undefined;
  if (!nonEmptyString(serverName)) return undefined;
  if (typeof declarationDigest !== "string" || !DIGEST_PATTERN.test(declarationDigest)) {
    return undefined;
  }
  if (typeof grantedAt !== "string" || !DATETIME_PATTERN.test(grantedAt)) return undefined;
  return { workspaceIdentity, serverName, declarationDigest, grantedAt };
}

/** 解析已 `JSON.parse` 的对象；任何结构不符返回 undefined。 */
export function parseWorkspaceMcpTrustStoreObject(
  value: unknown,
): WorkspaceMcpTrustStoreFile | undefined {
  if (!isRecord(value) || !hasExactlyKeys(value, STORE_KEYS)) return undefined;
  if (value.schemaVersion !== WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION) return undefined;
  if (!Array.isArray(value.records)) return undefined;
  const records: WorkspaceMcpTrustRecord[] = [];
  const keys = new Set<string>();
  for (const item of value.records) {
    const record = parseRecord(item);
    if (!record) return undefined;
    const key = `${record.workspaceIdentity}\u0000${record.serverName}\u0000${record.declarationDigest}`;
    if (keys.has(key)) return undefined;
    keys.add(key);
    records.push(record);
  }
  return { schemaVersion: WORKSPACE_MCP_TRUST_STORE_SCHEMA_VERSION, records };
}

/** 解析 trust store 文件内容；语法错误与 schema 失败统一判 `invalid`。 */
export function parseWorkspaceMcpTrustStoreContent(
  content: string,
): WorkspaceMcpTrustStoreParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return { status: "invalid" };
  }
  const file = parseWorkspaceMcpTrustStoreObject(parsed);
  return file ? { status: "ok", file } : { status: "invalid" };
}
