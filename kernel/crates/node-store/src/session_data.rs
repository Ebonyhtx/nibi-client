//! `v4/storage/sessionData/*` 的文件面：会话的 artifacts / exec / agents / sessions 目录、
//! 模型轨迹文件，以及目录的项目记忆（上游 `session-data-files` adapter）。
//!
//! 路径规则与 Node 相同：
//! - `<cli>/artifacts/<sid>`、`<cli>/exec/<sid>`、`<cli>/agents/<sid>`、`<cli>/sessions/<sid>`；
//! - `<cli>/{debug,rollout}/model-io-<sid>.jsonl`（两个目录都统计/删除，运行实际用的那一个即可）；
//! - 记忆是 `cli/memories/projects/<slug>-<hash>` 整个目录（`memory` 的父目录）。
//!
//! 只统计真实文件：符号链接按 0 且不跟随；缺失按 0；数据库行不计入（库文件不收缩）。

use std::io;
use std::path::{Path, PathBuf};

use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::session_data::{SessionDataDirectory, SessionDataError};

const SESSION_DIRECTORY_ROOTS: [&str; 4] = ["artifacts", "exec", "agents", "sessions"];
const MODEL_IO_DIRECTORIES: [&str; 2] = ["debug", "rollout"];
const MEMORY_PROJECTS_PATH: [&str; 2] = ["memories", "projects"];

/// 会话 ID 直接拼进路径，必须是单个安全文件名段（上游 `SAFE_SESSION_ID`）。
fn safe_session_id(session: &SessionId) -> Result<&str, SessionDataError> {
    let id = session.as_str();
    if !id.is_empty()
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
    {
        Ok(id)
    } else {
        Err(SessionDataError::new("session-data.invalid-session-id"))
    }
}

fn session_paths(cli_root: &Path, session: &SessionId) -> Result<Vec<PathBuf>, SessionDataError> {
    let id = safe_session_id(session)?;
    let mut paths: Vec<PathBuf> = SESSION_DIRECTORY_ROOTS
        .iter()
        .map(|name| cli_root.join(name).join(id))
        .collect();
    paths.extend(
        MODEL_IO_DIRECTORIES
            .iter()
            .map(|name| cli_root.join(name).join(format!("model-io-{id}.jsonl"))),
    );
    Ok(paths)
}

/// 记忆的项目目录（`.../memories/projects/<slug>-<hash>`，不含末尾的 `memory`）。只允许
/// `memories/projects` 的直接子目录，防止解析结果越界删到别处（上游同一道闸）。
fn memory_folder(
    cli_root: &Path,
    directory: &SessionDataDirectory,
) -> Result<PathBuf, SessionDataError> {
    let memory = nibi_kernel_memory::project_memory_root(
        cli_root,
        &directory.workspace_path,
        directory.workspace_identity.as_deref(),
    );
    let Some(folder) = memory.parent() else {
        return Err(SessionDataError::new("session-data.memory-outside-storage"));
    };
    let projects = cli_root
        .join(MEMORY_PROJECTS_PATH[0])
        .join(MEMORY_PROJECTS_PATH[1]);
    let Ok(relative) = folder.strip_prefix(&projects) else {
        return Err(SessionDataError::new("session-data.memory-outside-storage"));
    };
    if relative.as_os_str().is_empty() || relative.components().count() != 1 {
        return Err(SessionDataError::new("session-data.memory-outside-storage"));
    }
    Ok(folder.to_path_buf())
}

/// `io::Error` → 上游 `failed[].code` 的形状（Node 的 errno 字符串；未知按 `"unknown"`）。
fn code(error: &io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => "ENOENT",
        io::ErrorKind::PermissionDenied => "EACCES",
        io::ErrorKind::AlreadyExists => "EEXIST",
        io::ErrorKind::InvalidInput => "EINVAL",
        io::ErrorKind::WouldBlock => "EBUSY",
        io::ErrorKind::TimedOut => "ETIMEDOUT",
        io::ErrorKind::WriteZero | io::ErrorKind::StorageFull => "ENOSPC",
        _ => "unknown",
    }
    .to_owned()
}

fn file_error(error: io::Error) -> SessionDataError {
    SessionDataError::new(code(&error))
}

async fn measure_paths(paths: &[PathBuf]) -> Result<u64, SessionDataError> {
    let mut total = 0;
    for path in paths {
        total += nibi_kernel_fs::path_bytes(path).await.map_err(file_error)?;
    }
    Ok(total)
}

async fn remove_paths(paths: &[PathBuf]) -> Result<u64, SessionDataError> {
    // 先统计再删：删除后文件已经不可测（上游 `removeAll` 同一顺序）。
    let bytes = measure_paths(paths).await?;
    for path in paths {
        nibi_kernel_fs::remove_path(path)
            .await
            .map_err(file_error)?;
    }
    Ok(bytes)
}

pub(crate) async fn measure_session(
    cli_root: &Path,
    session: &SessionId,
) -> Result<u64, SessionDataError> {
    measure_paths(&session_paths(cli_root, session)?).await
}

pub(crate) async fn remove_session(
    cli_root: &Path,
    session: &SessionId,
) -> Result<u64, SessionDataError> {
    remove_paths(&session_paths(cli_root, session)?).await
}

pub(crate) async fn measure_memory(
    cli_root: &Path,
    directory: &SessionDataDirectory,
) -> Result<u64, SessionDataError> {
    measure_paths(&[memory_folder(cli_root, directory)?]).await
}

pub(crate) async fn remove_memory(
    cli_root: &Path,
    directory: &SessionDataDirectory,
) -> Result<u64, SessionDataError> {
    remove_paths(&[memory_folder(cli_root, directory)?]).await
}

#[cfg(test)]
#[path = "session_data_files_tests.rs"]
mod tests;
