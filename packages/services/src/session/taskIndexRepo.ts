import { TaskGroupRepository } from "#src/task-groups/index.js";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- task 索引仓库集中维护 sqlite schema、查询和状态写入，迁移稳定后再按读写职责拆分。 */
import { mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  LEGACY_NIBI_AGENT_PROVIDER,
  normalizeAgentProviderToNibiAgent,
  nibiTaskMetaSchema,
  resolveWorkspaceKey,
  type NibiProvider,
  type NibiTaskMeta,
} from "@nibi/shared";
import type {
  NibiTaskListQuery,
  NibiTaskListResult,
  NibiTaskListItem,
} from "#src/session/nibiTaskListTypes.js";

import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getTasksIndexDatabasePath, getNibiDataRootDir } from "#src/paths.js";
import { projectStorage, type ProjectMigrationContext } from "#src/project-storage/index.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

function appendNibiAgentIndexedProviderFilter(
  where: string[],
  args: Array<string | number>,
  provider: NibiProvider,
): void {
  // Nibi Agent 列表入口只展示当前 runtime 产生的 task；旧 lane 值在迁移完成前继续可见。
  where.push("(provider = ? OR provider = ?)");
  args.push(provider, LEGACY_NIBI_AGENT_PROVIDER);
}
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;
type SQLInputValue = import("node:sqlite").SQLInputValue;

interface TaskIndexRow {
  cli_title?: string | null;
  cli_title_source?: string | null;
  cli_created_at?: number | null;
  cli_updated_at?: number | null;
  cli_last_outcome?: "completed" | "interrupted" | "error" | null;
  cli_deleted?: number | null;
  handoff_pending?: number;

  workspace_key: string;
  workspace_path: string;
  workspace_identity: string | null;
  task_id: string;
  title: string;
  task_status: string | null;
  provider: string | null;
  mode: string;
  model: string | null;
  migration_source: string | null;
  forked_from_task_id: string | null;
  cron_automation_id: string | null;
  created_at: number;
  updated_at: number;
  unread_at: number | null;
  last_unread_at: number;
  pinned: number;
  archived: number;
  deleted: number;
  title_overridden: number;
  searchable_text: string;
  meta_json: string;
}

interface LegacyAcpTaskIndexRow extends TaskIndexRow {
  acp_session_id: string | null;
}

interface TaskIndexWriteRecord {
  meta: NibiTaskMeta;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  titleOverridden: boolean;
}

interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  unreadAt?: number;
}

// 关键业务逻辑：聊天内容搜索只需要可匹配文本，不需要把完整超长会话无限塞进 sqlite 索引。
// 这里做上限截断，避免长任务把 tasks-index.sqlite 放大到影响启动和列表查询。
const TASK_SEARCH_SNIPPET_PREFIX_RADIUS = 20;
const TASK_SEARCH_SNIPPET_SUFFIX_RADIUS = 72;
const TASK_SEARCH_SNIPPET_MAX_CHARS = 140;
const TASK_SEARCH_SNIPPET_LIMIT = 4;
const logger = createServiceLogger("task-index-repo");

function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
  return resolveWorkspaceKey(params);
}

function resolveTaskIndexRowWorkspaceIdentity(row: TaskIndexRow): string | undefined {
  const columnIdentity = row.workspace_identity?.trim();
  if (columnIdentity === row.workspace_key) {
    return columnIdentity;
  }
  // workspace_key 是 SQLite 查询与主键隔离的真实依据；只要它是统一格式的远端 identity，
  // 返回值就必须与它一致，不能让残留的 workspace_identity 列把实体投影到另一个远端。
  if (isRemoteWorkspaceIdentity(row.workspace_key)) {
    return row.workspace_key;
  }
  // identity 投影与主键不一致时不能采用，也不能把远端实体退回 workspacePath，
  // 否则相同路径的不同远端会在侧栏 activity join 时串行。
  return undefined;
}

/**
 * Host 为 createSession 预留归属时写入的占位行：只有 workspace/task 主键，没有任何 CLI 事实。
 *
 * `cli_created_at` 只由 syncer 的 CLI 事实写入；`created_at<=0` 是 reserveCreatedTask 的固定占位值。
 * 这类行不是用户会话：列表/清理计数必须跳过，只有在 CLI 明确确认会话不存在（reconcile
 * orphan）或磁盘会话库可确定且无该 ID 后才能自愈删除。
 */
function isUnmaterializedTaskRow(
  row: Pick<TaskIndexRow, "created_at" | "cli_created_at">,
): boolean {
  return row.cli_created_at == null && row.created_at <= 0;
}

/**
 * 列表/项目计数只接受真实会话：CLI 事实必须存在，且 meta_json 不能是空事实。
 *
 * - 旧版 NULL/空串 meta 按展示字段缺省处理（历史 CLI 行可能从未写 meta）；
 * - `'{}'` 是列默认值/占位行遗留的空事实，没有任何会话字段，不能进入列表；
 * - 解析失败或非对象是损坏数据，跳过；
 * - 带字段的部分旧 meta 仍算 legacy（字段缺省由行/展示层补齐），避免隐藏历史会话。
 *
 * 占位行（created_at<=0 且没有 cli_created_at）始终不可列举；它们仍参与 CLI 对账
 * 与启动自愈。
 */
function isListableTaskRow(
  row: Pick<TaskIndexRow, "created_at" | "cli_created_at" | "meta_json">,
): boolean {
  if (isUnmaterializedTaskRow(row)) return false;
  if (row.cli_created_at == null || row.cli_created_at <= 0) return false;
  if (typeof row.meta_json !== "string" || row.meta_json.trim() === "") return true;
  try {
    const parsed: unknown = JSON.parse(row.meta_json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.keys(parsed).length > 0
      : false;
  } catch {
    return false;
  }
}

function rowToMeta(row: TaskIndexRow): NibiTaskMeta {
  const meta = readPresentation(row);
  return {
    ...meta,
    title: row.title_overridden === 1 ? row.title : (row.cli_title ?? ""),
    titleOverridden: row.title_overridden === 1 || row.cli_title_source === "custom",
    createdAt: row.cli_created_at ?? 0,
    updatedAt: row.cli_updated_at ?? 0,
    status:
      row.cli_last_outcome === "interrupted" ? "completed" : (row.cli_last_outcome ?? undefined),
  };
}

function readPresentation(row: TaskIndexRow): NibiTaskMeta {
  const workspaceIdentity = resolveTaskIndexRowWorkspaceIdentity(row);
  // 预留占位行的 meta_json 是列默认值 '{}'，不是损坏数据；对账会周期性读取它们，
  // 不能每轮都按非法 meta 打 warn（历史日志曾因此成片刷屏）。
  const unmaterialized = isUnmaterializedTaskRow(row);
  try {
    const parsed = nibiTaskMetaSchema.safeParse(JSON.parse(row.meta_json));
    if (parsed.success) {
      return {
        ...(parsed.data as NibiTaskMeta),
        // SQLite 使用这些字段查询并隔离实体，旧 meta_json 里的 identity
        // 可能缺失或属于旧远端。读取时必须与行主键投影一致，sessions-index 才能
        // 按 workspaceKey + taskId 附加 running activity。
        taskId: row.task_id,
        workspacePath: row.workspace_path,
        workspaceIdentity,
        // unread 是 tasks-index 产品壳状态；标量列必须覆盖可能来自其他 Host 的旧 meta_json。
        unreadAt: row.unread_at ?? undefined,
        // cron 身份以 meta_json 为准；cron_automation_id 列是索引投影，仅作兜底：
        // 历史行 meta_json 里可能还没有该字段，回退读列，下次写入会自动回填进 meta_json。
        cronAutomationId: parsed.data.cronAutomationId ?? row.cron_automation_id ?? undefined,
        titleOverridden: row.title_overridden === 1,
      };
    }
    if (!unmaterialized) {
      logger.warn(
        undefined,
        `读取 task index meta_json 非法 taskId=${row.task_id}`,
        parsed.error.flatten(),
      );
    }
  } catch (error) {
    if (!unmaterialized) {
      logger.warn(undefined, `读取 task index meta_json 失败 taskId=${row.task_id}`, error);
    }
  }

  return {
    taskId: row.task_id,
    traceId: `nibi-${row.task_id}`,
    title: "",
    titleOverridden: row.title_overridden === 1,
    workspacePath: row.workspace_path,
    workspaceIdentity,
    createdAt: 0,
    updatedAt: 0,
    mode: row.mode as NibiTaskMeta["mode"],
    model: row.model ?? undefined,
    // 旧行 provider 列可能残留三方 CLI 值；meta 回退投影时统一归一为 nibi-agent。
    provider: row.provider
      ? normalizeAgentProviderToNibiAgent(row.provider as NibiTaskMeta["provider"])
      : undefined,
    migrationSource: (row.migration_source as NibiTaskMeta["migrationSource"]) ?? undefined,
    forkedFromTaskId: row.forked_from_task_id ?? undefined,
    cronAutomationId: row.cron_automation_id ?? undefined,
    unreadAt: row.unread_at ?? undefined,
  };
}

/** 序列化 meta 到 meta_json。cron 身份随 meta 一起写入（单一来源），另在 writeRecord 投影到 cron_automation_id 索引列。 */
function serializeMetaJson(meta: NibiTaskMeta): string {
  return JSON.stringify(meta);
}

function normalizeLimit(limit: number | undefined): number | null {
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : null;
}

function normalizeWorkspaceKeys(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): string[] {
  return [
    ...new Set(scopes.map((scope) => workspaceKey(scope)).filter((key) => key.trim().length > 0)),
  ].sort((left, right) => left.localeCompare(right));
}

function normalizeSearchSnippetText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TASK_SEARCH_SNIPPET_MAX_CHARS);
}

// 全局会话搜索 (TaskSearchDialog) 期望命中正文时返回若干片段做摘要展示。
// 以匹配点为中心截窗，去重相近窗口，最多 4 条；
// 全部未命中（title 命中）时回退一条整段摘要，避免下方空白。
function buildSearchSnippets(searchableText: string, search: string | null): string[] {
  if (!search || !searchableText.trim()) {
    return [];
  }

  const normalizedSearch = search.toLocaleLowerCase();
  const normalizedText = searchableText.toLocaleLowerCase();
  const snippets: string[] = [];
  const snippetRanges: Array<{ start: number; end: number }> = [];
  let searchStart = 0;

  while (snippets.length < TASK_SEARCH_SNIPPET_LIMIT && searchStart < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedSearch, searchStart);
    if (matchIndex < 0) {
      break;
    }

    const start = Math.max(0, matchIndex - TASK_SEARCH_SNIPPET_PREFIX_RADIUS);
    const end = Math.min(
      searchableText.length,
      matchIndex + normalizedSearch.length + TASK_SEARCH_SNIPPET_SUFFIX_RADIUS,
    );
    const prefix = start > 0 ? "..." : "";
    const suffix = end < searchableText.length ? "..." : "";
    const snippet = normalizeSearchSnippetText(
      `${prefix}${searchableText.slice(start, end)}${suffix}`,
    );
    const overlapsExistingSnippet = snippetRanges.some(
      (range) => Math.min(range.end, end) - Math.max(range.start, start) > 0,
    );
    // 同一个关键词在很近的位置多次出现时，摘要窗口会高度重叠；服务端先合并近重复摘要。
    if (snippet && !overlapsExistingSnippet) {
      snippets.push(snippet);
      snippetRanges.push({ start, end });
    }
    searchStart = matchIndex + normalizedSearch.length;
  }

  if (snippets.length === 0) {
    // title 命中但正文没命中时，仍给一条整段摘要兜底，避免标题下方空白。
    const fallbackSnippet = normalizeSearchSnippetText(searchableText);
    return fallbackSnippet ? [fallbackSnippet] : [];
  }

  return snippets;
}

function rowToTaskListItem(row: TaskIndexRow, search: string | null): NibiTaskListItem {
  const meta = rowToMeta(row);
  const snippets = buildSearchSnippets(row.searchable_text, search);
  if (snippets.length === 0) {
    return meta;
  }
  return { ...meta, searchSnippet: snippets[0], searchSnippets: snippets };
}

function migrateLegacyTaskMetaJson(
  rawMetaJson: string,
  fallback: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    mode: string;
    provider?: string;
    model?: string;
    status?: NibiTaskMeta["status"];
  },
): NibiTaskMeta {
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(rawMetaJson) as unknown;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  const meta = {
    ...parsed,
    taskId: fallback.taskId,
    traceId:
      typeof parsed.traceId === "string" && parsed.traceId
        ? parsed.traceId
        : `nibi-${fallback.taskId}`,
    title: fallback.title,
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity,
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : fallback.createdAt,
    updatedAt: fallback.updatedAt,
    mode: typeof parsed.mode === "string" ? parsed.mode : fallback.mode,
    provider: typeof parsed.provider === "string" ? parsed.provider : fallback.provider,
    model: typeof parsed.model === "string" ? parsed.model : fallback.model,
    status: typeof parsed.status === "string" ? parsed.status : fallback.status,
    migrationSource: undefined,
  };
  return nibiTaskMetaSchema.parse(meta) as NibiTaskMeta;
}

export class TaskIndexRepo {
  /** 启动迁移结果，供 main 提示；不参与任务事实或组织状态。 */
  migrationBackupSkipped = false;
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(
    private readonly migrationSettings?: ProjectMigrationContext["settings"],
    private readonly storageHostId?: string,
    private readonly startupDbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
    /**
     * 只有真正的应用启动入口才开启占位行自愈；测试/惰性副仓库不得清理共享 tasks-index。
     */
    private readonly pruneUnmaterializedOnStartup = false,
    /**
     * CLI 会话库（`session` 表）路径。仅用于启动自愈的磁盘缺席证据：路径不可确定时为
     * undefined，此时只清理已被 CLI 对账确认 orphan 的占位行。测试可传临时库。
     */
    private readonly agentSessionDbPath?: string | null,
  ) {}

  /** Host 装配层共用迁移后的组织库；UI 只能通过 project/remote-projects 服务访问。 */
  private admitTaskGroup(meta: NibiTaskMeta, archived: boolean, deleted: boolean) {
    if (this.storageHostId && this.storageHostId !== "local") return;
    // 本机只登记本机事实；远程成员由控制端服务验证远端投影后写入。
    if (meta.workspaceIdentity?.trim()) return;
    new TaskGroupRepository(this.getDatabase()).admit([
      { ...meta, hostId: "local", archived, deleted },
    ]);
  }

  async getOrganizationDatabase() {
    await this.ensureReady();
    return this.getDatabase();
  }

  async getProjectRepository() {
    await this.ensureReady();
    return projectStorage.repository(this.getDatabase(), this.storageHostId);
  }

  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getTasksIndexDatabasePath();
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
      this.initializePromise = this.initialize(path).catch((error) => {
        // 释放失败连接；迁移后修复可能已部分提交，重试仍走原幂等初始化。
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore close errors
    }
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    this.writeChains.clear();
    if (options?.throwOnError && closeError) throw closeError;
  }

  private async initialize(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      // 多窗口 Host 共用 tasks-index；写事务和首次 schema 升级应短暂等待，而不是立即 SQLITE_BUSY。
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    const taskMigration = await runTasksDatabaseMigrations(this.db, path);
    const migration = await projectStorage.migrate(this.getDatabase(), {
      settings: this.migrationSettings,
      hostId: this.storageHostId,
      backupDirectories: [join(getNibiDataRootDir(), "backup")],
      warn: (message, details) => createServiceLogger("project-migration").warn(message, details),
    });
    this.migrationBackupSkipped = taskMigration.backupSkipped || migration.backupSkipped;
    // Bugfix: z-code-2 早期列表 task_id 是 wrapper id，真实 Nibi session id 在旧列
    // acp_session_id。直接运行时映射会让 read/send/subscribe 到处变成双 ID 兜底；
    // 初始化时把索引行迁到真实 session id，后续统一走新协议正常路径。
    this.migrateLegacyAcpTaskIds();
    if (this.pruneUnmaterializedOnStartup) await this.pruneUnmaterializedOrphanRows();
  }

  /**
   * 启动自愈：删除已被证明没有对应 CLI 会话的创建占位行。
   *
   * 写入方是 reserveCreatedTask（createSession 先占项目归属）。draft prewarm 的会话只在
   * CLI 内存中存在（v4 createSession 初始 persistence=deferred），正常回收会发
   * deleteSession；进程崩溃/旧版本会让占位行永远留着。
   *
   * 两条删除证据：
   * 1. handoff_pending orphan bit 只由 task-facts 在 CLI reconcile 明确返回 exists=false 时写入；
   * 2. 可确定的 CLI 会话库已能打开，但该 taskId 在 `session` 表不存在——旧版本遗留的
   *    draft 占位行没有 orphan 标记，也不会再触发对账，只能靠磁盘事实清理。
   *
   * 无法确定会话库（相对路径/project 覆盖/打不开）时只按 orphan 证据清理，宁可少删。
   * 有 cli_created_at 的行哪怕 orphan 也保留（tombstone 是用户数据）。
   */
  private async pruneUnmaterializedOrphanRows(): Promise<number> {
    const db = this.getDatabase();
    const rows = db
      .prepare(
        `SELECT workspace_key, task_id, created_at, cli_created_at, handoff_pending
        FROM tasks
        WHERE cli_created_at IS NULL
          AND created_at <= 0
          AND (handoff_pending & 3) = 0`,
      )
      .all() as Array<{
      workspace_key: string;
      task_id: string;
      created_at: number;
      cli_created_at: number | null;
      handoff_pending: number;
    }>;
    if (rows.length === 0) return 0;
    // cron / 运行历史仍引用的会话 ID 不能因为索引行缺失就清掉投影；保留行，交给引用方处理。
    const referenced = this.readReferencedAutomationSessionIds();
    const persisted = await this.readPersistedAgentSessionIds(rows.map((row) => row.task_id));
    const victims = rows.filter((row) => {
      if (!isUnmaterializedTaskRow(row) || referenced.has(row.task_id)) return false;
      const orphanConfirmed = (row.handoff_pending & 4) !== 0;
      // persisted=null 表示无法取得磁盘证据；此时只信 CLI orphan 结论。
      return orphanConfirmed || (persisted !== null && !persisted.has(row.task_id));
    });
    if (victims.length === 0) return 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      const statement = db.prepare("DELETE FROM tasks WHERE workspace_key=? AND task_id=?");
      for (const row of victims) statement.run(row.workspace_key, row.task_id);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    const orphanConfirmed = victims.filter((row) => (row.handoff_pending & 4) !== 0).length;
    logger.info(undefined, `清理无 CLI 会话的空任务占位行 数量=${victims.length}`, {
      orphanConfirmed,
      diskAbsent: persisted === null ? null : victims.length - orphanConfirmed,
    });
    return victims.length;
  }

  /**
   * 读取 CLI 会话库里真实存在的 session id。
   *
   * 返回 null = 无法确定（未提供路径、库文件不存在/不可读、没有 session 表），调用方
   * 不得据此删除任何行。只读打开并设置 busy_timeout，WAL 中未 checkpoint 的行也可见。
   * 任何异常都降级为 null，启动自愈不能阻断应用启动。
   */
  private async readPersistedAgentSessionIds(ids: string[]): Promise<Set<string> | null> {
    const path = this.agentSessionDbPath?.trim();
    if (!path) return null;
    try {
      const file = await stat(path);
      if (!file.isFile()) return null;
      const sessionDb = new DatabaseSync(path, { readOnly: true });
      try {
        sessionDb.exec("PRAGMA busy_timeout = 2000");
        const hasTable = sessionDb
          .prepare(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='session') AS has",
          )
          .get() as { has?: number } | undefined;
        if (!hasTable?.has) return null;
        const statement = sessionDb.prepare("SELECT 1 FROM session WHERE id = ?");
        const persisted = new Set<string>();
        for (const id of ids) {
          if (statement.get(id)) persisted.add(id);
        }
        return persisted;
      } finally {
        sessionDb.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT：CLI 还没有会话库 = 没有任何持久化会话，但默认路径也可能被自定义配置
      // 覆盖；保守起见仍视为“无法确定”，只走 orphan 证据。
      if (code !== "ENOENT") {
        logger.warn(undefined, "读取 CLI 会话库失败，跳过磁盘占位行自愈", error);
      }
      return null;
    }
  }

  private readReferencedAutomationSessionIds(): Set<string> {
    const db = this.getDatabase();
    const referenced = new Set<string>();
    if (this.hasColumn("automations", "target_task_id")) {
      for (const row of db
        .prepare(
          "SELECT target_task_id AS session_id FROM automations WHERE target_task_id IS NOT NULL",
        )
        .all() as Array<{ session_id: string }>) {
        referenced.add(row.session_id);
      }
    }
    if (this.hasColumn("automation_runs", "session_id")) {
      for (const row of db
        .prepare("SELECT session_id FROM automation_runs WHERE session_id IS NOT NULL")
        .all() as Array<{ session_id: string }>) {
        referenced.add(row.session_id);
      }
    }
    return referenced;
  }

  private hasColumn(table: string, column: string): boolean {
    const columns = this.getDatabase().prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    return columns.some((item) => item.name === column);
  }

  private migrateLegacyAcpTaskIds(): void {
    if (!this.hasColumn("tasks", "acp_session_id")) {
      return;
    }

    const db = this.getDatabase();
    const rows = db
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          acp_session_id,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE acp_session_id IS NOT NULL
          AND trim(acp_session_id) <> ''
          AND trim(acp_session_id) <> task_id`,
      )
      .all() as unknown as LegacyAcpTaskIndexRow[];
    if (rows.length === 0) {
      return;
    }

    const findTarget = db.prepare(
      `SELECT
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        title,
        task_status,
        provider,
        mode,
        model,
        migration_source,
        forked_from_task_id,
        created_at,
        updated_at,
        unread_at,
        last_unread_at,
        pinned,
        archived,
        deleted,
        title_overridden,
        searchable_text,
        meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
      FROM tasks
      WHERE workspace_key = ? AND task_id = ?`,
    );
    const updateRow = db.prepare(
      `UPDATE tasks
      SET task_id = @task_id,
        title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json,
        acp_session_id = NULL
      WHERE workspace_key = @workspace_key AND task_id = @old_task_id`,
    );
    const updateTarget = db.prepare(
      `UPDATE tasks
      SET title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json
      WHERE workspace_key = @workspace_key AND task_id = @task_id`,
    );
    const deleteOld = db.prepare(`DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?`);

    db.exec("BEGIN IMMEDIATE");
    try {
      let migrated = 0;
      for (const row of rows) {
        const nextTaskId = row.acp_session_id?.trim();
        if (!nextTaskId) {
          continue;
        }
        const target = findTarget.get(row.workspace_key, nextTaskId) as TaskIndexRow | undefined;
        const merged = this.buildLegacyAcpMigratedRow(row, target ?? null, nextTaskId);
        if (target) {
          updateTarget.run(merged);
          deleteOld.run(row.workspace_key, row.task_id);
        } else {
          updateRow.run({ ...merged, old_task_id: row.task_id });
        }
        migrated += 1;
      }
      db.exec("COMMIT");
      if (migrated > 0) {
        logger.info(undefined, `已迁移 legacy ACP task_id 到 Nibi session id 数量=${migrated}`);
      }
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private buildLegacyAcpMigratedRow(
    source: LegacyAcpTaskIndexRow,
    target: TaskIndexRow | null,
    taskId: string,
  ): Record<string, SQLInputValue> {
    const sourceMeta = migrateLegacyTaskMetaJson(source.meta_json, {
      taskId,
      workspacePath: source.workspace_path,
      workspaceIdentity: source.workspace_identity ?? undefined,
      title: source.title,
      createdAt: source.created_at,
      updatedAt: source.updated_at,
      mode: source.mode,
      provider: source.provider ?? undefined,
      model: source.model ?? undefined,
      status: source.task_status ? (source.task_status as NibiTaskMeta["status"]) : undefined,
    });
    if (!target) {
      return {
        workspace_key: source.workspace_key,
        task_id: taskId,
        title: source.title,
        task_status: source.task_status,
        provider: source.provider,
        mode: source.mode,
        model: source.model,
        migration_source: null,
        forked_from_task_id: source.forked_from_task_id,
        created_at: source.created_at,
        updated_at: source.updated_at,
        unread_at: source.unread_at,
        last_unread_at: Math.max(source.last_unread_at, source.unread_at ?? 0),
        pinned: source.pinned,
        archived: source.archived,
        deleted: source.deleted,
        title_overridden: source.title_overridden,
        searchable_text: source.searchable_text,
        meta_json: JSON.stringify(sourceMeta),
      };
    }

    const targetMeta = migrateLegacyTaskMetaJson(target.meta_json, {
      ...sourceMeta,
      taskId,
      workspacePath: target.workspace_path,
      workspaceIdentity: target.workspace_identity ?? undefined,
      title: target.title || source.title,
      createdAt: Math.min(target.created_at, source.created_at),
      updatedAt: Math.max(target.updated_at, source.updated_at),
      mode: target.mode || source.mode,
      provider: target.provider ?? source.provider ?? undefined,
      model: target.model ?? source.model ?? undefined,
      status: target.task_status
        ? (target.task_status as NibiTaskMeta["status"])
        : source.task_status
          ? (source.task_status as NibiTaskMeta["status"])
          : undefined,
    });
    const title = source.title_overridden === 1 ? source.title : target.title || source.title;
    const updatedAt = Math.max(target.updated_at, source.updated_at);
    const unreadAt =
      source.unread_at !== null && target.unread_at !== null
        ? Math.max(source.unread_at, target.unread_at)
        : (source.unread_at ?? target.unread_at);
    return {
      workspace_key: source.workspace_key,
      task_id: taskId,
      title,
      task_status: target.task_status ?? source.task_status,
      provider: target.provider ?? source.provider,
      mode: target.mode || source.mode,
      model: target.model ?? source.model,
      migration_source: null,
      forked_from_task_id: target.forked_from_task_id ?? source.forked_from_task_id,
      created_at: Math.min(target.created_at, source.created_at),
      updated_at: updatedAt,
      unread_at: unreadAt,
      last_unread_at: Math.max(source.last_unread_at, target.last_unread_at, unreadAt ?? 0),
      pinned: source.pinned === 1 || target.pinned === 1 ? 1 : 0,
      archived: source.archived === 1 || target.archived === 1 ? 1 : 0,
      deleted: source.deleted === 1 ? 1 : target.deleted,
      title_overridden: source.title_overridden === 1 || target.title_overridden === 1 ? 1 : 0,
      searchable_text: target.searchable_text || source.searchable_text,
      meta_json: JSON.stringify({
        ...targetMeta,
        title,
        updatedAt,
        unreadAt: unreadAt ?? undefined,
        migrationSource: undefined,
      }),
    };
  }

  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      throw new Error("task index sqlite 尚未初始化");
    }
    return this.db;
  }

  private writeKey(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): string {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  private enqueueWrite<T>(
    params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
    operation: () => Promise<T> | T,
  ): Promise<T> {
    const key = this.writeKey(params);
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeChains.set(key, completion);
    void completion.finally(() => {
      if (this.writeChains.get(key) === completion) {
        this.writeChains.delete(key);
      }
    });
    return result;
  }

  private getTaskRow(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): TaskIndexRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .get(workspaceKey(params), params.taskId) as TaskIndexRow | undefined;
    return row ?? null;
  }

  private writeRecord(record: TaskIndexWriteRecord): NibiTaskMeta {
    const database = this.getDatabase();
    const ownTransaction = !database.isTransaction;
    if (ownTransaction) database.exec("BEGIN IMMEDIATE");
    try {
      // 本方法只在预留行首次落 CLI 事实时调用，正文索引与未读 CAS marker 都不归它写：
      // 读一次现有行，ON CONFLICT 时原样保留 searchable_text / unread_at。
      const existing = this.getTaskRow({
        workspacePath: record.meta.workspacePath,
        workspaceIdentity: record.meta.workspaceIdentity,
        taskId: record.meta.taskId,
      });
      const searchableText = existing?.searchable_text ?? "";
      this.getDatabase()
        .prepare(
          `INSERT INTO tasks (
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        ) VALUES (
          @workspace_key,
          @workspace_path,
          @workspace_identity,
          @task_id,
          @title,
          @task_status,
          @provider,
          @mode,
          @model,
          @migration_source,
          @forked_from_task_id,
          @cron_automation_id,
          @created_at,
          @updated_at,
          @unread_at,
          @last_unread_at,
          @pinned,
          @archived,
          @deleted,
          @title_overridden,
          @searchable_text,
          @meta_json
        )
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          title = excluded.title,
          task_status = excluded.task_status,
          provider = excluded.provider,
          mode = excluded.mode,
          model = excluded.model,
          migration_source = excluded.migration_source,
          forked_from_task_id = excluded.forked_from_task_id,
          cron_automation_id = excluded.cron_automation_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          unread_at = tasks.unread_at,
          last_unread_at = MAX(tasks.last_unread_at, COALESCE(tasks.unread_at, 0)),
          pinned = excluded.pinned,
          archived = excluded.archived,
          deleted = excluded.deleted,
          title_overridden = excluded.title_overridden,
          searchable_text = excluded.searchable_text,
          meta_json = excluded.meta_json`,
        )
        .run({
          workspace_key: workspaceKey(record.meta),
          workspace_path: record.meta.workspacePath,
          workspace_identity: record.meta.workspaceIdentity ?? null,
          task_id: record.meta.taskId,
          title: record.meta.title,
          task_status: record.meta.status ?? null,
          provider: record.meta.provider ?? null,
          mode: record.meta.mode,
          model: record.meta.model ?? null,
          migration_source: record.meta.migrationSource ?? null,
          forked_from_task_id: record.meta.forkedFromTaskId ?? null,
          // cron automation 身份从 meta 投影到索引列（meta_json 里也保留一份，见 serializeMetaJson）。
          cron_automation_id: record.meta.cronAutomationId ?? null,
          created_at: record.meta.createdAt,
          updated_at: record.meta.updatedAt,
          unread_at: record.meta.unreadAt ?? null,
          last_unread_at: record.meta.unreadAt ?? 0,
          pinned: record.pinned ? 1 : 0,
          archived: record.archived ? 1 : 0,
          deleted: record.deleted ? 1 : 0,
          title_overridden: record.titleOverridden ? 1 : 0,
          searchable_text: searchableText,
          meta_json: serializeMetaJson(record.meta),
        });
      projectStorage.admitTaskIdentity(database, record.meta, this.storageHostId);
      if (record.titleOverridden)
        database
          .prepare(
            "UPDATE tasks SET handoff_pending=handoff_pending | 2 WHERE workspace_key=? AND task_id=? AND cli_title_source IS NULL",
          )
          .run(workspaceKey(record.meta), record.meta.taskId);

      const persisted = this.getTaskRow(record.meta);
      if (!persisted) {
        throw new Error(`task index 写入后缺少 task: ${record.meta.taskId}`);
      }
      this.admitTaskGroup(rowToMeta(persisted), persisted.archived === 1, persisted.deleted === 1);
      if (ownTransaction) database.exec("COMMIT");
      return rowToMeta(persisted);
    } catch (error) {
      if (ownTransaction && database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }

  async listReconciliationRows(target: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<
    Array<{ meta: NibiTaskMeta; handoffPending: number; unmaterialized?: boolean }>
  > {
    await this.ensureReady();
    const rows = this.getDatabase()
      .prepare("SELECT * FROM tasks WHERE workspace_key=?")
      .all(workspaceKey(target)) as unknown as TaskIndexRow[];
    return rows.map((row) => ({
      meta: rowToMeta(row),
      handoffPending: row.handoff_pending ?? 0,
      // 占位行仍要参与第一次对账（拿到 CLI 缺席证据后才能自愈删除），
      // 但调用方不能把它当成用户会话广播或计数。
      unmaterialized: isUnmaterializedTaskRow(row),
    }));
  }

  /** CLI 确认 child 后移除旧版本误建的派生行，不修改会话正文或 CLI deleted。 */
  async removeSubagentIndexRow(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      this.getDatabase()
        .prepare("DELETE FROM tasks WHERE workspace_key=? AND task_id=?")
        .run(workspaceKey(target), target.taskId);
    });
  }

  async markCliOrphan(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      this.getDatabase()
        .prepare(
          "UPDATE tasks SET handoff_pending=handoff_pending | 4 WHERE workspace_key=? AND task_id=?",
        )
        .run(workspaceKey(target), target.taskId);
    });
  }

  /**
   * 删除尚未落任何 CLI 事实的创建占位行。
   *
   * 只允许在两条证据路径调用：CLI 已确认 deleteSession 成功（draft prewarm 回收），
   * 或 task-facts 对账返回 exists=false 且该行此前已被标记 orphan。已有 cli_created_at
   * 的用户会话一律返回 false，不能借清理路径删真实数据。
   */
  async removeUnmaterializedTask(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<boolean> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(target);
        if (!row || !isUnmaterializedTaskRow(row)) {
          db.exec("COMMIT");
          return false;
        }
        const result = db
          .prepare("DELETE FROM tasks WHERE workspace_key=? AND task_id=?")
          .run(workspaceKey(target), target.taskId);
        db.exec("COMMIT");
        return Number(result.changes) > 0;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** task-facts 对账端口：已有 CLI 缺席证据的占位行，条件满足时删除。 */
  async removeUnmaterializedOrphan(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<boolean> {
    return this.removeUnmaterializedTask(target);
  }

  /** 仅 syncer 消费 CLI 明确删除，不以列表缺席推断删除。 */
  async applyCliDeletion(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          "UPDATE tasks SET cli_deleted=1,deleted=1,handoff_pending=handoff_pending & ~1 WHERE workspace_key=? AND task_id=?",
        ).run(workspaceKey(target), target.taskId);
        const row = this.getTaskRow(target);
        if (row) this.admitTaskGroup(rowToMeta(row), row.archived === 1, true);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 仅 syncer 调用：CLI 事实是唯一来源，组织态写者不得合成这些值。 */
  async applyCliFacts(params: {
    meta: NibiTaskMeta;
    titleSource?: string;
    lastOutcome?: "completed" | "interrupted" | "error";
    deleted?: boolean;
  }): Promise<NibiTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params.meta, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = this.getTaskRow(params.meta);
        // 预留行尚无 CLI 事实。首条事实补齐 provider/展示基线，保留预留后发生的组织操作。
        if (!existing || (existing.cli_created_at == null && existing.created_at === 0))
          this.writeRecord({
            meta: {
              ...params.meta,
              ...(existing?.title_overridden === 1 ? { title: existing.title } : {}),
            },
            pinned: existing?.pinned === 1,
            archived: existing?.archived === 1,
            deleted: existing?.deleted === 1,
            titleOverridden: existing?.title_overridden === 1,
          });
        const source = params.titleSource ?? "default";
        db.prepare(`UPDATE tasks SET
          cli_title=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          cli_title_source=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title_source ELSE ? END,
          cli_created_at=?,cli_updated_at=max(coalesce(cli_updated_at,0),?),
          cli_last_outcome=coalesce(?,cli_last_outcome),cli_deleted=max(coalesce(cli_deleted,0),?),
          title=CASE WHEN (handoff_pending & 2)<>0 THEN title WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          title_overridden=CASE WHEN (handoff_pending & 2)<>0 THEN title_overridden WHEN ?='custom' OR cli_title_source='custom' THEN 1 ELSE 0 END,
          updated_at=?,created_at=?,task_status=coalesce(?,task_status),deleted=max(deleted,?),
          handoff_pending=(handoff_pending & ~4) & CASE WHEN ?=1 THEN ~1 ELSE -1 END & CASE WHEN ?=title AND ?='custom' THEN ~2 ELSE -1 END
          WHERE workspace_key=? AND task_id=?`).run(
          source,
          params.meta.title,
          source,
          source,
          params.meta.createdAt,
          params.meta.updatedAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          source,
          params.meta.title,
          source,
          params.meta.updatedAt,
          params.meta.createdAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          params.deleted ? 1 : 0,
          params.meta.title,
          source,
          workspaceKey(params.meta),
          params.meta.taskId,
        );
        const persisted = this.getTaskRow(params.meta)!;
        this.admitTaskGroup(
          rowToMeta(persisted),
          persisted.archived === 1,
          persisted.deleted === 1,
        );
        db.exec("COMMIT");
        return rowToMeta(persisted);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: NibiTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        // 旧库补列时 watermark 默认为 0；清除前必须吸收现存 marker，避免重启后时钟回拨复用旧值。
        const updated = db
          .prepare(
            "UPDATE tasks SET last_unread_at=max(last_unread_at,unread_at),unread_at=NULL WHERE workspace_key=? AND task_id=? AND deleted=0 AND unread_at=?",
          )
          .run(workspaceKey(params), params.taskId, params.expectedUnreadAt);
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1)
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        db.exec("COMMIT");
        return { meta: rowToMeta(row), cleared: Number(updated.changes) > 0 };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<NibiTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        // 确认框可能停留期间被另一端恢复；归档检查必须与 tombstone 写入同事务，
        // 不能先读后删。已删除/不存在也跳过，避免重试从 CLI seed 后复活。
        if (!row || row.deleted === 1 || row.archived !== 1) {
          database.exec("COMMIT");
          return null;
        }
        const meta = this.writeRecord({
          meta: rowToMeta(row),
          pinned: row.pinned === 1,
          archived: true,
          deleted: true,
          titleOverridden: row.title_overridden === 1,
        });
        // 删除事实交给 CLI；持久化意图使中途断线后仍可按既有 handoff 对账完成。
        database
          .prepare(
            "UPDATE tasks SET handoff_pending=handoff_pending | 1 WHERE workspace_key=? AND task_id=?",
          )
          .run(row.workspace_key, row.task_id);
        database.exec("COMMIT");
        return meta;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<NibiTaskMeta> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1)
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        const hasUnread = "unreadAt" in params.patch;
        // marker 的 watermark 在清除后仍保留；旧手机 CAS 不能清除同毫秒内的新未读。
        const unread =
          typeof params.patch.unreadAt === "number"
            ? Math.max(params.patch.unreadAt, row.last_unread_at + 1, (row.unread_at ?? 0) + 1)
            : null;
        db.prepare(`UPDATE tasks SET pinned=coalesce(?,pinned),archived=coalesce(?,archived),
          unread_at=CASE WHEN ? THEN ? ELSE unread_at END,
          last_unread_at=max(last_unread_at,coalesce(?,0)) WHERE workspace_key=? AND task_id=?`).run(
          params.patch.pinned === undefined ? null : Number(params.patch.pinned),
          params.patch.archived === undefined ? null : Number(params.patch.archived),
          Number(hasUnread),
          unread,
          hasUnread ? unread : null,
          workspaceKey(params),
          params.taskId,
        );
        const result = rowToMeta(this.getTaskRow(params)!);
        this.admitTaskGroup(result, row.archived === 1, row.deleted === 1);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  /** 展示缓存不接受 title/time/status/deleted；CLI 事实由独立端口写入。 */
  async updateTaskPresentation(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    presentation: Partial<
      Pick<
        NibiTaskMeta,
        | "mode"
        | "model"
        | "thoughtLevel"
        | "lastError"
        | "target"
        | "migrationSource"
        | "cronAutomationId"
      >
    >;
    searchableText?: string;
  }): Promise<NibiTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row) {
          db.exec("COMMIT");
          return null;
        }
        const meta = { ...rowToMeta(row), ...params.presentation };
        this.getDatabase()
          .prepare(
            `UPDATE tasks SET mode=?,model=?,migration_source=?,cron_automation_id=?,meta_json=?,searchable_text=coalesce(?,searchable_text) WHERE workspace_key=? AND task_id=?`,
          )
          .run(
            meta.mode,
            meta.model ?? null,
            meta.migrationSource ?? null,
            meta.cronAutomationId ?? null,
            serializeMetaJson(meta),
            params.searchableText ?? null,
            workspaceKey(params),
            params.taskId,
          );
        const result = rowToMeta(this.getTaskRow(params)!);
        this.admitTaskGroup(result, row.archived === 1, row.deleted === 1);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: NibiProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  }): Promise<NibiTaskMeta[]> {
    await this.ensureReady();
    // listTaskMetas 支持不传 workspacePath 查询全部任务，但 workspaceKey 只接受必填路径。
    // 先把可选入参收窄成明确的 workspace target，避免类型层把全量查询和 workspace 查询混在一起。
    const targetWorkspaceKey = params.workspacePath
      ? workspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })
      : null;
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
          AND cli_created_at IS NOT NULL
          AND (@include_deleted = 1 OR (deleted = 0 AND coalesce(cli_deleted,0) = 0))
          -- 旧 lane 值在迁移完成前继续可见；Claude Code 等非 Nibi 导入仍被过滤。
          AND (@provider IS NULL OR provider = @provider OR provider = 'glm')
          AND (@pinned IS NULL OR pinned = @pinned)
          AND (@archived IS NULL OR archived = @archived)
        ORDER BY cli_updated_at DESC, cli_created_at DESC, task_id DESC`,
      )
      .all({
        workspace_key: targetWorkspaceKey,
        include_deleted: params.includeDeleted ? 1 : 0,
        provider: params.provider ?? null,
        pinned: typeof params.pinned === "boolean" ? (params.pinned ? 1 : 0) : null,
        archived: typeof params.archived === "boolean" ? (params.archived ? 1 : 0) : null,
      }) as unknown as TaskIndexRow[];
    return rows.filter(isListableTaskRow).map(rowToMeta);
  }

  /**
   * 读取 workspace 下的删除 tombstone。
   *
   * CLI session store 会继续保留会话内容；如果列表 join 只读取 active/pinned/archived，
   * deleted task 会因“不在 archived 集合”被误判成普通 task，并在冷启动后重新出现。
   */
  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: NibiProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    const workspaceKeyValue = workspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const rows = this.getDatabase()
      .prepare(
        `SELECT task_id
        FROM tasks
        WHERE workspace_key = @workspace_key
          AND deleted = 1
          AND (@provider IS NULL OR provider = @provider OR provider = 'glm')
        ORDER BY task_id`,
      )
      .all({
        workspace_key: workspaceKeyValue,
        provider: params.provider ?? null,
      }) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  async queryTaskList(
    params: NibiTaskListQuery & { provider?: NibiProvider },
  ): Promise<NibiTaskListResult> {
    await this.ensureReady();
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    if (workspaceKeys.length === 0) {
      return { items: [], total: 0, hasMore: false };
    }

    const search = params.search?.trim();
    const normalizedSearchLike =
      search && search.length > 0 ? `%${search.toLocaleLowerCase()}%` : null;
    const where = [
      "deleted = 0",
      "coalesce(cli_deleted,0) = 0",
      "cli_created_at IS NOT NULL",
      `workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`,
    ];
    const args: Array<string | number> = [...workspaceKeys];
    if (params.provider) {
      appendNibiAgentIndexedProviderFilter(where, args, params.provider);
    }
    if (params.kind === "pinned") {
      where.push("pinned = 1", "archived = 0");
    } else if (params.kind === "archived") {
      where.push("archived = 1");
    } else {
      where.push("pinned = 0", "archived = 0");
    }
    if (normalizedSearchLike) {
      // 之前只按 title 模糊匹配，没有命中聊天正文；TaskSearchDialog 长期搜不到内容。
      // 现在 title 或 searchable_text 任一命中即视为匹配，正文摘要在结果阶段构建。
      where.push(
        "(LOWER(CASE WHEN title_overridden=1 THEN title ELSE cli_title END) LIKE ? OR LOWER(searchable_text) LIKE ?)",
      );
    }

    if (normalizedSearchLike) {
      args.push(normalizedSearchLike, normalizedSearchLike);
    }
    const whereClause = where.join(" AND ");

    const limit = normalizeLimit(params.limit);
    const orderBy =
      params.sortBy === "created"
        ? "cli_created_at DESC, cli_updated_at DESC, task_id DESC"
        : "cli_updated_at DESC, cli_created_at DESC, task_id DESC";
    const rows = (
      this.getDatabase()
        .prepare(
          `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE ${whereClause}
        ORDER BY ${orderBy}`,
        )
        .all(...args) as unknown as TaskIndexRow[]
    ).filter(isListableTaskRow);
    // 非法 meta / 占位行必须在分页前剔除：否则 total 与 items 会包含幽灵会话，
    // 而 SQL LIMIT 又会让“跳过”表现为该页凭空变短。
    const total = rows.length;
    const pageRows = limit === null ? rows : rows.slice(0, limit);
    const workspacePurposeByKey = new Map(
      params.workspaceScopes.flatMap((scope) =>
        scope.workspacePurpose ? [[workspaceKey(scope), scope.workspacePurpose] as const] : [],
      ),
    );

    return {
      items: pageRows.map((row) => {
        const item = rowToTaskListItem(row, search ?? null);
        const workspacePurpose = workspacePurposeByKey.get(row.workspace_key);
        return workspacePurpose ? { ...item, workspacePurpose } : item;
      }),
      total,
      hasMore: total > pageRows.length,
    };
  }

  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<NibiTaskMeta | null> {
    await this.ensureReady();
    const row = this.getTaskRow(params);
    // 显式按 ID 查询也不能把占位行/损坏 meta 当成会话返回；调用方据此决定
    // 是否广播、建目录或显示 0 B 会话。
    if (!row || row.deleted === 1 || !isListableTaskRow(row)) {
      return null;
    }
    return rowToMeta(row);
  }
}
