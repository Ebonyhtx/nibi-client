//! 文件变更聚合与回退预览（141 审计 §9 第 2 项余项）。
//!
//! 两件事都在 checkpoint 的 artifact 上做：`fileChanges` 把一轮里的写入按路径汇总成
//! 增删行与补丁块（Node `readConversationFileChangesFromEvents`）；`fileRewindPreview` 按
//! `buildWorkspaceFileRewindPlan` 的口径把文件分成「能安全恢复 / 不能 / 忽略」，判据是
//! checkpoint 写入后的内容与磁盘当前内容是否一致。两者都不改文件，也不登记 token——执行仍在
//! [`crate::rewind_machines`]。
//!
//! 与 Node 的已知差异：没有 `afterContent` 的 artifact 不尝试用补丁重建写入后的内容，直接判
//! `unsupported_checkpoint`（Rust 的写入工具与 Node 的写入器都带 `afterContent`）。远端机器上的
//! 文件用那台机器的 `Files` 端口读；机器没连上时按 `file_read_failed` 报。

use std::collections::{BTreeSet, HashMap, HashSet};

use nibi_kernel_api::checkpoint::CheckpointArtifact;
use nibi_kernel_api::env::{EnvPath, ReadFile, WorkspaceRef};
use nibi_kernel_api::env_files::PathStyle;
use nibi_kernel_api::env_rewind::content_hash;
use nibi_kernel_api::file_changes::{
    DiffHunk, FileChangeItem, FileChangesReport, RewindAction, RewindIgnoredFile, RewindPreview,
    RewindSafeFile, RewindUnsafeFile, RewindUnsafeReason, TurnFileSummary, bash_ignored,
    patch_stats, structured_patch,
};
use nibi_kernel_api::ids::MessageId;
use nibi_kernel_api::machine::Files;
use nibi_kernel_api::store::{ArtifactStore, WorkspaceCheckpoint};


/// 给定消息集合选中这一轮的 checkpoint：prompt（开启这一轮的 user 消息）或 assistant（工具所在
/// 的 assistant 消息）在集合里。空集合表示「全部」（冷打开的摘要）。
pub(crate) fn select<'a>(
    checkpoints: &'a [WorkspaceCheckpoint],
    messages: &[MessageId],
) -> Vec<&'a WorkspaceCheckpoint> {
    if messages.is_empty() {
        return checkpoints.iter().collect();
    }
    let ids: HashSet<&MessageId> = messages.iter().collect();
    checkpoints
        .iter()
        .filter(|checkpoint| ids.contains(&checkpoint.prompt) || ids.contains(&checkpoint.assistant))
        .collect()
}

async fn read(store: &dyn ArtifactStore, checkpoint: &WorkspaceCheckpoint) -> Result<CheckpointArtifact, String> {
    let bytes = store
        .get(&checkpoint.snapshot)
        .await
        .map_err(|error| error.to_string())?;
    CheckpointArtifact::parse(&bytes).map_err(|error| error.to_string())
}

/// 一个路径在整轮里的汇总（Node `FileChangeAggregate`）。
#[derive(Default)]
struct Aggregate {
    before: Option<String>,
    after: Option<String>,
    /// 逐次写入的补丁（没有写入后内容时的退路）。
    patches: Vec<DiffHunk>,
    fallback_additions: u64,
    fallback_deletions: u64,
    tool_names: BTreeSet<String>,
    write_count: u32,
}

/// `v4/conversation/fileChanges`：一轮的文件改动明细，按路径排序。
///
/// artifact 读不出时整体失败（Node 同样向上抛）：宁可让前端看到一次读失败，也不静默少报一个
/// 文件。没有 checkpoint 的一轮返回空结果。
pub(crate) async fn report(
    store: &dyn ArtifactStore,
    checkpoints: &[&WorkspaceCheckpoint],
) -> Result<FileChangesReport, String> {
    let mut order: Vec<String> = Vec::new();
    let mut by_path: HashMap<String, Aggregate> = HashMap::new();
    for checkpoint in checkpoints {
        let artifact = read(store, checkpoint).await?;
        for file in &artifact.files {
            let (additions, deletions) = patch_stats(&file.structured_patch);
            match by_path.get_mut(&file.path) {
                None => {
                    order.push(file.path.clone());
                    by_path.insert(
                        file.path.clone(),
                        Aggregate {
                            before: file.before_content.clone().filter(|_| file.existed_before),
                            after: file.after_content.clone(),
                            patches: file.structured_patch.clone(),
                            fallback_additions: additions,
                            fallback_deletions: deletions,
                            tool_names: BTreeSet::from([artifact.tool_name.clone()]),
                            write_count: 1,
                        },
                    );
                }
                Some(entry) => {
                    if file.after_content.is_some() {
                        entry.after.clone_from(&file.after_content);
                    }
                    entry.patches.extend(file.structured_patch.iter().cloned());
                    entry.fallback_additions += additions;
                    entry.fallback_deletions += deletions;
                    entry.tool_names.insert(artifact.tool_name.clone());
                    entry.write_count += 1;
                }
            }
        }
    }
    let mut items: Vec<FileChangeItem> = order
        .into_iter()
        .filter_map(|path| {
            let entry = by_path.remove(&path)?;
            // 有写入后的内容时按「最早的写入前 → 最后的写入后」重算补丁与行数（Node 同一口径）。
            let (patches, additions, deletions) = match &entry.after {
                Some(after) => {
                    let (patches, additions, deletions) =
                        structured_patch(entry.before.as_deref().unwrap_or(""), after);
                    (patches, additions, deletions)
                }
                None => (
                    entry.patches,
                    entry.fallback_additions,
                    entry.fallback_deletions,
                ),
            };
            Some(FileChangeItem {
                path,
                additions,
                deletions,
                write_count: entry.write_count,
                tool_names: entry.tool_names.into_iter().collect(),
                patches,
            })
        })
        .collect();
    items.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(FileChangesReport {
        files: items.len() as u64,
        additions: items.iter().map(|item| item.additions).sum(),
        deletions: items.iter().map(|item| item.deletions).sum(),
        items,
    })
}

/// 冷投影的每轮摘要：按开启这一轮的 user 消息分组（Node `buildColdFileChangeSummaries`）。
/// artifact 读不出的 checkpoint 跳过并告警——摘要只影响轮头的角标，不该拦住会话打开。
pub(crate) async fn summaries(
    store: &dyn ArtifactStore,
    checkpoints: &[&WorkspaceCheckpoint],
) -> Vec<TurnFileSummary> {
    let mut order: Vec<MessageId> = Vec::new();
    let mut grouped: HashMap<MessageId, Vec<&WorkspaceCheckpoint>> = HashMap::new();
    for checkpoint in checkpoints {
        let entry = grouped.entry(checkpoint.prompt.clone()).or_default();
        if entry.is_empty() {
            order.push(checkpoint.prompt.clone());
        }
        entry.push(checkpoint);
    }
    let mut out = Vec::new();
    for prompt in order {
        let mut paths: Vec<String> = Vec::new();
        let mut additions = 0;
        let mut deletions = 0;
        let mut readable = true;
        for checkpoint in grouped.remove(&prompt).unwrap_or_default() {
            match read(store, checkpoint).await {
                Ok(artifact) => {
                    let (adds, dels) = report_of(&artifact);
                    for file in &artifact.files {
                        if !paths.contains(&file.path) {
                            paths.push(file.path.clone());
                        }
                    }
                    additions += adds;
                    deletions += dels;
                }
                Err(error) => {
                    tracing::warn!(%error, checkpoint = %checkpoint.id, "file change summary skipped an unreadable checkpoint");
                    readable = false;
                }
            }
        }
        if readable && !paths.is_empty() {
            out.push(TurnFileSummary {
                prompt,
                files: paths.len() as u64,
                additions,
                deletions,
            });
        }
    }
    out
}

/// 一个 artifact 的行数合计（摘要只要总数，明细按路径合并）。
fn report_of(artifact: &CheckpointArtifact) -> (u64, u64) {
    let mut additions = 0;
    let mut deletions = 0;
    for file in &artifact.files {
        let (adds, dels) = match &file.after_content {
            Some(after) => {
                let (_, adds, dels) = structured_patch(
                    file.before_content
                        .as_deref()
                        .filter(|_| file.existed_before)
                        .unwrap_or(""),
                    after,
                );
                (adds, dels)
            }
            None => patch_stats(&file.structured_patch),
        };
        additions += adds;
        deletions += dels;
    }
    (additions, deletions)
}

/// 一台机器上读文件的端口与工作区（预览按 checkpoint 的机器取）。
struct Access {
    files: std::sync::Arc<dyn Files>,
    workspace: WorkspaceRef,
}

/// 当前文件的状态：内容（不存在时 None）或读失败。
enum Current {
    Known(Option<String>),
    Failed(String),
}

async fn current(access: &Access, path: &str) -> Current {
    match access
        .files
        .read_file(
            &access.workspace,
            ReadFile {
                path: EnvPath::new(path.to_owned()),
            },
        )
        .await
    {
        Ok(file) => match String::from_utf8(file.bytes) {
            Ok(text) => Current::Known(Some(text)),
            Err(error) => Current::Failed(error.to_string()),
        },
        Err(nibi_kernel_api::env::EnvError::NotFound { .. }) => Current::Known(None),
        Err(error) => Current::Failed(error.to_string()),
    }
}

/// 内容的状态 hash：不存在时 `missing`（Node `hashContent(null)`）。
fn state_hash(content: Option<&str>) -> String {
    content.map_or_else(|| "missing".to_owned(), |text| content_hash(text.as_bytes()))
}

/// checkpoint 里的路径转成那台机器上的绝对路径（Node `resolveCheckpointFilePath`）：
/// 模型传入的相对路径按工作区根解析，已是绝对路径的原样保留。
fn resolve_path(workspace: &WorkspaceRef, path: &str) -> String {
    let style = PathStyle::infer(workspace.root.as_str());
    if style.is_absolute(path) {
        return path.to_owned();
    }
    style.resolve(workspace.root.as_str(), path, None)
}

/// 一个待预览的写入操作。
struct Operation {
    action: RewindAction,
    /// 写入后的内容（判据）；`None` 走 `unsupported_checkpoint`。
    after: Option<String>,
    before: Option<String>,
    path: String,
    tool_name: String,
    /// 这台机器上的文件（`None` 是本机）。
    machine: Option<String>,
}

/// 一个路径的预览汇总。
#[derive(Default)]
struct PreviewAggregate {
    action: RewindAction,
    operation_count: u32,
    tool_names: BTreeSet<String>,
    unsafe_reason: Option<RewindUnsafeReason>,
    current_hash: Option<String>,
    expected_hash: Option<String>,
    message: Option<String>,
}

/// 标记一个路径不安全（Node `markUnsafe`：第一次的原因优先，后来的哈希/文案不覆盖已有值）。
fn mark_unsafe(
    unsafe_paths: &mut HashMap<String, PreviewAggregate>,
    operation: &Operation,
    reason: RewindUnsafeReason,
    current_hash: Option<String>,
    expected_hash: Option<String>,
    message: Option<String>,
) {
    let entry = unsafe_paths.entry(operation.path.clone()).or_default();
    entry.action = operation.action;
    entry.operation_count += 1;
    entry.tool_names.insert(operation.tool_name.clone());
    if entry.unsafe_reason.is_none() {
        entry.unsafe_reason = Some(reason);
    }
    if current_hash.is_some() {
        entry.current_hash = current_hash;
    }
    if expected_hash.is_some() {
        entry.expected_hash = expected_hash;
    }
    if message.is_some() {
        entry.message = message;
    }
}

/// `v4/conversation/fileRewindPreview`：只读、不改文件、不登记 token。
pub(crate) async fn preview(
    store: &dyn ArtifactStore,
    local_files: &std::sync::Arc<dyn Files>,
    workspace: &WorkspaceRef,
    machines: &dyn nibi_kernel_api::env_registry::EnvironmentRegistry,
    checkpoints: &[&WorkspaceCheckpoint],
) -> RewindPreview {
    if checkpoints.is_empty() {
        return RewindPreview::empty();
    }
    // 机器 → 读文件的端口；没连上的机器记 None。
    let mut accesses: HashMap<Option<String>, Option<Access>> = HashMap::new();
    for name in checkpoints.iter().map(|checkpoint| checkpoint.machine.clone()) {
        if accesses.contains_key(&name) {
            continue;
        }
        let access = match &name {
            None => Some(Access {
                files: local_files.clone(),
                workspace: workspace.clone(),
            }),
            Some(machine) => machines.remote(machine).map(|(env, workspace)| Access {
                files: env.files().clone(),
                workspace,
            }),
        };
        accesses.insert(name, access);
    }

    let mut unsafe_files: Vec<RewindUnsafeFile> = Vec::new();
    let mut ignored: HashMap<String, PreviewAggregate> = HashMap::new();
    let mut operations: Vec<Operation> = Vec::new();
    let mut unsupported: HashMap<String, PreviewAggregate> = HashMap::new();
    for checkpoint in checkpoints {
        let artifact = match read(store, checkpoint).await {
            Ok(artifact) => artifact,
            Err(message) => {
                unsafe_files.push(RewindUnsafeFile {
                    path: format!("checkpoint:{}", checkpoint.id),
                    reason: RewindUnsafeReason::CheckpointUnreadable,
                    operation_count: 1,
                    tool_names: Vec::new(),
                    current_hash: None,
                    expected_hash: None,
                    message: Some(message),
                });
                continue;
            }
        };
        let machine = checkpoint.machine.clone();
        let root = accesses
            .get(&machine)
            .and_then(|access| access.as_ref())
            .map_or(workspace, |access| &access.workspace)
            .clone();
        for file in &artifact.files {
            let path = resolve_path(&root, &file.path);
            if bash_ignored(&artifact.tool_name) {
                let entry = ignored.entry(path).or_default();
                entry.operation_count += 1;
                entry.tool_names.insert(artifact.tool_name.clone());
                continue;
            }
            let action = match file.restore_content() {
                Some(_) => RewindAction::Restore,
                None => RewindAction::Delete,
            };
            match &file.after_content {
                Some(after) => operations.push(Operation {
                    action,
                    after: Some(after.clone()),
                    before: file.restore_content().map(str::to_owned),
                    path,
                    tool_name: artifact.tool_name.clone(),
                    machine: machine.clone(),
                }),
                None => {
                    let entry = unsupported.entry(path).or_default();
                    entry.action = action;
                    entry.operation_count += 1;
                    entry.tool_names.insert(artifact.tool_name.clone());
                    entry.unsafe_reason = Some(RewindUnsafeReason::UnsupportedCheckpoint);
                }
            }
        }
    }

    // 从最后一次写入往前模拟：磁盘当前内容必须等于那次写入后的内容，然后按写入前继续。
    let mut simulated: HashMap<String, Option<String>> = HashMap::new();
    let mut safe: HashMap<String, PreviewAggregate> = HashMap::new();
    let mut unsafe_paths = unsupported;
    for operation in operations.iter().rev() {
        let aggregate = safe.entry(operation.path.clone()).or_default();
        aggregate.operation_count += 1;
        aggregate.action = operation.action;
        aggregate.tool_names.insert(operation.tool_name.clone());
        if unsafe_paths.contains_key(&operation.path) {
            continue;
        }
        let current = match simulated.get(&operation.path) {
            Some(content) => Current::Known(content.clone()),
            None => match accesses.get(&operation.machine).and_then(Option::as_ref) {
                Some(access) => current(access, &operation.path).await,
                None => Current::Failed(match &operation.machine {
                    Some(name) => format!("{name} is not connected"),
                    None => "the machine is not connected".to_owned(),
                }),
            },
        };
        let Some(current) = (match current {
            Current::Known(content) => Some(content),
            Current::Failed(message) => {
                mark_unsafe(
                    &mut unsafe_paths,
                    operation,
                    RewindUnsafeReason::FileReadFailed,
                    None,
                    None,
                    Some(message),
                );
                None
            }
        }) else {
            continue;
        };
        let expected = content_hash(
            operation
                .after
                .as_deref()
                .unwrap_or_default()
                .as_bytes(),
        );
        let observed = state_hash(current.as_deref());
        if observed != expected {
            mark_unsafe(
                &mut unsafe_paths,
                operation,
                RewindUnsafeReason::ExternalModified,
                Some(observed),
                Some(expected),
                None,
            );
            continue;
        }
        simulated.insert(operation.path.clone(), operation.before.clone());
    }

    // 不安全的路径从安全清单里去掉；操作数取这个路径的总操作数（Node 同一口径）。
    for (path, entry) in &mut unsafe_paths {
        let total = operations.iter().filter(|op| &op.path == path).count() as u32;
        entry.operation_count = entry.operation_count.max(total);
    }
    let mut safe_files: Vec<RewindSafeFile> = safe
        .into_iter()
        .filter(|(path, _)| !unsafe_paths.contains_key(path))
        .map(|(path, entry)| RewindSafeFile {
            action: entry.action,
            operation_count: entry.operation_count,
            path,
            tool_names: entry.tool_names.into_iter().collect(),
        })
        .collect();
    safe_files.sort_by(|left, right| left.path.cmp(&right.path));
    for (path, entry) in unsafe_paths {
        unsafe_files.push(RewindUnsafeFile {
            path,
            reason: entry
                .unsafe_reason
                .unwrap_or(RewindUnsafeReason::UnsupportedCheckpoint),
            operation_count: entry.operation_count,
            tool_names: entry.tool_names.into_iter().collect(),
            current_hash: entry.current_hash,
            expected_hash: entry.expected_hash,
            message: entry.message,
        });
    }
    unsafe_files.sort_by(|left, right| left.path.cmp(&right.path));
    let mut ignored_files: Vec<RewindIgnoredFile> = ignored
        .into_iter()
        .map(|(path, entry)| RewindIgnoredFile {
            operation_count: entry.operation_count,
            path,
            reason: "bash_ignored".to_owned(),
            tool_names: entry.tool_names.into_iter().collect(),
        })
        .collect();
    ignored_files.sort_by(|left, right| left.path.cmp(&right.path));
    RewindPreview {
        can_apply: !safe_files.is_empty() && unsafe_files.is_empty(),
        safe_files,
        unsafe_files,
        ignored_files,
    }
}

#[cfg(test)]
#[path = "file_changes_tests.rs"]
mod tests;
