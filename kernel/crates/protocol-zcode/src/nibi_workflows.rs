//! NIBI 协议中枢的运行历史（`workflows/runs`，Node `listSavedWorkflowRunsOp` 同一契约）：
//! GUI 中枢按「工作流名 = run 名」归属运行历史。只读 journal、在任何会话之外——中枢看不到
//! 「submit 已回、行未落」的注册表间隙，那几个微任务靠下一次刷新补上。
//!
//! 参数契约从 Node 的 zod 逐字（`.strict()`：未知键与类型错一律 `-32602`，message 前缀同形）；
//! journal 缺席（内核没接会话库）回空页而不是错误——中枢据此显示「尚未运行」。

use rust_cli_kernel_api::session_api::KernelError;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::{json, Value};

use crate::server::Server;

/// 中枢的页大小上限（Node `NIBI_WORKFLOWS_RUNS_MAX_LIMIT`）；多取一条**只为判定 truncated**。
const MAX_LIMIT: u64 = 50;

pub(crate) async fn runs(server: &Server, raw: &Value) -> Result<Value, RpcError> {
    let params = raw
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))?;
    let workspace = params
        .get("workspace")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("`workspace` must be an object"))?;
    let workspace_path = workspace
        .get("workspacePath")
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| invalid("`workspace.workspacePath` must be a non-empty string"))?;
    // 稳定键是 ref 契约的必填项（strict；op 只读 workspacePath，键的存在照样要验）。
    if workspace
        .get("workspaceKey")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(invalid("`workspace.workspaceKey` must be a non-empty string"));
    }
    // zod `.optional()`：显式 null 不在契约里（服务层缺席时省键，不发 null）。
    let name = match params.get("name") {
        None => None,
        Some(Value::String(name)) if !name.is_empty() => Some(name.clone()),
        Some(_) => return Err(invalid("`name` must be a non-empty string")),
    };
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

/// 参数违规（Node `parseParams` 的 `-32602`，message 前缀同形）。
fn invalid(message: impl std::fmt::Display) -> RpcError {
    RpcError::invalid_params(format!("Invalid params — {message}"))
}
