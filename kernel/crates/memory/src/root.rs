//! 项目记忆目录：与 Node `resolveProjectMemoryRoot`（`@nibi/core` 的 `memory/project-root.ts`）
//! 同一套口径——`<cliStorageRoot>/memories/projects/<slug>-<sha256 前 16 位>/memory`。
//!
//! Node 的 key：工作区身份优先；没有身份时用规范化的工作区路径，Windows 上先转小写。
//! slug：有身份时固定 `project`，否则取工作区目录名的小写净化版本。
//!
//! 这里只算路径，不读文件系统；目录是否存在由调用方（入口 / 抽取）保证。

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// 项目记忆目录（平台按编译目标）。
pub fn project_memory_root(
    cli_storage_root: &Path,
    workspace_path: &str,
    workspace_identity: Option<&str>,
) -> PathBuf {
    project_memory_root_for(
        cli_storage_root,
        workspace_path,
        workspace_identity,
        cfg!(windows),
    )
}

/// 同 [`project_memory_root`]，平台可显式指定（测试用）。
pub fn project_memory_root_for(
    cli_storage_root: &Path,
    workspace_path: &str,
    workspace_identity: Option<&str>,
    windows: bool,
) -> PathBuf {
    let identity = workspace_identity
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let normalized = normalize_workspace_path(workspace_path, windows);
    let key_source = match identity {
        Some(identity) => identity.to_owned(),
        None if windows => normalized.to_lowercase(),
        None => normalized.clone(),
    };
    let hash = short_hash(&key_source);
    let slug = match identity {
        Some(_) => "project".to_owned(),
        None => sanitize_project_slug(&basename(&normalized, windows)),
    };
    cli_storage_root
        .join("memories")
        .join("projects")
        .join(format!("{slug}-{hash}"))
        .join("memory")
}

/// Node `isPosixAbsolutePath`：以 `/` 开头、不是盘符形状、不含反斜杠。
fn is_posix_absolute(value: &str) -> bool {
    value.starts_with('/') && !value.contains('\\') && !has_drive_prefix(value)
}

fn has_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn normalize_workspace_path(value: &str, windows: bool) -> String {
    if is_posix_absolute(value) {
        return normalize_posix(value);
    }
    if windows {
        return normalize_windows(value);
    }
    // Node `path.resolve`：相对路径先按进程 cwd 变成绝对路径。
    let absolute = if value.starts_with('/') {
        value.to_owned()
    } else {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
        format!("{}/{}", cwd.to_string_lossy().trim_end_matches('/'), value)
    };
    normalize_posix(&absolute)
}

fn normalize_posix(value: &str) -> String {
    let absolute = value.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            _ => parts.push(part),
        }
    }
    let mut out = String::new();
    if absolute {
        out.push('/');
    }
    out.push_str(&parts.join("/"));
    if out.is_empty() {
        if absolute {
            "/".to_owned()
        } else {
            ".".to_owned()
        }
    } else {
        out
    }
}

/// Node 在 Windows 上 `path.resolve` 的规范化：盘符大写、统一反斜杠、折叠 `.` / `..`。
fn normalize_windows(value: &str) -> String {
    let replaced = value.replace('/', "\\");
    let (prefix, rest, absolute) = if let Some(rest) = replaced.strip_prefix("\\\\") {
        ("\\\\".to_owned(), rest.to_owned(), true)
    } else if has_drive_prefix(&replaced) {
        let drive = replaced[..1].to_ascii_uppercase();
        let rest = &replaced[2..];
        if rest.starts_with('\\') {
            (
                format!("{drive}:\\"),
                rest.trim_start_matches('\\').to_owned(),
                true,
            )
        } else {
            (format!("{drive}:"), rest.to_owned(), false)
        }
    } else if let Some(rest) = replaced.strip_prefix('\\') {
        ("\\".to_owned(), rest.to_owned(), true)
    } else {
        (String::new(), replaced.clone(), false)
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in rest.split('\\') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            _ => parts.push(part),
        }
    }
    let joined = parts.join("\\");
    match (prefix.is_empty(), joined.is_empty()) {
        (true, true) => ".".to_owned(),
        (true, false) => joined,
        (false, true) => prefix,
        (false, false) => format!("{prefix}{joined}"),
    }
}

fn basename(value: &str, windows: bool) -> String {
    if windows {
        let trimmed = value.trim_end_matches(['\\', '/']);
        if trimmed.len() == 2 && has_drive_prefix(trimmed) {
            return String::new();
        }
        value
            .rsplit(['\\', '/'])
            .find(|part| !part.is_empty())
            .unwrap_or_default()
            .to_owned()
    } else {
        value
            .rsplit('/')
            .find(|part| !part.is_empty())
            .unwrap_or_default()
            .to_owned()
    }
}

/// Node `sanitizeProjectSlug`：小写；不在 `[a-z0-9._-]` 的连续片段换成一个 `-`；
/// 去掉首尾 `-`；最多 48 个字符；空时 `project`。
fn sanitize_project_slug(value: &str) -> String {
    let lowered = value.to_lowercase();
    let mut slug = String::new();
    let mut in_gap = false;
    for ch in lowered.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '.' | '_' | '-') {
            slug.push(ch);
            in_gap = false;
        } else if !in_gap {
            slug.push('-');
            in_gap = true;
        }
    }
    let slug = slug.trim_matches('-');
    let truncated: String = slug.chars().take(48).collect();
    if truncated.is_empty() {
        "project".to_owned()
    } else {
        truncated
    }
}

fn short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let hex = format!("{digest:x}");
    hex[..16].to_owned()
}

#[cfg(test)]
#[path = "root_tests.rs"]
mod tests;
