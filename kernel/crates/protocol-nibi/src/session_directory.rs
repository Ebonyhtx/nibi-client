//! `session/list`（Host 的任务列表、项目谱系校验与分享导入去重）。
//!
//! 语义逐条对齐 Node `listSessions`（`apps/zcode-cli/packages/bootstrap/src/nibi-protocol/
//! server-operations.ts`）：
//!
//! - 给了 `sessionIds` 就逐个按持久化身份读，**不看目录与任务类型**——Host 用它沿父链证明
//!   项目归属（`project.session-lineage-invalid` 的那条链）；
//! - 否则按 `workspacePath` 列这个工作区的任务（Node `TASK_LIST_SESSION_TYPES`），默认 50 条；
//! - 两种读法都过同一道归属校验：`workspaceIdentity`（远端）优先，否则按 `path || directory`
//!   比对；只有辅助会话（子代理 / 工作流子会话 / 辅助对话）能沿父链上溯，且上溯的每一跳都必须
//!   落在同一个工作区目录里。
//!
//! 旧实现恒回 `{"sessions": []}`：Rust 内核下任务列表永远是空的。这是功能缺口，不是协议缺口
//! ——Host 侧没有任何降级可以救，它只会认为这个工作区没有会话。

use std::collections::HashSet;

use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::session_api::KernelError;
use nibi_kernel_api::store::{SessionDirectoryEntry, SessionDirectoryQuery};
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::server::Server;

/// Node `isAuxiliarySessionKind`：只有这几类可以沿父链证明归属。
///
/// `fork` 与 `workflow_parent` **不在**其中——它们是独立任务，即使有父会话也不能沿父链
/// 改写项目（Node 同一裁决，见 `zcodeSessionKindSchema` 下面的注释）。
fn is_auxiliary(task_type: &str) -> bool {
    matches!(
        task_type,
        "subagent_child" | "workflow_child" | "nested_workflow_child" | "selection_side_chat"
    )
}

fn non_empty(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|text| !text.is_empty())
}

/// 会话行的工作目录：Node `current.path || current.directory`（空串等同没有）。
fn row_path(entry: &SessionDirectoryEntry) -> &str {
    entry
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or(&entry.directory)
}

/// Node 的归属键：`workspaceID?.trim() || (path || directory)`。
fn row_key(entry: &SessionDirectoryEntry) -> &str {
    entry
        .workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|identity| !identity.is_empty())
        .unwrap_or_else(|| row_path(entry))
}

/// 按 ID 读一行（父链上溯的一跳）。软删除的行读不出来——Node 的父链遍历也以
/// `time.deleted === undefined` 为前提。
async fn fetch(server: &Server, id: &SessionId) -> Result<Option<SessionDirectoryEntry>, RpcError> {
    let entries = server
        .kernel
        .session_directory(SessionDirectoryQuery {
            directory: None,
            ids: Some(vec![id.clone()]),
            limit: 1,
        })
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    Ok(entries.into_iter().next())
}

/// Node 的 `scoped()`：这一行是否属于 `expected_key` 那个工作区。
///
/// 返回值只回答「接受 / 不接受」，调用方回的是**起点行**——沿父链上溯是为了证明归属，
/// 不是要把父会话当结果返回。
///
/// **注意**：这五个条件按 Node 原文排列。它们合起来使循环实际上只走一圈——`key` 是
/// `workspaceID || path`，`key != expected` 之后只剩两种可能：没有身份时 `path != expected`，
/// 于是 `path !== workspacePath` 直接拒绝；有身份时 `key != path`，于是最后一条直接拒绝。
/// 保留循环结构是为了与 Node 逐条对齐（它以后修了父链判定，这里要跟着动），改动任一条件
/// 都必须重新确认这段结论。
async fn owned(
    server: &Server,
    entry: &SessionDirectoryEntry,
    workspace_path: &str,
    expected_key: &str,
) -> Result<bool, RpcError> {
    let mut current = entry.clone();
    let mut visited = HashSet::new();
    loop {
        if !visited.insert(current.id.as_str().to_owned()) {
            // 父链成环（坏数据）：Node 用 visited 挡住，这里同样拒绝而不是继续上溯。
            return Ok(false);
        }
        let path = row_path(&current).to_owned();
        let key = row_key(&current).to_owned();
        if key == expected_key {
            return Ok(true);
        }
        let identity = current
            .workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|identity| !identity.is_empty());
        // Node 的「这一跳能不能继续上溯」：辅助会话、有父、这一跳就在工作区目录里，
        // 且没带对不上的远端身份。
        let can_walk = is_auxiliary(&current.task_type)
            && current.parent.is_some()
            && path == workspace_path
            && !(identity.is_some() && key != path);
        if !can_walk {
            return Ok(false);
        }
        let parent = current.parent.clone().expect("can_walk 要求有父会话");
        let Some(next) = fetch(server, &parent).await? else {
            return Ok(false);
        };
        if row_path(&next) != workspace_path {
            return Ok(false);
        }
        current = next;
    }
}

/// `zcodeSessionInfo`（`packages/shared/src/nibi-protocol-legacy-types.ts`）。
///
/// 目录读法不带 app / projection，所以 Node 的 `mapSessionInfo` 给的就是缺省值：
/// `mode: "build"`、`status: "idle"`，`model` / `target` 不出现（两者在 schema 里都可选）。
fn info(entry: &SessionDirectoryEntry, requested: Option<&Value>) -> Value {
    let workspace = match requested {
        Some(workspace) => workspace.clone(),
        // Node `buildWorkspaceRef({workspacePath: session.path ?? session.directory})`：
        // 本机会话的 workspaceKey 就是路径。
        None => {
            let path = row_path(entry);
            json!({"workspacePath": path, "workspaceKey": path})
        }
    };
    let mut value = json!({
        "sessionId": entry.id.as_str(),
        "workspace": workspace,
        "sessionKind": entry.task_type,
        "title": entry.title,
        "mode": "build",
        "status": "idle",
        "createdAt": entry.created_at_ms,
        "updatedAt": entry.updated_at_ms,
    });
    if let Some(parent) = &entry.parent {
        value["parentSessionId"] = json!(parent.as_str());
    }
    if let Some(trace) = &entry.trace {
        value["traceId"] = json!(trace);
    }
    if let Some(source) = &entry.title_source {
        value["titleSource"] = json!(source);
    }
    value
}

pub async fn list(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let requested = params.get("workspace").filter(|value| value.is_object());
    let workspace_path = requested.and_then(|workspace| non_empty(&workspace["workspacePath"]));
    let identity = requested.and_then(|workspace| non_empty(&workspace["workspaceIdentity"]));
    let ids: Option<Vec<SessionId>> = params.get("sessionIds").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(SessionId::new)
            .collect()
    });
    // Node `params.limit ?? 50`；非正数按不设限处理（`listSessions` 只在 > 0 时才加 limit）。
    let limit = params["limit"]
        .as_u64()
        .filter(|limit| *limit > 0)
        .and_then(|limit| usize::try_from(limit).ok())
        .unwrap_or(50);

    let query = SessionDirectoryQuery {
        // 显式 ID 读法不带目录：Host 查的是身份，可能是别的目录下的子会话。
        directory: if ids.is_some() { None } else { workspace_path.map(str::to_owned) },
        ids,
        limit,
    };
    let rows = match server.kernel.session_directory(query).await {
        Ok(rows) => rows,
        // 存储端口没有这条读面时退回空列表：Host 把错误当加载失败，空列表至少不打断它。
        Err(KernelError::Unsupported { what }) => {
            tracing::warn!(
                event = "protocol.session_list.unsupported",
                what = %what,
                "the store has no session directory; the task list is empty"
            );
            return Ok(json!({"sessions": []}));
        }
        Err(error) => return Err(crate::server::kernel_error(&error)),
    };

    let mut sessions = Vec::with_capacity(rows.len());
    for row in rows {
        // 没有 workspace 参数时 Node 只要求「没被软删除」（存储已经滤过）。
        let scoped = match workspace_path {
            Some(path) => {
                let expected = identity.unwrap_or(path);
                owned(server, &row, path, expected).await?
            }
            None => true,
        };
        if scoped {
            sessions.push(info(&row, requested));
        }
    }
    Ok(json!({"sessions": sessions}))
}
