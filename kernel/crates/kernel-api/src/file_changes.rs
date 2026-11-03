//! 文件变更聚合与回退预览（141 审计 §9 第 2 项余项）：`v4/conversation/fileChanges` 与
//! `v4/conversation/fileRewindPreview` 的共享词表。
//!
//! 两份结果都是 Host 的 zod schema（`packages/shared/src/nibi-protocol-v4/transport.ts`）逐字段
//! 对应：变更明细带补丁块（`readonlyDiffHunkSchema`），回退预览按「能安全恢复 / 不能 / 忽略」
//! 三组给出原因。分类规则来自 Node 的 `previewWorkspaceFileRewind`
//! （`packages/core/src/runtime/methods/file-rewind.ts`）：bash 写过的文件不可追踪所以忽略；
//! checkpoint 里的写入后内容与磁盘当前内容不符就是「被外部改过」。
//!
//! 补丁块不做最小 diff：去掉公共前后缀后，删除行在前、新增行在后，两侧各留三行上下文——与
//! tools 写 checkpoint 时用的同一算法（Node 注释同样说明「不是最小 diff」）。

use serde::{Deserialize, Serialize};

use crate::ids::MessageId;

/// 上下文行数（jsdiff `structuredPatch` 的默认值）。
const CONTEXT: usize = 3;

/// 一个统一 diff 块（Host `readonlyDiffHunkSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub old_start: u64,
    pub old_lines: u64,
    pub new_start: u64,
    pub new_lines: u64,
    /// 行首是 ` `（上下文）、`-`（删除）或 `+`（新增）。
    pub lines: Vec<String>,
}

/// 两条文本的补丁块与增删行数。相同文本没有块。
pub fn structured_patch(before: &str, after: &str) -> (Vec<DiffHunk>, u64, u64) {
    let old: Vec<&str> = lines(before);
    let new: Vec<&str> = lines(after);
    let prefix = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let suffix = old[prefix..]
        .iter()
        .rev()
        .zip(new[prefix..].iter().rev())
        .take_while(|(a, b)| a == b)
        .count();
    let removed = &old[prefix..old.len() - suffix];
    let added = &new[prefix..new.len() - suffix];
    if removed.is_empty() && added.is_empty() {
        return (Vec::new(), 0, 0);
    }
    let lead = prefix.min(CONTEXT);
    let trail = suffix.min(CONTEXT);
    let mut body: Vec<String> = old[prefix - lead..prefix]
        .iter()
        .map(|line| format!(" {line}"))
        .collect();
    body.extend(removed.iter().map(|line| format!("-{line}")));
    body.extend(added.iter().map(|line| format!("+{line}")));
    let tail = old.len() - suffix;
    body.extend(
        old[tail..tail + trail]
            .iter()
            .map(|line| format!(" {line}")),
    );
    let old_lines = (lead + removed.len() + trail) as u64;
    let new_lines = (lead + added.len() + trail) as u64;
    // jsdiff：某一侧没有行时起始行号为 0。
    let start = |count: u64| if count == 0 { 0 } else { (prefix - lead + 1) as u64 };
    (
        vec![DiffHunk {
            old_start: start(old_lines),
            old_lines,
            new_start: start(new_lines),
            new_lines,
            lines: body,
        }],
        added.len() as u64,
        removed.len() as u64,
    )
}

/// 按 `\n` 分行，行内不含换行符；末尾的换行不产生空行。
fn lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    text.strip_suffix('\n')
        .unwrap_or(text)
        .split('\n')
        .collect()
}

/// 补丁块里的增删行数（Host `countPatchLines`）。
pub fn patch_stats(hunks: &[DiffHunk]) -> (u64, u64) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in hunks.iter().flat_map(|hunk| &hunk.lines) {
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

/// 一个文件的改动明细（Host `items[]`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeItem {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
    /// 这一轮里写这个文件的次数（checkpoint 里的文件条数）。
    pub write_count: u32,
    /// 写过它的工具名，排序去重。
    pub tool_names: Vec<String>,
    /// 从这一轮第一次写入前到最后一次写入后的补丁；没有写入后内容时退回逐次写入的补丁。
    pub patches: Vec<DiffHunk>,
}

/// `v4/conversation/fileChanges` 的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChangesReport {
    pub files: u64,
    pub additions: u64,
    pub deletions: u64,
    /// 按路径排序。
    pub items: Vec<FileChangeItem>,
}

impl FileChangesReport {
    pub fn empty() -> Self {
        Self {
            files: 0,
            additions: 0,
            deletions: 0,
            items: Vec::new(),
        }
    }
}

/// 一轮的摘要（冷投影的轮头 `fileChanges`，Host `turnHeaderRowSchema.fileChanges`）。
///
/// `prompt` 是开启这一轮的 user 消息：冷投影按它把摘要挂回轮头行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFileSummary {
    pub prompt: MessageId,
    pub files: u64,
    pub additions: u64,
    pub deletions: u64,
}

/// 安全文件的动作。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RewindAction {
    #[default]
    Restore,
    Delete,
}

impl RewindAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Restore => "restore",
            Self::Delete => "delete",
        }
    }
}

/// 不能安全回退的原因（Host `v4WorkspaceFileRewindUnsafeFileSchema.reason`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RewindUnsafeReason {
    /// 找不到这一轮对应的 checkpoint。
    CheckpointMissing,
    /// checkpoint 的 artifact 读不出或解析失败。
    CheckpointUnreadable,
    /// 磁盘上的内容已经不是 checkpoint 写入后的内容（被别的方式改过）。
    ExternalModified,
    /// 读当前文件失败（权限、机器没连上等）。
    FileReadFailed,
    /// checkpoint 里没有写入后的内容，也无法从补丁重建。
    UnsupportedCheckpoint,
}

/// 能安全恢复的文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindSafeFile {
    pub action: RewindAction,
    pub operation_count: u32,
    pub path: String,
    pub tool_names: Vec<String>,
}

/// 不能安全恢复的文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindUnsafeFile {
    pub path: String,
    pub reason: RewindUnsafeReason,
    pub operation_count: u32,
    pub tool_names: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 被忽略的文件（bash / shell 写过的，没有 checkpoint）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindIgnoredFile {
    pub operation_count: u32,
    pub path: String,
    /// 恒为 `bash_ignored`（Host 的 schema 只有这一个取值）。
    #[serde(default = "bash_ignored_reason")]
    pub reason: String,
    pub tool_names: Vec<String>,
}

fn bash_ignored_reason() -> String {
    "bash_ignored".to_owned()
}

/// `v4/conversation/fileRewindPreview` 的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindPreview {
    pub can_apply: bool,
    pub safe_files: Vec<RewindSafeFile>,
    pub unsafe_files: Vec<RewindUnsafeFile>,
    pub ignored_files: Vec<RewindIgnoredFile>,
}

impl RewindPreview {
    pub fn empty() -> Self {
        Self {
            can_apply: false,
            safe_files: Vec::new(),
            unsafe_files: Vec::new(),
            ignored_files: Vec::new(),
        }
    }
}

/// bash / shell 类工具：它们写的文件没有 checkpoint，回退时只能忽略（Node `isIgnoredShellTool`）。
pub fn bash_ignored(tool_name: &str) -> bool {
    let normalized: String = tool_name
        .to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    normalized == "bash"
        || normalized == "shell"
        || normalized.contains("terminal")
        || normalized.ends_with("shell")
}

#[cfg(test)]
#[path = "file_changes_tests.rs"]
mod tests;
