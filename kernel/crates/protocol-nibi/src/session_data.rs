//! `v4/storage/sessionData/measure` / `purge`（上游 `packages/shared/src/zcode-protocol-v4/
//! session-data/contract.ts`）。
//!
//! 载荷与上游 zod 的 `.strict()` 同形：`{sessionIds, directories}`，目录是
//! `{workspacePath, workspaceIdentity?}`；未知键、空字符串与类型错一律 `-32602`。方法名是上游
//! `V4_METHODS` 的冻结值，旧 Host 看到 method-not-found 时隐藏入口；内核自身不存在这个能力面时
//! 按标准内部错误返回（`KernelError::Unsupported`）。
//!
//! 语义在 [`nibi_kernel_api::session_data`] 与 runtime：这里只做校验、转发与删成功后的会话列表
//! 清理（`session.removed`），不碰存储。

use nibi_kernel_api::session_data::{SessionDataDirectory, SessionDataParams};
use nibi_kernel_protocol_core::connection::Reply;
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{Map, Value};

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

fn array<'a>(params: &'a Map<String, Value>, key: &str) -> Result<&'a Vec<Value>, RpcError> {
    params
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| invalid(format!("`{key}` must be an array")))
}

fn parse(raw: &Value) -> Result<SessionDataParams, RpcError> {
    let params = object(raw)?;
    strict_keys(params, &["sessionIds", "directories"])?;
    let mut session_ids = Vec::new();
    for value in array(params, "sessionIds")? {
        let id = value
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| invalid("`sessionIds` must contain non-empty strings"))?;
        session_ids.push(nibi_kernel_api::ids::SessionId::new(id));
    }
    let mut directories = Vec::new();
    for value in array(params, "directories")? {
        let directory = object(value)?;
        strict_keys(directory, &["workspacePath", "workspaceIdentity"])?;
        let workspace_path = non_empty_string(directory, "workspacePath")?;
        let workspace_identity = match directory.get("workspaceIdentity") {
            None => None,
            Some(value) => Some(
                value
                    .as_str()
                    .filter(|identity| !identity.is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        invalid("`workspaceIdentity` must be a non-empty string when present")
                    })?,
            ),
        };
        directories.push(SessionDataDirectory {
            workspace_path,
            workspace_identity,
        });
    }
    Ok(SessionDataParams {
        session_ids,
        directories,
    })
}

fn result(value: impl serde::Serialize) -> Result<Reply, RpcError> {
    serde_json::to_value(value)
        .map(Reply::new)
        .map_err(|error| {
            RpcError::internal(format!("could not encode the session data result: {error}"))
        })
}

pub(crate) async fn measure(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let params = parse(params)?;
    let measured = server
        .kernel
        .measure_session_data(params)
        .await
        .map_err(|error| kernel_error(&error))?;
    result(measured)
}

pub(crate) async fn purge(server: &Server, params: &Value) -> Result<Reply, RpcError> {
    let params = parse(params)?;
    let purged = server
        .kernel
        .purge_session_data(params)
        .await
        .map_err(|error| kernel_error(&error))?;
    // 文件与行都删掉之后才从 sessions-index 投影移除（上游 `forgetIndexed`）。不发这一帧的话，
    // Host 的 tasks-index 会按旧列表行把会话加回来。
    for deleted in &purged.deleted {
        server.topics.remove(deleted.session_id.as_str());
    }
    result(purged)
}

#[cfg(test)]
#[path = "session_data_tests.rs"]
mod tests;
