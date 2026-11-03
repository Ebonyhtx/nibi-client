//! v4 查询面（141 审计 §9 第 2 项）：usage 2 条 + run 详情 7 条。
//!
//! 这九条方法在 Host 侧全是 live（`V4_METHODS` 实发），而 Rust 内核此前一条都不受理——
//! 桌面切到 Rust 后用量页与 run 详情页会整体空白。数据全在内核侧的会话库（`model_usage` /
//! `turn_usage` / `tool_usage` / `dwf_run` / `dwf_node` / `dwf_event`），所以这一族是**纯投影
//! 与分页**：没有新表、没有新写入面。
//!
//! 参数契约从 Host 的 zod 逐字（`.strict()`：未知键与类型错一律 `-32602`，message 前缀同形
//! ——`Invalid params — …`，与 `nibi_workflows.rs` 同一套 helper 语义）。两个要点：
//!
//! - **界在哪里执行**。条数上限（事件 500 / 看板条目 500 / 工作区 2000）与字节上界（16 MiB 的
//!   四分之一）在**这里**钳，存储层精确兑现、不另加天花板；`maxBytes` 也只能被钳小，renderer
//!   不能放宽。
//! - **拒绝长什么样**。run 不属于本会话 / 不存在：清单与事件页回空（与 Node 的
//!   `V4CapabilityUnsupportedError` 之外的「未知 runId 回空清单」同一姿态），按
//!   `(siteId, ordinal)` 与按 `(artifactId, version)` 的单点读回结构化的 not found——那是
//!   「你点的那一张卡已经不在」与「整页读不出来」的区别。
//!
//! usage 两条**不经会话**：`v4/usage/stats` 是应用级聚合（任意已连接的工作区都能答），
//! `v4/conversation/usage` 才按 `sessionId` 取。时区不在内核里解析——请求给的是 IANA 名，而
//! 内核没有时区库；偏移取自注入的 [`Clock`](rust_cli_kernel_api::clock::Clock)（入口按系统时区
//! 建的那一个），请求里显式的 `timeZone` 因此在 Rust 内核下按本机时区归桶。

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::workflow::{
    WorkflowRunArtifactItemQuery, WorkflowRunEventQuery, WorkflowRunSummaryRow,
};
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::server::{SESSION_UNAVAILABLE, Server};

// ———— 协议常量（Host `packages/shared/src/nibi-protocol-v4/` 的镜像，数字即契约）————

/// `PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes`：逻辑帧上限 16 MiB。
const LOGICAL_FRAME_ASSEMBLY_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// `PROTOCOL_V4_LIMITS.attachmentChunkMaxBytes`：一次一块 512 KiB（产物字节读）。
const ATTACHMENT_CHUNK_MAX_BYTES: u64 = 512 * 1024;
/// `PROTOCOL_V4_LIMITS.attachmentMaxBytes`：单个产物 20 MiB（`ARTIFACT_CAPS.maxFileBytes` 同值）。
const ATTACHMENT_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// `WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents`。
const RUN_EVENTS_MAX: u64 = 500;
/// 事件页与看板页的字节上界：协议单帧上限的四分之一。条数单独管不住字节——500 条带着大
/// report item 的事件足以顶到单帧上限。
const RUN_PAGE_MAX_BYTES: u64 = LOGICAL_FRAME_ASSEMBLY_MAX_BYTES / 4;
/// `WORKFLOW_ARTIFACT_LIMITS.maxItemsPerPage`。
const ARTIFACT_ITEMS_MAX: u64 = 500;
/// `WORKFLOW_ARTIFACT_LIMITS.defaultItemsPerPage`。
const ARTIFACT_ITEMS_DEFAULT: u64 = 200;
/// `WORKFLOW_ARTIFACT_LIMITS.maxPageBytes`。
const ARTIFACT_PAGE_MAX_BYTES: u64 = LOGICAL_FRAME_ASSEMBLY_MAX_BYTES / 4;
/// `WORKFLOW_ARTIFACT_LIMITS.maxFieldsPerRequest` / `maxFieldPathLength` / `maxFieldValueBytes`。
const ARTIFACT_MAX_FIELDS: usize = 32;
const ARTIFACT_MAX_FIELD_PATH: usize = 256;
const ARTIFACT_MAX_FIELD_VALUE_BYTES: u64 = 4_096;
/// `WORKFLOW_WORKSPACE_LIMITS.maxNodes` / `resultMaxBytes`。
const WORKSPACE_MAX_NODES: usize = 2_000;
const WORKSPACE_RESULT_MAX_BYTES: u64 = 32 * 1024;
/// `PROTOCOL_V4_LIMITS.rowsRangeMaxLimit`：一次最多取这么多行。
const ROWS_RANGE_MAX_LIMIT: u64 = 200;
/// run 目录的上限与缺省（Node `MAX_LIST_RUNS_LIMIT` / `DEFAULT_LIST_RUNS_LIMIT`）。
/// 协议 schema 已把 `limit` 限在 [1, 64]，这里的常量只用于缺省值。
const RUNS_DEFAULT_LIMIT: usize = 16;

// ———— 参数校验（Host zod 的 `.strict()` 语义）————

fn invalid(message: impl std::fmt::Display) -> RpcError {
    RpcError::invalid_params(format!("Invalid params — {message}"))
}

/// 顶层入参的 `.strict()`：未知键与 Node 同样炸 `-32602`。
fn object(params: &Value) -> Result<&serde_json::Map<String, Value>, RpcError> {
    params
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))
}

fn strict_keys(params: &serde_json::Map<String, Value>, known: &[&str]) -> Result<(), RpcError> {
    for key in params.keys() {
        if !known.contains(&key.as_str()) {
            return Err(invalid(format!("Unrecognized key `{key}`")));
        }
    }
    Ok(())
}

fn required_string(params: &serde_json::Map<String, Value>, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("`{key}` must be a non-empty string")))
}

fn optional_u64(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<Option<u64>, RpcError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| invalid(format!("`{key}` must be a non-negative integer"))),
    }
}

fn required_u64(params: &serde_json::Map<String, Value>, key: &str) -> Result<u64, RpcError> {
    params
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid(format!("`{key}` must be a non-negative integer")))
}

// ———— 行分页与计划目录（历史回填）————

/// `v4/conversation/rowsRange`：按 `beforeRowId` 游标向上取一窗历史行（只读、无状态）。
///
/// 与 Node 的 `getRowsRange` 同一条口径：全序是 rowId 升序；取 `rowId < beforeRowId` 的最后 `limit`
/// 行；`hasMore` 是「这一窗之前还有没有」。数据源是会话投影的全量行（不是快照的 tail window）——
/// 冷会话经 `server.live()` 走与订阅相同的冷恢复管线先把投影建起来。
///
/// `clientMode` 目前不改变结果：Host 的 `filterConversationRowsForProfile` 今天是恒等函数
/// （没有 profile 专属的行种类），这里保留参数校验与方向，不发明过滤。
pub(crate) async fn rows_range(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(params, &["sessionId", "clientMode", "beforeRowId", "limit"])?;
    let session = params
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("`sessionId` must be a string"))?;
    if let Some(mode) = params.get("clientMode") {
        match mode {
            Value::String(value)
                if matches!(
                    value.as_str(),
                    "desktop-continuous" | "web-remote-replayable"
                ) => {}
            _ => {
                return Err(invalid(
                    "`clientMode` must be `desktop-continuous` or `web-remote-replayable`",
                ));
            }
        }
    }
    let before = optional_u64(params, "beforeRowId")?;
    let limit = required_u64(params, "limit")?;
    if limit == 0 || limit > ROWS_RANGE_MAX_LIMIT {
        return Err(invalid(format!(
            "`limit` must be between 1 and {ROWS_RANGE_MAX_LIMIT}"
        )));
    }
    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let live = server
        .live(&SessionId::new(session.to_owned()))
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    let all = live.sink.rows();
    let eligible: Vec<Value> = all
        .into_iter()
        .filter(|row| {
            before.is_none_or(|before| row["rowId"].as_u64().unwrap_or(0) < before)
        })
        .map(Value::Object)
        .collect();
    let start = eligible.len().saturating_sub(limit);
    let rows = eligible[start..].to_vec();
    let (_, revision) = live.sink.status();
    Ok(json!({
        "rows": rows,
        "atSeq": live.sink.seq(),
        "atRevision": revision,
        "atLogEpoch": live.sink.epoch(),
        "hasMore": eligible.len() > rows.len(),
    }))
}

/// 计划行的 `input.plan` 是不是一段非空 markdown（Node `hasPlanMarkdown`）。
fn plan_markdown(row: &serde_json::Map<String, Value>) -> bool {
    if let Some(plan) = row.get("input").and_then(|input| input.get("plan"))
        && plan.as_str().is_some_and(|plan| !plan.trim().is_empty())
    {
        return true;
    }
    let Some(text) = row.get("inputText").and_then(Value::as_str) else {
        return false;
    };
    if text.trim().is_empty() {
        return false;
    }
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|parsed| parsed.get("plan").and_then(Value::as_str).map(str::to_owned))
        .is_some_and(|plan| !plan.trim().is_empty())
}

/// `v4/conversation/plans`：当前有效分支的终态 `ExitPlanMode` 目录（rowId 降序）。
///
/// Node 的注释写明「目录来自完整有效 projection，不能用 renderer 的有界 tail window 推导」，
/// 这里读全量行（比 Node 实现里的 `snapshot.rows.window` 更完整）；终态判据是
/// `success` / `error` / `cancelled`，与 Host 的 `TERMINAL_PLAN_STATUSES` 同值。
pub(crate) async fn plans(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(params, &["sessionId"])?;
    let session = required_string(params, "sessionId")?;
    let live = server
        .live(&SessionId::new(session))
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    let mut plans: Vec<Value> = live
        .sink
        .rows()
        .into_iter()
        .filter(|row| {
            row["kind"] == "toolCall"
                && row["toolName"] == "ExitPlanMode"
                && matches!(
                    row["status"].as_str(),
                    Some("success" | "error" | "cancelled")
                )
                && plan_markdown(row)
        })
        .map(Value::Object)
        .collect();
    plans.sort_by(|left, right| {
        right["rowId"]
            .as_u64()
            .unwrap_or(0)
            .cmp(&left["rowId"].as_u64().unwrap_or(0))
    });
    Ok(json!({
        "plans": plans,
        "atSeq": live.sink.seq(),
        "atLogEpoch": live.sink.epoch(),
    }))
}

// ———— run 详情 + 目录 ————

/// `v4/conversation/workflowRuns`：本会话的 run 目录（最近更新在前）。
pub(crate) async fn workflow_runs(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(params, &["sessionId", "limit"])?;
    let session = required_string(params, "sessionId")?;
    // 协议 schema：`limit` 是 [1, 64] 的正整数，缺省由 CLI 侧给（`DEFAULT_LIST_RUNS_LIMIT`）。
    let limit = match optional_u64(params, "limit")? {
        Some(limit) if (1..=64).contains(&limit) => limit as usize,
        Some(_) => return Err(invalid("`limit` must be an integer between 1 and 64")),
        None => RUNS_DEFAULT_LIMIT,
    };
    let runs = server
        .kernel
        .workflow_run_summaries(&SessionId::new(session), limit)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    Ok(json!({ "runs": runs.iter().map(summary_json).collect::<Vec<_>>() }))
}

fn summary_json(row: &WorkflowRunSummaryRow) -> Value {
    let mut value = json!({
        "runId": row.run_id,
        "label": row.label,
        "status": row.status,
        "resumable": row.resumable,
    });
    if let Some(tool_call_id) = &row.tool_call_id {
        value["toolCallId"] = json!(tool_call_id);
    }
    if let Some(updated_at) = row.updated_at {
        value["updatedAt"] = json!(updated_at);
    }
    if let Some(stop_reason) = &row.stop_reason {
        value["stopReason"] = json!(stop_reason);
    }
    if let Some(resumed_from) = &row.resumed_from {
        value["resumedFrom"] = json!(resumed_from);
    }
    if let Some(superseded_by) = &row.superseded_by {
        value["supersededBy"] = json!(superseded_by);
    }
    if let Some(failure_code) = &row.failure_code {
        value["failureCode"] = json!(failure_code);
    }
    if let Some(failure_message) = &row.failure_message {
        value["failureMessage"] = json!(failure_message);
    }
    value
}

/// `v4/conversation/workflowRunEvents`：事件日志的一页（cursor = journal sequence）。
pub(crate) async fn workflow_run_events(
    server: &Server,
    params: &Value,
) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(params, &["sessionId", "runId", "afterSequence", "limit"])?;
    let session = required_string(params, "sessionId")?;
    let run_id = required_string(params, "runId")?;
    let after_sequence = optional_u64(params, "afterSequence")?;
    let limit = match optional_u64(params, "limit")? {
        Some(limit) if (1..=RUN_EVENTS_MAX).contains(&limit) => limit as usize,
        Some(_) => {
            return Err(invalid(format!(
                "`limit` must be an integer between 1 and {RUN_EVENTS_MAX}"
            )));
        }
        // 缺省取协议上限（与网关的 `params.limit ?? maxEvents` 同规）。
        None => RUN_EVENTS_MAX as usize,
    };
    let page = server
        .kernel
        .workflow_run_events(
            &SessionId::new(session),
            &run_id,
            WorkflowRunEventQuery {
                after_sequence,
                limit,
                max_bytes: RUN_PAGE_MAX_BYTES,
            },
        )
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    let events: Vec<Value> = page
        .events
        .iter()
        .map(|event| {
            let mut value = json!({
                "sequence": event.sequence,
                "type": event.r#type,
                "payload": event.payload,
            });
            if event.truncated {
                value["truncated"] = json!(true);
            }
            value
        })
        .collect();
    Ok(json!({ "events": events, "hasMore": page.has_more }))
}

/// `v4/conversation/workflowRunArtifacts`：用户面产物的全量清单。
///
/// 未知 runId 回**空清单**而不是错误（与网关同一姿态）：一个已被淘汰 / 从未存在的 run 没有
/// 产物，这是一个事实而不是故障。
pub(crate) async fn workflow_run_artifacts(
    server: &Server,
    params: &Value,
) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(params, &["sessionId", "runId"])?;
    let session = required_string(params, "sessionId")?;
    let run_id = required_string(params, "runId")?;
    let artifacts = server
        .kernel
        .workflow_run_artifacts(&SessionId::new(session), &run_id)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?
        .unwrap_or_default();
    let artifacts: Vec<Value> = artifacts
        .iter()
        .map(|artifact| {
            let mut value = json!({
                "id": artifact.id,
                "kind": artifact.kind,
                "version": artifact.version,
                "itemCount": artifact.item_count,
                "versions": artifact
                    .versions
                    .iter()
                    .map(version_json)
                    .collect::<Vec<_>>(),
            });
            if let Some(title) = &artifact.title {
                value["title"] = json!(title);
            }
            if let Some(description) = &artifact.description {
                value["description"] = json!(description);
            }
            if let Some(content_type) = &artifact.content_type {
                value["contentType"] = json!(content_type);
            }
            if let Some(source_path) = &artifact.source_path {
                value["sourcePath"] = json!(source_path);
            }
            if let Some(spec) = &artifact.spec {
                value["spec"] = spec.clone();
            }
            if artifact.primary == Some(true) {
                value["primary"] = json!(true);
            }
            value
        })
        .collect();
    Ok(json!({ "artifacts": artifacts }))
}

/// 一个版本 → 协议形状。**`uri` 刻意不出现**：schema 的注释写着「只给 CLI 侧用，模型与
/// renderer 都读不了它」——它是 store 的内部地址，出了这一层就是一条越权的读路径。
fn version_json(version: &rust_cli_kernel_api::workflow::WorkflowRunArtifactVersion) -> Value {
    let mut value = json!({
        "version": version.version,
        "publishedAt": version.published_at,
    });
    if let Some(title) = &version.title {
        value["title"] = json!(title);
    }
    if let Some(description) = &version.description {
        value["description"] = json!(description);
    }
    if let Some(content_type) = &version.content_type {
        value["contentType"] = json!(content_type);
    }
    if let Some(bytes) = version.bytes {
        value["bytes"] = json!(bytes);
    }
    if let Some(source_path) = &version.source_path {
        value["sourcePath"] = json!(source_path);
    }
    if let Some(spec) = &version.spec {
        value["spec"] = spec.clone();
    }
    if version.primary == Some(true) {
        value["primary"] = json!(true);
    }
    value
}

/// `v4/conversation/workflowRunArtifactData`：看板条目的一页（cursor = journal sequence）。
///
/// `limit` 的缺省与钳制在**这里**（`200` / `[1, 500]`）；存储层精确兑现、不再钳。`fields`
/// 原样下传：看板只要 spec 点名的字段，一条 1 MiB 的 item 不该为了一个数被整条搬进渲染器。
pub(crate) async fn workflow_run_artifact_data(
    server: &Server,
    params: &Value,
) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "sessionId",
            "runId",
            "artifactId",
            "afterSequence",
            "limit",
            "fields",
        ],
    )?;
    let session = required_string(params, "sessionId")?;
    let run_id = required_string(params, "runId")?;
    let artifact_id = required_string(params, "artifactId")?;
    if artifact_id.len() > 64 {
        return Err(invalid("`artifactId` must be at most 64 characters"));
    }
    let after_sequence = optional_u64(params, "afterSequence")?;
    let limit = match optional_u64(params, "limit")? {
        Some(limit) if (1..=ARTIFACT_ITEMS_MAX).contains(&limit) => limit as usize,
        Some(_) => {
            return Err(invalid(format!(
                "`limit` must be an integer between 1 and {ARTIFACT_ITEMS_MAX}"
            )));
        }
        None => ARTIFACT_ITEMS_DEFAULT as usize,
    };
    let fields = match params.get("fields") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            if items.is_empty() || items.len() > ARTIFACT_MAX_FIELDS {
                return Err(invalid(format!(
                    "`fields` must contain between 1 and {ARTIFACT_MAX_FIELDS} paths"
                )));
            }
            let mut paths = Vec::with_capacity(items.len());
            for item in items {
                let path = item
                    .as_str()
                    .filter(|path| !path.is_empty() && path.len() <= ARTIFACT_MAX_FIELD_PATH)
                    .ok_or_else(|| {
                        invalid(format!(
                            "`fields` paths must be non-empty strings of at most {ARTIFACT_MAX_FIELD_PATH} characters"
                        ))
                    })?;
                paths.push(path.to_owned());
            }
            Some(paths)
        }
        Some(_) => return Err(invalid("`fields` must be an array of field paths")),
    };
    let page = server
        .kernel
        .workflow_run_artifact_items(
            &SessionId::new(session),
            &run_id,
            WorkflowRunArtifactItemQuery {
                artifact_id,
                after_sequence,
                limit,
                // 字节恒为协议上限，renderer 不能放宽（它连这个键都没有）。
                max_bytes: ARTIFACT_PAGE_MAX_BYTES,
                fields,
                max_field_value_bytes: ARTIFACT_MAX_FIELD_VALUE_BYTES,
            },
        )
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    let items: Vec<Value> = page
        .items
        .iter()
        .map(|item| {
            let mut value = json!({
                "sequence": item.sequence,
                "siteId": item.site_id,
                "ordinal": item.ordinal,
            });
            if let Some(fields) = &item.fields {
                value["fields"] = fields.clone();
            } else if let Some(item) = &item.item {
                value["item"] = item.clone();
            }
            value
        })
        .collect();
    Ok(json!({ "items": items, "hasMore": page.has_more }))
}

/// `v4/conversation/workflowRunArtifactRead`：内容产物的一字节块（≤ 512 KiB）。
///
/// 授权全在内核侧（run 属于本会话 ∧ journal 里有 `(artifactId, version)` 的 completed 行）；
/// 这里只做参数校验与分块。`offset` 越界不是错误：返回空块 + `nextOffset: null`，与读到尾
/// 同一形态。无此版本 → 结构化的 not found（与网关的 `fault.workflowRunArtifactRead.notFound`
/// 同一口径），因为「这张卡打不开」与「这一页读不出来」是两件事。
pub(crate) async fn workflow_run_artifact_read(
    server: &Server,
    params: &Value,
) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "sessionId",
            "runId",
            "artifactId",
            "version",
            "offset",
            "limit",
        ],
    )?;
    let session = required_string(params, "sessionId")?;
    let run_id = required_string(params, "runId")?;
    let artifact_id = required_string(params, "artifactId")?;
    let version = required_u64(params, "version")?;
    if !(1..=16).contains(&version) {
        return Err(invalid("`version` must be an integer between 1 and 16"));
    }
    let offset = required_u64(params, "offset")?;
    let limit = required_u64(params, "limit")?;
    if !(1..=ATTACHMENT_CHUNK_MAX_BYTES).contains(&limit) {
        return Err(invalid(format!(
            "`limit` must be an integer between 1 and {ATTACHMENT_CHUNK_MAX_BYTES}"
        )));
    }
    let Some((bytes, content_type)) = server
        .kernel
        .workflow_run_artifact_bytes(&SessionId::new(session), &run_id, &artifact_id, version)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?
    else {
        return Err(RpcError::invalid_params(format!(
            "fault.workflowRunArtifactRead.notFound: {run_id}/{artifact_id}@{version}"
        )));
    };
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > ATTACHMENT_MAX_BYTES {
        return Err(RpcError::internal(format!(
            "artifact {artifact_id}@{version} is larger than {ATTACHMENT_MAX_BYTES} bytes"
        )));
    }
    let total_bytes = bytes.len() as u64;
    let start = usize::try_from(offset.min(total_bytes)).unwrap_or(usize::MAX);
    let end = usize::try_from(offset.saturating_add(limit).min(total_bytes)).unwrap_or(bytes.len());
    let chunk = &bytes[start..end];
    use base64::Engine;
    Ok(json!({
        "dataBase64": base64::engine::general_purpose::STANDARD.encode(chunk),
        // contentType 取**journal 记录**上的值（UI 分派渲染器的精确匹配契约）；老行缺席时
        // 退回 octet-stream——下载可以，按类型分派会落到默认渲染器，这是诚实的那一档。
        "mediaType": content_type.unwrap_or_else(|| "application/octet-stream".to_owned()),
        "totalBytes": total_bytes,
        "nextOffset": if end < bytes.len() { Some(end as u64) } else { None },
    }))
}

/// `v4/conversation/workflowRunWorkspace`：工作区 transcript 的清单（不带正文）。
///
/// 宿主回 `None`（未知 run / 不是你的 run）得到**空清单**而不是错误：与产物清单同一姿态，
/// 也是授权链「不告诉越权者猜对了哪一半」的要求。超 `maxNodes` 截尾并置 `truncated`——一个
/// 循环里跑了三千次 `world.run` 的 run 不该把侧板撑爆。
pub(crate) async fn workflow_run_workspace(
    server: &Server,
    params: &Value,
) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(params, &["sessionId", "runId"])?;
    let session = required_string(params, "sessionId")?;
    let run_id = required_string(params, "runId")?;
    let nodes = server
        .kernel
        .workflow_run_workspace(&SessionId::new(session), &run_id)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?
        .unwrap_or_default();
    let truncated = nodes.len() > WORKSPACE_MAX_NODES;
    let nodes: Vec<Value> = nodes
        .iter()
        .take(WORKSPACE_MAX_NODES)
        .map(|node| {
            let mut value = json!({
                "siteId": node.site_id,
                "ordinal": node.ordinal,
                "kind": node.kind,
                "status": node.status,
                "createdAt": node.created_at,
                "updatedAt": node.updated_at,
            });
            if let Some(op) = &node.op {
                value["op"] = json!(op);
            }
            if let Some(args) = &node.args {
                value["args"] = json!(args);
            }
            if node.input_truncated == Some(true) {
                value["inputTruncated"] = json!(true);
            }
            if let Some(error) = &node.error {
                value["error"] = json!({"code": error.code, "message": error.message});
            }
            if let Some(summary) = &node.summary {
                let mut value_summary = json!({ "resultBytes": summary.result_bytes });
                if let Some(count) = summary.result_count {
                    value_summary["resultCount"] = json!(count);
                }
                if let Some(exit_code) = summary.exit_code {
                    value_summary["exitCode"] = json!(exit_code);
                }
                if let Some(stdout_bytes) = summary.stdout_bytes {
                    value_summary["stdoutBytes"] = json!(stdout_bytes);
                }
                if let Some(stderr_bytes) = summary.stderr_bytes {
                    value_summary["stderrBytes"] = json!(stderr_bytes);
                }
                value["summary"] = value_summary;
            }
            value
        })
        .collect();
    let mut result = json!({ "nodes": nodes });
    if truncated {
        result["truncated"] = json!(true);
    }
    Ok(result)
}

/// `v4/conversation/workflowRunNodeResult`：一个工作区节点的正文（按 `maxBytes` 保形有界化）。
pub(crate) async fn workflow_run_node_result(
    server: &Server,
    params: &Value,
) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &["sessionId", "runId", "siteId", "ordinal", "maxBytes"],
    )?;
    let session = required_string(params, "sessionId")?;
    let run_id = required_string(params, "runId")?;
    let site_id = required_string(params, "siteId")?;
    if site_id.len() > 64 {
        return Err(invalid("`siteId` must be at most 64 characters"));
    }
    let ordinal = required_u64(params, "ordinal")?;
    // 缺省与上限都是 resultMaxBytes；renderer 只能钳小，不能放宽。
    let max_bytes = match optional_u64(params, "maxBytes")? {
        Some(max_bytes) if (1..=WORKSPACE_RESULT_MAX_BYTES).contains(&max_bytes) => max_bytes,
        Some(_) => {
            return Err(invalid(format!(
                "`maxBytes` must be an integer between 1 and {WORKSPACE_RESULT_MAX_BYTES}"
            )));
        }
        None => WORKSPACE_RESULT_MAX_BYTES,
    };
    let Some(result) = server
        .kernel
        .workflow_run_node_result(
            &SessionId::new(session),
            &run_id,
            &site_id,
            ordinal,
            max_bytes,
        )
        .await
        .map_err(|error| crate::server::kernel_error(&error))?
    else {
        // 单点读回是 not found：与网关的 `fault.workflowRunNodeResult.notFound` 同一条口径。
        return Err(RpcError::invalid_params(format!(
            "fault.workflowRunNodeResult.notFound: {run_id}/{site_id}@{ordinal}"
        )));
    };
    let mut value = json!({
        "status": result.status,
        "truncated": result.truncated,
        "totalBytes": result.total_bytes,
    });
    if let Some(body) = result.result {
        value["result"] = body;
    }
    if let Some(error) = result.error {
        value["error"] = json!({"code": error.code, "message": error.message});
    }
    Ok(value)
}

// ———— usage ————

/// `APP_USAGE_RANGES` 的天数（`all` 是「从 0 起」）。
fn range_days(range: &str) -> Option<u64> {
    match range {
        "7d" => Some(7),
        "30d" => Some(30),
        "all" => None,
        _ => None,
    }
}

/// `v4/usage/stats`：应用级用量（`AppUsageSnapshot`）。
///
/// 入参与旧 `usage/stats` 同形（`range` / `timeZone`），结果 = `AppUsageSnapshot`。**归桶在
/// 这里**：`since` 由 range 与当前时刻算出，偏移取自注入的 clock（内核没有时区库，请求里的
/// IANA 名只用于回显）。热力图、连续天数、份额这些展示推导也在这里（Node 的
/// `buildAppUsageSnapshot` 是同一个纯函数）。
pub(crate) async fn usage_stats(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(params, &["range", "timeZone"])?;
    let range = match params.get("range") {
        Some(Value::String(range)) if matches!(range.as_str(), "all" | "7d" | "30d") => {
            range.clone()
        }
        Some(_) => return Err(invalid("`range` must be one of `all`, `7d`, `30d`")),
        None => return Err(invalid("`range` is required")),
    };
    let time_zone = match params.get("timeZone") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        Some(_) => return Err(invalid("`timeZone` must be a string")),
    };
    let clock = server.context.clock.as_ref();
    let until = clock.now_ms();
    let offset_minutes = i64::from(clock.utc_offset_minutes(until));
    let tz_offset_ms = offset_minutes * 60_000;
    let since = match range_days(&range) {
        Some(days) => until.saturating_sub(days.saturating_mul(86_400_000)),
        // `all`：Node 传 `since = 0`（不是「从今天往前算 N 天」）。
        None => 0,
    };
    let usage = match server
        .kernel
        .app_usage(rust_cli_kernel_api::usage::AppUsageQuery {
            since_ms: since,
            until_ms: until,
            tz_offset_ms,
        })
        .await
    {
        Ok(usage) => usage,
        // 存储不支持（TUI / 内存）：空快照而不是错误——UI 显示空态。
        Err(rust_cli_kernel_api::session_api::KernelError::Unsupported { .. }) => {
            Default::default()
        }
        Err(error) => return Err(crate::server::kernel_error(&error)),
    };
    Ok(build_usage_snapshot(
        &range,
        // `timeZone` 缺席时回显本机时区名（Node 的缺省是 `UTC`，但它读得到请求里的值；
        // 内核只有本机时区可用，回真实的那一个比回一个假的 UTC 诚实）。
        time_zone.unwrap_or_else(|| clock.time_zone()),
        tz_offset_ms,
        until,
        since,
        &usage,
    ))
}

/// `v4/conversation/usage`：会话级 token 用量（旧 `session/usage` 的 v4 落位）。
pub(crate) async fn conversation_usage(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(params, &["sessionId"])?;
    let session = required_string(params, "sessionId")?;
    let usage = match server
        .kernel
        .session_usage(&SessionId::new(session.clone()))
        .await
    {
        Ok(usage) => usage,
        Err(rust_cli_kernel_api::session_api::KernelError::Unsupported { .. }) => {
            Default::default()
        }
        // 会话不存在：与其它会话方法同一条错误码（`sessionUnavailable`），Host 据此换会话。
        Err(error @ rust_cli_kernel_api::session_api::KernelError::NotFound { .. }) => {
            return Err(RpcError::new(
                SESSION_UNAVAILABLE,
                format!(
                    "Session unavailable: {}",
                    crate::server::kernel_error(&error).message
                ),
            ));
        }
        Err(error) => return Err(crate::server::kernel_error(&error)),
    };
    Ok(json!({
        "sessionId": session,
        "totalTokens": usage.total_tokens,
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "reasoningTokens": usage.reasoning_tokens,
        "cacheCreationTokens": usage.cache_creation_tokens,
        "cacheReadTokens": usage.cache_read_tokens,
        "modelRequestCount": usage.model_request_count,
        "modelErrorCount": usage.model_error_count,
        "inputBaselineBySource": usage.input_baseline_by_source,
    }))
}

/// `AppUsageSnapshot` 的纯投影（Node `buildAppUsageSnapshot` 的移植）。
///
/// 与 Node 逐字对齐的几处口径：
/// - 缓存命中率的分母是 `inputTokens`（它已是总输入）；为 0 时才退回缓存读写之和，否则会把
///   命中率压低一半；
/// - 连续天数：从**今天**往前扫，遇到第一个零 token 的日就停（`currentStreakDays`），
///   最长连续是整段里的最大连续长度；
/// - 热力图的档位按 `peakDayTokens` 的四等分；
/// - `range: "all"` 的起点取实际数据里最早的日索引（不是 `since`——那里是 0）。
fn build_usage_snapshot(
    range: &str,
    time_zone: String,
    tz_offset_ms: i64,
    until: u64,
    since: u64,
    usage: &rust_cli_kernel_api::usage::AppUsage,
) -> Value {
    let end_day = day_index(until, tz_offset_ms);
    let start_day = if range == "all" {
        usage
            .days
            .iter()
            .map(|day| day.day_index)
            .chain(usage.day_models.iter().map(|day| day.day_index))
            .min()
            .unwrap_or(end_day)
    } else {
        day_index(since, tz_offset_ms)
    };

    let mut by_day: std::collections::BTreeMap<i64, (u64, u64, u64)> =
        std::collections::BTreeMap::new();
    for day in &usage.days {
        by_day.insert(
            day.day_index,
            (day.total_tokens, day.turn_count, day.tool_call_count),
        );
    }

    // activeDays / 连续天数：从今天往前扫。
    let mut active_days = 0u64;
    let mut current_streak = 0u64;
    let mut longest_streak = 0u64;
    let mut running_streak = 0u64;
    let mut streak_broken = false;
    let mut day = end_day;
    while day >= start_day {
        let tokens = by_day.get(&day).map(|entry| entry.0).unwrap_or(0);
        if tokens > 0 {
            active_days += 1;
            running_streak += 1;
            longest_streak = longest_streak.max(running_streak);
            if !streak_broken {
                current_streak += 1;
            }
        } else {
            if !streak_broken {
                streak_broken = true;
            }
            running_streak = 0;
        }
        // 下界保护：`start_day` 可能是 i64::MIN 附近的值（`range: all` 且数据极老），
        // 减到 `i64::MIN` 就停，避免溢出。
        if day == i64::MIN {
            break;
        }
        day -= 1;
    }

    let peak_day_tokens = usage
        .days
        .iter()
        .map(|day| day.total_tokens)
        .max()
        .unwrap_or(0);
    let level_for = |tokens: u64| -> u8 {
        if tokens == 0 || peak_day_tokens == 0 {
            return 0;
        }
        let ratio = tokens as f64 / peak_day_tokens as f64;
        if ratio > 0.75 {
            4
        } else if ratio > 0.5 {
            3
        } else if ratio > 0.25 {
            2
        } else {
            1
        }
    };

    // 热力图：从 start_day 到 end_day，按 7 天一周切片；末周补 null。
    let mut weeks: Vec<Value> = Vec::new();
    let mut week: Vec<Value> = Vec::new();
    let mut day = start_day;
    while day <= end_day {
        let (tokens, turns, calls) = by_day.get(&day).copied().unwrap_or((0, 0, 0));
        week.push(json!({
            "date": civil_date_of_day(day),
            "level": level_for(tokens),
            "totalTokens": tokens,
            "turnCount": turns,
            "toolCallCount": calls,
        }));
        if week.len() == 7 {
            weeks.push(json!({"weekIndex": weeks.len(), "days": week}));
            week = Vec::new();
        }
        if day == i64::MAX {
            break;
        }
        day += 1;
    }
    if !week.is_empty() {
        while week.len() < 7 {
            week.push(Value::Null);
        }
        weeks.push(json!({"weekIndex": weeks.len(), "days": week}));
    }

    // 按日的模型趋势。
    let mut daily: std::collections::BTreeMap<i64, Vec<(Option<String>, u64)>> =
        std::collections::BTreeMap::new();
    for row in &usage.day_models {
        let entry = daily.entry(row.day_index).or_default();
        match entry.iter_mut().find(|(model, _)| model == &row.model_id) {
            Some((_, tokens)) => *tokens = tokens.saturating_add(row.total_tokens),
            None => entry.push((row.model_id.clone(), row.total_tokens)),
        }
    }
    let mut daily_model_usage = Vec::new();
    let mut day = start_day;
    while day <= end_day {
        let models: Vec<Value> = daily
            .get(&day)
            .map(|rows| {
                rows.iter()
                    .map(|(model_id, tokens)| json!({"modelId": model_id, "totalTokens": tokens}))
                    .collect()
            })
            .unwrap_or_default();
        daily_model_usage.push(json!({"date": civil_date_of_day(day), "models": models}));
        if day == i64::MAX {
            break;
        }
        day += 1;
    }

    let total_model_tokens: u64 = usage.models.iter().map(|model| model.total_tokens).sum();
    let models: Vec<Value> = usage
        .models
        .iter()
        .map(|model| {
            json!({
                "modelId": model.model_id,
                "totalTokens": model.total_tokens,
                "inputTokens": model.input_tokens,
                "outputTokens": model.output_tokens,
                "requestCount": model.request_count,
                "share": if total_model_tokens > 0 {
                    model.total_tokens as f64 / total_model_tokens as f64
                } else {
                    0.0
                },
            })
        })
        .collect();
    let favorite_model = usage.models.first().map(|model| {
        json!({
            "modelId": model.model_id,
            "totalTokens": model.total_tokens,
            "share": if total_model_tokens > 0 {
                model.total_tokens as f64 / total_model_tokens as f64
            } else {
                0.0
            },
        })
    });

    let tools: Vec<Value> = usage
        .tools
        .iter()
        .map(|tool| {
            json!({
                "toolName": tool.tool_name,
                "callCount": tool.call_count,
                "errorCount": tool.error_count,
                "errorRate": if tool.call_count > 0 {
                    tool.error_count as f64 / tool.call_count as f64
                } else {
                    0.0
                },
                "avgDurationMs": tool.avg_duration_ms,
            })
        })
        .collect();

    // 命中率的分母是 inputTokens（已是总输入），只有它为 0 时才退回缓存读写之和。
    let cache_denominator = if usage.input_tokens > 0 {
        usage.input_tokens
    } else {
        usage
            .cache_creation_tokens
            .saturating_add(usage.cache_read_tokens)
    };
    let cache_hit_rate = if cache_denominator > 0 {
        usage.cache_read_tokens as f64 / cache_denominator as f64
    } else {
        0.0
    };

    json!({
        "range": range,
        "generatedAt": until,
        "timeZone": time_zone,
        "source": "agent-db",
        "summary": {
            "totalTokens": usage.total_tokens,
            "inputTokens": usage.input_tokens,
            "outputTokens": usage.output_tokens,
            "reasoningTokens": usage.reasoning_tokens,
            "cacheCreationTokens": usage.cache_creation_tokens,
            "cacheReadTokens": usage.cache_read_tokens,
            "cacheHitRate": cache_hit_rate,
            "totalSessions": usage.total_sessions,
            "totalTurns": usage.total_turns,
            "toolCallCount": usage.tool_call_count,
            "toolErrorRate": if usage.tool_call_count > 0 {
                usage.tool_error_count as f64 / usage.tool_call_count as f64
            } else {
                0.0
            },
            "modelErrorRate": if usage.model_request_count > 0 {
                usage.model_error_count as f64 / usage.model_request_count as f64
            } else {
                0.0
            },
            "avgTimeToFirstTokenMs": usage.avg_time_to_first_token_ms,
            "avgTurnDurationMs": usage.avg_turn_duration_ms,
            "activeDays": active_days,
            "currentStreakDays": current_streak,
            "longestSessionMs": usage.longest_session_ms,
            "longestStreakDays": longest_streak,
            "peakDayTokens": peak_day_tokens,
            "favoriteModel": favorite_model,
        },
        "heatmap": {
            "startDate": civil_date_of_day(start_day),
            "endDate": civil_date_of_day(end_day),
            "maxTokens": peak_day_tokens,
            "weeks": weeks,
        },
        "dailyModelUsage": daily_model_usage,
        "models": models,
        "tools": tools,
    })
}

/// 时刻 → 本地日索引（`floor((ms + offset) / DAY)`，Node 的同一条算术）。
fn day_index(at_ms: u64, tz_offset_ms: i64) -> i64 {
    const DAY_MS: i64 = 86_400_000;
    let at = i64::try_from(at_ms).unwrap_or(i64::MAX);
    // `div_euclid` 而不是 `/`：负偏移（西半球）下 `ms + offset` 仍为正，但显式用欧几里得除法
    // 让「floor」这件事在代码里成立，而不是靠符号碰巧对。
    at.saturating_add(tz_offset_ms).div_euclid(DAY_MS)
}

/// 本地日索引 → `YYYY-MM-DD`（`dayIndex * DAY` 是「本地午夜当作 UTC」的时刻，取其 UTC 日历
/// 分量即本地日期）。
fn civil_date_of_day(day: i64) -> String {
    let at = day.saturating_mul(86_400_000).max(0) as u64;
    rust_cli_kernel_api::clock::civil_date(at)
}

#[cfg(test)]
#[path = "v4_queries_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "v4_rows_tests.rs"]
mod rows_tests;
