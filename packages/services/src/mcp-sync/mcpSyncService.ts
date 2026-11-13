/* eslint-disable max-lines -- MCP 同步服务集中维护用户目录读写、远端导入和 filesystem 路径改写，拆分会增加远端配置同步回归面。 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, win32 } from "node:path";
import type {
  DecideWorkspaceMcpTrustRequest,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpScope,
  McpServerConfig,
  McpSyncCandidate,
  McpSyncExportedServer,
  McpSyncImportResult,
  McpSyncRemoteStatus,
  McpSyncSource,
  NativeMcpServerRecord,
  SaveCliMcpToUserDirectoryRequest,
  SettingsDirectoryLocation,
  SettingsDirectorySource,
  WorkspaceMcpTrustDecision,
} from "@nibi/shared";
import type { IMcpSyncService } from "./mcpSync.js";
import { createMcpDataSyncMethods } from "#src/data-sync/mcpDataSync.js";
import { decideWorkspaceMcpTrust, inspectWorkspaceMcpTrust } from "../mcp-trust/index.js";
import { checkRemoteSyncDirectoryWriteAccess } from "../remote-sync/remoteSyncWriteAccess.js";
import { readJsonObjectFileForUpdate, updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";

type McpConfigKeyName = "mcp.servers" | "mcpServers";

interface DirectoryMcpDescriptor {
  source: McpSyncSource;
  directorySource: SettingsDirectorySource;
  userConfigDirSegments: string[];
  workspaceConfigDirSegments: string[];
  fileName: string;
  configKeyName: McpConfigKeyName;
}

export interface UserMcpRecord {
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  source: McpSyncSource;
  path: string;
}

const NIBI_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "nibi",
  directorySource: "nibi",
  userConfigDirSegments: [".nibi", "cli"],
  workspaceConfigDirSegments: [".nibi"],
  fileName: "config.json",
  configKeyName: "mcp.servers",
};

const AGENTS_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "agents",
  directorySource: "agents",
  userConfigDirSegments: [".agents"],
  workspaceConfigDirSegments: [".agents"],
  fileName: "mcp.json",
  configKeyName: "mcpServers",
};

const ENABLED_KEY = "enabled";
// 历史遗留：桌面端早期把停用状态写成 enable，而 CLI 契约字段（contracts McpServerConfigBase）
// 一直是 enabled，导致同一条 server 出现两套口径、停用后仍被 agent 拉起。
// 现在读写逻辑一律只认 enabled，这里只保留一次性迁移；存量配置清空后整块删除。
const LEGACY_ENABLE_KEY = "enable";
const SECRET_CONFIG_FILE_MODE = 0o600;
const DIRECTORY_MCP_DESCRIPTORS: readonly DirectoryMcpDescriptor[] = [
  NIBI_MCP_DESCRIPTOR,
  AGENTS_MCP_DESCRIPTOR,
];

export interface McpSyncServiceDependencies {
  /**
   * MCP server 运行态状态检查的执行面。真实 connect/listTools 必须发生在
   * agent 进程（workspace 的 PATH/cwd 环境），host 侧没有可替代实现；无该依赖的
   * 构造（纯目录同步用途/单测）调用 listWorkspaceMcpServerStatuses 会显式抛错。
   */
  listMcpServerStatuses?: IMcpSyncService["listWorkspaceMcpServerStatuses"];
}

export function createMcpSyncService(
  dependencies: McpSyncServiceDependencies = {},
): IMcpSyncService {
  return {
    // 数据同步分类方法：list/hash/export/import，两端同一实现。
    ...createMcpDataSyncMethods(),
    async loadMcpFromUserDirectory(request) {
      return loadMcpFromUserDirectory(request);
    },
    async decideWorkspaceMcpTrust(request: DecideWorkspaceMcpTrustRequest) {
      return decideWorkspaceMcpTrustForEnvironment(request);
    },
    async listWorkspaceMcpServerStatuses(params) {
      if (!dependencies.listMcpServerStatuses) {
        throw new Error("MCP server status listing is unavailable in this runtime");
      }
      return dependencies.listMcpServerStatuses(params);
    },
    async saveMcpToUserDirectory(payload) {
      await saveMcpToUserDirectory(payload);
    },
    async listLocalUserMcpCandidates() {
      const localHomeDir = resolveUserHomeDir();
      return {
        candidates: (await collectEffectiveUserMcpRecords()).map(recordToCandidate),
        localHomeDir,
      };
    },
    async listRemoteUserMcpStatuses(params) {
      const remoteHomeDir = resolveUserHomeDir();
      const existingByName = await collectEffectiveUserMcpRecordByName();
      return {
        remoteHomeDir,
        statuses: params.names.map((name): McpSyncRemoteStatus => {
          const existing = existingByName.get(normalizeMcpNameKey(name));
          return existing ? { name, exists: true, path: existing.path } : { name, exists: false };
        }),
      };
    },
    async exportMcpServers(params) {
      const candidates = (await collectEffectiveUserMcpRecords()).map(recordToCandidate);
      const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      return {
        localHomeDir: resolveUserHomeDir(),
        servers: params.serverIds.map((id): McpSyncExportedServer => {
          const candidate = candidateById.get(id);
          if (!candidate) {
            throw new Error(`mcp sync candidate not found: ${id}`);
          }
          return {
            id: candidate.id,
            name: candidate.name,
            config: cloneMcpConfig(candidate.config),
            enabled: candidate.enabled,
            source: candidate.source,
            path: candidate.path,
          };
        }),
      };
    },
    async checkRemoteUserMcpWriteAccess() {
      return checkRemoteSyncDirectoryWriteAccess(dirname(getUserNibiMcpConfigPath()));
    },
    async importMcpServers(params) {
      if (params.overwrite) {
        throw new Error("mcp sync overwrite is not supported");
      }
      return await importMcpServers(params);
    },
  };
}

export function resolveUserHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

function buildDirectoryConfigPath(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): string {
  const baseDir = scope === "user" ? resolveUserHomeDir() : workspacePath;
  if (!baseDir) {
    throw new Error(
      `Missing workspace path for ${descriptor.directorySource} workspace MCP config`,
    );
  }
  const segments =
    scope === "user" ? descriptor.userConfigDirSegments : descriptor.workspaceConfigDirSegments;
  return join(baseDir, ...segments, descriptor.fileName);
}

function buildUserConfigPath(descriptor: DirectoryMcpDescriptor): string {
  return buildDirectoryConfigPath(descriptor, "user");
}

export function getUserNibiMcpConfigPath(): string {
  return buildUserConfigPath(NIBI_MCP_DESCRIPTOR);
}

function buildDirectoryMcpLocation(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): SettingsDirectoryLocation {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  return {
    source: descriptor.directorySource,
    scope: scope === "workspace" ? "project" : "user",
    directoryPath: dirname(filePath),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

function findDescriptorByLocation(location: SettingsDirectoryLocation): DirectoryMcpDescriptor {
  const descriptor = DIRECTORY_MCP_DESCRIPTORS.find(
    (item) => item.directorySource === location.source,
  );
  if (!descriptor) {
    throw new Error(`Unsupported MCP settings directory source: ${location.source}`);
  }
  return descriptor;
}

export async function collectEffectiveUserMcpRecords(): Promise<UserMcpRecord[]> {
  const nibiRecords = await readUserMcpRecordsFromFile(NIBI_MCP_DESCRIPTOR);
  if (nibiRecords.length > 0) {
    return sortMcpRecords(nibiRecords);
  }
  return sortMcpRecords(await readUserMcpRecordsFromFile(AGENTS_MCP_DESCRIPTOR));
}

async function collectEffectiveUserMcpRecordByName(): Promise<Map<string, UserMcpRecord>> {
  const result = new Map<string, UserMcpRecord>();
  for (const record of await collectEffectiveUserMcpRecords()) {
    const nameKey = normalizeMcpNameKey(record.name);
    if (!result.has(nameKey)) {
      result.set(nameKey, record);
    }
  }
  return result;
}

async function loadMcpFromUserDirectory(
  request?: LoadCliMcpFromUserDirectoryRequest,
): Promise<LoadCliMcpFromUserDirectoryResult> {
  const servers: NativeMcpServerRecord[] = [];
  if (request?.workspacePath) {
    servers.push(
      ...(await readDirectoryServersFromPreferredSources("workspace", request.workspacePath)),
    );
  }
  servers.push(...(await readDirectoryServersFromPreferredSources("user", request?.workspacePath)));
  if (!request?.workspacePath) {
    return { servers };
  }
  // 根因：远端工作区（SSH/WSL/Docker/Server remote）的项目 MCP 由远端内核按
  // `<远端存储根>/security/workspace-mcp-trust-v1.json` 拒绝；此前 IMcpSyncService 只回传
  // servers，远端 UI 看不到 review，也无法在远端建立授权。这里与 desktop Host 使用同一份
  // 信任实现，在既有 loadMcpFromUserDirectory 方法内附带 review（不新增 RPC 通道）。
  try {
    const inspected = await inspectWorkspaceMcpTrust({
      records: servers,
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    });
    return {
      servers,
      trust: inspected.reviews,
      unreviewable: inspected.unreviewable,
    };
  } catch (error) {
    console.warn("[mcp-sync] workspace MCP trust inspection failed:", formatErrorMessage(error));
    // 审核状态读不出来时不能退化成“未知即可通过”：UI 展示不可审核，内核仍按默认拒绝。
    return { servers, trustReasonCode: "workspace_mcp_trust_unavailable" };
  }
}

/**
 * 在**当前 Environment** 的用户域信任库里写入一条决定；只接受与当前声明摘要精确匹配的条目。
 * 远端 UI 通过 IMcpSyncService 调到这里，保证信任记录与远端内核读取的位置一致。
 */
async function decideWorkspaceMcpTrustForEnvironment(
  request: DecideWorkspaceMcpTrustRequest,
): Promise<WorkspaceMcpTrustDecision> {
  const workspacePath = request.workspacePath?.trim();
  if (!workspacePath || !request.serverName?.trim() || !request.declarationDigest?.trim()) {
    return { accepted: false, reasonCode: "workspace_mcp_trust_unavailable" };
  }
  try {
    const loaded = await loadMcpFromUserDirectory({
      workspacePath,
      ...(request.workspaceIdentity?.trim()
        ? { workspaceIdentity: request.workspaceIdentity.trim() }
        : {}),
    });
    return await decideWorkspaceMcpTrust({
      records: loaded.servers,
      workspacePath,
      ...(request.workspaceIdentity?.trim()
        ? { workspaceIdentity: request.workspaceIdentity.trim() }
        : {}),
      serverName: request.serverName,
      declarationDigest: request.declarationDigest,
      trusted: request.trusted,
    });
  } catch (error) {
    console.warn("[mcp-sync] workspace MCP trust decision failed:", formatErrorMessage(error));
    return { accepted: false, reasonCode: "workspace_mcp_trust_unavailable" };
  }
}

async function saveMcpToUserDirectory(payload: SaveCliMcpToUserDirectoryRequest): Promise<void> {
  if (payload.action === "set-enabled") {
    if (typeof payload.enabled !== "boolean") {
      throw new Error("Missing enabled value for MCP set-enabled action");
    }
    const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
    const location =
      payload.location ??
      buildDirectoryMcpLocation(NIBI_MCP_DESCRIPTOR, scope, payload.projectPath);
    await writeServerEnabledToFile(
      findDescriptorByLocation(location),
      location,
      payload.name,
      payload.enabled,
    );
    await cleanupLegacyMcpEnabledOverride(location, payload.name);
    return;
  }

  const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
  const config = payload.action === "upsert" ? payload.config : undefined;
  if (payload.action === "upsert" && !config) {
    throw new Error("Missing MCP config for upsert action");
  }
  // 根因：旧实现先宽松读取现有 server map 再整文件写回；config.json 损坏时读取被当作空对象，
  // provider、命令、插件等其他写入方的字段会被一起冲掉。
  // 修法：写前在 updateJsonObjectFile 内重读，只增删当前 server，其他字段原样保留。
  await updateNibiServersInFile(scope, payload.projectPath, (servers) => {
    if (config) {
      servers[payload.name] = config;
    } else {
      delete servers[payload.name];
    }
  });
}

function sortMcpRecords(records: UserMcpRecord[]): UserMcpRecord[] {
  return records.sort((left, right) => left.name.localeCompare(right.name));
}

async function readDirectoryServersFromPreferredSources(
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const nibiServers = await readDirectoryServersFromFile(NIBI_MCP_DESCRIPTOR, scope, workspacePath);
  if (nibiServers.length > 0) {
    return nibiServers;
  }
  return readDirectoryServersFromFile(AGENTS_MCP_DESCRIPTOR, scope, workspacePath);
}

async function readDirectoryServersFromFile(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  const parsed = await readJsonObject(filePath);
  if (!parsed) {
    return [];
  }
  const serverMap = await readServerMapWithLegacyMigration(
    filePath,
    parsed,
    descriptor.configKeyName,
  );
  const location = buildDirectoryMcpLocation(descriptor, scope, workspacePath);
  return Object.entries(serverMap).map(([name, config]) => ({
    source: "nibiagentmcp",
    scope,
    name,
    config: config as McpServerConfig,
    enabled: readServerEnabled(config),
    projectPath: scope === "workspace" ? workspacePath : undefined,
    location,
    file: {
      format: "json",
      filePath,
    },
  }));
}

/**
 * 写前重读 `.nibi` 的 server map，只改 update 涉及的 server，其他写入方字段原样保留。
 * 根因：旧实现先宽松读取（config.json 损坏时返回 null → 空对象）再整文件写回，
 * provider、命令、插件等其他配置会被冲掉；现在统一走 updateJsonObjectFile（损坏时抛错、字节不变）。
 */
async function updateNibiServersInFile(
  scope: Exclude<McpScope, "common">,
  workspacePath: string | undefined,
  update: (servers: Record<string, Record<string, unknown>>) => void,
): Promise<void> {
  const filePath = buildDirectoryConfigPath(NIBI_MCP_DESCRIPTOR, scope, workspacePath);
  const key = NIBI_MCP_DESCRIPTOR.configKeyName;
  await updateJsonObjectFile(filePath, (current) => {
    const servers = {
      ...migrateLegacyEnableFlag(readServerMapFromJson(current, key)).servers,
    };
    update(servers);
    return writeServerMapToJson(current, key, servers);
  });
}

function removeLegacyMcpEnabledOverride(
  config: Record<string, unknown>,
  location: SettingsDirectoryLocation,
  name: string,
): { config: Record<string, unknown>; changed: boolean } {
  if (!isRecord(config.mcp) || !isRecord(config.mcp[location.directoryPath])) {
    return { config, changed: false };
  }

  const mcpConfig = { ...config.mcp };
  const pathConfig = {
    ...(mcpConfig[location.directoryPath] as Record<string, unknown>),
  };
  if (!(name in pathConfig)) {
    return { config, changed: false };
  }

  delete pathConfig[name];
  if (Object.keys(pathConfig).length > 0) {
    mcpConfig[location.directoryPath] = pathConfig;
  } else {
    delete mcpConfig[location.directoryPath];
  }

  return {
    config: {
      ...config,
      mcp: mcpConfig,
    },
    changed: true,
  };
}

// 修复：旧实现用宽松读取（读失败、JSON 损坏或根节点不是对象都当作空对象），
// 再用不设权限的原子写落盘，会把整份 config.json（provider、MCP secret）冲成只剩 MCP 字段。
// 现在统一走 updateJsonObjectFile：严格读取（损坏时抛错、字节不变）+ 写前重读 + 原子替换（0600）。
// 没有改动时先用严格读取判断并直接返回，不新建或重写文件。
async function cleanupLegacyMcpEnabledOverride(
  location: SettingsDirectoryLocation,
  name: string,
): Promise<void> {
  const filePath = getUserNibiMcpConfigPath();
  if (
    !removeLegacyMcpEnabledOverride(await readJsonObjectFileForUpdate(filePath), location, name)
      .changed
  ) {
    return;
  }
  await updateJsonObjectFile(
    filePath,
    (current) => removeLegacyMcpEnabledOverride(current, location, name).config,
  );
}

async function writeServerEnabledToFile(
  descriptor: DirectoryMcpDescriptor,
  location: SettingsDirectoryLocation,
  name: string,
  enabled: boolean,
): Promise<void> {
  const scope: Exclude<McpScope, "common"> = location.scope === "project" ? "workspace" : "user";
  const workspacePath = scope === "workspace" ? location.projectPath : undefined;
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  const hasServer = (current: Record<string, unknown>) =>
    isRecord(readServerMapFromJson(current, descriptor.configKeyName)[name]);
  if (!hasServer(await readJsonObjectFileForUpdate(filePath))) {
    return;
  }

  await updateJsonObjectFile(filePath, (current) => {
    if (!hasServer(current)) {
      return current;
    }
    const serverMap = readServerMapFromJson(current, descriptor.configKeyName);
    // MCP 自身已有 mcp.servers/mcpServers 结构；禁用状态写在 server 配置对象内，
    // 避免把目录路径写到 mcp 顶层后和真实 MCP 配置混在一起。
    const nextServerMap = {
      ...serverMap,
      [name]: setServerEnabled(serverMap[name] as McpServerConfig, enabled) as Record<
        string,
        unknown
      >,
    };
    const next = writeServerMapToJson(current, descriptor.configKeyName, nextServerMap);
    return removeLegacyMcpEnabledOverride(next, location, name).config;
  });
}

async function readUserMcpRecordsFromFile(
  descriptor: DirectoryMcpDescriptor,
): Promise<UserMcpRecord[]> {
  const filePath = buildUserConfigPath(descriptor);
  const parsed = await readJsonObject(filePath);
  if (!parsed) {
    return [];
  }
  const serverMap = await readServerMapWithLegacyMigration(
    filePath,
    parsed,
    descriptor.configKeyName,
  );
  return Object.entries(serverMap).map(([name, config]) => ({
    name,
    config: config as McpServerConfig,
    enabled: readServerEnabled(config),
    source: descriptor.source,
    path: filePath,
  }));
}

function recordToCandidate(record: UserMcpRecord): McpSyncCandidate {
  return {
    id: createCandidateId(record),
    name: record.name,
    config: cloneMcpConfig(record.config),
    enabled: record.enabled,
    source: record.source,
    path: record.path,
  };
}

function createCandidateId(record: UserMcpRecord): string {
  return createHash("sha256")
    .update(`${record.source}:${record.path}:${record.name}`)
    .digest("hex");
}

export function normalizeMcpNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function readServerEnabled(config: Record<string, unknown>): boolean {
  return config[ENABLED_KEY] !== false;
}

export function setServerEnabled(config: McpServerConfig, enabled: boolean): McpServerConfig {
  // 启用是默认态，不落盘冗余字段；同时清掉可能残留的 legacy enable，
  // 避免再产出 enable:false + enabled:true 这类自相矛盾的配置。
  const { [LEGACY_ENABLE_KEY]: _legacyEnable, [ENABLED_KEY]: _enabled, ...rest } = config;
  if (enabled) {
    return rest;
  }
  return { ...rest, [ENABLED_KEY]: false };
}

function migrateLegacyEnableFlag(serverMap: Record<string, Record<string, unknown>>): {
  servers: Record<string, Record<string, unknown>>;
  changed: boolean;
} {
  let changed = false;
  const migrated: Record<string, Record<string, unknown>> = {};

  for (const [name, config] of Object.entries(serverMap)) {
    if (!isRecord(config) || !(LEGACY_ENABLE_KEY in config)) {
      migrated[name] = config;
      continue;
    }
    changed = true;
    // 两个字段冲突时以「停用」为准：桌面端写 enable:false 时不会清理外部导入残留的
    // enabled:true，若按 enabled 取值会把用户关掉的 server 重新拉起。
    const disabled = config[LEGACY_ENABLE_KEY] === false || config[ENABLED_KEY] === false;
    migrated[name] = setServerEnabled(config as McpServerConfig, !disabled) as Record<
      string,
      unknown
    >;
  }

  return { servers: migrated, changed };
}

/**
 * 读取 server map，顺带把存量 enable 就地折叠成 enabled 并落盘。
 * 没有残留字段时不写文件，保证幂等；写盘失败不阻断读取，内存结果已是正确口径，下次加载会重试。
 */
async function readServerMapWithLegacyMigration(
  filePath: string,
  parsed: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
): Promise<Record<string, Record<string, unknown>>> {
  const migration = migrateLegacyEnableFlag(readServerMapFromJson(parsed, configKeyName));
  if (!migration.changed) {
    return migration.servers;
  }

  try {
    await updateJsonObjectFile(filePath, (current) =>
      writeServerMapToJson(
        current,
        configKeyName,
        migrateLegacyEnableFlag(readServerMapFromJson(current, configKeyName)).servers,
      ),
    );
  } catch (error) {
    console.warn("[mcp-sync] legacy enable migration failed:", filePath, formatErrorMessage(error));
  }
  return migration.servers;
}

export function readServerMapFromJson(
  parsed: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
): Record<string, Record<string, unknown>> {
  if (configKeyName === "mcp.servers") {
    const mcp = parsed.mcp;
    if (!isRecord(mcp)) {
      return {};
    }
    const servers = mcp.servers;
    return isRecord(servers) ? (servers as Record<string, Record<string, unknown>>) : {};
  }

  const rawServerMap = parsed[configKeyName];
  return isRecord(rawServerMap) ? (rawServerMap as Record<string, Record<string, unknown>>) : {};
}

export function writeServerMapToJson(
  current: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
  servers: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  if (configKeyName !== "mcp.servers") {
    return {
      ...current,
      [configKeyName]: servers,
    };
  }

  const currentMcp = isRecord(current.mcp) ? current.mcp : {};
  return {
    ...current,
    mcp: {
      ...currentMcp,
      servers,
    },
  };
}

async function importMcpServers(params: {
  servers: McpSyncExportedServer[];
  localHomeDir: string;
  localWorkspacePath?: string;
  remoteWorkspacePath?: string;
}): Promise<McpSyncImportResult> {
  const targetPath = getUserNibiMcpConfigPath();
  const current = (await readJsonObject(targetPath)) ?? {};
  const targetServers = readServerMapFromJson(current, NIBI_MCP_DESCRIPTOR.configKeyName);
  const existingByName = await collectEffectiveUserMcpRecordByName();
  const results: McpSyncImportResult["results"] = [];
  let changed = false;

  for (const server of params.servers) {
    const nameKey = normalizeMcpNameKey(server.name);
    const existingTarget = targetServers[server.name];
    if (existingTarget) {
      results.push({ name: server.name, status: "skipped", path: targetPath });
      continue;
    }

    const existing = existingByName.get(nameKey);
    if (existing) {
      results.push({
        name: server.name,
        status: "skipped",
        path: existing.path,
      });
      continue;
    }

    try {
      const rewrittenConfig = rewriteFilesystemMcpConfig(
        server.name,
        setServerEnabled(cloneMcpConfig(server.config), server.enabled),
        {
          localHomeDir: params.localHomeDir,
          localWorkspacePath: params.localWorkspacePath,
          remoteHomeDir: resolveUserHomeDir(),
          remoteWorkspacePath: params.remoteWorkspacePath,
        },
      );
      targetServers[server.name] = rewrittenConfig as Record<string, unknown>;
      existingByName.set(nameKey, {
        name: server.name,
        config: rewrittenConfig,
        enabled: server.enabled,
        source: "nibi",
        path: targetPath,
      });
      results.push({ name: server.name, status: "synced", path: targetPath });
      changed = true;
    } catch (error) {
      results.push({
        name: server.name,
        status: "failed",
        path: targetPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (changed) {
    await writeTextAtomic(
      targetPath,
      `${JSON.stringify(writeServerMapToJson(current, NIBI_MCP_DESCRIPTOR.configKeyName, targetServers), null, 2)}\n`,
    );
  }

  return { results };
}

export function rewriteFilesystemMcpConfig(
  name: string,
  config: McpServerConfig,
  paths: {
    localHomeDir: string;
    localWorkspacePath?: string;
    remoteHomeDir: string;
    remoteWorkspacePath?: string;
  },
): McpServerConfig {
  if (!isStdioMcpConfig(config) || !isFilesystemMcpServer(name, config)) {
    return config;
  }
  if (!Array.isArray(config.args)) {
    return config;
  }
  return {
    ...config,
    args: config.args.map((arg) => rewritePathArgForRemote(arg, paths)),
  };
}

function isStdioMcpConfig(config: McpServerConfig): boolean {
  const type = typeof config.type === "string" ? config.type.trim().toLowerCase() : "";
  if (!type && typeof config.command === "string" && config.command.trim()) {
    return true;
  }
  return type === "stdio";
}

function isFilesystemMcpServer(name: string, config: McpServerConfig): boolean {
  const normalizedName = name.trim().toLowerCase();
  if (
    normalizedName === "filesystem" ||
    normalizedName === "file-system" ||
    normalizedName === "fs"
  ) {
    return true;
  }
  const haystack = [config.command, ...(Array.isArray(config.args) ? config.args : [])]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  return (
    haystack.includes("@modelcontextprotocol/server-filesystem") ||
    haystack.includes("mcp-server-filesystem")
  );
}

function rewritePathArgForRemote(
  arg: string,
  paths: {
    localHomeDir: string;
    localWorkspacePath?: string;
    remoteHomeDir: string;
    remoteWorkspacePath?: string;
  },
): string {
  const workspaceRelative = getRelativePathIfWithin(paths.localWorkspacePath, arg);
  if (workspaceRelative !== null && paths.remoteWorkspacePath?.trim()) {
    return joinRemotePath(paths.remoteWorkspacePath, workspaceRelative);
  }

  const homeRelative = getRelativePathIfWithin(paths.localHomeDir, arg);
  if (homeRelative !== null) {
    return joinRemotePath(paths.remoteHomeDir, homeRelative);
  }

  return arg;
}

function getRelativePathIfWithin(
  basePath: string | undefined,
  candidatePath: string,
): string | null {
  if (!basePath?.trim()) {
    return null;
  }
  const base = normalizeComparablePath(basePath);
  const candidate = normalizeComparablePath(candidatePath);
  if (!base || !candidate) {
    return null;
  }
  const baseValue = base.caseInsensitive ? base.value.toLowerCase() : base.value;
  const candidateValue = base.caseInsensitive ? candidate.value.toLowerCase() : candidate.value;
  if (candidateValue === baseValue) {
    return "";
  }
  const prefix = baseValue.endsWith("/") ? baseValue : `${baseValue}/`;
  if (!candidateValue.startsWith(prefix)) {
    return null;
  }
  return candidate.value.slice(prefix.length);
}

function normalizeComparablePath(
  rawPath: string,
): { value: string; caseInsensitive: boolean } | null {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }
  const isWindowsPath = /^[a-zA-Z]:[\\/]/u.test(trimmed) || trimmed.startsWith("\\\\");
  const isPosixPath = trimmed.startsWith("/");
  if (!isWindowsPath && !isPosixPath) {
    return null;
  }

  let value = trimmed.replaceAll("\\", "/");
  value = value.replace(/\/+$/u, "");
  if (value === "") {
    value = "/";
  }
  return {
    value,
    caseInsensitive: isWindowsPath,
  };
}

function joinRemotePath(remoteBasePath: string, relativePath: string): string {
  if (!relativePath) {
    return remoteBasePath;
  }
  const segments = relativePath.split(/[\\/]+/u).filter(Boolean);
  // MCP 同步运行在本机进程里，但 remoteWorkspacePath 描述的是远端主机路径。
  // 不能用 process.platform 决定拼接风格，否则 Windows 客户端同步到 Linux/WSL 时会把 /srv/... 写成 \srv\...。
  const normalizedBasePath = remoteBasePath.trim();
  if (normalizedBasePath.startsWith("/")) {
    return posix.join(normalizedBasePath.replaceAll("\\", "/"), ...segments);
  }
  if (/^[a-zA-Z]:[\\/]/u.test(normalizedBasePath) || normalizedBasePath.startsWith("\\\\")) {
    return win32.join(normalizedBasePath, ...segments);
  }
  return posix.join(normalizedBasePath.replaceAll("\\", "/"), ...segments);
}

export function cloneMcpConfig(config: McpServerConfig): McpServerConfig {
  return JSON.parse(JSON.stringify(config)) as McpServerConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return null;
    }
    throw new Error(`无法读取 MCP 配置文件 ${filePath}: ${formatErrorMessage(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    // 远端 MCP 导入必须先确认现有 config.json 可读可合并；
    // JSON 损坏时如果当作空对象继续写，会静默覆盖 provider、MCP 和 secret 配置。
    throw new Error(`无法解析 MCP 配置文件 ${filePath}: ${formatErrorMessage(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`MCP 配置文件 ${filePath} 必须是 JSON 对象`);
  }
  return parsed;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = join(
    dirname(filePath),
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    // 远端 MCP 配置会持久化 env/header/token 等 secret；
    // 临时文件权限不能依赖远端 umask，否则 rename 后 config.json 可能被同组或其他用户读取。
    await writeFile(tempPath, content, {
      encoding: "utf-8",
      mode: SECRET_CONFIG_FILE_MODE,
    });
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}
