//! 归档会话的永久删除（`v4/storage/sessionData/deletionPreview|deletionExecute`）：范围、凭据、文件与删行。SQL 与文件位置照
//! Node（`adapters/.../session-store/repositories/sessions.ts` 的 `listOwnedSessionTrees`、`inspectSessionDeletion`、
//! `purgeSessions`，`adapters/.../session-data-files`）；删除凭据 `session_purge` 是迁移 0026 建的表。
//!
//! 与上游 0.1.88 的差异：文件清单直接按本工程的存储根（`cli/artifacts|exec|agents|sessions` 与
//! `cli/{debug,rollout}/model-io-<sid>.jsonl`）算，没有另做 `SessionDataPaths` 结构；引用的扫描同时认
//! `nibi-artifact://` 与旧记录里的 `zcode-artifact://`。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use nibi_kernel_api::deletion::{
    ArtifactReference, BeginOutcome, DeletionBegin, DeletionScope, Receipt, SessionFile,
    SessionStamp, TitledSession,
};
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_api::store::StoreError;
use nibi_kernel_paths::StoragePaths;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};

use crate::{LOCAL_ENVIRONMENT, storage};

/// 随父会话存在的子会话（Node `OWNED_CHILD_TASK_TYPES`）：fork 与交互会话是用户的独立任务，不展开。
const OWNED_CHILD_TASK_TYPES: [&str; 4] = [
    "selection_side_chat",
    "workflow_child",
    "subagent_child",
    "nested_workflow_child",
];
/// 一条 `in (…)` 里最多的 id（Node `SQL_ID_CHUNK`）。
const SQL_ID_CHUNK: usize = 400;
/// 删除凭据的两种状态（迁移 0026 的 `check(state in ('deleting', 'deleted'))`）。
const RECEIPT_DELETING: &str = "deleting";
const RECEIPT_DELETED: &str = "deleted";
/// 类别目录被换成链接（同 Node 的错误）：不经链接删用户的文件。
const SYMLINK_ROOT: &str = "session-data.symlink-root";
/// 库里可能出现的两种产物 scheme：本工程写的 `nibi-artifact://`，以及 Node / 旧记录里的 `zcode-artifact://`。
const ARTIFACT_SCHEMES: [&str; 2] = ["nibi-artifact://", "zcode-artifact://"];

/// 树外的记录里可能有附件引用的列（Node `inspectSessionDeletion` 的 `sources`）：（表，会话列，正文列）。
const REFERENCE_SOURCES: [(&str, &str, &str); 6] = [
    ("part", "session_id", "data"),
    ("message", "session_id", "data"),
    ("session_input", "session_id", "payload"),
    ("session_entry", "session_id", "data"),
    ("session", "id", "revert"),
    ("input_history", "session_id", "attachments"),
];
/// 工作流 journal 里的引用：（表，run 表（None：自己就是 run），正文列），沿 run 的 `parent_session_id` 归到会话。
const WORKFLOW_SOURCES: [(&str, Option<&str>, &[&str]); 7] = [
    (
        "dwf_run",
        None,
        &["args_json", "result_json", "failure_json"],
    ),
    (
        "workflow_run",
        None,
        &["args_json", "stats_json", "failure_json"],
    ),
    (
        "dwf_node",
        Some("dwf_run"),
        &["input_json", "result_json", "error_json"],
    ),
    ("dwf_event", Some("dwf_run"), &["payload_json"]),
    ("dwf_actor", Some("dwf_run"), &["persona_json"]),
    (
        "workflow_activity",
        Some("workflow_run"),
        &["prompt", "opts_json", "result_json", "error_json"],
    ),
    ("workflow_event", Some("workflow_run"), &["payload_json"]),
];

/// 引用扫描的 SQL：没删除的会话里正文含 artifact scheme 的行，`(会话, 正文, 标题)`。
fn reference_queries() -> Vec<String> {
    let mut queries: Vec<String> = REFERENCE_SOURCES
        .iter()
        .map(|(table, id, data)| {
            let condition = ARTIFACT_SCHEMES
                .iter()
                .map(|scheme| format!("instr(t.{data}, '{scheme}') > 0"))
                .collect::<Vec<_>>()
                .join(" or ");
            format!(
                "select t.{id}, t.{data}, s.title from {table} t join session s on s.id = t.{id} \
                 where s.time_deleted is null and ({condition})"
            )
        })
        .collect();
    for (table, owner, columns) in WORKFLOW_SOURCES {
        let body = columns
            .iter()
            .map(|column| format!("coalesce(t.{column}, '')"))
            .collect::<Vec<_>>()
            .join(" || ' ' || ");
        let condition = ARTIFACT_SCHEMES
            .iter()
            .map(|scheme| format!("instr({body}, '{scheme}') > 0"))
            .collect::<Vec<_>>()
            .join(" or ");
        let (join, run) = match owner {
            Some(owner) => (format!("join {owner} r on r.id = t.run_id"), "r"),
            None => (String::new(), "t"),
        };
        queries.push(format!(
            "select s.id, {body}, s.title from {table} t {join} join session s on s.id = {run}.parent_session_id \
             where s.time_deleted is null and ({condition})"
        ));
    }
    queries
}

fn millis(value: i64) -> u64 {
    u64::try_from(value).unwrap_or_default()
}

/// 根与它的自有后代（Node `listOwnedSessionTrees`）：广度优先，根在最前；根不在库里时为空。
fn owned_tree(conn: &Connection, root: &str) -> rusqlite::Result<Vec<String>> {
    let marks = vec!["?"; OWNED_CHILD_TASK_TYPES.len()].join(",");
    let mut children = conn.prepare(&format!(
        "select id from session where parent_id = ?1 and task_type in ({marks}) \
         union select child_session_id from session_task_link where parent_session_id = ?1 order by 1"
    ))?;
    let mut tree = vec![root.to_owned()];
    let mut seen: BTreeSet<String> = tree.iter().cloned().collect();
    let mut index = 0;
    while index < tree.len() {
        let parent = tree[index].clone();
        let mut values: Vec<&dyn rusqlite::ToSql> = vec![&parent];
        values.extend(
            OWNED_CHILD_TASK_TYPES
                .iter()
                .map(|kind| kind as &dyn rusqlite::ToSql),
        );
        let found = children
            .query_map(values.as_slice(), |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for child in found {
            if seen.insert(child.clone()) {
                tree.push(child);
            }
        }
        index += 1;
    }
    Ok(tree)
}

/// 根的删除凭据的一行（`session_purge`）。
struct ReceiptRow {
    session: String,
    retained: Vec<String>,
    deleting: bool,
}

fn receipt_rows(conn: &Connection, root: &str) -> rusqlite::Result<Vec<ReceiptRow>> {
    conn.prepare(
        "select session_id, retained_artifacts, state from session_purge where root_id = ? order by session_id",
    )?
    .query_map([root], |row| {
        let retained: String = row.get(1)?;
        Ok(ReceiptRow {
            session: row.get(0)?,
            retained: serde_json::from_str(&retained).unwrap_or_default(),
            deleting: row.get::<_, String>(2)? == RECEIPT_DELETING,
        })
    })?
    .collect()
}

/// 根的工作区：会话行（目录与环境）；行已经删了时取凭据里记的（Node `inspectSessionDeletion` 的 `workspace`）。
fn workspace_of(
    conn: &Connection,
    root: &str,
) -> rusqlite::Result<Option<(String, Option<String>)>> {
    let row = conn
        .query_row(
            "select directory, workspace_id from session where id = ?",
            [root],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    match row {
        Some(row) => Ok(Some(row)),
        None => conn
            .query_row(
                "select workspace_path, workspace_identity from session_purge where session_id = ?",
                [root],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional(),
    }
}

/// Node `inspectSessionDeletion`（不含文件与运行态，那两样在内核）：有凭据时范围是凭据里的会话、保留的 artifact 并进引用、不看待处理工作；
/// 没有凭据时是根与它的自有后代。读事务与开删的写事务共用它。
fn inspect(conn: &Connection, root: &SessionId) -> Result<DeletionScope, StoreError> {
    let receipt = receipt_rows(conn, root.as_str()).map_err(storage)?;
    let tree = if receipt.is_empty() {
        let exists = conn
            .query_row(
                "select 1 from session where id = ?",
                [root.as_str()],
                |_| Ok(()),
            )
            .optional()
            .map_err(storage)?
            .is_some();
        if exists {
            owned_tree(conn, root.as_str()).map_err(storage)?
        } else {
            Vec::new()
        }
    } else {
        receipt.iter().map(|row| row.session.clone()).collect()
    };
    if tree.is_empty() {
        return Ok(DeletionScope::default());
    }
    let inside: BTreeSet<&str> = tree.iter().map(String::as_str).collect();
    let forks = forks(conn, &inside).map_err(storage)?;
    let mut references = references(conn, &inside).map_err(storage)?;
    // 凭据里记着的保留的附件：引用方已经没了也照样留（同 Node）
    for row in &receipt {
        for artifact in &row.retained {
            let known = references.iter().any(|reference| {
                reference.session.as_str() == row.session && &reference.artifact == artifact
            });
            if !known {
                references.push(ArtifactReference {
                    session: SessionId::new(&row.session),
                    artifact: artifact.clone(),
                    referrers: Vec::new(),
                });
            }
        }
    }
    references.sort_by(|a, b| (&a.session, &a.artifact).cmp(&(&b.session, &b.artifact)));
    let mut stamp = conn
        .prepare("select time_updated, time_deleted from session where id = ?")
        .map_err(storage)?;
    let mut stamps = Vec::new();
    for id in &tree {
        let found = stamp
            .query_row([id], |row| {
                Ok(SessionStamp {
                    session: SessionId::new(id),
                    updated_ms: millis(row.get(0)?),
                    deleted_ms: row.get::<_, Option<i64>>(1)?.map(millis),
                })
            })
            .optional()
            .map_err(storage)?;
        stamps.extend(found);
    }
    drop(stamp);
    let pending_work = receipt.is_empty() && pending_work(conn, &tree).map_err(storage)?;
    let workspace =
        workspace_of(conn, root.as_str())
            .map_err(storage)?
            .map(|(directory, environment)| WorkspaceRef {
                environment: EnvironmentId::new(
                    environment.as_deref().unwrap_or(LOCAL_ENVIRONMENT),
                ),
                root: EnvPath::new(directory),
            });
    let state = if receipt.is_empty() {
        None
    } else if receipt.iter().any(|row| row.deleting) {
        Some(Receipt::Deleting)
    } else {
        Some(Receipt::Deleted)
    };
    Ok(DeletionScope {
        sessions: tree.into_iter().map(SessionId::new).collect(),
        workspace,
        forks,
        references,
        stamps,
        pending_work,
        receipt: state,
    })
}

/// 一次读事务（预检）。
pub(crate) fn scope(conn: &mut Connection, root: &SessionId) -> Result<DeletionScope, StoreError> {
    let tx = conn.transaction().map_err(storage)?;
    let scope = inspect(&tx, root)?;
    tx.commit().map_err(storage)?;
    Ok(scope)
}

/// 开删（Node `beginSessionDeletion`）：`BEGIN IMMEDIATE` 里再看一次；已有凭据时接着删；否则待处理工作 → Running，版本事实变了或树空了 → Changed，
/// 再给每个会话插一行 `deleting`（保留的 artifact id、根的工作区路径与身份、operation id）。插下之后 0026 的触发器挡住写进这些会话。
pub(crate) fn begin(
    conn: &mut Connection,
    root: &SessionId,
    begin: &DeletionBegin,
) -> Result<BeginOutcome, StoreError> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    let now = inspect(&tx, root)?;
    if now.receipt.is_some() {
        tx.commit().map_err(storage)?;
        return Ok(BeginOutcome::Admitted);
    }
    if now.pending_work {
        return Ok(BeginOutcome::Running);
    }
    if now.sessions.is_empty() || now.stamps != begin.stamps {
        return Ok(BeginOutcome::Changed);
    }
    let (path, identity) = workspace_of(&tx, root.as_str())
        .map_err(storage)?
        .unwrap_or_default();
    for session in &now.sessions {
        let retained: Vec<&str> = begin
            .retained
            .iter()
            .filter(|(owner, _)| owner == session)
            .map(|(_, artifact)| artifact.as_str())
            .collect();
        tx.execute(
            "insert into session_purge(session_id, root_id, operation_id, retained_artifacts, workspace_path, workspace_identity, state) \
             values (?, ?, ?, ?, ?, ?, 'deleting')",
            rusqlite::params![
                session.as_str(),
                root.as_str(),
                begin.operation,
                serde_json::to_string(&retained).map_err(storage)?,
                path,
                identity,
            ],
        )
        .map_err(storage)?;
    }
    tx.commit().map_err(storage)?;
    Ok(BeginOutcome::Admitted)
}

fn forks(conn: &Connection, inside: &BTreeSet<&str>) -> rusqlite::Result<Vec<TitledSession>> {
    let mut statement = conn.prepare(
        "select id, title, parent_id from session where time_deleted is null and parent_id is not null order by id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    let mut forks = Vec::new();
    for row in rows {
        let (id, title, parent) = row?;
        if inside.contains(parent.as_str()) && !inside.contains(id.as_str()) {
            forks.push(TitledSession {
                session: SessionId::new(id),
                title: title.unwrap_or_default(),
            });
        }
    }
    Ok(forks)
}

/// 树外没删除的会话对树里会话附件的引用，按（会话，artifact）排序；引用方按会话 id 排序、不重复。
fn references(
    conn: &Connection,
    inside: &BTreeSet<&str>,
) -> rusqlite::Result<Vec<ArtifactReference>> {
    let mut found: BTreeMap<(String, String), BTreeMap<String, String>> = BTreeMap::new();
    for query in reference_queries() {
        let mut statement = conn.prepare(&query)?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })?;
        for row in rows {
            let (referrer, body, title) = row?;
            if inside.contains(referrer.as_str()) {
                continue;
            }
            for (session, artifact) in artifact_references(body.as_deref().unwrap_or_default()) {
                if !inside.contains(session.as_str()) {
                    continue;
                }
                found
                    .entry((session.as_str().to_owned(), artifact))
                    .or_default()
                    .entry(referrer.clone())
                    .or_insert_with(|| title.clone().unwrap_or_default());
            }
        }
    }
    Ok(found
        .into_iter()
        .map(|((session, artifact), referrers)| ArtifactReference {
            session: SessionId::new(session),
            artifact,
            referrers: referrers
                .into_iter()
                .map(|(session, title)| TitledSession {
                    session: SessionId::new(session),
                    title,
                })
                .collect(),
        })
        .collect())
}

/// 文本里的每个产物引用（`<scheme><会话>/<artifact>`，两段都到 `"`、`\`、空白为止，artifact 另到 `/`、`?`、`#` 为止）。
/// 与 Node 的 `inspectSessionDeletion` 同口径：解不出的段跳过。
fn artifact_references(text: &str) -> Vec<(SessionId, String)> {
    let stops = |byte: u8| byte == b'"' || byte == b'\\' || byte.is_ascii_whitespace();
    let mut found = Vec::new();
    for scheme in ARTIFACT_SCHEMES {
        let mut rest = text;
        while let Some(at) = rest.find(scheme) {
            rest = &rest[at + scheme.len()..];
            let session_end = rest
                .bytes()
                .position(|byte| byte == b'/' || stops(byte))
                .unwrap_or(rest.len());
            let (session, after) = rest.split_at(session_end);
            let Some(tail) = after.strip_prefix('/') else {
                continue;
            };
            let artifact_end = tail
                .bytes()
                .position(|byte| stops(byte) || matches!(byte, b'/' | b'?' | b'#'))
                .unwrap_or(tail.len());
            if session.is_empty() || artifact_end == 0 {
                continue;
            }
            if let (Some(session), Some(artifact)) = (
                percent_decode(session),
                percent_decode(&tail[..artifact_end]),
            ) {
                found.push((SessionId::new(session), artifact));
            }
        }
    }
    found
}

/// URI 段的百分号解码（`encodeURIComponent` 的逆）；不合法时为 None。
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Node 写下的待处理工作（`inspectSessionDeletion` 的 `pendingWork`）：rust 不写这两张表，旧的 Node 会话留下的仍算在用。
fn pending_work(conn: &Connection, tree: &[String]) -> rusqlite::Result<bool> {
    let mut input = conn.prepare(
        "select 1 from session_input where session_id = ? and status = 'admitted' limit 1",
    )?;
    let mut target = conn.prepare(
        "select 1 from session_target where session_id = ? and status = 'active' limit 1",
    )?;
    for id in tree {
        if input.exists([id])? || target.exists([id])? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 删完（Node `completeSessionDeletion`）：一个事务删凭据里这些会话的行，再把凭据改成 `deleted`（Node `purgeSessions`：消息、part、todo、
/// 用量与 `session_task_link` 经外键级联；`input_history`、`dwf_run`、`workflow_run` 对 session 没有级联外键，显式删，否则留下孤儿行）。
/// 调用方先删文件：文件删不掉时不调它，凭据留着，重试接着删。
pub(crate) fn complete(conn: &mut Connection, root: &SessionId) -> Result<(), StoreError> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage)?;
    let sessions: Vec<String> = receipt_rows(&tx, root.as_str())
        .map_err(storage)?
        .into_iter()
        .map(|row| row.session)
        .collect();
    for chunk in sessions.chunks(SQL_ID_CHUNK) {
        let marks = vec!["?"; chunk.len()].join(",");
        for statement in [
            format!("delete from input_history where session_id in ({marks})"),
            format!("delete from dwf_run where parent_session_id in ({marks})"),
            format!("delete from workflow_run where parent_session_id in ({marks})"),
            format!("delete from session where id in ({marks})"),
        ] {
            tx.execute(&statement, rusqlite::params_from_iter(chunk))
                .map_err(storage)?;
        }
    }
    tx.execute(
        "update session_purge set state = ? where root_id = ?",
        rusqlite::params![RECEIPT_DELETED, root.as_str()],
    )
    .map_err(storage)?;
    tx.commit().map_err(storage)?;
    Ok(())
}

/// 一个会话在存储里的位置：存储根、类别目录（第一个是附件目录）与模型轨迹文件。
struct SessionPaths {
    root: PathBuf,
    directories: Vec<PathBuf>,
    files: Vec<PathBuf>,
}

fn session_paths(paths: &StoragePaths, session: &SessionId) -> Result<SessionPaths, StoreError> {
    let cli_root = paths.cli_root().as_path().to_path_buf();
    let (directories, files) =
        crate::session_data::session_locations(&cli_root, session).map_err(|error| {
            StoreError::Storage {
                message: error.code,
            }
        })?;
    Ok(SessionPaths {
        root: cli_root,
        directories,
        files,
    })
}

/// 这个会话的文件：按相对存储根的路径排序。
pub(crate) async fn files(
    paths: &StoragePaths,
    session: &SessionId,
) -> Result<Vec<SessionFile>, StoreError> {
    let data = session_paths(paths, session)?;
    let root = data.root.as_path();
    let mut found = Vec::new();
    let locations = data
        .directories
        .iter()
        .enumerate()
        .map(|(index, dir)| (dir, index == 0))
        .chain(data.files.iter().map(|file| (file, false)));
    for (location, artifact) in locations {
        // 存储类别目录若被换成链接，不能沿祖先链接清理用户文件（同 Node）
        if let Some(category) = location.parent()
            && nibi_kernel_fs::is_symlink(category)
                .await
                .map_err(storage)?
        {
            return Err(storage(SYMLINK_ROOT));
        }
        for file in nibi_kernel_fs::tree_files(location)
            .await
            .map_err(storage)?
        {
            let relative = file.path.strip_prefix(root).unwrap_or(&file.path);
            found.push(SessionFile {
                relative_path: relative.to_string_lossy().into_owned(),
                name: file
                    .path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                artifact,
                bytes: file.bytes,
            });
        }
    }
    found.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(found)
}

/// 删这个会话的文件（Node `removeSession`）：没有要留的时每个位置整个删；有时附件目录里只删
/// 文件名不含任何一个 `keep` 的文件（留下 URI 定位所需的附件，绝不因为引用而留下正文、执行日志或别的独占附件），其余位置整个删。
pub(crate) async fn remove_files(
    paths: &StoragePaths,
    session: &SessionId,
    keep: &[String],
) -> Result<(), StoreError> {
    let data = session_paths(paths, session)?;
    let (artifacts, rest) = data
        .directories
        .split_first()
        .ok_or_else(|| storage("session-data.invalid-session-id"))?;
    if keep.is_empty() {
        nibi_kernel_fs::remove_path(artifacts)
            .await
            .map_err(storage)?;
    } else {
        for file in nibi_kernel_fs::tree_files(artifacts)
            .await
            .map_err(storage)?
        {
            let name = file
                .path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default();
            if !keep.iter().any(|id| name.contains(id.as_str())) {
                nibi_kernel_fs::remove_path(&file.path)
                    .await
                    .map_err(storage)?;
            }
        }
    }
    for location in rest.iter().chain(data.files.iter()) {
        nibi_kernel_fs::remove_path(location)
            .await
            .map_err(storage)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "purge_tests.rs"]
mod tests;
