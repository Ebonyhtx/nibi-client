import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  SESSION_TASK_TYPES,
  SessionDeletionError,
  type ClaimLegacySessionWorkspaceInput,
  type CreateSessionInput,
  type FileDiff,
  type ListSessionsInput,
  type RepairLegacyRemoteSessionWorkspaceInput,
  type RepairRemoteSessionPathsInput,
  type SessionArtifactReference,
  type SessionDeletionBeginInput,
  type SessionDeletionBeginOutcome,
  type SessionDeletionScope,
  type SessionDeletionStamp,
  type SessionDeletionTitledSession,
  type SessionId,
  type SessionInfo,
  type SessionRevert,
  type UpdateSessionInput,
  type SessionTaskType,
} from "@nibi/contracts";
import { decodeSessionRow } from "../codecs.js";
import { encodeJson } from "../json.js";
import type { SessionRow } from "../rows.js";

export function createSession(db: DatabaseSync, input: CreateSessionInput): SessionInfo {
  const now = Date.now();
  const timeCreated = input.time?.created ?? now;
  const timeUpdated = input.time?.updated ?? timeCreated;

  try {
    db.prepare(
      `
      insert into session (
        id, project_id, workspace_id, parent_id, trace_id, task_type, slug, directory, path,
        title, title_source, title_message_id, version,
        share_url, summary_additions, summary_deletions, summary_files, summary_diffs,
        revert, permission, time_created, time_updated, time_title_updated,
        time_compacting
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, null, null, ?, ?, ?, ?, null)
      on conflict(id) do update set
        project_id = excluded.project_id,
        workspace_id = excluded.workspace_id,
        parent_id = excluded.parent_id,
        trace_id = coalesce(session.trace_id, excluded.trace_id),
        task_type = excluded.task_type,
        slug = excluded.slug,
        directory = excluded.directory,
        path = excluded.path,
        title = excluded.title,
        title_source = excluded.title_source,
        title_message_id = excluded.title_message_id,
        version = excluded.version,
        share_url = excluded.share_url,
        permission = coalesce(excluded.permission, session.permission),
        time_title_updated = excluded.time_title_updated,
        time_updated = excluded.time_updated
      `,
    ).run(
      input.id,
      input.projectID,
      input.workspaceID ?? null,
      input.parentID ?? null,
      input.traceID ?? null,
      input.taskType ?? "interactive",
      input.slug,
      input.directory,
      input.path ?? null,
      input.title,
      input.titleSource ?? "first_input",
      input.titleMessageID ?? null,
      input.version,
      input.shareURL ?? null,
      encodeJson(input.permission),
      timeCreated,
      timeUpdated,
      input.titleSource || input.titleMessageID ? timeUpdated : null,
    );
  } catch (error) {
    throw mapSessionDeletionError(error);
  }

  return mustGetSession(db, input.id);
}

export async function updateSession(
  db: DatabaseSync,
  input: UpdateSessionInput,
): Promise<SessionInfo> {
  const fields: string[] = [];
  const values: SQLInputValue[] = [];
  const set = (column: string, value: SQLInputValue | undefined) => {
    if (value === undefined) return;
    fields.push(`${column} = ?`);
    values.push(value);
  };
  // Bug 根因：先读整行再 await 会用旧快照覆盖并发标题、权限和结果；只更新本次输入拥有的列。
  set("directory", input.directory);
  set("path", input.path);
  set("title", input.title);
  set("title_source", input.titleSource);
  set("title_message_id", input.titleMessageID);
  set("share_url", input.shareURL);
  set("last_outcome", input.lastOutcome);
  if (input.summary !== undefined) {
    set("summary_additions", input.summary?.additions ?? null);
    set("summary_deletions", input.summary?.deletions ?? null);
    set("summary_files", input.summary?.files ?? null);
    set("summary_diffs", encodeJson(input.summary?.diffs));
  }
  if (input.revert !== undefined) set("revert", encodeJson(input.revert));
  if (input.permission !== undefined) set("permission", encodeJson(input.permission));
  set("time_compacting", input.timeCompacting);
  if (
    input.title !== undefined ||
    input.titleSource !== undefined ||
    input.titleMessageID !== undefined
  ) {
    set("time_title_updated", Date.now());
  }
  // 标题及组织态不代表会话活动；活动时间只由消息/终态显式提交，且禁止回退。
  if (input.timeUpdated !== undefined) {
    fields.push("time_updated = max(time_updated, ?)");
    values.push(input.timeUpdated);
  }
  if (fields.length) {
    values.push(input.id);
    const sources = input.title !== undefined ? input.expectedTitleSources : undefined;
    const guard = sources?.length
      ? ` and coalesce(title_source, 'first_input') in (${sources.map(() => "?").join(",")})`
      : "";
    if (sources?.length) values.push(...sources);
    try {
      db.prepare(`update session set ${fields.join(",")} where id=?${guard}`).run(...values);
    } catch (error) {
      throw mapSessionDeletionError(error);
    }
  }
  return mustGetSession(db, input.id);
}

export function softDeleteSession(
  db: DatabaseSync,
  sessionID: SessionId,
  timeDeleted: number,
): void {
  // 软删除保持幂等，并保留 message/part 及活动时间；旧 create/upsert 不能清除此字段。
  db.prepare("update session set time_deleted = coalesce(time_deleted, ?) where id = ?").run(
    timeDeleted,
    sessionID,
  );
}

export function getSession(db: DatabaseSync, sessionID: SessionId): SessionInfo | null {
  const row = db.prepare("select * from session where id = ?").get(sessionID) as
    | SessionRow
    | undefined;
  return row ? decodeSessionRow(row) : null;
}

export async function listSessions(
  db: DatabaseSync,
  input: ListSessionsInput = {},
): Promise<SessionInfo[]> {
  const clauses: string[] = [
    "time_deleted is null",
    // 有删除凭据（删除中或删完）的会话是用户已经永久删除的：列表、冷恢复与
    // sessions-index 都不能再把它加回来。行本身在 complete 前还在库里。
    "not exists (select 1 from session_purge where session_purge.session_id = session.id)",
  ];
  const values: SQLInputValue[] = [];

  if (input.projectID) {
    clauses.push("project_id = ?");
    values.push(input.projectID);
  }

  if (input.workspaceID !== undefined) {
    if (input.workspaceID === null) {
      clauses.push("workspace_id is null");
    } else {
      clauses.push("workspace_id = ?");
      values.push(input.workspaceID);
    }
  }

  if (input.directory) {
    clauses.push("directory = ?");
    values.push(input.directory);
  }

  if (input.path !== undefined) {
    if (input.path.length === 0) {
      clauses.push("(path is null or path = '')");
    } else {
      clauses.push("(path = ? or path like ?)");
      values.push(input.path, `${input.path}/%`);
    }
  }

  // 子代理冷恢复按父会话扫描 child session（docs/subagent-restart-resume.md）。
  if (input.parentID) {
    clauses.push("parent_id = ?");
    values.push(input.parentID);
  }

  if (input.roots) {
    clauses.push("parent_id is null");
  }

  const taskTypes = normalizeSessionTaskTypes(input.taskTypes);
  if (taskTypes.length > 0) {
    clauses.push(`task_type in (${taskTypes.map(() => "?").join(", ")})`);
    values.push(...taskTypes);
  }

  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const limitValue = input.limit && input.limit > 0 ? input.limit : undefined;
  const limit = limitValue === undefined ? "" : " limit ?";
  if (limitValue !== undefined) {
    values.push(limitValue);
  }
  const rows = db
    .prepare(`select * from session ${where} order by time_updated desc, id desc${limit}`)
    .all(...values) as unknown as SessionRow[];
  return rows.map(decodeSessionRow);
}

export function claimLegacySessionWorkspace(
  db: DatabaseSync,
  input: ClaimLegacySessionWorkspaceInput,
): number {
  const sessionIDs = [...new Set(input.sessionIDs)];
  if (sessionIDs.length === 0) return 0;
  // 3.3.6 的 SSH/WSL session 没有 workspace_id，3.4 sessions-index 又按完整
  // identity 严格查询，升级后历史任务全部不可见。这里只认 host tasks-index 给出的精确
  // taskId allowlist，并叠加实际目录和 NULL identity，不能退化成按路径批量认领。
  const result = db
    .prepare(
      `update session
       set workspace_id = ?
       where workspace_id is null
         and directory = ?
         and id in (${sessionIDs.map(() => "?").join(", ")})`,
    )
    .run(input.workspaceID, input.directory, ...sessionIDs);
  return Number(result.changes);
}

export function repairLegacyRemoteSessionWorkspace(
  db: DatabaseSync,
  input: RepairLegacyRemoteSessionWorkspaceInput,
): boolean {
  // 3.4.2 把 WSL identity 当成执行路径，生产路径还可能先被 path.resolve
  // 拼到真实 cwd 后落库。只按单 session 和完整旧目录精确迁移，禁止模糊搜索或批量认领。
  const result = db
    .prepare(
      `update session
       set project_id = ?, workspace_id = ?, directory = ?, path = ?
       where id = ?
         and workspace_id is null
         and directory = ?
         and (path is null or path = ?)`,
    )
    .run(
      input.projectID,
      input.workspaceID,
      input.workspacePath,
      input.workspacePath,
      input.sessionID,
      input.legacyWorkspaceDirectory,
      input.legacyWorkspaceDirectory,
    );
  return Number(result.changes) === 1;
}

export function repairRemoteSessionPaths(
  db: DatabaseSync,
  input: RepairRemoteSessionPathsInput,
): boolean {
  // 路径自愈曾复用全字段 updateSession，把读取快照中的标题、权限、回滚和
  // 归档状态覆盖到并发新值上。维护性迁移只能拥有路径字段，并用旧路径做 CAS。
  const result = db
    .prepare(
      `update session
       set directory = ?, path = ?, time_updated = max(time_updated, ?)
       where id = ?
         and workspace_id = ?
         and directory = ?
         and ((? is null and path is null) or path = ?)`,
    )
    .run(
      input.directory,
      input.path,
      input.timeUpdated,
      input.sessionID,
      input.workspaceID,
      input.expectedDirectory,
      input.expectedPath,
      input.expectedPath,
    );
  return Number(result.changes) === 1;
}

export async function setRevert(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  },
): Promise<void> {
  await updateSession(db, {
    id: input.sessionID,
    revert: input.revert,
    summary: input.summary
      ? {
          additions: input.summary.additions,
          deletions: input.summary.deletions,
          files: input.summary.files,
          diffs: input.summary.diffs,
        }
      : undefined,
  });
}

export async function clearRevert(db: DatabaseSync, sessionID: SessionId): Promise<void> {
  await updateSession(db, {
    id: sessionID,
    revert: null,
    summary: null,
  });
}

export function touchSession(db: DatabaseSync, sessionID: SessionId, timeUpdated: number): void {
  db.prepare("update session set time_updated = max(time_updated, ?) where id = ?").run(
    timeUpdated,
    sessionID,
  );
}

function normalizeSessionTaskTypes(taskTypes: readonly SessionTaskType[] | undefined): string[] {
  if (!taskTypes || taskTypes.length === 0) return [];
  const valid = new Set<string>(SESSION_TASK_TYPES);
  return [...new Set(taskTypes.filter((taskType) => valid.has(taskType)))];
}

function mustGetSession(db: DatabaseSync, sessionID: SessionId): SessionInfo {
  const session = getSession(db, sessionID);
  if (!session) {
    throw new Error(`Session not found after write: ${sessionID}`);
  }
  return session;
}

// ── 归档会话的永久删除（v4/storage/sessionData/deletionPreview|deletionExecute）──
// 与旧 sessionData/purge（项目数据清理）是两条路径：这里按删除凭据先预检、再开删、
// 删文件、删行。口径与 kernel/crates/node-store/src/purge.rs 一致。

/** 随父会话存在的子会话；fork 与交互会话是用户的独立任务，不展开。 */
const OWNED_CHILD_TASK_TYPES = [
  "selection_side_chat",
  "workflow_child",
  "subagent_child",
  "nested_workflow_child",
] as const;
const ARTIFACT_SCHEMES = ["nibi-artifact://", "zcode-artifact://"] as const;
/** 一条 `in (…)` 里最多的 id。 */
const SQL_ID_CHUNK = 400;

type ArtifactScheme = (typeof ARTIFACT_SCHEMES)[number];

function asSessionId(value: string): SessionId {
  return value as SessionId;
}

function chunked<T>(values: readonly T[], size = SQL_ID_CHUNK): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

/** 把 SQLite 触发器里的业务码还原成稳定的错误对象，调用方与协议层不用解析原文。 */
export function mapSessionDeletionError(error: unknown): unknown {
  if (error instanceof SessionDeletionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("session-data.deleting")) {
    return new SessionDeletionError("session-data.deleting", message);
  }
  return error;
}

/**
 * 根 → 根自身与它的自有后代（广度优先，根在最前）。只沿 subagent / workflow /
 * selection side chat 的父链和 session_task_link 展开；fork 是独立任务，不展开。
 * 根不在库里时返回空数组。
 */
export function listOwnedSessionTrees(
  db: DatabaseSync,
  rootIDs: readonly SessionId[],
): Map<SessionId, SessionId[]> {
  const result = new Map<SessionId, SessionId[]>();
  const exists = db.prepare("select 1 from session where id = ?");
  const marks = OWNED_CHILD_TASK_TYPES.map(() => "?").join(",");
  const children = db.prepare(
    `select id from session where parent_id = ? and task_type in (${marks})
     union select child_session_id from session_task_link where parent_session_id = ?
     order by 1`,
  );
  for (const rootID of rootIDs) {
    if (!exists.get(rootID)) {
      result.set(rootID, []);
      continue;
    }
    const tree: SessionId[] = [rootID];
    const seen = new Set<string>([rootID]);
    for (let index = 0; index < tree.length; index++) {
      const parent = tree[index]!;
      const rows = children.all(parent, ...OWNED_CHILD_TASK_TYPES, parent) as Array<{
        id: string;
      }>;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        tree.push(asSessionId(row.id));
      }
    }
    result.set(rootID, tree);
  }
  return result;
}

/** 文本里的每个产物引用（`<scheme><会话>/<artifact>`）；解不出的段跳过。 */
function artifactReferences(text: string): Array<{ sessionID: SessionId; artifactID: string }> {
  const found: Array<{ sessionID: SessionId; artifactID: string }> = [];
  for (const scheme of ARTIFACT_SCHEMES) {
    let rest = text;
    for (;;) {
      const at = rest.indexOf(scheme);
      if (at < 0) break;
      rest = rest.slice(at + scheme.length);
      const sessionEnd = rest.search(/[/"\\\s]/u);
      if (sessionEnd < 0) continue;
      const session = rest.slice(0, sessionEnd);
      if (rest[sessionEnd] !== "/") continue;
      const tail = rest.slice(sessionEnd + 1);
      const artifactEnd = tail.search(/["\\\s/?#]/u);
      const artifact = artifactEnd < 0 ? tail : tail.slice(0, artifactEnd);
      if (!session || !artifact) continue;
      const decodedSession = percentDecode(session);
      const decodedArtifact = percentDecode(artifact);
      if (decodedSession === null || decodedArtifact === null) continue;
      found.push({ sessionID: asSessionId(decodedSession), artifactID: decodedArtifact });
    }
  }
  return found;
}

function percentDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

interface ReferenceSource {
  /** 会话列（普通表）或 run 表的 parent_session_id（工作流 journal）。 */
  sql: string;
}

/** 树外没删除的会话里可能引用附件的列；工作流 journal 沿 run 的 parent_session_id 归到会话。 */
function referenceSources(): ReferenceSource[] {
  const sources: ReferenceSource[] = [];
  for (const [table, sessionColumn, dataColumn] of [
    ["part", "session_id", "data"],
    ["message", "session_id", "data"],
    ["session_input", "session_id", "payload"],
    ["session_entry", "session_id", "data"],
    ["session", "id", "revert"],
    ["input_history", "session_id", "attachments"],
  ] as const) {
    const condition = ARTIFACT_SCHEMES.map(
      (scheme) => `instr(t.${dataColumn}, '${scheme}') > 0`,
    ).join(" or ");
    sources.push({
      sql: `select t.${sessionColumn} as session_id, t.${dataColumn} as body, s.title as title
            from ${table} t join session s on s.id = t.${sessionColumn}
            where s.time_deleted is null and (${condition})`,
    });
  }
  for (const [table, owner, columns] of [
    ["dwf_run", null, ["args_json", "result_json", "failure_json"]],
    ["workflow_run", null, ["args_json", "stats_json", "failure_json"]],
    ["dwf_node", "dwf_run", ["input_json", "result_json", "error_json"]],
    ["dwf_event", "dwf_run", ["payload_json"]],
    ["dwf_actor", "dwf_run", ["persona_json"]],
    ["workflow_activity", "workflow_run", ["prompt", "opts_json", "result_json", "error_json"]],
    ["workflow_event", "workflow_run", ["payload_json"]],
  ] as const) {
    const body = columns.map((column) => `coalesce(t.${column}, '')`).join(" || ' ' || ");
    const condition = ARTIFACT_SCHEMES.map((scheme) => `instr(${body}, '${scheme}') > 0`).join(
      " or ",
    );
    const join = owner ? `join ${owner} r on r.id = t.run_id` : "";
    const ownerAlias = owner ? "r" : "t";
    sources.push({
      sql: `select s.id as session_id, ${body} as body, s.title as title
            from ${table} t ${join} join session s on s.id = ${ownerAlias}.parent_session_id
            where s.time_deleted is null and (${condition})`,
    });
  }
  return sources;
}

interface ReferenceRow {
  session_id: string;
  body: string | null;
  title: string | null;
}

/** 树外未删除会话对树内会话附件的引用，按（会话，artifact）排序；引用方按会话 id 排序、不重复。 */
function collectArtifactReferences(
  db: DatabaseSync,
  inside: ReadonlySet<string>,
): SessionArtifactReference[] {
  const found = new Map<string, Map<string, string>>();
  for (const source of referenceSources()) {
    const rows = db.prepare(source.sql).all() as unknown as ReferenceRow[];
    for (const row of rows) {
      if (inside.has(row.session_id)) continue;
      for (const reference of artifactReferences(row.body ?? "")) {
        if (!inside.has(reference.sessionID)) continue;
        const key = `${reference.sessionID}\u0000${reference.artifactID}`;
        let referrers = found.get(key);
        if (!referrers) {
          referrers = new Map();
          found.set(key, referrers);
        }
        if (!referrers.has(row.session_id)) referrers.set(row.session_id, row.title ?? "");
      }
    }
  }
  return [...found.entries()]
    .map(([key, referrers]) => {
      const [sessionID, artifactID] = key.split("\u0000") as [string, string];
      return {
        sessionID: asSessionId(sessionID),
        artifactID,
        referrers: [...referrers.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([referrerID, title]) => ({ sessionID: asSessionId(referrerID), title })),
      };
    })
    .sort(
      (left, right) =>
        left.sessionID.localeCompare(right.sessionID) ||
        left.artifactID.localeCompare(right.artifactID),
    );
}

/**
 * 每个目标会话 → 树外仍引用它的未删除会话（按 id 排序）。三类库内引用：
 * - part 内容里的 `nibi-artifact://<目标>/…`（旧记录可能是 `zcode-artifact://`）；
 * - `session.parent_id` 两侧（fork 的父/子关系）；
 * - `session_task_link.parent_session_id` / `child_session_id`（工作流子会话的活链接）。
 * 与上游 `listArtifactReferrers` 同口径：只算未软删除的引用方，自己的引用不算。
 */
export function listArtifactReferrers(
  db: DatabaseSync,
  targetIDs: readonly SessionId[],
): Map<SessionId, SessionId[]> {
  const result = new Map<SessionId, SessionId[]>();
  for (const target of targetIDs) result.set(target, []);
  if (targetIDs.length === 0) return result;
  const wanted = new Set<string>(targetIDs);
  const found = new Map<string, Set<string>>();
  const add = (target: string, referrer: string) => {
    if (target === referrer || !wanted.has(target)) return;
    let referrers = found.get(target);
    if (!referrers) {
      referrers = new Set();
      found.set(target, referrers);
    }
    referrers.add(referrer);
  };

  // 1) part 内容里的产物 URI。只在删除时调用，一次全表扫描可接受（上游同）。
  const partRows = db
    .prepare(
      `select p.session_id as referrer, p.data as body
       from part p join session s on s.id = p.session_id
       where s.time_deleted is null
         and (instr(p.data, 'nibi-artifact://') > 0 or instr(p.data, 'zcode-artifact://') > 0)`,
    )
    .all() as Array<{ referrer: string; body: string | null }>;
  for (const row of partRows) {
    for (const reference of artifactReferences(row.body ?? "")) {
      add(reference.sessionID, row.referrer);
    }
  }

  // 2) 父链两侧：目标的孩子与目标的父会话。
  const children = db.prepare(
    "select id from session where parent_id = ? and id <> ? and time_deleted is null",
  );
  const parent = db.prepare("select parent_id from session where id = ? and time_deleted is null");
  const alive = db.prepare("select 1 from session where id = ? and time_deleted is null");
  for (const target of targetIDs) {
    const childRows = children.all(target, target) as Array<{ id: string }>;
    for (const child of childRows) add(target, child.id);
    const parentRow = parent.get(target) as { parent_id: string | null } | undefined;
    const parentID = parentRow?.parent_id;
    if (parentID && parentID !== target && alive.get(parentID)) add(target, parentID);
  }

  // 3) 工作流任务链接：父会话与子会话互相引用。
  const links = db.prepare(
    `select coalesce(parent_session_id, '') as parent, child_session_id as child
     from session_task_link
     where parent_session_id = ? or child_session_id = ?`,
  );
  for (const target of targetIDs) {
    const linkRows = links.all(target, target) as Array<{ parent: string; child: string }>;
    for (const link of linkRows) {
      if (target === link.parent) {
        if (alive.get(link.child)) add(target, link.child);
      } else if (target === link.child && link.parent && alive.get(link.parent)) {
        add(target, link.parent);
      }
    }
  }

  for (const [target, referrers] of found) {
    result.set(asSessionId(target), [...referrers].sort().map(asSessionId));
  }
  return result;
}

function receiptRows(
  db: DatabaseSync,
  rootID: SessionId,
): Array<{ sessionID: SessionId; retained: string[]; state: string }> {
  const rows = db
    .prepare(
      "select session_id, retained_artifacts, state from session_purge where root_id = ? order by session_id",
    )
    .all(rootID) as Array<{ session_id: string; retained_artifacts: string; state: string }>;
  return rows.map((row) => {
    let retained: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.retained_artifacts);
      if (Array.isArray(parsed)) retained = parsed.filter((value) => typeof value === "string");
    } catch {
      /* 凭据损坏时按没有保留附件处理。 */
    }
    return { sessionID: asSessionId(row.session_id), retained, state: row.state };
  });
}

function sessionWorkspace(
  db: DatabaseSync,
  rootID: SessionId,
): { workspacePath: string; workspaceIdentity: string | null } | null {
  const row = db.prepare("select directory, workspace_id from session where id = ?").get(rootID) as
    | { directory: string; workspace_id: string | null }
    | undefined;
  if (row) return { workspacePath: row.directory, workspaceIdentity: row.workspace_id ?? null };
  const receipt = db
    .prepare("select workspace_path, workspace_identity from session_purge where session_id = ?")
    .get(rootID) as { workspace_path: string; workspace_identity: string | null } | undefined;
  return receipt
    ? {
        workspacePath: receipt.workspace_path,
        workspaceIdentity: receipt.workspace_identity ?? null,
      }
    : null;
}

function pendingWork(db: DatabaseSync, sessionIDs: readonly SessionId[]): boolean {
  const input = db.prepare(
    "select 1 from session_input where session_id = ? and status = 'admitted' limit 1",
  );
  const target = db.prepare(
    "select 1 from session_target where session_id = ? and status = 'active' limit 1",
  );
  return sessionIDs.some((sessionID) => Boolean(input.get(sessionID) || target.get(sessionID)));
}

/** 一次读事务得到删除范围；有凭据时范围是凭据里的会话，没有凭据时是根与它的自有后代。 */
export function inspectSessionDeletion(db: DatabaseSync, rootID: SessionId): SessionDeletionScope {
  const receipts = receiptRows(db, rootID);
  let sessionIDs: SessionId[];
  if (receipts.length) {
    sessionIDs = receipts.map((row) => row.sessionID);
  } else {
    const exists = db.prepare("select 1 from session where id = ?").get(rootID);
    sessionIDs = exists ? (listOwnedSessionTrees(db, [rootID]).get(rootID) ?? []) : [];
  }
  if (sessionIDs.length === 0) {
    return {
      sessionIDs: [],
      workspace: null,
      forks: [],
      references: [],
      stamps: [],
      pendingWork: false,
      receipt: receipts.length ? receiptState(receipts) : null,
    };
  }
  const inside = new Set<string>(sessionIDs);
  const forks: SessionDeletionTitledSession[] = [];
  for (const ids of chunked(sessionIDs)) {
    const rows = db
      .prepare(
        `select id, title from session
         where time_deleted is null and parent_id in (${ids.map(() => "?").join(",")})
         order by id`,
      )
      .all(...ids) as Array<{ id: string; title: string | null }>;
    for (const row of rows) {
      if (inside.has(row.id)) continue;
      forks.push({ sessionID: asSessionId(row.id), title: row.title ?? "" });
    }
  }
  forks.sort((left, right) => left.sessionID.localeCompare(right.sessionID));
  const references = collectArtifactReferences(db, inside);
  // 凭据里记着的保留附件：引用方已经没了也照样留（同上游）。
  for (const receipt of receipts) {
    for (const artifactID of receipt.retained) {
      if (
        references.some(
          (reference) =>
            reference.sessionID === receipt.sessionID && reference.artifactID === artifactID,
        )
      )
        continue;
      references.push({ sessionID: receipt.sessionID, artifactID, referrers: [] });
    }
  }
  references.sort(
    (left, right) =>
      left.sessionID.localeCompare(right.sessionID) ||
      left.artifactID.localeCompare(right.artifactID),
  );
  const stamps: SessionDeletionStamp[] = [];
  const stamp = db.prepare("select time_updated, time_deleted from session where id = ?");
  for (const sessionID of sessionIDs) {
    const row = stamp.get(sessionID) as
      | { time_updated: number; time_deleted: number | null }
      | undefined;
    if (!row) continue;
    stamps.push({
      sessionID,
      updatedAt: Number(row.time_updated),
      deletedAt: row.time_deleted === null ? null : Number(row.time_deleted),
    });
  }
  return {
    sessionIDs,
    workspace: sessionWorkspace(db, rootID),
    forks,
    references,
    stamps,
    pendingWork: receipts.length === 0 && pendingWork(db, sessionIDs),
    receipt: receipts.length ? receiptState(receipts) : null,
  };
}

function receiptState(receipts: ReadonlyArray<{ state: string }>): "deleting" | "deleted" | null {
  if (receipts.some((row) => row.state === "deleting")) return "deleting";
  if (receipts.some((row) => row.state === "deleted")) return "deleted";
  return null;
}

function stampsMatch(
  expected: readonly SessionDeletionStamp[],
  actual: readonly SessionDeletionStamp[],
): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((stamp, index) => {
    const other = actual[index];
    return (
      other !== undefined &&
      stamp.sessionID === other.sessionID &&
      stamp.updatedAt === other.updatedAt &&
      stamp.deletedAt === other.deletedAt
    );
  });
}

function inImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  if (db.isTransaction) return operation();
  db.exec("begin immediate");
  try {
    const result = operation();
    db.exec("commit");
    return result;
  } catch (error) {
    try {
      db.exec("rollback");
    } catch {
      /* 保留首个错误。 */
    }
    throw error;
  }
}

/**
 * 开删：一个事务里再核对版本事实、给范围里每个会话插一行 `deleting` 的凭据。
 * 已有凭据时什么都不插（接着删）；有待处理工作时回 running；范围或版本事实变了回 changed。
 */
export function beginSessionDeletion(
  db: DatabaseSync,
  rootID: SessionId,
  input: SessionDeletionBeginInput,
): SessionDeletionBeginOutcome {
  return inImmediateTransaction(db, () => {
    const scope = inspectSessionDeletion(db, rootID);
    if (scope.receipt !== null) return "admitted";
    if (scope.pendingWork || hasSessionRuntimePresence(db, scope.sessionIDs)) return "running";
    if (scope.sessionIDs.length === 0 || !stampsMatch(input.stamps, scope.stamps)) return "changed";
    const workspace = scope.workspace;
    const insert = db.prepare(
      `insert into session_purge (
         session_id, root_id, operation_id, retained_artifacts,
         workspace_path, workspace_identity, state
       ) values (?, ?, ?, ?, ?, ?, 'deleting')`,
    );
    for (const sessionID of scope.sessionIDs) {
      const retained = input.retained
        .filter((entry) => entry.sessionID === sessionID)
        .map((entry) => entry.artifactID);
      insert.run(
        sessionID,
        rootID,
        input.operationID,
        JSON.stringify(retained),
        workspace?.workspacePath ?? "",
        workspace?.workspaceIdentity ?? null,
      );
    }
    return "admitted";
  });
}

/** 删这些会话及其自有后代的数据库行：外键级联 message/part 等；没有级联外键的表显式删。 */
export function purgeSessions(db: DatabaseSync, sessionIDs: readonly SessionId[]): void {
  const all = new Set<string>(sessionIDs);
  for (const tree of listOwnedSessionTrees(db, sessionIDs).values()) {
    for (const id of tree) all.add(id);
  }
  const ids = [...all].map(asSessionId);
  for (const chunk of chunked(ids)) {
    const marks = chunk.map(() => "?").join(",");
    for (const statement of [
      `delete from input_history where session_id in (${marks})`,
      `delete from dwf_run where parent_session_id in (${marks})`,
      `delete from workflow_run where parent_session_id in (${marks})`,
      `delete from session where id in (${marks})`,
    ]) {
      db.prepare(statement).run(...chunk);
    }
  }
}

/**
 * 删完：一个事务删凭据里这些会话的行，再把凭据改成 `deleted`。调用方先删文件；
 * 文件删不掉时不调用，凭据留着，重试接着删。重复调用幂等。
 */
export function completeSessionDeletion(db: DatabaseSync, rootID: SessionId): void {
  inImmediateTransaction(db, () => {
    const sessionIDs = receiptRows(db, rootID).map((row) => row.sessionID);
    if (sessionIDs.length) purgeSessions(db, sessionIDs);
    db.prepare("update session_purge set state = 'deleted' where root_id = ?").run(rootID);
  });
}

// ── 运行时占用（session_runtime_presence）──

export function registerSessionRuntimePresence(
  db: DatabaseSync,
  sessionID: SessionId,
  ownerID: string,
  processID: number,
): void {
  try {
    db.prepare(
      `insert into session_runtime_presence(session_id, owner_id, process_id)
       values (?, ?, ?)
       on conflict(session_id, owner_id) do update set process_id = excluded.process_id`,
    ).run(sessionID, ownerID, processID);
  } catch (error) {
    throw mapSessionDeletionError(error);
  }
}

export function unregisterSessionRuntimePresence(
  db: DatabaseSync,
  sessionID: SessionId,
  ownerID: string,
): void {
  db.prepare("delete from session_runtime_presence where session_id = ? and owner_id = ?").run(
    sessionID,
    ownerID,
  );
}

export function clearSessionRuntimePresenceForOwner(db: DatabaseSync, ownerID: string): void {
  db.prepare("delete from session_runtime_presence where owner_id = ?").run(ownerID);
}

export function hasSessionRuntimePresence(
  db: DatabaseSync,
  sessionIDs: readonly SessionId[],
): boolean {
  for (const ids of chunked(sessionIDs)) {
    const row = db
      .prepare(
        `select 1 from session_runtime_presence
         where session_id in (${ids.map(() => "?").join(",")}) limit 1`,
      )
      .get(...ids);
    if (row) return true;
  }
  return false;
}

export function assertSessionNotDeleting(db: DatabaseSync, sessionID: SessionId): void {
  const row = db.prepare("select 1 from session_purge where session_id = ? limit 1").get(sessionID);
  if (row) throw new SessionDeletionError("session-data.deleting");
}
