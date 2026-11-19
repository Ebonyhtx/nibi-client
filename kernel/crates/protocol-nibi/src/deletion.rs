//! `v4/storage/sessionData/deletionPreview` / `deletionExecute`：归档会话的永久删除。
//!
//! 参数是严格形状（同 zod `.strict()`）：`{sessionId, workspace:{workspacePath, workspaceIdentity?}}`，
//! 执行另带 `revision`（预检给出的版本事实）与 `operationId`（写进删除凭据的 `operation_id`）。未知键、
//! 空字符串与类型错一律 `-32602`。
//!
//! 语义在内核（[`nibi_kernel_api::deletion`]）与存储（`nibi-kernel-node-store` 的 `purge`）；这里只做校验、
//! 转发与删成功后的会话列表清理（`session.removed`）。与旧的 `sessionData/purge` 是两条路径：purge 是项目
//! 彻底删除的字节统计与尽力清理，这里按 Node 的删除凭据走（先预检再开删、删文件、删行）。

use nibi_kernel_api::deletion::{
    DeletionBlock, DeletionOutcome, DeletionPreview, DeletionResult, RetainedArtifact,
    TitledSession,
};
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_protocol_core::connection::Reply;
use nibi_kernel_protocol_core::rpc::RpcError;
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::server::{Server, kernel_error};

fn invalid(message: impl std::fmt::Display) -> RpcError {
    RpcError::invalid_params(format!("Invalid params — {message}"))
}

fn object(params: &Value) -> Result<&Map<String, Value>, RpcError> {
    params
        .as_object()
        .ok_or_else(|| invalid("params must be an object"))
}

fn strict_keys(params: &Map<String, Value>, known: &[&str]) -> Result<(), RpcError> {
    for key in params.keys() {
        if !known.contains(&key.as_str()) {
            return Err(invalid(format!("Unrecognized key `{key}`")));
        }
    }
    Ok(())
}

fn non_empty_string(params: &Map<String, Value>, key: &str) -> Result<String, RpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid(format!("`{key}` must be a non-empty string")))
}

/// `{workspacePath, workspaceIdentity?}` → 工作区（身份缺席时用进程的缺省环境）。
fn workspace(server: &Server, params: &Map<String, Value>) -> Result<WorkspaceRef, RpcError> {
    let workspace = params
        .get("workspace")
        .and_then(Value::as_object)
        .ok_or_else(|| invalid("`workspace` must be an object"))?;
    strict_keys(workspace, &["workspacePath", "workspaceIdentity"])?;
    let path = non_empty_string(workspace, "workspacePath")?;
    let environment = match workspace.get("workspaceIdentity") {
        None => server.defaults.environment.clone(),
        Some(value) => {
            let identity = value
                .as_str()
                .filter(|identity| !identity.is_empty())
                .ok_or_else(|| {
                    invalid("`workspaceIdentity` must be a non-empty string when present")
                })?;
            EnvironmentId::new(identity)
        }
    };
    Ok(WorkspaceRef {
        environment,
        root: EnvPath::new(path),
    })
}

/// 预检的入参。
struct PreviewParams {
    session: SessionId,
    workspace: WorkspaceRef,
}

fn preview_params(server: &Server, params: &Value) -> Result<PreviewParams, RpcError> {
    let params = object(params)?;
    strict_keys(params, &["sessionId", "workspace"])?;
    Ok(PreviewParams {
        session: SessionId::new(non_empty_string(params, "sessionId")?),
        workspace: workspace(server, params)?,
    })
}

/// 执行的入参（另带 `revision` 与 `operationId`）。
struct ExecuteParams {
    session: SessionId,
    workspace: WorkspaceRef,
    revision: String,
    operation: String,
}

fn execute_params(server: &Server, params: &Value) -> Result<ExecuteParams, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &["sessionId", "workspace", "revision", "operationId"],
    )?;
    Ok(ExecuteParams {
        session: SessionId::new(non_empty_string(params, "sessionId")?),
        workspace: workspace(server, params)?,
        revision: non_empty_string(params, "revision")?,
        operation: non_empty_string(params, "operationId")?,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Titled {
    session_id: String,
    title: String,
}

fn titled(sessions: &[TitledSession]) -> Vec<Titled> {
    sessions
        .iter()
        .map(|titled| Titled {
            session_id: titled.session.as_str().to_owned(),
            title: titled.title.clone(),
        })
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Retained {
    session_id: String,
    artifact_id: String,
    file_name: String,
    referrers: Vec<Titled>,
}

fn retained(artifacts: &[RetainedArtifact]) -> Vec<Retained> {
    artifacts
        .iter()
        .map(|retained| Retained {
            session_id: retained.session.as_str().to_owned(),
            artifact_id: retained.artifact.clone(),
            file_name: retained.file_name.clone(),
            referrers: titled(&retained.referrers),
        })
        .collect()
}

/// 预检的结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreviewResult {
    session_id: String,
    revision: String,
    session_ids: Vec<String>,
    forks: Vec<Titled>,
    retained_artifacts: Vec<Retained>,
    deleted_files: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    blocked_reason: Option<&'static str>,
    incomplete: bool,
    completed: bool,
}

fn block_reason(block: DeletionBlock) -> &'static str {
    match block {
        DeletionBlock::Running => "running",
        DeletionBlock::Changed => "changed",
        DeletionBlock::OtherWorkspace => "unavailable",
        DeletionBlock::NotFound => "not_found",
    }
}

fn preview_result(root: &SessionId, preview: &DeletionPreview) -> PreviewResult {
    PreviewResult {
        session_id: root.as_str().to_owned(),
        revision: preview.revision.clone(),
        session_ids: ids(&preview.sessions),
        forks: titled(&preview.forks),
        retained_artifacts: retained(&preview.retained),
        deleted_files: u64::try_from(preview.deleted_files).unwrap_or(u64::MAX),
        blocked_reason: preview.blocked.map(block_reason),
        incomplete: preview.incomplete,
        completed: preview.completed,
    }
}

fn ids(sessions: &[SessionId]) -> Vec<String> {
    sessions
        .iter()
        .map(|session| session.as_str().to_owned())
        .collect()
}

/// 执行的结局 → 结果。`OtherWorkspace` 是前置条件（什么都没删），按内核的同一分类回报。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecuteResult {
    session_id: String,
    status: &'static str,
    session_ids: Vec<String>,
    retained_artifacts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

fn execute_result(root: &SessionId, result: &DeletionResult) -> ExecuteResult {
    let (status, reason) = match &result.outcome {
        DeletionOutcome::Deleted => ("deleted", None),
        DeletionOutcome::Blocked(block) => ("blocked", Some(block_reason(*block).to_owned())),
        DeletionOutcome::Incomplete(reason) => ("incomplete", Some(reason.clone())),
    };
    ExecuteResult {
        session_id: root.as_str().to_owned(),
        status,
        session_ids: ids(&result.sessions),
        retained_artifacts: u64::try_from(result.retained).unwrap_or(u64::MAX),
        reason,
    }
}

fn result(value: impl serde::Serialize) -> Result<Reply, RpcError> {
    serde_json::to_value(value)
        .map(Reply::new)
        .map_err(|error| {
            RpcError::internal(format!("could not encode the deletion result: {error}"))
        })
}

pub(crate) async fn preview(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let params = preview_params(server, params)?;
    let preview = server
        .kernel
        .deletion_preview(&params.session, &params.workspace)
        .await
        .map_err(|error| kernel_error(&error))?;
    result(preview_result(&params.session, &preview))
}

pub(crate) async fn execute(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let params = execute_params(server, params)?;
    let deleted = server
        .kernel
        .delete_permanently(
            &params.session,
            &params.workspace,
            &params.revision,
            &params.operation,
        )
        .await
        .map_err(|error| kernel_error(&error))?;
    if deleted.outcome == DeletionOutcome::Deleted {
        // 行已经删了：先撤掉协议层的运行实例，再从会话列表移除（`session.removed`）。不发这一帧的话
        // Host 的 tasks-index 会按旧的列表行把会话加回来。
        for session in &deleted.sessions {
            if server.bridge.get(session).is_some() {
                server
                    .close_session(&json!({"sessionId": session.as_str()}))
                    .await;
            }
            server.topics.remove(session.as_str());
        }
    }
    result(execute_result(&params.session, &deleted))
}

#[cfg(test)]
#[path = "deletion_tests.rs"]
mod tests;
