//! `v4/storage/sessionData/*` 的纯 SQL 仓储（上游 `apps/zcode-cli/packages/adapters/src/storage/
//! session-store/repositories/sessions.ts` 的 `listOwnedSessionTrees` / `listArtifactReferrers` /
//! `purgeSessions`）。
//!
//! 只沿「附属会话」展开后代：`parent_id` 且 `task_type ∈ {selection_side_chat, workflow_child,
//! subagent_child, nested_workflow_child}`，加 `session_task_link` 的子会话。fork 的 `parent_id` 也指向
//! 源会话，但它是用户可见的独立任务，不展开。

use std::collections::{HashMap, HashSet, VecDeque};

use rusqlite::{Connection, params, params_from_iter};

use nibi_kernel_api::ids::SessionId;

/// 附属会话的任务类型（与上游 `OWNED_CHILD_TASK_TYPES` 同序）。
const OWNED_CHILD_TASK_TYPES: [&str; 4] = [
    "selection_side_chat",
    "workflow_child",
    "subagent_child",
    "nested_workflow_child",
];
/// SQL 的 `IN` 列表一次最多绑定这么多参数（上游 `SQL_ID_CHUNK` 同一上限）。
const SQL_ID_CHUNK: usize = 400;

/// 上游 `zcode-artifact://` 与本工程品牌化后的 `nibi-artifact://` 都认：库里可能还有 Node 写的行。
const ARTIFACT_SCHEMES: [&str; 2] = ["nibi-artifact://", "zcode-artifact://"];

fn chunks<T>(items: &[T]) -> impl Iterator<Item = &[T]> {
    items.chunks(SQL_ID_CHUNK)
}

/// 每个根 → 根自身与全部附属后代；根不存在时回空数组。
pub fn owned_session_trees(
    conn: &Connection,
    roots: &[SessionId],
) -> rusqlite::Result<HashMap<SessionId, Vec<SessionId>>> {
    let mut exists = conn.prepare_cached("select 1 from session where id = ?")?;
    let type_marks = ["?", "?", "?", "?"].join(",");
    let mut children = conn.prepare_cached(&format!(
        "select id from session where parent_id = ?1 and task_type in ({type_marks})
         union select child_session_id as id from session_task_link where parent_session_id = ?1"
    ))?;
    let mut trees = HashMap::with_capacity(roots.len());
    for root in roots {
        match exists.query_row([root.as_str()], |_| Ok(())) {
            Ok(()) => {}
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                trees.insert(root.clone(), Vec::new());
                continue;
            }
            Err(error) => return Err(error),
        }
        let mut seen: HashSet<String> = HashSet::from([root.as_str().to_owned()]);
        let mut queue = VecDeque::from([root.as_str().to_owned()]);
        while let Some(current) = queue.pop_front() {
            let mut bound: Vec<&str> = vec![&current];
            bound.extend(OWNED_CHILD_TASK_TYPES);
            let rows =
                children.query_map(params_from_iter(bound), |row| row.get::<_, String>(0))?;
            for row in rows {
                let id = row?;
                if seen.insert(id.clone()) {
                    queue.push_back(id);
                }
            }
        }
        trees.insert(root.clone(), seen.into_iter().map(SessionId::new).collect());
    }
    Ok(trees)
}

/// 目标会话 → 仍引用它的其他未删除会话。三类库内引用：
/// - part 内容里的 `nibi-artifact://<目标>/…`（fork / 回退 / 工作流转录按值复制后仍指向源会话）；
/// - `session.parent_id`（fork 的父/子两侧；附属会话在同一棵树里时由调用方按可删除集合过滤）；
/// - `session_task_link.parent_session_id` / `child_session_id`（工作流子会话的活链接）。
///
/// 与上游一样只算 `time_deleted is null` 的引用方；自己的引用不算。
pub fn referrers(
    conn: &Connection,
    targets: &[SessionId],
) -> rusqlite::Result<HashMap<SessionId, Vec<SessionId>>> {
    if targets.is_empty() {
        return Ok(HashMap::new());
    }
    let wanted: HashSet<&str> = targets.iter().map(SessionId::as_str).collect();
    let mut found: HashMap<SessionId, HashSet<SessionId>> = HashMap::new();
    let mut add = |target: &str, referrer: &str| {
        if target == referrer || !wanted.contains(target) {
            return;
        }
        found
            .entry(SessionId::new(target))
            .or_default()
            .insert(SessionId::new(referrer));
    };

    // 1) part 内容里的产物 URI。只在彻底删除时调用，一次全表扫描可接受（上游同）。
    let mut parts = conn.prepare(
        "select p.session_id, p.data from part p join session s on s.id = p.session_id
         where s.time_deleted is null and (instr(p.data, ?1) > 0 or instr(p.data, ?2) > 0)",
    )?;
    let mut rows = parts.query(params![ARTIFACT_SCHEMES[0], ARTIFACT_SCHEMES[1]])?;
    while let Some(row) = rows.next()? {
        let referrer: String = row.get(0)?;
        let data: String = row.get(1)?;
        for target in artifact_targets(&data) {
            add(&target, &referrer);
        }
    }

    // 2) 父链两侧：目标的孩子（parent_id = 目标）与目标的父会话。
    let mut children = conn.prepare_cached(
        "select id from session where parent_id = ?1 and id <> ?1 and time_deleted is null",
    )?;
    let mut parents = conn
        .prepare_cached("select parent_id from session where id = ?1 and time_deleted is null")?;
    let mut parent_exists =
        conn.prepare_cached("select 1 from session where id = ?1 and time_deleted is null")?;
    for target in targets {
        let rows = children.query_map([target.as_str()], |row| row.get::<_, String>(0))?;
        for row in rows {
            add(target.as_str(), &row?);
        }
        let parent: Option<String> = parents
            .query_row([target.as_str()], |row| row.get(0))
            .ok()
            .flatten();
        let Some(parent) = parent else {
            continue;
        };
        if parent != target.as_str()
            && parent_exists
                .query_row([parent.as_str()], |_| Ok(()))
                .is_ok()
        {
            add(target.as_str(), &parent);
        }
    }

    // 3) 工作流任务链接：父会话与子会话互相引用。
    let mut links = conn.prepare_cached(
        "select coalesce(parent_session_id, ''), child_session_id from session_task_link
         where parent_session_id = ?1 or child_session_id = ?1",
    )?;
    for target in targets {
        let rows = links.query_map([target.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (parent, child) = row?;
            if target.as_str() == parent {
                if session_alive(conn, &child)? {
                    add(target.as_str(), &child);
                }
            } else if target.as_str() == child
                && !parent.is_empty()
                && session_alive(conn, &parent)?
            {
                add(target.as_str(), &parent);
            }
        }
    }

    Ok(found
        .into_iter()
        .map(|(target, referrers)| (target, referrers.into_iter().collect()))
        .collect())
}

fn session_alive(conn: &Connection, id: &str) -> rusqlite::Result<bool> {
    conn.prepare_cached("select 1 from session where id = ?1 and time_deleted is null")?
        .query_row([id], |_| Ok(()))
        .map(|()| true)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(other),
        })
}

/// 被外部事实钉住的会话：`share_url` 非空的分享（可以恢复/仍可访问的链接不该被删）。
pub fn pinned(conn: &Connection, targets: &[SessionId]) -> rusqlite::Result<Vec<SessionId>> {
    let mut out = Vec::new();
    for chunk in chunks(targets) {
        let marks = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "select id from session where id in ({marks})
             and share_url is not null and trim(share_url) <> ''"
        );
        let mut statement = conn.prepare(&sql)?;
        let rows = statement.query_map(
            params_from_iter(chunk.iter().map(SessionId::as_str)),
            |row| row.get::<_, String>(0),
        )?;
        for row in rows {
            out.push(SessionId::new(row?));
        }
    }
    Ok(out)
}

/// 删除这些根及其附属后代的会话行。`input_history`、`dwf_run`、`workflow_run` 没有指向
/// `session` 的级联外键，显式删除；message / part / todo / session_entry / usage / session_input
/// 经外键级联。调用方先删文件，文件失败时不调用。
pub fn purge_sessions(conn: &mut Connection, roots: &[SessionId]) -> rusqlite::Result<()> {
    let ids: Vec<SessionId> = owned_session_trees(conn, roots)?
        .into_values()
        .flatten()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    // 外键不能在事务内切换；打开时已打开，这里再保证一次级联生效（上游同一句）。
    conn.execute_batch("pragma foreign_keys = on")?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for chunk in chunks(&ids) {
        let marks = vec!["?"; chunk.len()].join(",");
        let bound = || params_from_iter(chunk.iter().map(SessionId::as_str));
        tx.execute(
            &format!("delete from input_history where session_id in ({marks})"),
            bound(),
        )?;
        tx.execute(
            &format!("delete from dwf_run where parent_session_id in ({marks})"),
            bound(),
        )?;
        tx.execute(
            &format!("delete from workflow_run where parent_session_id in ({marks})"),
            bound(),
        )?;
        tx.execute(
            &format!("delete from session where id in ({marks})"),
            bound(),
        )?;
    }
    tx.commit()
}

/// part 内容里所有 `…-artifact://<会话>/…` 的会话（百分号解码）。按字符流扫描，不解析整段 JSON：
/// part 可能是很大的工具输出，删除时只看 URI。
fn artifact_targets(data: &str) -> Vec<String> {
    let mut out = Vec::new();
    for scheme in ARTIFACT_SCHEMES {
        let mut rest = data;
        while let Some(start) = rest.find(scheme) {
            let after = &rest[start + scheme.len()..];
            let Some(slash) = after.find('/') else {
                break;
            };
            let owner = &after[..slash];
            if !owner.is_empty()
                && !owner.contains(['"', '\\', ' ', '\n', '\r', '\t'])
                && let Some(owner) = percent_decode(owner)
            {
                out.push(owner);
            }
            rest = &after[slash..];
        }
    }
    out
}

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

#[cfg(test)]
#[path = "session_data_repo_tests.rs"]
mod tests;
