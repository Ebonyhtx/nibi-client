//! 冷读取：会话行、活动分支上的消息、模型选择与模式；会话列表
//! （docs/specs/rust-cli/node-store.md §5，docs/specs/rust-m11-node-storage.md §6）。
use std::borrow::Cow;
use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, MessageId, SessionId, TraceId, TurnId};
use nibi_kernel_api::model::{ModelConnection, ModelSelection};
use nibi_kernel_api::permission::ExecutionState;
use nibi_kernel_api::store::{
    LoadedSession, MessageTime, SessionDirectoryEntry, SessionDirectoryQuery, SessionIndexFact,
    SessionKind, SessionLaunchTurn, SessionMeta, SessionModelTurn, SessionSummary, TurnAnchor,
};
use nibi_kernel_api::store::{SessionFilter, StoreError};
use serde_json::Value;

use crate::branch::{Branch, active_messages, earlier_messages};
use crate::facts::{live_session, unsupported};
use crate::mode;
use crate::operations;
use crate::records;
use crate::repo::messages;
use crate::repo::messages::WithParts;
use crate::repo::sessions::{self, SessionRow};
use crate::state::{self, PERMISSION_MODE_ENTRY};
use crate::{LOCAL_ENVIRONMENT, OrStorage};

/// 冷读取的会话；`checkpoints` 留空，由调用方按 [`crate::rewind::Active`] 补出（Node 写的要读产物目录，不在
/// 数据库线程里做，修复线 F12）。
pub fn load(
    conn: &Connection,
    session: &SessionId,
) -> Result<(LoadedSession, Vec<crate::rewind::Active>), StoreError> {
    let row = live_session(conn, session)?;
    let records = messages::messages(conn, session.as_str()).storage()?;
    let branch = Branch::from_revert(row.revert.as_ref());
    let active = active_messages(&records, &branch, true);
    // 压缩点之前的历史只供显示（工作线 F102，compact.md §5.1）；模型侧的历史仍是 `active`，单独转换，结果不变。
    let earlier = earlier_messages(&records, &branch, &active);
    let model = state::selection(conn, session.as_str())
        .storage()?
        .as_ref()
        .map(kernel_selection)
        .map(|selection| with_connection(conn, session, selection))
        .transpose()?;
    let execution = execution_state(conn, &row)?;
    // 库里的当前轮：会话 actor 打开会话时的起点（node-store.md §4，修复线 F6）。
    let turn = state::current_user(conn, session.as_str())
        .storage()?
        .map(|(prompt, turn)| TurnAnchor {
            prompt: MessageId::new(prompt),
            turn: turn.map(TurnId::new),
        });
    let loaded = LoadedSession {
        messages: crate::hydrate::hydrate(&active),
        earlier: crate::hydrate::hydrate(&earlier),
        // 工作流控制轮（NIBI 中枢启动/设置轮，launch.md）：earlier 与活动段都算，显示顺序在前。
        launches: launch_turns(&earlier)
            .into_iter()
            .chain(launch_turns(&active))
            .collect(),
        // 每轮输入的模型选择（Node 消息记录上的 `modelSelection`）：冷投影补 modelChange 分隔线。
        model_turns: model_turns(&earlier)
            .into_iter()
            .chain(model_turns(&active))
            .collect(),
        // 输入的规范意图（Node 消息的 `metadata.conversationInputIntent`）：冷投影恢复行上原文、
        // 机器人来源与引用；earlier 与活动段都算。
        input_intents: input_intents(&earlier)
            .into_iter()
            .chain(input_intents(&active))
            .collect(),
        model,
        mode: execution.map(|state| state.mode),
        plan: execution.is_some_and(|state| state.plan),
        meta: meta(&row),
        open_operations: operations::open_operations(conn, session.as_str())?,
        pending_interactions: operations::pending_interactions(conn, session.as_str())?,
        checkpoints: Vec::new(),
        turn: turn.clone(),
        // 续写时补 assistant 的判断（session-lifecycle.md §6.3.1）：当前轮的 `turn_usage` 是错误。
        last_turn_failed: match &turn {
            Some(anchor) => {
                crate::repo::usage::turn_failed(conn, session.as_str(), anchor.prompt.as_str())
                    .storage()?
            }
            None => false,
        },
    };
    Ok((loaded, crate::rewind::active_checkpoints(conn, session)?))
}

/// 会话里每条消息的持久时间：旧协议快照的 `info.time.created/completed` 用它。
pub fn message_times(
    conn: &Connection,
    session: &SessionId,
) -> Result<HashMap<MessageId, MessageTime>, StoreError> {
    let mut query = conn
        .prepare("select id, time_created, time_updated from message where session_id = ?")
        .storage()?;
    let rows = query
        .query_map([session.as_str()], |row| {
            let id: String = row.get(0)?;
            let created: i64 = row.get(1)?;
            let updated: i64 = row.get(2)?;
            Ok((id, created, updated))
        })
        .storage()?;
    let mut times = HashMap::new();
    for row in rows {
        let (id, created, updated) = row.storage()?;
        times.insert(
            MessageId::new(id),
            MessageTime {
                created_at_ms: u64::try_from(created).unwrap_or_default(),
                updated_at_ms: Some(u64::try_from(updated).unwrap_or_default()),
            },
        );
    }
    Ok(times)
}

pub fn list(conn: &Connection, filter: &SessionFilter) -> Result<Vec<SessionSummary>, StoreError> {    if filter.workspace.environment.as_str() != LOCAL_ENVIRONMENT {
        return Err(unsupported("sessions of a remote environment"));
    }
    // 本目录的顶层会话与 fork 出的会话，按活动时间倒序（session-lifecycle.md §6.2）。
    let limit = i64::try_from(filter.limit).unwrap_or(i64::MAX);
    let rows = sessions::list(conn, filter.workspace.root.as_str(), Some(limit)).storage()?;
    Ok(rows
        .into_iter()
        .map(|row| SessionSummary {
            id: SessionId::new(row.id),
            title: row.title,
            updated_at_ms: u64::try_from(row.time_updated).unwrap_or(0),
        })
        .collect())
}

/// legacy `session/list` 的目录读面（[`SessionDirectoryQuery`]）：显式 ID 走 `getSession`
/// 逐条读（不看目录与任务类型），否则走 Node 的任务列表口径（[`sessions::task_list`]）。
/// 软删除的行两种读法都不返回——Node 的 `listSessions` 与父链校验都以
/// `time.deleted === undefined` 为前提。
pub fn directory(
    conn: &Connection,
    query: &SessionDirectoryQuery,
) -> Result<Vec<SessionDirectoryEntry>, StoreError> {
    let rows = match &query.ids {
        Some(ids) => {
            let mut rows = Vec::with_capacity(ids.len());
            for id in ids {
                let Some(row) = sessions::get(conn, id.as_str()).storage()? else {
                    continue;
                };
                if row.time_deleted.is_none() {
                    rows.push(row);
                }
            }
            rows
        }
        None => {
            let limit = i64::try_from(query.limit).unwrap_or(i64::MAX);
            sessions::task_list(conn, query.directory.as_deref(), limit).storage()?
        }
    };
    Ok(rows.into_iter().map(directory_entry).collect())
}

/// `sessions-index/reconcile` 的单条事实（Node `v4-bridge.ts` 的 `reconcileSessions`）：软删除的行
/// 也要读出来并带 `deleted: true`——Host 用它把 tasks-index 的行落墓碑。
pub fn index_fact(
    conn: &Connection,
    session: &SessionId,
) -> Result<Option<SessionIndexFact>, StoreError> {
    conn.prepare_cached(
        "select directory, workspace_id, title, title_source, time_created, time_updated,
                time_deleted, last_outcome
           from session where id = ?",
    )
    .storage()?
    .query_row([session.as_str()], |row| {
        let created = row.get::<_, i64>(4)?;
        let updated = row.get::<_, i64>(5)?;
        Ok(SessionIndexFact {
            directory: row.get(0)?,
            workspace_id: row.get(1)?,
            title: row.get(2)?,
            title_source: row.get(3)?,
            created_at_ms: u64::try_from(created).unwrap_or(0),
            updated_at_ms: u64::try_from(updated).unwrap_or(0),
            deleted: row.get::<_, Option<i64>>(6)?.is_some(),
            last_outcome: row.get(7)?,
        })
    })
    .optional()
    .storage()
}

fn directory_entry(row: SessionRow) -> SessionDirectoryEntry {    SessionDirectoryEntry {
        id: SessionId::new(row.id),
        parent: row.parent_id.map(SessionId::new),
        trace: row.trace_id,
        task_type: row.task_type,
        title: row.title,
        title_source: row.title_source,
        workspace_id: row.workspace_id,
        directory: row.directory,
        path: row.path,
        created_at_ms: u64::try_from(row.time_created).unwrap_or(0),
        updated_at_ms: u64::try_from(row.time_updated).unwrap_or(0),
    }
}

/// 消息记录里带 `source: "workflow_launch"` 的控制轮（NIBI 中枢启动/设置轮，launch.md）：
/// 消息 id 与 `metadata.workflowLaunch`。冷投影据它在 real-user 轮边界里重建 controlOnly 的
/// 轮（Node `workflowLaunchOfMessage` 同一判据）；元数据缺了也照记——投影拿不到值时退回
/// 普通 agent 轮的呈现。
fn launch_turns(records: &[Cow<'_, WithParts>]) -> Vec<SessionLaunchTurn> {
    records
        .iter()
        .filter(|record| record.info["source"] == "workflow_launch")
        .map(|record| SessionLaunchTurn {
            message: MessageId::new(record.id()),
            launch: record.info["metadata"]["workflowLaunch"].clone(),
        })
        .collect()
}

/// 每轮用户输入时刻的模型选择：Node 把当时的 `runtime/model_selection` 写进 user 消息的
/// `modelSelection`。严格结构优先，坏数据跳过（冷投影只拿它画分隔线，不能因此读不出会话）。
fn model_turns(records: &[Cow<'_, WithParts>]) -> Vec<SessionModelTurn> {
    records
        .iter()
        .filter(|record| record.info["role"] == "user")
        .filter_map(|record| {
            let selection =
                crate::repo::codecs::parse_model_selection(&record.info["modelSelection"])?;
            Some(SessionModelTurn {
                message: MessageId::new(record.id()),
                selection: kernel_selection(&selection),
            })
        })
        .collect()
}

/// 每条真人输入的规范意图：Node 把 canonical intent 写进 user 消息的
/// `metadata.conversationInputIntent`。坏数据跳过（冷投影只拿它恢复行上原文与来源，不能因此读不出会话）。
fn input_intents(records: &[Cow<'_, WithParts>]) -> Vec<(MessageId, Value)> {
    records
        .iter()
        .filter(|record| record.info["role"] == "user")
        .filter_map(|record| {
            let intent = &record.info["metadata"]["conversationInputIntent"];
            (!intent.is_null()).then(|| (MessageId::new(record.id()), intent.clone()))
        })
        .collect()
}

fn meta(row: &SessionRow) -> SessionMeta {
    let kind = match row.task_type.as_str() {
        "subagent_child" => SessionKind::Subagent,
        "fork" | "selection_side_chat" => SessionKind::Fork,
        _ => SessionKind::Interactive,
    };
    SessionMeta {
        id: SessionId::new(row.id.as_str()),
        kind,
        parent: row.parent_id.as_deref().map(SessionId::new),
        workspace: WorkspaceRef {
            // 远程会话的 workspace_id 是 Node 的远程 identity；本地为 NULL。
            environment: EnvironmentId::new(
                row.workspace_id.as_deref().unwrap_or(LOCAL_ENVIRONMENT),
            ),
            root: EnvPath::new(row.directory.as_str()),
        },
        title: row.title.clone(),
        // Node 会话都写 traceID；缺失时（极旧的会话）链路 ID 取会话 ID。
        trace: TraceId::new(row.trace_id.as_deref().unwrap_or(&row.id)),
        created_at_ms: u64::try_from(row.time_created).unwrap_or(0),
    }
}

/// Node `ModelSelection` → 内核的模型选择。
fn kernel_selection(selection: &Value) -> ModelSelection {
    let text = |value: &Value| value.as_str().unwrap_or("").to_owned();
    ModelSelection {
        provider: text(&selection["providerId"]),
        model: text(&selection["modelId"]),
        reasoning: selection["options"]["reasoningLevel"]
            .as_str()
            .map(str::to_owned),
        connection: None,
    }
}

/// 团队项目（工作线 F49，node-store.md §5 第 5 条）：`nibi-kernel/model_connection` 的 `providerId` / `modelId` 与 Node 的
/// 选择相同才用（Node 或 App 之后换过模型时不套用）；三个 ID 都要是去空白后非空的字符串。
fn with_connection(
    conn: &Connection,
    session: &SessionId,
    mut selection: ModelSelection,
) -> Result<ModelSelection, StoreError> {
    let Some(data) =
        state::last_entry(conn, session.as_str(), records::MODEL_CONNECTION_ENTRY).storage()?
    else {
        return Ok(selection);
    };
    let matches = data["providerId"] == selection.provider.as_str()
        && data["modelId"] == selection.model.as_str();
    let connection = serde_json::from_value::<ModelConnection>(data["connection"].clone())
        .ok()
        .filter(|connection| {
            [
                &connection.product_id,
                &connection.organization_id,
                &connection.project_id,
            ]
            .iter()
            .all(|id| !nibi_kernel_base::js::string::trim(id).is_empty())
        });
    if matches {
        selection.connection = connection.map(Box::new);
    }
    Ok(selection)
}

/// Node 执行状态对应的权限模式与 plan 开关（修复线 F20）；`nibi-kernel/permission_mode` 记的模式与执行状态一致时用它
/// （区分 default 与 dontAsk），Node 续写改过模式后以 Node 为准。
fn execution_state(
    conn: &Connection,
    row: &SessionRow,
) -> Result<Option<ExecutionState>, StoreError> {
    let Some(execution) = state::execution(conn, row).storage()? else {
        return Ok(None);
    };
    let named = state::last_entry(conn, &row.id, PERMISSION_MODE_ENTRY)
        .storage()?
        .and_then(|data| data["mode"].as_str().and_then(mode::from_entry_name));
    Ok(Some(mode::read(&execution, named)))
}

#[cfg(test)]
#[path = "load_turn_tests.rs"]
mod turn_tests;
