import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  createAgentStateId,
  type DataSyncImportItem,
  type DataSyncImportResultItem,
  type DataSyncItemDependencies,
  type DataSyncListItem,
  type SubagentDataSyncPayload,
} from "@nibi/shared";
import { migrateUserSubagentMarkdown } from "@nibi/shared/node";
import { pathExists, updateJsonObjectFile, writeFileAtomically } from "#src/fs/atomicFileUtils.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { checkRemoteSyncDirectoryWriteAccess } from "#src/remote-sync/remoteSyncWriteAccess.js";
import { parseSubagentMarkdown } from "#src/subagents/subagentMarkdown.js";
import {
  resolveSubagentStateFile,
  resolveUserHomeDir,
  resolveUserSubagentRoot,
  type SubagentStorageOptions,
} from "#src/subagents/subagentStorage.js";
import {
  collectAgentMarkdownPaths,
  readAgentStateAtPath,
} from "#src/subagents/subagentsService.js";
import type { IDataSyncCategoryService } from "./contract.js";
import { errorMessage } from "./syncUtils.js";

const logger = createServiceLogger("subagent-data-sync");

const AGENT_FILE_NAME = /^[^/\\]+\.(md|markdown)$/iu;

interface ResolvedUserSubagent {
  key: string;
  name: string;
  description: string;
  filePath: string;
  dependencies?: DataSyncItemDependencies;
  /** 迁移之后的文件字节。 */
  content: Buffer;
}

function hashContent(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function toSubagentKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 依赖只认运行时支持的字符串名称（见 CLI `parseAgentMcpServers`）：MCP 的对象形式是内联配置，不依赖目标端。
 * skills 已由 parseSubagentMarkdown 归一为字符串列表。
 */
function resolveDependencies(agent: {
  skills?: readonly string[];
  mcpServers?: readonly unknown[];
}): DataSyncItemDependencies | undefined {
  const mcpServers = (agent.mcpServers ?? [])
    .filter((spec): spec is string => typeof spec === "string")
    .map((spec) => spec.trim())
    .filter(Boolean);
  const skills = agent.skills ?? [];
  if (mcpServers.length === 0 && skills.length === 0) return undefined;
  return {
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
    ...(skills.length > 0 ? { skills: [...skills] } : {}),
  };
}

function toUserAgentStateId(key: string): string {
  return createAgentStateId({ name: key, scope: "user", source: "user" });
}

/**
 * 本端用户子智能体，按 name trim 后转小写对齐。根目录按本端存储根解析，两端可以不同。
 * 先完成本端 markdown 迁移再读字节：迁移只改写旧 Provider 身份，未迁移的一端与已迁移的一端
 * 内容实际相同，不先迁移就会被误判为「内容不同」。同名时保留路径排序中的第一个文件。
 */
async function resolveUserSubagents(options?: SubagentStorageOptions): Promise<{
  root: string;
  agents: Map<string, ResolvedUserSubagent>;
}> {
  const root = await resolveUserSubagentRoot(options);
  const migration = await migrateUserSubagentMarkdown(root);
  for (const failure of migration.failures) {
    logger.warn(undefined, "用户 Subagent Markdown 迁移失败，按原文件计算", failure);
  }
  const agents = new Map<string, ResolvedUserSubagent>();
  for (const filePath of await collectAgentMarkdownPaths(root)) {
    const content = await readFile(filePath);
    const parsed = parseSubagentMarkdown({
      content: content.toString("utf-8"),
      path: filePath,
      scope: "user",
    }).agent;
    if (!parsed) continue;
    const key = toSubagentKey(parsed.name);
    if (agents.has(key)) continue;
    const model = parsed.modelSelection?.modelId;
    const dependencies = resolveDependencies(parsed);
    agents.set(key, {
      key,
      name: parsed.name,
      description: model ? `${model} · ${parsed.description}` : parsed.description,
      filePath,
      ...(dependencies ? { dependencies } : {}),
      content,
    });
  }
  return { root, agents };
}

/** 只读展示：状态文件缺失、损坏或不可读时视为全部启用。写入走 updateJsonObjectFile。 */
async function readDisabledAgentIds(options?: SubagentStorageOptions): Promise<Set<string>> {
  try {
    const state = await readAgentStateAtPath(await resolveSubagentStateFile(options));
    return new Set(state.disabledAgentIds);
  } catch {
    return new Set();
  }
}

export function createSubagentDataSyncMethods(
  storageOptions?: SubagentStorageOptions,
): IDataSyncCategoryService<SubagentDataSyncPayload> {
  async function importOne(
    item: DataSyncImportItem,
    payloadItem: SubagentDataSyncPayload["items"][number] | undefined,
    root: string,
    current: Map<string, ResolvedUserSubagent>,
  ): Promise<DataSyncImportResultItem & { createdPath?: string }> {
    const failed = (error: string) => ({ key: item.key, status: "failed" as const, error });
    if (!payloadItem) return failed("subagent is missing from the sync payload");
    if (!AGENT_FILE_NAME.test(payloadItem.fileName)) {
      return failed(`invalid subagent file name: ${payloadItem.fileName}`);
    }
    const content = Buffer.from(payloadItem.content);
    const parsed = parseSubagentMarkdown({
      content: content.toString("utf-8"),
      path: payloadItem.fileName,
      scope: "user",
    }).agent;
    if (!parsed || toSubagentKey(parsed.name) !== item.key) {
      return failed("subagent name does not match the sync key");
    }
    const existing = current.get(item.key);
    try {
      if (item.mode === "createOnly") {
        // 列表加载后目标端出现同名子智能体：不写入，提示刷新后重试。
        if (existing) return { key: item.key, status: "conflict" };
        const targetPath = join(root, payloadItem.fileName);
        if (await pathExists(targetPath))
          return failed(`target path already exists: ${targetPath}`);
        await mkdir(root, { recursive: true });
        await writeFileAtomically(targetPath, content);
        return { key: item.key, status: "created", createdPath: targetPath };
      }
      if (!existing || !item.expectedTargetHash) return { key: item.key, status: "conflict" };
      if (hashContent(existing.content) !== item.expectedTargetHash) {
        return { key: item.key, status: "conflict" };
      }
      // 替换目标端该 name 对应的实际文件（文件名可能与来源不同），不另建新文件。
      const { mode } = await lstat(existing.filePath);
      await writeFileAtomically(existing.filePath, content, mode);
      return { key: item.key, status: "updated" };
    } catch (error) {
      return failed(errorMessage(error));
    }
  }

  return {
    async listSyncItems() {
      const [{ agents }, disabled] = await Promise.all([
        resolveUserSubagents(storageOptions),
        readDisabledAgentIds(storageOptions),
      ]);
      const items: DataSyncListItem[] = [...agents.values()].map((agent) => ({
        key: agent.key,
        name: agent.name,
        description: agent.description,
        signature: { fileCount: 1, totalBytes: agent.content.byteLength },
        // 单个 markdown 文件，列表时已读入字节，哈希直接返回，比较时不再单独请求。
        contentHash: hashContent(agent.content),
        path: agent.filePath,
        enabled: !disabled.has(toUserAgentStateId(agent.key)),
        ...(agent.dependencies ? { dependencies: agent.dependencies } : {}),
      }));
      return { items, homeDir: resolveUserHomeDir(storageOptions) };
    },

    async getSyncContentHashes(params) {
      const { agents } = await resolveUserSubagents(storageOptions);
      const hashes: Record<string, string> = {};
      for (const key of params.keys) {
        const agent = agents.get(key);
        if (agent) hashes[key] = hashContent(agent.content);
      }
      return { hashes };
    },

    async checkSyncWriteAccess() {
      return await checkRemoteSyncDirectoryWriteAccess(
        await resolveUserSubagentRoot(storageOptions),
      );
    },

    async exportSyncItems(params) {
      const [{ agents }, disabled] = await Promise.all([
        resolveUserSubagents(storageOptions),
        readDisabledAgentIds(storageOptions),
      ]);
      return {
        sourceHomeDir: resolveUserHomeDir(storageOptions),
        items: params.keys.map((key) => {
          const agent = agents.get(key);
          if (!agent) throw new Error(`subagent sync item not found: ${key}`);
          return {
            key,
            name: agent.name,
            fileName: basename(agent.filePath),
            content: new Uint8Array(agent.content),
            enabled: !disabled.has(toUserAgentStateId(key)),
          };
        }),
      };
    },

    async importSyncItems(params) {
      // 目标端同样先迁移再计算哈希，与列表时给出的 expectedTargetHash 口径一致。
      const { root, agents } = await resolveUserSubagents(storageOptions);
      const payloadByKey = new Map(params.payload.items.map((item) => [item.key, item]));
      const results: Array<DataSyncImportResultItem & { createdPath?: string }> = [];
      for (const item of params.items) {
        results.push(await importOne(item, payloadByKey.get(item.key), root, agents));
      }
      await applyCreatedEnabledState(results, payloadByKey, storageOptions);
      return { results: results.map(({ createdPath: _createdPath, ...result }) => result) };
    },
  };
}

/**
 * 启用状态：新建项带上来源的禁用状态（`agents-state.json` 的 disabledAgentIds，键按 name，不用换算路径）；
 * 更新项不动，保留目标端状态。内置 / 插件智能体的模型覆盖属于本机状态，不读也不写。
 * 状态文件写入失败（例如文件损坏）时删除本次需要改状态的新建项并标为失败，避免远端出现状态不对的子智能体。
 *
 * 只处理来源状态与目标状态不一致的新建项（来源禁用→加入，来源启用→删除），与 command/skill 分类一致：
 * 来源启用的新建项遇到目标端残留的同名禁用 ID 时不再被错误地留在禁用态。状态文件损坏时按全部启用读取，
 * 来源启用的新建项不写、照常新建。
 */
async function applyCreatedEnabledState(
  results: Array<DataSyncImportResultItem & { createdPath?: string }>,
  payloadByKey: Map<string, SubagentDataSyncPayload["items"][number]>,
  options?: SubagentStorageOptions,
): Promise<void> {
  const currentDisabled = await readDisabledAgentIds(options);
  const entries = results.flatMap((result) => {
    if (result.status !== "created" || !result.createdPath) return [];
    const id = toUserAgentStateId(result.key);
    const disabled = payloadByKey.get(result.key)?.enabled === false;
    return disabled === currentDisabled.has(id) ? [] : [{ result, id, disabled }];
  });
  if (entries.length === 0) return;
  const stateFile = await resolveSubagentStateFile(options);
  try {
    await updateJsonObjectFile(stateFile, (state) => {
      const disabledIds = new Set(
        Array.isArray(state.disabledAgentIds)
          ? state.disabledAgentIds.filter((id): id is string => typeof id === "string")
          : [],
      );
      for (const { id, disabled } of entries) {
        if (disabled) disabledIds.add(id);
        else disabledIds.delete(id);
      }
      return { ...state, disabledAgentIds: [...disabledIds].sort() };
    });
  } catch (error) {
    for (const { result } of entries) {
      await rm(result.createdPath!, { force: true });
      result.status = "failed";
      result.error = errorMessage(error);
    }
  }
}
