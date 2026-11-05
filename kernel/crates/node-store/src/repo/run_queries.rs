//! 会话视角的 run 读面（141 审计 §9 第 2 项）：run 目录 + 详情页四个切片 + 产物字节。
//!
//! 与 `repo::dwf`（中枢视角的运行历史 + `GetWorkflowRun` 详情）分文件，理由与 Node 侧把
//! `DwfRunIntrospectionQueries` 拆出引擎端口同一条：这几条查询各自带一段「取数源为什么是
//! 这张表、排序为什么是这个、界为什么在这里」的论证，混进 `dwf.rs` 会让那个文件既有终态
//! 拆解又有分页策略，而它们的读者不是同一批。
//!
//! **授权链**（六条查询共用，顺序不可换）：
//!
//! ```text
//! 调用方给的 runId
//!     ├─① dwf_run 行存在吗？                         否 ⇒ 拒绝（空 / None）
//!     ├─② 该行的 parent_session_id == 本会话吗？      否 ⇒ 拒绝
//!     └─③ 才碰 dwf_node / dwf_event / store
//! ```
//!
//! 目录清单也授权（`parent_session_id = ?` 直接进 WHERE）；其余五条先走 ①②，再查数据。
//! `parent_session_id` 为 NULL 的老行**不放行**：「无从判定」不是「判定通过」。

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};
use nibi_kernel_api::workflow::{
    WorkflowRunArtifactDetail, WorkflowRunArtifactItem, WorkflowRunArtifactItemPage,
    WorkflowRunArtifactItemQuery, WorkflowRunArtifactVersion, WorkflowRunEventPage,
    WorkflowRunEventQuery, WorkflowRunEventRow, WorkflowRunNodeResult, WorkflowRunSummaryRow,
    WorkflowRunWorkspaceNode, WorkflowRunWorkspaceSummary,
};

/// 事件载荷的结构界（Node `DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS` 的镜像）。
///
/// 界是**结构性的**（字符串长度 / 数组条数 / 键数 / 深度）而不是字节总量：结构界可以逐字段
/// 就地施加，不会因为一个巨大字段把其余字段一起丢掉。两个天然无界的字段正是它存在的理由：
/// `actor-created` 的 `persona.system`（整段 system prompt）与 node 级错误的 `finalText`。
mod limits {
    pub const MAX_STRING_LENGTH: usize = 2_048;
    pub const MAX_ARRAY_ITEMS: usize = 32;
    pub const MAX_KEYS: usize = 32;
    pub const MAX_DEPTH: usize = 6;
}

/// 授权链 ①②：`run_id` 存在且属于 `session` 才放行。
///
/// 只回 `bool` 而不是整行：调用方要的是「能不能读」，其余五条读面各自再查自己需要的列（它们
/// 的投影互不相同，合成一个带全部字段的结构只会让每个调用点拿到一堆用不上的值）。
/// `parent_session_id` 为 NULL 的老行**不放行**——「无从判定」不是「判定通过」。
fn owns_run(conn: &Connection, session: &str, run_id: &str) -> Result<bool> {
    let parent: Option<Option<String>> = conn
        .query_row(
            "select parent_session_id from dwf_run where id = ?",
            params![run_id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(parent.flatten().as_deref() == Some(session))
}

/// resume 门的唯一谓词（Node `isResumableSettlement`）：**stopped 即可恢复**，除了
/// `superseded`——它的未完结工作已归后继所有。
fn resumable(status: &str, stop_reason: Option<&str>) -> bool {
    status == "stopped" && stop_reason != Some("superseded")
}

/// 本会话发起的 run 目录，最近更新在前（`order by time_updated desc, id desc`——与 Node 的
/// `listRunsByParentSession` 逐字同序；同刻的两行靠 id 定序，结果稳定）。
pub fn summaries(
    conn: &Connection,
    session: &str,
    limit: usize,
) -> Result<Vec<WorkflowRunSummaryRow>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let limit = i64::try_from(limit).unwrap_or(i64::MAX);
    let mut query = conn.prepare_cached(
        "select id, name, script_text, tool_call_id, resumed_from, status, failure_json,
                time_created, time_updated
         from dwf_run where parent_session_id = ?
         order by time_updated desc, id desc limit ?",
    )?;
    let rows = query.query_map(params![session, limit], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            id,
            name,
            script_text,
            tool_call_id,
            resumed_from,
            status,
            failure_json,
            _created,
            updated,
        ) = row?;
        let settlement = super::dwf::settlement_of(status.as_str(), failure_json.as_deref());
        let label = match name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            Some(name) => name.to_owned(),
            None => super::dwf::derived_label(script_text.as_deref(), &id),
        };
        // 终态行才报 failure（stopped(provider|interrupted) / errored）；运行中的行没有失败可说。
        let (failure_code, failure_message) = match &settlement.failure {
            Some((code, message)) => (Some(code.clone()), Some(message.clone())),
            None => (None, None),
        };
        out.push(WorkflowRunSummaryRow {
            run_id: id,
            tool_call_id,
            label,
            updated_at: (updated > 0).then_some(updated as u64),
            resumable: resumable(&settlement.status, settlement.stop_reason.as_deref()),
            status: settlement.status,
            stop_reason: settlement.stop_reason,
            resumed_from,
            superseded_by: settlement.superseded_by,
            failure_code,
            failure_message,
        });
    }
    Ok(out)
}

/// 事件日志的一页。条数与字节两道界同时生效：条数到 `limit`、或再加一行就超 `max_bytes`
/// 时收尾，**第一行总是带上**（一行超界的载荷自成一页，否则翻页永远卡住）。
///
/// 实现照 Node 的 `pageEventRows`：窗口只作用在 `octet_length(payload_json)` 上——SQLite 对
/// `octet_length` 只读行头里的长度、不碰载荷本身，于是「哪几行进页」在不读任何载荷的前提下
/// 就定了；外层的 `case` 是惰性的，只有进页的行才真的把载荷读出来，收尾处那一行（它的存在
/// 就是 `has_more`）一个字节都不读。
pub fn events(
    conn: &Connection,
    session: &str,
    run_id: &str,
    query: WorkflowRunEventQuery,
) -> Result<WorkflowRunEventPage> {
    if query.limit == 0 || !owns_run(conn, session, run_id)? {
        return Ok(WorkflowRunEventPage {
            events: Vec::new(),
            has_more: false,
        });
    }
    let cursor = query.after_sequence.map_or("", |_| " and sequence > ?");
    let mut statement = conn.prepare_cached(&format!(
        "with sized as (
           select sequence, octet_length(payload_json) as bytes
           from dwf_event
           where run_id = ?{cursor}
           order by sequence
           limit ?
         ),
         ranked as (
           select sequence,
                  row_number() over (order by sequence) as rn,
                  sum(bytes) over (order by sequence rows unbounded preceding) as through
           from sized
         )
         select r.sequence, e.type,
                case when r.rn = 1 or (r.rn <= ? and r.through <= ?) then e.payload_json end
                  as payload_json
         from ranked r
         join dwf_event e on e.run_id = ? and e.sequence = r.sequence
         order by r.sequence"
    ))?;
    let limit = i64::try_from(query.limit).unwrap_or(i64::MAX);
    let max_bytes = i64::try_from(query.max_bytes).unwrap_or(i64::MAX).max(0);
    let mut bindings: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(run_id.to_owned())];
    if let Some(after) = query.after_sequence {
        bindings.push(Box::new(i64::try_from(after).unwrap_or(i64::MAX)));
    }
    // 多取一行：它不进页，它的存在就是 has_more。
    bindings.push(Box::new(limit.saturating_add(1)));
    bindings.push(Box::new(limit));
    bindings.push(Box::new(max_bytes));
    bindings.push(Box::new(run_id.to_owned()));
    let rows = statement.query_map(
        rusqlite::params_from_iter(bindings.iter().map(std::convert::AsRef::as_ref)),
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        },
    )?;
    let mut events = Vec::new();
    let mut has_more = false;
    for row in rows {
        let (sequence, event_type, payload_json) = row?;
        let Some(payload_json) = payload_json else {
            // `through` 单调不减，所以进页的行恰是一段前缀：第一处没有载荷的地方就是页尾。
            has_more = true;
            break;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&payload_json) else {
            continue;
        };
        // `type` 取 `type` 列（下推用的冗余），payload = 其余字段。落库的 payload 是完整的
        // RunEvent（含 `type`），读面因此把那个键摘掉——与 Node 的 `toProtocolEvent` 同形。
        let mut payload = value.as_object().cloned().unwrap_or_default();
        payload.remove("type");
        let (payload, truncated) = bound_payload(payload);
        events.push(WorkflowRunEventRow {
            sequence: u64::try_from(sequence).unwrap_or(0),
            r#type: event_type,
            payload: serde_json::Value::Object(payload),
            truncated,
        });
    }
    Ok(WorkflowRunEventPage { events, has_more })
}

/// 载荷按结构界裁剪（Node `boundDynamicWorkflowRunEventPayload` 的移植）：
/// 超长字符串切尾、超长数组去尾、超键数对象截键、超深度的整段省略，任一发生即 `truncated`。
/// 非有限数折叠成 `null`（`JSON.stringify` 的语义），使落库前后同形。
fn bound_payload(
    payload: serde_json::Map<String, serde_json::Value>,
) -> (serde_json::Map<String, serde_json::Value>, bool) {
    let mut truncated = false;
    let value = bound_value(serde_json::Value::Object(payload), 0, &mut truncated);
    match value {
        serde_json::Value::Object(map) => (map, truncated),
        _ => (serde_json::Map::new(), truncated),
    }
}

fn bound_value(value: serde_json::Value, depth: usize, truncated: &mut bool) -> serde_json::Value {
    use serde_json::Value;
    match value {
        // null / 布尔原样（`value` 已被 match 借用检查器收走，这里直接重建）。
        Value::Null => Value::Null,
        Value::Bool(flag) => Value::Bool(flag),
        Value::Number(number) => {
            if number.is_f64() && number.as_f64().is_some_and(|value| !value.is_finite()) {
                *truncated = true;
                Value::Null
            } else {
                Value::Number(number)
            }
        }
        Value::String(text) => {
            if text.chars().count() <= limits::MAX_STRING_LENGTH {
                Value::String(text)
            } else {
                *truncated = true;
                Value::String(text.chars().take(limits::MAX_STRING_LENGTH).collect())
            }
        }
        Value::Array(items) => {
            if depth >= limits::MAX_DEPTH {
                *truncated = true;
                return Value::Null;
            }
            if items.len() > limits::MAX_ARRAY_ITEMS {
                *truncated = true;
            }
            Value::Array(
                items
                    .into_iter()
                    .take(limits::MAX_ARRAY_ITEMS)
                    .map(|item| bound_value(item, depth + 1, truncated))
                    .collect(),
            )
        }
        Value::Object(map) => {
            if depth >= limits::MAX_DEPTH {
                *truncated = true;
                return Value::Null;
            }
            if map.len() > limits::MAX_KEYS {
                *truncated = true;
            }
            let mut out = serde_json::Map::new();
            for (key, item) in map.into_iter().take(limits::MAX_KEYS) {
                out.insert(key, bound_value(item, depth + 1, truncated));
            }
            Value::Object(out)
        }
    }
}

/// 一个 run 的用户面产物清单（全量版本，版本升序；交付物带头）。
///
/// 归并规则与 Node `artifactsOf` 逐字相同：
///   - 只收 `completed` 的行（失败的发布不占 id、不占版本号）；
///   - 同 id 按 `version` 升序，顶层字段取**最新版**的值；
///   - `itemCount` = 打了这个 id 标签的 `report` 行数（内容产物恒 0）。
///
/// 未知 / 不是你的 run → `None`（网关归一成空清单）。
pub fn artifacts(
    conn: &Connection,
    session: &str,
    run_id: &str,
) -> Result<Option<Vec<WorkflowRunArtifactDetail>>> {
    if !owns_run(conn, session, run_id)? {
        return Ok(None);
    }
    let mut statement = conn.prepare_cached(
        "select artifact_id, result_json from dwf_node
         where run_id = ? and kind = 'artifact' and status = 'completed' order by id",
    )?;
    let rows = statement
        .query_map(params![run_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // id → 版本表。插入顺序 = 首次出现顺序（协议契约上 artifacts 的顺序）。
    let mut order: Vec<String> = Vec::new();
    let mut by_id: std::collections::HashMap<String, (String, Vec<WorkflowRunArtifactVersion>)> =
        std::collections::HashMap::new();
    for (artifact_id, result_json) in rows {
        let Some(record) =
            result_json.and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        else {
            continue;
        };
        let Some(version) = record["version"].as_u64().filter(|version| *version >= 1) else {
            continue;
        };
        let Some(kind) = record["kind"].as_str().filter(|kind| {
            matches!(
                *kind,
                "file" | "markdown" | "chart" | "table" | "metrics" | "board"
            )
        }) else {
            continue;
        };
        let id = match artifact_id.filter(|id| !id.is_empty()) {
            Some(id) => id,
            None => match record["id"].as_str().filter(|id| !id.is_empty()) {
                Some(id) => id.to_owned(),
                None => continue,
            },
        };
        let entry = by_id.entry(id.clone()).or_insert_with(|| {
            order.push(id.clone());
            (kind.to_owned(), Vec::new())
        });
        entry.1.push(WorkflowRunArtifactVersion {
            version,
            title: record["title"].as_str().map(str::to_owned),
            description: record["description"].as_str().map(str::to_owned),
            content_type: record["contentType"].as_str().map(str::to_owned),
            bytes: record["bytes"].as_u64(),
            uri: record["uri"].as_str().map(str::to_owned),
            source_path: record["sourcePath"].as_str().map(str::to_owned),
            spec: record.get("spec").cloned(),
            // driver 恒写 `publishedAt`；缺席给 0 而不是丢行（一个没有时间戳的产物仍可看，
            // 丢掉它会让版本号在 UI 上出现空洞）。
            published_at: record["publishedAt"].as_u64().unwrap_or(0),
            primary: (record["primary"] == serde_json::Value::Bool(true)).then_some(true),
        });
    }
    if by_id.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let counts = super::dwf::tagged_report_counts(conn, run_id)?;
    let mut out: Vec<WorkflowRunArtifactDetail> = order
        .into_iter()
        .filter_map(|id| {
            let (kind, mut versions) = by_id.remove(&id)?;
            versions.sort_by_key(|version| version.version);
            let latest = versions.last()?.clone();
            let is_preset = matches!(kind.as_str(), "chart" | "table" | "metrics" | "board");
            // 旗子按 id 粘着（引擎保证后续版本都带），任一版带上即算——老 CLI 落的行没有这个键。
            let primary = versions.iter().any(|version| version.primary == Some(true));
            Some(WorkflowRunArtifactDetail {
                id: id.clone(),
                kind,
                title: latest.title,
                description: latest.description,
                content_type: latest.content_type,
                source_path: latest.source_path,
                spec: latest.spec,
                version: latest.version,
                versions,
                item_count: if is_preset {
                    counts.get(&id).copied().unwrap_or(0)
                } else {
                    0
                },
                primary: primary.then_some(true),
            })
        })
        .collect();
    // 交付物带头，其余保持首次发布顺序（稳定排序）。
    out.sort_by_key(|artifact| std::cmp::Reverse(artifact.primary));
    Ok(Some(out))
}

/// 喂给某个预置产物的 `report` 条目的一页（`v4/conversation/workflowRunArtifactData`）。
///
/// 取数源是 **dwf_event 而不是 dwf_node**，尽管两张表都记了同一批标签 report——理由是游标：
/// UI 以事件日志那一套 `sequence` 增量拉取，而 `dwf_node` 上没有 sequence。
/// `type = 'report'` 一并入条件：`type` 列是为下推而存的冗余，少了它一条恰好带
/// `artifactId` 的别种事件会混进看板的数据流。未打标签的 report 天然被排除（payload 里
/// 根本没有 `artifactId` 键，`json_extract` 给 NULL）。
pub fn artifact_items(
    conn: &Connection,
    session: &str,
    run_id: &str,
    query: &WorkflowRunArtifactItemQuery,
) -> Result<WorkflowRunArtifactItemPage> {
    if query.limit == 0 || !owns_run(conn, session, run_id)? {
        return Ok(WorkflowRunArtifactItemPage {
            items: Vec::new(),
            has_more: false,
        });
    }
    let cursor = query.after_sequence.map_or("", |_| " and e.sequence > ?");
    let mut statement = conn.prepare_cached(&format!(
        "with sized as (
           select e.sequence, octet_length(e.payload_json) as bytes
           from dwf_event e
           where e.run_id = ?
             and e.type = 'report'
             and json_extract(e.payload_json, '$.artifactId') = ?{cursor}
           order by e.sequence
           limit ?
         ),
         ranked as (
           select sequence,
                  row_number() over (order by sequence) as rn,
                  sum(bytes) over (order by sequence rows unbounded preceding) as through
           from sized
         )
         select r.sequence,
                case when r.rn = 1 or (r.rn <= ? and r.through <= ?) then e.payload_json end
                  as payload_json
         from ranked r
         join dwf_event e on e.run_id = ? and e.sequence = r.sequence
         order by r.sequence"
    ))?;
    let limit = i64::try_from(query.limit).unwrap_or(i64::MAX);
    let max_bytes = i64::try_from(query.max_bytes).unwrap_or(i64::MAX).max(0);
    let mut bindings: Vec<Box<dyn rusqlite::ToSql>> = vec![
        Box::new(run_id.to_owned()),
        Box::new(query.artifact_id.clone()),
    ];
    if let Some(after) = query.after_sequence {
        bindings.push(Box::new(i64::try_from(after).unwrap_or(i64::MAX)));
    }
    bindings.push(Box::new(limit.saturating_add(1)));
    bindings.push(Box::new(limit));
    bindings.push(Box::new(max_bytes));
    bindings.push(Box::new(run_id.to_owned()));
    let rows = statement.query_map(
        rusqlite::params_from_iter(bindings.iter().map(std::convert::AsRef::as_ref)),
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<String>>(1)?)),
    )?;
    let mut items = Vec::new();
    let mut has_more = false;
    for row in rows {
        let (sequence, payload_json) = row?;
        let Some(payload_json) = payload_json else {
            has_more = true;
            break;
        };
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(&payload_json) else {
            continue;
        };
        let Some(site_id) = payload["instance"]["siteId"].as_str() else {
            continue;
        };
        let ordinal = payload["instance"]["ordinal"].as_u64().unwrap_or(0);
        let item = payload.get("item").cloned();
        let fields = query.fields.as_ref().and_then(|paths| {
            let item = item.as_ref()?;
            let mut out = serde_json::Map::new();
            for path in paths {
                if let Some(value) =
                    nibi_kernel_api::workflow::read_workflow_artifact_field(item, path)
                {
                    out.insert(
                        path.clone(),
                        clip_field_value(value, query.max_field_value_bytes),
                    );
                }
            }
            Some(serde_json::Value::Object(out))
        });
        items.push(WorkflowRunArtifactItem {
            sequence: u64::try_from(sequence).unwrap_or(0),
            site_id: site_id.to_owned(),
            ordinal,
            item: if fields.is_some() { None } else { item },
            fields,
        });
    }
    Ok(WorkflowRunArtifactItemPage { items, has_more })
}

/// 一个字段值的序列化字节上界：超过的值回成一段截短的字符串（前 1000 个字符加「…」）。
/// 图表只用数值，表格与看板的格子本来就只显示短文本。
fn clip_field_value(value: serde_json::Value, max_bytes: u64) -> serde_json::Value {
    const CLIPPED_CHARS: usize = 1_000;
    let serialized = serde_json::to_vec(&value).unwrap_or_default();
    if u64::try_from(serialized.len()).unwrap_or(u64::MAX) <= max_bytes {
        return value;
    }
    let text = match &value {
        serde_json::Value::String(text) => text.chars().take(CLIPPED_CHARS).collect::<String>(),
        other => serde_json::to_string(other)
            .unwrap_or_default()
            .chars()
            .take(CLIPPED_CHARS)
            .collect::<String>(),
    };
    serde_json::Value::String(format!("{text}…"))
}

/// 一个 run 的工作区 transcript 清单（`world-read` / `world-run` 行，不带正文）。
///
/// **不取 `result_json`**：这条读面是清单（op / args / 状态 / 时间），正文另有按
/// `(siteId, ordinal)` 的读面——一页 256 个节点把每个 256 KB 的 stdout 一起解出来，等于把整条
/// journal 读进内存。摘要里的几个数由 SQLite 在库内算出（`result_bytes` / `result_count` /
/// `exit_code` / 两路字节）。
pub fn workspace_nodes(
    conn: &Connection,
    session: &str,
    run_id: &str,
) -> Result<Option<Vec<WorkflowRunWorkspaceNode>>> {
    if !owns_run(conn, session, run_id)? {
        return Ok(None);
    }
    let mut statement = conn.prepare_cached(
        "select site_id, ordinal, kind, status, error_json, input_json,
                length(cast(result_json as blob)) as result_bytes,
                case when json_type(result_json) = 'array' then json_array_length(result_json) end
                  as result_count,
                case when json_type(result_json) = 'object'
                  then json_extract(result_json, '$.exitCode') end as exit_code,
                case when json_type(result_json) = 'object'
                  then length(cast(json_extract(result_json, '$.stdout') as blob)) end as stdout_bytes,
                case when json_type(result_json) = 'object'
                  then length(cast(json_extract(result_json, '$.stderr') as blob)) end as stderr_bytes,
                time_created, time_updated
         from dwf_node
         where run_id = ? and kind in ('world-read', 'world-run')
         order by id",
    )?;
    let rows = statement.query_map(params![run_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<i64>>(6)?,
            row.get::<_, Option<i64>>(7)?,
            row.get::<_, Option<i64>>(8)?,
            row.get::<_, Option<i64>>(9)?,
            row.get::<_, Option<i64>>(10)?,
            row.get::<_, i64>(11)?,
            row.get::<_, i64>(12)?,
        ))
    })?;
    let mut nodes = Vec::new();
    for row in rows {
        let (
            site_id,
            ordinal,
            kind,
            status,
            error_json,
            input_json,
            result_bytes,
            result_count,
            exit_code,
            stdout_bytes,
            stderr_bytes,
            created_at,
            updated_at,
        ) = row?;
        // 0030 之前的行、以及 ask / report / artifact 行的 input_json 都是 NULL → 缺席。
        let input =
            input_json.and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        let error = error_json.and_then(|text| {
            let value = serde_json::from_str::<serde_json::Value>(&text).ok()?;
            Some(nibi_kernel_api::workflow::WorkflowRunError {
                code: value["code"].as_str()?.to_owned(),
                message: clip_message(value["message"].as_str()?),
            })
        });
        // 摘要只有结算成功（有正文）的行才有。
        let summary = match (status.as_str(), result_bytes) {
            ("completed", Some(bytes)) => Some(WorkflowRunWorkspaceSummary {
                result_bytes: bytes.max(0) as u64,
                result_count: result_count.map(|count| count.max(0) as u64),
                exit_code,
                stdout_bytes: stdout_bytes.map(|bytes| bytes.max(0) as u64),
                stderr_bytes: stderr_bytes.map(|bytes| bytes.max(0) as u64),
            }),
            _ => None,
        };
        let mut node = WorkflowRunWorkspaceNode {
            site_id,
            ordinal: ordinal.max(0) as u64,
            kind: if kind == "world-run" {
                "world-run"
            } else {
                "world-read"
            }
            .to_owned(),
            op: None,
            args: None,
            input_truncated: None,
            status,
            error,
            summary,
            created_at: created_at.max(0) as u64,
            updated_at: updated_at.max(0) as u64,
        };
        if let Some(input) = input
            && let Some(op) = input["op"].as_str()
        {
            node.op = Some(op.to_owned());
            node.args = Some(input["args"].as_array().cloned().unwrap_or_default());
            if input["truncated"] == serde_json::Value::Bool(true) {
                node.input_truncated = Some(true);
            }
        }
        nodes.push(node);
    }
    Ok(Some(nodes))
}

/// 失败信息的展示长度（= 协议侧 `WORKFLOW_WORKSPACE_LIMITS.maxErrorMessageLength`）。
const ERROR_MESSAGE_MAX_CHARS: usize = 2000;

fn clip_message(message: &str) -> String {
    if message.chars().count() > ERROR_MESSAGE_MAX_CHARS {
        let mut clipped: String = message.chars().take(ERROR_MESSAGE_MAX_CHARS - 1).collect();
        clipped.push('…');
        clipped
    } else {
        message.to_owned()
    }
}

/// 一个工作区节点的正文，按 `max_bytes` **保形**有界化（Node `boundWorkspaceResult` 的移植）。
///
/// 引擎侧 `WORLD_READ_CAPS` 的政策是「溢出即拒绝」——那是脚本的取数面，半份 grep 结果会让脚本
/// 做错决定。这里是审计面：一张卡片要的是「跑了什么、前几百行是什么」，截断并**说明**截断
/// （`truncated` + `totalBytes`）比一个「太大读不了」有用得多。
pub fn node_result(
    conn: &Connection,
    session: &str,
    run_id: &str,
    site_id: &str,
    ordinal: u64,
    max_bytes: u64,
) -> Result<Option<WorkflowRunNodeResult>> {
    if !owns_run(conn, session, run_id)? {
        return Ok(None);
    }
    let row: Option<(String, Option<String>, Option<String>)> = conn
        .query_row(
            "select status, result_json, error_json from dwf_node
             where run_id = ? and site_id = ? and ordinal = ? and kind in ('world-read', 'world-run')",
            params![run_id, site_id, i64::try_from(ordinal).unwrap_or(i64::MAX)],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((status, result_json, error_json)) = row else {
        return Ok(None);
    };
    let error = error_json.and_then(|text| {
        let value = serde_json::from_str::<serde_json::Value>(&text).ok()?;
        Some(nibi_kernel_api::workflow::WorkflowRunError {
            code: value["code"].as_str()?.to_owned(),
            message: clip_message(value["message"].as_str()?),
        })
    });
    if status == "failed" {
        return Ok(Some(WorkflowRunNodeResult {
            status,
            result: None,
            error,
            truncated: false,
            total_bytes: 0,
        }));
    }
    let Some(result_json) = result_json else {
        return Ok(Some(WorkflowRunNodeResult {
            status,
            result: None,
            error,
            truncated: false,
            total_bytes: 0,
        }));
    };
    let Ok(result) = serde_json::from_str::<serde_json::Value>(&result_json) else {
        return Ok(Some(WorkflowRunNodeResult {
            status,
            result: None,
            error,
            truncated: false,
            total_bytes: 0,
        }));
    };
    let bounded = bound_workspace_result(result, max_bytes);
    Ok(Some(WorkflowRunNodeResult {
        status,
        result: Some(bounded.result),
        error,
        truncated: bounded.truncated,
        total_bytes: bounded.total_bytes,
    }))
}

struct Bounded {
    result: serde_json::Value,
    truncated: bool,
    total_bytes: u64,
}

fn utf8_len(text: &str) -> u64 {
    u64::try_from(text.len()).unwrap_or(u64::MAX)
}

/// 把字符串切到 ≤ `max_bytes` 个 UTF-8 字节，不切在多字节序列中间。
fn truncate_utf8(text: &str, max_bytes: u64) -> String {
    if utf8_len(text) <= max_bytes {
        return text.to_owned();
    }
    let budget = usize::try_from(max_bytes)
        .unwrap_or(usize::MAX)
        .min(text.len());
    let mut end = budget;
    // 去掉尾部不完整的多字节序列：宁可少一个字符，也不要让解码把它换成 U+FFFD。
    while end > 0 && (text.as_bytes()[end - 1] & 0b1100_0000) == 0b1000_0000 {
        end -= 1;
    }
    if end > 0 && (text.as_bytes()[end - 1] & 0b1100_0000) == 0b1100_0000 {
        end -= 1;
    }
    text[..end].to_owned()
}

/// 按正文形状有界化：
/// - 字符串（read / diff / status）：切尾；
/// - 数组（glob / grep / changedFiles / log）：逐项累加，放不下的去尾；
/// - `world.run` 的 `{exitCode, stdout, stderr}`：exitCode 恒保留，两路输出共用剩余预算
///   （各占一半，一路用不完的余额让给另一路）；
/// - 其它：序列化后不超限原样，超限退化成切尾的 JSON 文本（形状已不可保）。
fn bound_workspace_result(result: serde_json::Value, max_bytes: u64) -> Bounded {
    let serialized = serde_json::to_vec(&result).unwrap_or_default();
    let total_bytes = u64::try_from(serialized.len()).unwrap_or(u64::MAX);
    if total_bytes <= max_bytes {
        return Bounded {
            result,
            truncated: false,
            total_bytes,
        };
    }
    match result {
        serde_json::Value::String(text) => Bounded {
            result: serde_json::Value::String(truncate_utf8(&text, max_bytes)),
            truncated: true,
            total_bytes,
        },
        serde_json::Value::Array(items) => {
            let mut kept = Vec::new();
            let mut used: u64 = 2; // 方括号
            for item in items {
                let item_bytes = serde_json::to_vec(&item)
                    .map(|bytes| u64::try_from(bytes.len()).unwrap_or(u64::MAX))
                    .unwrap_or(0)
                    .saturating_add(1);
                if used.saturating_add(item_bytes) > max_bytes {
                    break;
                }
                used = used.saturating_add(item_bytes);
                kept.push(item);
            }
            Bounded {
                result: serde_json::Value::Array(kept),
                truncated: true,
                total_bytes,
            }
        }
        serde_json::Value::Object(fields)
            if fields
                .get("exitCode")
                .is_some_and(serde_json::Value::is_number)
                && fields
                    .get("stdout")
                    .is_some_and(serde_json::Value::is_string)
                && fields
                    .get("stderr")
                    .is_some_and(serde_json::Value::is_string) =>
        {
            let stdout = fields["stdout"].as_str().unwrap_or("").to_owned();
            let stderr = fields["stderr"].as_str().unwrap_or("").to_owned();
            // 除两路输出之外的开销（exitCode + 键名 + 花括号）。
            let mut overhead = fields.clone();
            overhead.insert(
                "stdout".to_owned(),
                serde_json::Value::String(String::new()),
            );
            overhead.insert(
                "stderr".to_owned(),
                serde_json::Value::String(String::new()),
            );
            let overhead_bytes = serde_json::to_vec(&serde_json::Value::Object(overhead))
                .map(|bytes| u64::try_from(bytes.len()).unwrap_or(u64::MAX))
                .unwrap_or(0);
            let budget = max_bytes.saturating_sub(overhead_bytes);
            let stderr_want = utf8_len(&stderr);
            let stdout_want = utf8_len(&stdout);
            // 各分一半；一路用不完的余额让给另一路。
            let stderr_budget =
                stderr_want.min((budget / 2).max(budget.saturating_sub(stdout_want)));
            let stdout_budget = budget.saturating_sub(stderr_budget);
            let mut bounded = serde_json::Map::new();
            for (key, value) in fields {
                let bounded_value = match key.as_str() {
                    "stdout" if value.is_string() => {
                        serde_json::Value::String(truncate_utf8(&stdout, stdout_budget))
                    }
                    "stderr" if value.is_string() => {
                        serde_json::Value::String(truncate_utf8(&stderr, stderr_budget))
                    }
                    _ => value,
                };
                bounded.insert(key, bounded_value);
            }
            Bounded {
                result: serde_json::Value::Object(bounded),
                truncated: true,
                total_bytes,
            }
        }
        other => Bounded {
            result: serde_json::Value::String(truncate_utf8(&other.to_string(), max_bytes)),
            truncated: true,
            total_bytes,
        },
    }
}

/// 一个产物版本的字节：run 属于本会话 ∧ journal 里有 `(artifactId, version)` 的 completed 行
/// → 才拿**行上的** uri 去读 store。返回 `(bytes, 行上的 contentType)`。
///
/// 五个拒绝理由（无此 run / 不是你的 / 无此版本 / 无 uri 的块看板 / store 里没这份文件）对调用
/// 方是同一个业务事实，全部归一成 `None`。
pub fn artifact_version_uri(
    conn: &Connection,
    session: &str,
    run_id: &str,
    artifact_id: &str,
    version: u64,
) -> Result<Option<(String, Option<String>)>> {
    if !owns_run(conn, session, run_id)? {
        return Ok(None);
    }
    let mut statement = conn.prepare_cached(
        "select artifact_id, result_json from dwf_node
         where run_id = ? and kind = 'artifact' and status = 'completed' order by id",
    )?;
    let rows = statement
        .query_map(params![run_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (row_artifact_id, result_json) in rows {
        let Some(record) =
            result_json.and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        else {
            continue;
        };
        // 行的 artifact_id 列优先；老行按记录里的 id 兜底（两者由引擎在同一次 putNode 写下）。
        let id = row_artifact_id.filter(|id| !id.is_empty());
        let id = match id.as_deref() {
            Some(id) => id,
            None => match record["id"].as_str() {
                Some(id) if !id.is_empty() => id,
                _ => continue,
            },
        };
        if id != artifact_id {
            continue;
        }
        if record["version"].as_u64() != Some(version) {
            continue;
        }
        let Some(uri) = record["uri"].as_str().filter(|uri| !uri.is_empty()) else {
            return Ok(None);
        };
        let content_type = record["contentType"]
            .as_str()
            .filter(|value| !value.is_empty());
        return Ok(Some((uri.to_owned(), content_type.map(str::to_owned))));
    }
    Ok(None)
}

#[cfg(test)]
#[path = "run_queries_tests.rs"]
mod tests;
