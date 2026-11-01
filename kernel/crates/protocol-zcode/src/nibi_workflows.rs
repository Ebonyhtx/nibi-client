//! NIBI 协议中枢（GUI）：运行历史（`workflows/runs`，Node `listSavedWorkflowRunsOp` 同一契约）
//! 与已保存工作流的读/写面（`workflows/list` / `get` / `save` / `updateMeta` / `delete` /
//! `move`）。读面在会话之外——中枢看不到「submit 已回、行未落」的注册表间隙，那几个微任务
//! 靠下一次刷新补上；写面的解析器与序列化器在 sidecar（@nibi/core），宿主只转发，写面没有
//! 降级（没有 sidecar 的入口 fail-closed，见 runtime 层）。
//!
//! 参数契约从 Node 的 zod 逐字（`.strict()`：未知键与类型错一律 `-32602`，message 前缀同形；
//! `nonEmptyString` 的 trim 是转换的一部分，写面用它拼文件名）；journal 缺席（内核没接会话库）
//! 回空页而不是错误——中枢据此显示「尚未运行」。

use rust_cli_kernel_api::session_api::KernelError;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{json, Value};

use crate::server::Server;

/// 中枢的页大小上限（Node `NIBI_WORKFLOWS_RUNS_MAX_LIMIT`）；多取一条**只为判定 truncated**。
const MAX_LIMIT: u64 = 50;

/// forRun 的候选上界（Node `NIBI_WORKFLOWS_FOR_RUN_MAX_CANDIDATES`）：一次 run 在一段对话里
/// 被存过的次数远小于它。
const FOR_RUN_MAX_CANDIDATES: usize = 8;

pub(crate) async fn runs(server: &Server, raw: &Value) -> Result<Value, RpcError> {
    let params = raw
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))?;
    strict_keys(params, &["workspace", "name", "limit", "scope"])?;
    let workspace_path = workspace_path_of(params)?;
    // zod `.optional()`：显式 null 不在契约里（服务层缺席时省键，不发 null）。
    let name = optional_non_empty_string_of(params, "name", "`name` must be a non-empty string")?;
    let scope = match params.get("scope") {
        None => "project",
        Some(Value::String(scope)) if scope == "project" || scope == "global" => scope.as_str(),
        Some(_) => return Err(invalid("`scope` must be `project` or `global`")),
    };
    let limit = match params.get("limit") {
        Some(value) => value
            .as_u64()
            .filter(|limit| (1..=MAX_LIMIT).contains(limit))
            .ok_or_else(|| invalid(format!("`limit` must be an integer between 1 and {MAX_LIMIT}")))?,
        None => return Err(invalid("`limit` must be an integer between 1 and 50")),
    };

    // `project`（缺省）：只查 `dwf_run.cwd === workspacePath`。`global`：**不**按 cwd 过滤，跨
    // 所有项目取该名字的运行历史；结果行带 `cwd` 供 GUI 标项目。
    let cwd = (scope == "project").then(|| workspace_path.to_owned());
    let rows = match server
        .kernel
        .workflow_runs_page(cwd, name, limit as usize + 1)
        .await
    {
        Ok(rows) => rows,
        // journal 缺席（TUI / 内存存储）：与 Node 的 `journal === undefined` 同规，空页不报错。
        Err(KernelError::Unsupported { .. }) => return Ok(json!({ "runs": [] })),
        Err(error) => return Err(RpcError::internal(error.to_string())),
    };
    let truncated = rows.len() > limit as usize;
    let runs: Vec<Value> = rows
        .into_iter()
        .take(limit as usize)
        .map(|row| {
            // 中枢 chips 上界（协议 schema 的 `.max(8)`）：kernel 已按归并取好，这里只裁字段
            // ——一行画得下的 kind 图标数，字节与条目经 v4 查询按需读。
            let artifacts = row.artifacts.map(|artifacts| {
                artifacts
                    .iter()
                    .take(8)
                    .map(|artifact| {
                        let mut chip = json!({
                            "id": artifact.id,
                            "kind": artifact.kind,
                            "version": artifact.version,
                        });
                        if let Some(title) = &artifact.title {
                            chip["title"] = json!(title);
                        }
                        if let Some(content_type) = &artifact.content_type {
                            chip["contentType"] = json!(content_type);
                        }
                        chip
                    })
                    .collect::<Vec<_>>()
            });
            let mut run = json!({
                "runId": row.run_id,
                "status": row.status,
                "createdAt": row.created_at,
                "updatedAt": row.updated_at,
                "spentTokens": row.spent_tokens,
            });
            if let Some(name) = &row.name {
                run["name"] = json!(name);
            }
            if let Some(stop_reason) = &row.stop_reason {
                run["stopReason"] = json!(stop_reason);
            }
            if let Some(parent_session_id) = &row.parent_session_id {
                run["parentSessionId"] = json!(parent_session_id);
            }
            if let Some(tool_call_id) = &row.tool_call_id {
                run["toolCallId"] = json!(tool_call_id);
            }
            if let Some(args) = &row.args {
                run["args"] = args.clone();
            }
            if let Some(cwd) = &row.cwd {
                run["cwd"] = json!(cwd);
            }
            if let Some(artifacts) = artifacts {
                run["artifacts"] = Value::Array(artifacts);
            }
            run
        })
        .collect();
    Ok(match truncated {
        true => json!({ "runs": runs, "truncated": true }),
        false => json!({ "runs": runs }),
    })
}

/// `nonEmptyString`（Node `z.string().trim().min(1)`）的同一读法：trim 是转换的一部分——
/// Node 的 `parseParams` 把 `" foo "` 解析成 `"foo"`，而写面拿名字拼文件名，宿主不照做就
/// 会在磁盘上写出第二个名字。
fn required_non_empty(value: &Value, what: &str) -> Result<String, RpcError> {
    match value {
        Value::String(text) if !text.trim().is_empty() => Ok(text.trim().to_owned()),
        _ => Err(invalid(format!("{what} must be a non-empty string"))),
    }
}

/// 顶层入参的 required `nonEmptyString`（键名进错误文案）。
fn non_empty_string_of(
    params: &serde_json::Map<String, Value>,
    key: &str,
) -> Result<String, RpcError> {
    match params.get(key) {
        Some(value) => required_non_empty(value, &format!("`{key}`")),
        None => Err(invalid(format!("`{key}` must be a non-empty string"))),
    }
}

/// optional `nonEmptyString`：缺席合法（服务层省键不发 null 的同一条约定；显式 null 与
/// 空串、空白串一样不在契约里）。
fn optional_non_empty_string_of(
    params: &serde_json::Map<String, Value>,
    key: &str,
    what: &str,
) -> Result<Option<String>, RpcError> {
    match params.get(key) {
        None => Ok(None),
        Some(value) => Ok(Some(required_non_empty(value, what)?)),
    }
}

/// 顶层入参的 `.strict()`：未知键与 Node 同样炸 `-32602`（GUI 拼错的键不该被静默丢掉）。
fn strict_keys(params: &serde_json::Map<String, Value>, known: &[&str]) -> Result<(), RpcError> {
    for key in params.keys() {
        if !known.contains(&key.as_str()) {
            return Err(invalid(format!("Unrecognized key `{key}`")));
        }
    }
    Ok(())
}

/// workspace ref 的严格校验（workflows 全方法共用）：路径与稳定键必填，两个 optional 的
/// 标识键给了就必须非空；`.strict()` 同样拒未知键。
fn workspace_path_of(params: &serde_json::Map<String, Value>) -> Result<String, RpcError> {
    let workspace = params
        .get("workspace")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("`workspace` must be an object"))?;
    for key in workspace.keys() {
        if !matches!(
            key.as_str(),
            "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "workspaceKey"
        ) {
            return Err(invalid(format!("Unrecognized key `{key}` in `workspace`")));
        }
    }
    let workspace_path = required_non_empty(
        workspace
            .get("workspacePath")
            .unwrap_or(&Value::Null),
        "`workspace.workspacePath`",
    )?;
    required_non_empty(workspace.get("workspaceKey").unwrap_or(&Value::Null), "`workspace.workspaceKey`")?;
    optional_non_empty_string_of(
        workspace,
        "workspaceIdentity",
        "`workspace.workspaceIdentity` must be a non-empty string",
    )?;
    optional_non_empty_string_of(
        workspace,
        "remoteSessionId",
        "`workspace.remoteSessionId` must be a non-empty string",
    )?;
    Ok(workspace_path)
}

/// 定向 scope（缺省 `project`；`global` 只查全局根）。
fn scope_of(params: &serde_json::Map<String, Value>) -> Result<String, RpcError> {
    match params.get("scope") {
        None => Ok("project".to_owned()),
        Some(Value::String(scope)) if scope == "project" || scope == "global" => {
            Ok(scope.clone())
        }
        Some(_) => Err(invalid("`scope` must be `project` or `global`")),
    }
}

/// `workflows/list`（Node `listSavedWorkflowsOp` 同一契约）：定向 scope 的目录枚举。
/// frontmatter 解析器在 sidecar（@nibi/core，宿主只转发）；没接 sidecar 的入口回空页——
/// 中枢据此显示「尚未保存」，与 journal 缺席的空运行历史同一条降级。
pub(crate) async fn list_workflows(server: &Server, raw: &Value) -> Result<Value, RpcError> {
    let params = raw
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))?;
    strict_keys(params, &["workspace", "scope"])?;
    let workspace_path = workspace_path_of(params)?;
    let scope = scope_of(params)?;
    match server.kernel.hub_list_saved_workflows(&workspace_path, &scope).await {
        Ok(reply) => Ok(reply),
        Err(error) => Err(RpcError::internal(error_message(error))),
    }
}

/// `workflows/get`（Node `getSavedWorkflowOp` 同一契约）：单个已保存工作流的解析。
pub(crate) async fn get_workflow(server: &Server, raw: &Value) -> Result<Value, RpcError> {
    let params = raw
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))?;
    strict_keys(params, &["workspace", "name", "scope"])?;
    let workspace_path = workspace_path_of(params)?;
    let scope = scope_of(params)?;
    let name = non_empty_string_of(params, "name")?;
    match server
        .kernel
        .hub_get_saved_workflow(&workspace_path, &name, &scope)
        .await
    {
        Ok(reply) => Ok(reply),
        // 没接 sidecar：与「目录里没有这个文件」同形（GUI 显示未找到，不假装内核坏了）。
        Err(KernelError::Unsupported { .. }) => Ok(json!({ "ok": false, "reason": "not_found" })),
        Err(error) => Err(RpcError::internal(error_message(error))),
    }
}

/// meta 的严格校验（shared `zcodeSavedWorkflowMetaSchema` 与 contracts
/// `SavedWorkflowMetaSchema` 的同一形状；两个 schema 由 bootstrap 的协议测试互相钉住）。
/// `.strict()` 让拼错的键炸 `-32602` 而不是被静默丢掉——保存的文件是用户会手改的，错字必须
/// 能被指出来。原样回传：sidecar 的 contracts schema 再解析一遍是「两边漂移」的追赶闸。
fn meta_of(params: &serde_json::Map<String, Value>) -> Result<Value, RpcError> {
    let meta = params
        .get("meta")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("`meta` must be an object"))?;
    let mut clean = serde_json::Map::new();
    for (key, value) in meta {
        match key.as_str() {
            "description" | "whenToUse" => {
                let text = required_non_empty(value, &format!("`meta.{key}`"))?;
                clean.insert(key.clone(), Value::String(text));
            }
            "args" => {
                clean.insert(key.clone(), args_of(value)?);
            }
            other => return Err(invalid(format!("Unrecognized key `{other}` in `meta`"))),
        }
    }
    // description 必填（schema 无 `.optional()`）。
    if !clean.contains_key("description") {
        return Err(invalid("`meta.description` must be a non-empty string"));
    }
    Ok(Value::Object(clean))
}

/// `meta.args` 的严格校验：每个声明只认四个键，`type` 必填且限定词汇。
fn args_of(value: &Value) -> Result<Value, RpcError> {
    let args = value
        .as_object()
        .ok_or_else(|| invalid("`meta.args` must be an object"))?;
    let mut entries = serde_json::Map::new();
    for (name, declaration) in args {
        let decl = declaration
            .as_object()
            .ok_or_else(|| invalid(format!("`meta.args.{name}` must be an object")))?;
        let mut clean = serde_json::Map::new();
        for (key, item) in decl {
            match key.as_str() {
                // 类型词汇：三个原语加一个 `json` 兜底——原语能被校验成「传错了」，`json`
                // 明确表示「这里什么都收」，两件事不是一件。
                "type" => {
                    let text = item.as_str().filter(|text| {
                        matches!(*text, "string" | "number" | "boolean" | "json")
                    });
                    match text {
                        Some(text) => {
                            clean.insert(key.clone(), Value::String(text.to_owned()));
                        }
                        None => {
                            return Err(invalid(format!(
                                "`meta.args.{name}.type` must be one of `string`, `number`, `boolean`, `json`"
                            )));
                        }
                    }
                }
                // `description` 是裸 `z.string()`（无 min、无 trim）：任意字符串都收。
                "description" => {
                    if item.as_str().is_none() {
                        return Err(invalid(format!(
                            "`meta.args.{name}.description` must be a string"
                        )));
                    }
                    clean.insert(key.clone(), item.clone());
                }
                "required" => {
                    if !item.is_boolean() {
                        return Err(invalid(format!(
                            "`meta.args.{name}.required` must be a boolean"
                        )));
                    }
                    clean.insert(key.clone(), item.clone());
                }
                // `default` 刻意 unknown：默认值的类型正确性由 validateWorkflowArgs 在应用
                // 之后与传入值走同一条校验，声明层不预设形状。
                "default" => {
                    clean.insert(key.clone(), item.clone());
                }
                other => {
                    return Err(invalid(format!(
                        "Unrecognized key `{other}` in `meta.args.{name}`"
                    )));
                }
            }
        }
        if clean.get("type").is_none() {
            return Err(invalid(format!(
                "`meta.args.{name}.type` must be one of `string`, `number`, `boolean`, `json`"
            )));
        }
        entries.insert(name.clone(), Value::Object(clean));
    }
    Ok(Value::Object(entries))
}

/// `workflows/save`（Node `saveSavedWorkflowFromRunOp` 同一契约）：完成卡的直接保存——
/// 不收脚本，只收 runId；要写的正文是这次 run 实际执行的那一份，sidecar 从 journal 读
/// （`dbPath` 同 holes/fill 的同一家）。落盘规则与 SaveWorkflow 同一套（名字合法性 → 脚本
/// 可得 → 覆盖判定 → 类型检查 → 写，顺序一致）。
pub(crate) async fn save_workflow(server: &Server, raw: &Value) -> Result<Value, RpcError> {
    let params = raw
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))?;
    strict_keys(params, &["workspace", "runId", "name", "meta", "scope", "overwrite"])?;
    let workspace_path = workspace_path_of(params)?;
    let run_id = non_empty_string_of(params, "runId")?;
    let name = non_empty_string_of(params, "name")?;
    let meta = meta_of(params)?;
    let scope = scope_of(params)?;
    // 缺省即「目标已存在就拒绝」：覆盖是用户的决定，不是一次保存的副作用。
    let overwrite = match params.get("overwrite") {
        None => false,
        Some(Value::Bool(flag)) => *flag,
        Some(_) => return Err(invalid("`overwrite` must be a boolean")),
    };
    match server
        .kernel
        .hub_save_workflow_from_run(&workspace_path, &run_id, &name, meta, &scope, overwrite)
        .await
    {
        Ok(reply) => Ok(reply),
        Err(error) => Err(RpcError::internal(error_message(error))),
    }
}

/// `workflows/updateMeta`（Node `updateSavedWorkflowMetaOp` 同一契约）：只改写文件顶部的
/// 元数据——sidecar 读回当前脚本正文，整文件覆写为 `serialize(newMeta, script)`。
pub(crate) async fn update_workflow_meta(server: &Server, raw: &Value) -> Result<Value, RpcError> {
    let params = raw
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))?;
    strict_keys(params, &["workspace", "name", "meta", "scope"])?;
    let workspace_path = workspace_path_of(params)?;
    let name = non_empty_string_of(params, "name")?;
    let meta = meta_of(params)?;
    let scope = scope_of(params)?;
    match server
        .kernel
        .hub_update_saved_workflow_meta(&workspace_path, &name, meta, &scope)
        .await
    {
        Ok(reply) => Ok(reply),
        Err(error) => Err(RpcError::internal(error_message(error))),
    }
}

/// `workflows/delete`（Node `deleteSavedWorkflowOp` 同一契约）：只按名字删。协议不收路径、
/// 也不接受 `..`——名字合法性是路径穿越的防线本身，先验后拼在 sidecar（与 Node 同一处）。
pub(crate) async fn delete_workflow(server: &Server, raw: &Value) -> Result<Value, RpcError> {
    let params = raw
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))?;
    strict_keys(params, &["workspace", "name", "scope"])?;
    let workspace_path = workspace_path_of(params)?;
    let name = non_empty_string_of(params, "name")?;
    let scope = scope_of(params)?;
    match server
        .kernel
        .hub_delete_saved_workflow(&workspace_path, &name, &scope)
        .await
    {
        Ok(reply) => Ok(reply),
        Err(error) => Err(RpcError::internal(error_message(error))),
    }
}

/// `workflows/move`（Node `moveSavedWorkflowOp` 同一契约）：把本机全局根的同名文件搬到
/// `workspace` 项目根（只此一向：项目→全局是模型的概括，不是搬文件）。无 scope 入参。
pub(crate) async fn move_workflow(server: &Server, raw: &Value) -> Result<Value, RpcError> {
    let params = raw
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))?;
    strict_keys(params, &["workspace", "name"])?;
    let workspace_path = workspace_path_of(params)?;
    let name = non_empty_string_of(params, "name")?;
    match server
        .kernel
        .hub_move_saved_workflow(&workspace_path, &name)
        .await
    {
        Ok(reply) => Ok(reply),
        Err(error) => Err(RpcError::internal(error_message(error))),
    }
}

/// `workflows/forRun`（Node `findSavedWorkflowForRunOp` 同一契约）：完成卡的推导判定——
/// 三规则按序（对话说的候选 → run 跑的脚本 → run 叫的名），答案推导得来、不记在卡上。
pub(crate) async fn for_run(server: &Server, raw: &Value) -> Result<Value, RpcError> {
    let params = raw
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))?;
    strict_keys(params, &["workspace", "runId", "candidates"])?;
    let workspace_path = workspace_path_of(params)?;
    let run_id = non_empty_string_of(params, "runId")?;
    // 候选缺席与空数组同形（Node `params.candidates ?? []`）；缺省不进线。
    let candidates = match params.get("candidates") {
        None | Some(Value::Null) => Value::Array(Vec::new()),
        Some(value) => candidates_of(value)?,
    };
    match server
        .kernel
        .hub_find_saved_workflow_for_run(&workspace_path, &run_id, candidates)
        .await
    {
        Ok(reply) => Ok(reply),
        Err(error) => Err(RpcError::internal(error_message(error))),
    }
}

/// 候选数组的严格校验（`zcodeWorkflowsForRunCandidateSchema` 的同一形状：≤ 8 条、每条
/// `.strict()` 只有 name + 可选 scope）。原样回传清洗后的数组——sidecar 的名字合法性检查
/// 仍会逐条过一遍（非法候选是跳过，不是错误）。
fn candidates_of(value: &Value) -> Result<Value, RpcError> {
    let items = value
        .as_array()
        .ok_or_else(|| invalid("`candidates` must be an array"))?;
    if items.len() > FOR_RUN_MAX_CANDIDATES {
        return Err(invalid(format!(
            "`candidates` must have at most {FOR_RUN_MAX_CANDIDATES} items"
        )));
    }
    let mut clean = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let candidate = item
            .as_object()
            .ok_or_else(|| invalid(format!("`candidates[{index}]` must be an object")))?;
        let mut entry = serde_json::Map::new();
        for (key, item) in candidate {
            match key.as_str() {
                "name" => {
                    let text = required_non_empty(item, "`candidates[].name`")?;
                    entry.insert("name".into(), Value::String(text));
                }
                "scope" => {
                    let scope = item.as_str().filter(|scope| {
                        matches!(*scope, "project" | "global")
                    });
                    match scope {
                        Some(scope) => {
                            entry.insert("scope".into(), Value::String(scope.to_owned()));
                        }
                        None => {
                            return Err(invalid(
                                "`candidates[].scope` must be `project` or `global`",
                            ));
                        }
                    }
                }
                other => {
                    return Err(invalid(format!(
                        "Unrecognized key `{other}` in `candidates[{index}]`"
                    )));
                }
            }
        }
        // name 必填（schema 无 `.optional()`）。
        if !entry.contains_key("name") {
            return Err(invalid("`candidates[].name` must be a non-empty string"));
        }
        clean.push(Value::Object(entry));
    }
    Ok(Value::Array(clean))
}

/// 降级（没接 sidecar 的入口）由 kernel 层现做：home 在机器事实里，协议层不读环境。
fn error_message(error: KernelError) -> String {
    match error {
        KernelError::Failed { message } => message,
        other => other.to_string(),
    }
}

/// 参数违规（Node `parseParams` 的 `-32602`，message 前缀同形）。
fn invalid(message: impl std::fmt::Display) -> RpcError {
    RpcError::invalid_params(format!("Invalid params — {message}"))
}

#[cfg(test)]
#[path = "nibi_workflows_tests.rs"]
mod tests;
