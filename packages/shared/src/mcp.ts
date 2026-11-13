/**
 * MCP (Model Context Protocol) types for Nibi
 * Based on the original Tauri implementation
 */

import type { SettingsDirectoryLocation } from "./settings-source.js";
import type { McpServerFailureKind } from "./nibi-protocol/index.js";

// CUA official plugin 身份常量（port 自 feat；UI 设置面板 + bootstrap 复用以避免字面量漂移）。
export const NIBI_CUA_OFFICIAL_PLUGIN_ID = "computer-use@nibi-official";
// CUA server 身份串（port 自 feat mcp.ts）：server key = 模型可见工具前缀段（刻意不带 nibi-）；
// namespace name = official plugin 运行时命名空间 plugin:<pluginId>:<serverKey>。
export const NIBI_CUA_OFFICIAL_MCP_NAMESPACE_NAME = "plugin:computer-use:computer-use";
// 插件身份 env key：resolver（adapters/src/plugins/mcp.ts）权威写入 loaded.id，manifest/user env 不可覆盖。
// bootstrap + cli/plugin-host-command.ts 复用此常量识别 official zcode-cua plugin server，避免字面量漂移。
export const NIBI_PLUGIN_ID_ENV_KEY = "NIBI_PLUGIN_ID";

export type McpSource =
  | "mcp"
  | "zcodeagentmcp"
  | "claudeclimcp"
  | "geminiclimcp"
  | "codexclimcp"
  | "opencodemcp";
export type CliMcpSource = Exclude<McpSource, "mcp">;
export type McpScope = "common" | "user" | "workspace";
export type McpFileFormat = "json" | "toml";

// Single MCP server configuration
export interface McpServerConfig {
  type?: string; // Supports stdio, http, sse, streamableHttp, etc.
  url?: string; // HTTP/SSE server URL
  command?: string; // stdio server command
  args?: string[]; // stdio server arguments
  env?: Record<string, string>; // stdio server environment variables
  headers?: Record<string, string>; // HTTP/SSE server request headers
  http_headers?: Record<string, string>; // 兼容旧配置字段，历史 BigModel MCP 配置会把鉴权头写在这里
  oauth?: McpOAuthConfig; // HTTP/SSE OAuth 机器凭据配置
  // Linear specific fields
  apiKey?: string;
  projectId?: string;
  issueType?: string;
  // Figma specific fields
  personalAccessToken?: string;
  fileId?: string;
  nodeId?: string;
  // Sentry specific fields
  organizationName?: string;
  projectName?: string;
  dsn?: string;
  // Context7 specific fields
  apiEndpoint?: string;
  [key: string]: any;
}

export type McpServerStatus = "connected" | "disconnected" | "error" | "connecting" | "unknown";

export interface CliMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
  projects: Record<string, Record<string, McpServerConfig>>;
}

export interface SaveCliMcpToUserDirectoryRequest {
  action: "upsert" | "delete" | "set-enabled";
  source: CliMcpSource;
  name: string;
  config?: McpServerConfig;
  enabled?: boolean;
  projectPath?: string;
  location?: SettingsDirectoryLocation;
}

export interface NativeMcpFileReference {
  format: McpFileFormat;
  filePath: string;
}

export interface NativeMcpServerRecord {
  source: McpSource;
  scope: McpScope;
  name: string;
  config: McpServerConfig;
  enabled?: boolean;
  projectPath?: string;
  location?: SettingsDirectoryLocation;
  file?: NativeMcpFileReference;
}

export interface LoadCliMcpFromUserDirectoryRequest {
  workspacePath?: string;
  /** 工作区身份（remote 链路与本地路径不同的稳定键）；缺省按 workspacePath。 */
  workspaceIdentity?: string;
}

/**
 * 一条工作区 MCP 声明的审核结果（Host 唯一 owner 计算）。
 *
 * `trusted` 只表示用户域记录里有当前精确摘要；`configuredEnabled` 与信任正交。
 * `display` 是 Host 已脱敏的展示文本，UI 不得从原始配置重建。
 */
export interface WorkspaceMcpTrustReview {
  declarationDigest: string;
  configuredEnabled: boolean;
  transport: "stdio" | "http" | "sse";
  sourcePaths: string[];
  display: string;
  trusted: boolean;
  /**
   * Host 读取信任记录得到的结论：同一工作区/服务器存在旧摘要但当前摘要未命中。
   * UI 只展示，不自行比较 digest。
   */
  declarationChanged?: boolean;
}

export type WorkspaceMcpTrustReasonCode =
  | "workspace_mcp_declaration_changed"
  | "workspace_mcp_trust_unavailable"
  | "workspace_mcp_workspace_not_registered"
  | "workspace_mcp_workspace_offline";

export type WorkspaceMcpTrustDecision =
  | { accepted: true }
  | {
      accepted: false;
      reasonCode: WorkspaceMcpTrustReasonCode;
    };

/** 对当前工作区的一条项目 MCP 声明提交信任/撤销；由 Host 重读声明并核对精确摘要。 */
export interface DecideWorkspaceMcpTrustRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  serverName: string;
  declarationDigest: string;
  trusted: boolean;
}

export interface LoadCliMcpFromUserDirectoryResult {
  servers: NativeMcpServerRecord[];
  /** 项目级（workspace scope）MCP 的审核状态；用户级/插件级不在其中。 */
  trust?: Record<string, WorkspaceMcpTrustReview>;
  /** Host 无法审核时的原因（未登记/离线/信任存储不可用）。 */
  trustReasonCode?: WorkspaceMcpTrustReasonCode;
  /** 无法归一化、Host 按未信任处理的项目 server 名。 */
  unreviewable?: string[];
}

export interface McpConfig {
  mcp: {
    mcpServers: Record<string, McpServerConfig>;
  };
  zcodeagentmcp: CliMcpConfig;
  claudeclimcp: CliMcpConfig;
  geminiclimcp: CliMcpConfig;
  codexclimcp: CliMcpConfig;
  opencodemcp: CliMcpConfig;
}

export interface NibiMcpServer {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  changed?: boolean;
  status?: McpServerStatus;
  lastConnected?: Date;
  error?: string;
  failureKind?: McpServerFailureKind;
  serverRequestId?: string;
  toolCount?: number;
  authorization?: {
    type: "oauth_authorization_code";
    authorizationUrl: string;
    startedAt: string;
  };
  source: McpSource;
  projectPath?: string;
  scope: McpScope;
  location?: SettingsDirectoryLocation;
  file?: NativeMcpFileReference;
}

export interface McpServerListItem {
  id: string;
  name: string;
  enabled: boolean;
  status: McpServerStatus;
  hasConfig: boolean;
  error?: string;
  toolCount?: number;
  source: McpSource;
  projectPath?: string;
  scope: McpScope;
  file?: NativeMcpFileReference;
}

export interface McpTestResult {
  success: boolean;
  error?: string;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: any;
  }>;
  serverInfo?: {
    name: string;
    version: string;
  };
  response_time?: number;
}

export type NibiAgentMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
      alwaysLoad?: boolean;
      isolation?: "session" | "workspace";
      protocolVersion?: "legacy" | "auto" | "2026-07-28";
      timeoutMs?: number;
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      alwaysLoad?: boolean;
      isolation?: "session" | "workspace";
      protocolVersion?: "legacy" | "auto" | "2026-07-28";
      headers: Array<{ name: string; value: string }>;
      oauth?: McpOAuthConfig;
      timeoutMs?: number;
    };

export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

export function getMcpServerRequestHeaders(
  config: McpServerConfig,
): Record<string, string> | undefined {
  return config.headers ?? config.http_headers;
}

// NIBI CUA 包规格识别的单一事实源。desktop 产品 broker resolver（@nibi/services 的
// mcpBrokerInjection）与 CLI bootstrap（apps/nibi-cli 的 mcp-config）两条注入入口必须用
// 完全一致的判定；否则同一 MCP 配置在不同入口行为不同，可能漏注入 product broker，让
// Python/uvx 自己持有 macOS TCC 权限（违反 fail-closed 边界）。改这里即同时改两条链路。
const NIBI_CUA_PACKAGE_SPEC = "nibi-cua";
const NIBI_CUA_NPM_SPEC = "@nibi/cua";
// 历史上游包名：只用于 fail-closed 识别旧配置，不再作为我们的包名。
const LEGACY_NIBI_CUA_PACKAGE_SPEC = "zcode-cua";
function nibiCuaArgLeaf(value: string): string {
  // 先去掉结尾的路径分隔符再取叶子：`.../nibi-cua/` 直接 split 会得到空串叶子 → 漏判 → fail-open。
  return (
    value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? value
  );
}

// 单个候选串是否匹配某个包规格。PyPI 视 `_`/`-` 等价，故先把下划线归一成短横（nibi_cua →
// nibi-cua）；覆盖 uv/npm 的 `@version`、pip 的 `==version`、extras `[...]`、git 的 `.git`/`.git@`，
// 以及 `python -m nibi_cua.server` 这种点号子模块（`nibi-cua.<submodule>`）。fail-closed 边界宁可
// 过判也不漏判；仍不会误判 `nibi-cua-proxy`（短横续接，不以 `.`/`@`/`[`/`==` 边界续接）。
function matchesNibiCuaSpecName(candidate: string, spec: string): boolean {
  return (
    candidate === spec ||
    candidate.startsWith(`${spec}[`) ||
    candidate.startsWith(`${spec}@`) ||
    candidate.startsWith(`${spec}==`) ||
    // `.` 分支同时覆盖 `nibi-cua.git` / `nibi-cua.git@v1` 与 `nibi-cua.server` 等 python 子模块。
    candidate.startsWith(`${spec}.`)
  );
}

function matchesNibiCuaSpec(candidate: string): boolean {
  const c = candidate.replace(/_/g, "-");
  return (
    matchesNibiCuaSpecName(c, NIBI_CUA_PACKAGE_SPEC) ||
    matchesNibiCuaSpecName(c, NIBI_CUA_NPM_SPEC) ||
    matchesNibiCuaSpecName(c, LEGACY_NIBI_CUA_PACKAGE_SPEC)
  );
}

/**
 * MCP server 的 command 是否指向 NIBI CUA。用与 args 相同的包规格判定（并比对路径叶子），
 * 覆盖 `command: "nibi-cua"`、`/opt/bin/nibi-cua`，以及把包规格直接当 command 的写法
 * （`nibi-cua@1.2.3` 等）。对 fail-closed 边界宁可过判也不漏判。
 */
export function isNibiCuaMcpCommand(command: string): boolean {
  return matchesNibiCuaSpec(command) || matchesNibiCuaSpec(nibiCuaArgLeaf(command));
}

/**
 * 单个 arg 是否为 NIBI CUA 的包规格。覆盖 `nibi-cua`、`nibi-cua[macos]`、`nibi-cua@1.2.3`、
 * `nibi-cua==1.2.3`、`nibi_cua`、`@nibi/cua`，以及 git / 本地路径形态（`.../nibi-cua`、
 * `nibi-cua.git`、`git+https://.../nibi-cua.git@v1`）。同时比对原始值与路径叶子，
 * 覆盖 `--from <path>`、`--from <git-url>`。
 */
export function isNibiCuaMcpPackageArg(value: string): boolean {
  return matchesNibiCuaSpec(value) || matchesNibiCuaSpec(nibiCuaArgLeaf(value));
}

export function convertToNibiAgentMcpServer(
  name: string,
  config: McpServerConfig,
): NibiAgentMcpServer | null {
  let inferredType = config.type;
  if (!inferredType) {
    if (config.command) inferredType = "stdio";
    else if (config.url) inferredType = "http";
  }

  const isStdio = inferredType === "stdio";
  if (isStdio && config.command) {
    // Windows 上 agent 通常用 shell: true 启动子进程，
    // "cmd /c npx ..." 会被双重包裹成 "cmd.exe /c cmd /c npx ..." 导致连接失败。
    // 这里把 cmd /c 包衣拆掉，直接使用内部命令。
    let command = config.command;
    let args = config.args || [];
    // 自动检测平台：Node.js 用 process.platform，浏览器用 navigator.platform
    const isWin32 =
      (typeof process !== "undefined" && process.platform === "win32") ||
      (typeof navigator !== "undefined" && /win/i.test(navigator.platform));
    if (isWin32) {
      const lowerCmd = command.toLowerCase();
      const unwrappedCommand = args[1];
      if ((lowerCmd === "cmd" || lowerCmd === "cmd.exe") && args[0] === "/c" && unwrappedCommand) {
        // noUncheckedIndexedAccess 下 args[1] 即使经过 length 判断也仍是 string | undefined。
        // 先显式取值并判空，既满足类型收窄，也避免把空命令传给 Nibi Agent。
        command = unwrappedCommand;
        args = args.slice(2);
      }
    }
    return {
      name,
      command,
      args,
      env: config.env
        ? Object.entries(config.env).map(([key, value]) => ({
            name: key,
            value,
          }))
        : [],
      // 修复原因：DTO 逐字段重建曾丢失 alwaysLoad；仅透传布尔值，保留显式 false。
      ...(typeof config.alwaysLoad === "boolean" ? { alwaysLoad: config.alwaysLoad } : {}),
      // MCP 设置页会把 timeoutMs 写入 config；session/create 走协议 DTO 时
      // 只能透传正整数，否则 strict protocol schema 会把存量非法配置从“忽略”变成“创建失败”。
      ...(isValidMcpTimeoutMs(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
      ...(isMcpIsolation(config.isolation) ? { isolation: config.isolation } : {}),
      ...(isMcpProtocolVersion(config.protocolVersion)
        ? { protocolVersion: config.protocolVersion }
        : {}),
    };
  } else if (config.url && inferredType) {
    const normalizedType: "http" | "sse" = inferredType === "sse" ? "sse" : "http";
    const headers = getMcpServerRequestHeaders(config);
    return {
      name,
      type: normalizedType,
      url: config.url,
      headers: headers
        ? Object.entries(headers).map(([key, value]) => ({
            name: key,
            value,
          }))
        : [],
      ...(isValidMcpOAuthConfig(config.oauth) ? { oauth: config.oauth } : {}),
      // HTTP/SSE 与 stdio 使用相同规则，避免配置在进入 Agent 前丢失。
      ...(typeof config.alwaysLoad === "boolean" ? { alwaysLoad: config.alwaysLoad } : {}),
      // HTTP/SSE MCP 与 stdio 一样需要保留超时配置，避免 UI 保存后真实 session 丢字段。
      ...(isValidMcpTimeoutMs(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
      ...(isMcpIsolation(config.isolation) ? { isolation: config.isolation } : {}),
      ...(isMcpProtocolVersion(config.protocolVersion)
        ? { protocolVersion: config.protocolVersion }
        : {}),
    };
  }
  return null;
}

function isValidMcpTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isMcpIsolation(value: unknown): value is "session" | "workspace" {
  return value === "session" || value === "workspace";
}

function isMcpProtocolVersion(value: unknown): value is "legacy" | "auto" | "2026-07-28" {
  return value === "legacy" || value === "auto" || value === "2026-07-28";
}

function isValidMcpOAuthConfig(value: unknown): value is McpOAuthConfig {
  if (!isRecord(value)) return false;
  if (
    value.type === "client_credentials" &&
    typeof value.clientId === "string" &&
    value.clientId.trim().length > 0 &&
    typeof value.clientSecret === "string" &&
    value.clientSecret.trim().length > 0
  ) {
    return (
      (value.clientName === undefined || typeof value.clientName === "string") &&
      (value.scope === undefined || typeof value.scope === "string")
    );
  }
  if (value.type === "authorization_code") {
    return (
      (value.clientId === undefined || typeof value.clientId === "string") &&
      (value.clientSecret === undefined || typeof value.clientSecret === "string") &&
      (value.clientName === undefined || typeof value.clientName === "string") &&
      (value.redirectPath === undefined || typeof value.redirectPath === "string") &&
      (value.scope === undefined || typeof value.scope === "string")
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
