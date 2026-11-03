//! 文件变更聚合与回退预览（141 审计 §9 第 2 项余项）。
//!
//! 造法：artifact 用 tools 写 checkpoint 的同一形状（`afterContent` / `beforeContent` /
//! `structuredPatch`），磁盘用 `MemoryEnvironment` 的 in-memory 文件表。

use std::sync::Arc;

use rust_cli_kernel_api::env::{EnvFacts, EnvPath, WorkspaceRef};
use rust_cli_kernel_api::env_registry::EnvironmentRegistry;
use rust_cli_kernel_api::ids::{EnvironmentId, MessageId, SessionId, ToolUseId};
use rust_cli_kernel_api::store::{ArtifactPurpose, ArtifactRef, WorkspaceCheckpoint};
use rust_cli_kernel_api::testing::{MemoryArtifacts, MemoryEnvironment, TestMachines};
use serde_json::json;

use super::*;

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/work"),
    }
}

fn facts() -> EnvFacts {
    EnvFacts {
        cwd: EnvPath::new("/work"),
        platform: "darwin".into(),
        os_version: "x".into(),
        shell: "zsh".into(),
        is_git_repo: false,
        additional_directories: Vec::new(),
        home: None,
    }
}

fn artifact(tool: &str, path: &str, before: Option<&str>, after: &str) -> Vec<u8> {
    let (hunks, _, _) = rust_cli_kernel_api::file_changes::structured_patch(
        before.unwrap_or(""),
        after,
    );
    serde_json::to_vec(&json!({
        "createdAt": "2026-11-03T00:00:00.000Z",
        "files": [{
            "afterContent": after,
            "afterContentLength": after.encode_utf16().count(),
            "beforeContent": before,
            "existedBefore": before.is_some(),
            "path": path,
            "structuredPatch": hunks,
        }],
        "kind": "workspace_file_before_change",
        "toolCallId": "tool",
        "toolName": tool,
        "version": 1,
    }))
    .expect("serializable")
}

async fn checkpoint(
    store: &MemoryArtifacts,
    id: &str,
    prompt: &str,
    assistant: &str,
    tool: &str,
    path: &str,
    before: Option<&str>,
    after: &str,
) -> WorkspaceCheckpoint {
    let bytes = artifact(tool, path, before, after);
    let snapshot: ArtifactRef = store
        .put(
            &SessionId::new("sess_1"),
            ArtifactPurpose::Checkpoint,
            "application/json".to_owned(),
            bytes,
        )
        .await
        .expect("the artifact is stored");
    WorkspaceCheckpoint {
        id: id.to_owned(),
        prompt: MessageId::new(prompt),
        assistant: MessageId::new(assistant),
        tool_use: ToolUseId::new(format!("tool_{id}")),
        snapshot,
        machine: None,
    }
}

/// 同一轮里同一个文件写了两次：写入次数、工具名、最终的补丁与行数都按「第一次写入前 →
/// 最后一次写入后」算；另一个文件独立成项。artifact 顺序就是写入顺序。
#[tokio::test]
async fn files_change_report_aggregates_a_turn() {
    let store = MemoryArtifacts::default();
    let first = checkpoint(
        &store, "c1", "u1", "a1", "Write", "/work/a.txt", None, "one\n",
    )
    .await;
    let second = checkpoint(
        &store, "c2", "u1", "a2", "Edit", "/work/a.txt", Some("one\n"), "one\ntwo\n",
    )
    .await;
    let third = checkpoint(
        &store, "c3", "u1", "a3", "Write", "/work/b.txt", None, "b\n",
    )
    .await;
    let all = [first, second, third];
    let selected = select(&all, &[MessageId::new("u1")]);
    assert_eq!(selected.len(), 3, "prompt 命中这一轮");
    let report = report(&store, &selected).await.expect("readable artifacts");
    assert_eq!(report.files, 2);
    assert_eq!((report.additions, report.deletions), (3, 0));
    let a = &report.items[0];
    assert_eq!(a.path, "/work/a.txt");
    assert_eq!(a.write_count, 2);
    assert_eq!(a.tool_names, ["Edit", "Write"]);
    assert_eq!((a.additions, a.deletions), (2, 0));
    // 补丁是「第一次写入前（空）→ 最后一次写入后（两行）」。
    assert_eq!(a.patches[0].lines, ["+one", "+two"]);
    assert_eq!(report.items[1].path, "/work/b.txt");
}

/// 只选这一轮：别的轮的 checkpoint 不进来（按 assistant 消息命中也算）。
#[tokio::test]
async fn selection_is_scoped_to_the_message_set() {
    let store = MemoryArtifacts::default();
    let ours = checkpoint(&store, "c1", "u1", "a1", "Write", "/work/a.txt", None, "one\n").await;
    let other = checkpoint(&store, "c2", "u2", "a2", "Write", "/work/b.txt", None, "b\n").await;
    let all = [ours, other];
    let by_assistant = select(&all, &[MessageId::new("a1")]);
    assert_eq!(by_assistant.len(), 1);
    assert_eq!(by_assistant[0].id, "c1");
    let all_selected = select(&all, &[]);
    assert_eq!(all_selected.len(), 2, "空集合是全部（冷打开摘要）");
}

/// 摘要按 prompt 分组：每轮的文件数与行数合计。
#[tokio::test]
async fn summaries_group_by_prompt() {
    let store = MemoryArtifacts::default();
    let one = checkpoint(&store, "c1", "u1", "a1", "Write", "/work/a.txt", None, "one\n").await;
    let two = checkpoint(&store, "c2", "u1", "a2", "Edit", "/work/a.txt", Some("one\n"), "one\ntwo\n").await;
    let three = checkpoint(&store, "c3", "u2", "a3", "Write", "/work/b.txt", None, "b\n").await;
    let all = [one, two, three];
    let selected = select(&all, &[]);
    let summaries = summaries(&store, &selected).await;
    assert_eq!(summaries.len(), 2);
    assert_eq!(summaries[0].prompt, MessageId::new("u1"));
    assert_eq!((summaries[0].files, summaries[0].additions), (1, 2));
    assert_eq!(summaries[1].prompt, MessageId::new("u2"));
    assert_eq!((summaries[1].files, summaries[1].additions), (1, 1));
}

/// 磁盘上还是写入后的内容：安全恢复（按写入前的样子）。
#[tokio::test]
async fn a_file_that_still_matches_the_checkpoint_is_safe() {
    let store = MemoryArtifacts::default();
    let env = Arc::new(MemoryEnvironment::new(facts()).with_file("/work/a.txt", "one\ntwo\n"));
    let machines = TestMachines::new(env.clone());
    let file = checkpoint(
        &store, "c1", "u1", "a1", "Edit", "/work/a.txt", Some("one\n"), "one\ntwo\n",
    )
    .await;
    let all = [file];
    let selected = select(&all, &[]);
    let preview = preview(
        &store,
        machines.local_machine().files(),
        &workspace(),
        machines.as_ref(),
        &selected,
    )
    .await;
    assert!(preview.can_apply);
    assert_eq!(preview.safe_files.len(), 1);
    assert_eq!(preview.safe_files[0].action, RewindAction::Restore);
    assert_eq!(preview.safe_files[0].operation_count, 1);
    assert_eq!(preview.safe_files[0].tool_names, ["Edit"]);
    assert!(preview.unsafe_files.is_empty());
}

/// 磁盘上的内容被别的方式改过：`external_modified`，带当前与期望的哈希；预览不写文件。
#[tokio::test]
async fn an_externally_modified_file_is_unsafe() {
    let store = MemoryArtifacts::default();
    let env = Arc::new(MemoryEnvironment::new(facts()).with_file("/work/a.txt", "changed\n"));
    let machines = TestMachines::new(env.clone());
    let file = checkpoint(
        &store, "c1", "u1", "a1", "Edit", "/work/a.txt", Some("one\n"), "one\ntwo\n",
    )
    .await;
    let all = [file];
    let selected = select(&all, &[]);
    let preview = preview(
        &store,
        machines.local_machine().files(),
        &workspace(),
        machines.as_ref(),
        &selected,
    )
    .await;
    assert!(!preview.can_apply);
    assert!(preview.safe_files.is_empty());
    assert_eq!(preview.unsafe_files.len(), 1);
    let unsafe_file = &preview.unsafe_files[0];
    assert_eq!(unsafe_file.reason, RewindUnsafeReason::ExternalModified);
    assert_eq!(
        unsafe_file.expected_hash.as_deref(),
        Some(content_hash(b"one\ntwo\n").as_str())
    );
    assert_eq!(
        unsafe_file.current_hash.as_deref(),
        Some(content_hash(b"changed\n").as_str())
    );
    // 文件没被预览改动。
    assert_eq!(
        env.read_file(&workspace(), rust_cli_kernel_api::env::ReadFile { path: EnvPath::new("/work/a.txt") })
            .await
            .unwrap()
            .bytes,
        b"changed\n"
    );
}

/// 新建的文件被删掉了：期望的是「存在且等于写入后内容」，现在不存在 → 不安全（hash 是 missing）。
#[tokio::test]
async fn a_deleted_file_is_unsafe() {
    let store = MemoryArtifacts::default();
    let env = Arc::new(MemoryEnvironment::new(facts()));
    let machines = TestMachines::new(env.clone());
    let file = checkpoint(&store, "c1", "u1", "a1", "Write", "/work/new.txt", None, "x\n").await;
    let all = [file];
    let selected = select(&all, &[]);
    let preview = preview(
        &store,
        machines.local_machine().files(),
        &workspace(),
        machines.as_ref(),
        &selected,
    )
    .await;
    assert_eq!(preview.unsafe_files.len(), 1);
    assert_eq!(
        preview.unsafe_files[0].reason,
        RewindUnsafeReason::ExternalModified
    );
    assert_eq!(preview.unsafe_files[0].current_hash.as_deref(), Some("missing"));
}

/// 文件本来不存在、写入后还在：动作是 delete。
#[tokio::test]
async fn a_created_file_still_in_place_is_a_safe_delete() {
    let store = MemoryArtifacts::default();
    let env = Arc::new(MemoryEnvironment::new(facts()).with_file("/work/new.txt", "x\n"));
    let machines = TestMachines::new(env.clone());
    let file = checkpoint(&store, "c1", "u1", "a1", "Write", "/work/new.txt", None, "x\n").await;
    let all = [file];
    let selected = select(&all, &[]);
    let preview = preview(
        &store,
        machines.local_machine().files(),
        &workspace(),
        machines.as_ref(),
        &selected,
    )
    .await;
    assert!(preview.can_apply);
    assert_eq!(preview.safe_files[0].action, RewindAction::Delete);
}

/// bash 写的文件没有 checkpoint：进 ignored，不参与 canApply 的判断。
#[tokio::test]
async fn shell_writes_are_ignored() {
    let store = MemoryArtifacts::default();
    let env = Arc::new(MemoryEnvironment::new(facts()));
    let machines = TestMachines::new(env.clone());
    let file = checkpoint(&store, "c1", "u1", "a1", "Bash", "/work/gen.txt", None, "x\n").await;
    let all = [file];
    let selected = select(&all, &[]);
    let preview = preview(
        &store,
        machines.local_machine().files(),
        &workspace(),
        machines.as_ref(),
        &selected,
    )
    .await;
    assert!(!preview.can_apply, "没有可安全恢复的文件");
    assert_eq!(preview.ignored_files.len(), 1);
    assert_eq!(preview.ignored_files[0].reason, "bash_ignored");
    assert_eq!(preview.ignored_files[0].tool_names, ["Bash"]);
    assert!(preview.unsafe_files.is_empty());
}

/// 远端机器没连上：那台机器的文件按 `file_read_failed` 报，不读本机的同名路径。
#[tokio::test]
async fn a_disconnected_machine_is_unsafe() {
    let store = MemoryArtifacts::default();
    let env = Arc::new(MemoryEnvironment::new(facts()).with_file("/work/a.txt", "one\n"));
    let machines = TestMachines::new(env.clone());
    let mut file = checkpoint(
        &store, "c1", "u1", "a1", "Edit", "/work/a.txt", Some("one\n"), "one\ntwo\n",
    )
    .await;
    file.machine = Some("builder".to_owned());
    let all = [file];
    let selected = select(&all, &[]);
    let preview = preview(
        &store,
        machines.local_machine().files(),
        &workspace(),
        machines.as_ref(),
        &selected,
    )
    .await;
    assert!(!preview.can_apply);
    assert_eq!(preview.unsafe_files.len(), 1);
    assert_eq!(
        preview.unsafe_files[0].reason,
        RewindUnsafeReason::FileReadFailed
    );
    assert!(
        preview.unsafe_files[0]
            .message
            .as_deref()
            .is_some_and(|message| message.contains("builder")),
        "{:?}",
        preview.unsafe_files[0].message
    );
}
