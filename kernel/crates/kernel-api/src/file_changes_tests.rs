//! 文件变更词表（141 审计 §9 第 2 项余项）：补丁块的算法与 Host schema 的线上形状。

use serde_json::json;

use super::*;

/// 中间一行变了：一个块、三行上下文、增删各一。
#[test]
fn a_changed_middle_line_is_one_hunk_with_context() {
    let before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
    let after = "1\n2\n3\n4\nfive\n6\n7\n8\n9\n";
    let (hunks, additions, deletions) = structured_patch(before, after);
    assert_eq!((additions, deletions), (1, 1));
    assert_eq!(
        hunks,
        vec![DiffHunk {
            old_start: 2,
            old_lines: 7,
            new_start: 2,
            new_lines: 7,
            lines: [" 2", " 3", " 4", "-5", "+five", " 6", " 7", " 8"]
                .map(str::to_owned)
                .to_vec(),
        }]
    );
}

/// 新建文件：删除侧没有行，起始行号按 jsdiff 是 0；相同文本没有块。
#[test]
fn a_created_file_adds_every_line_and_identical_text_has_no_hunk() {
    let (hunks, additions, deletions) = structured_patch("", "a\nb\n");
    assert_eq!((additions, deletions), (2, 0));
    assert_eq!(
        hunks,
        vec![DiffHunk {
            old_start: 0,
            old_lines: 0,
            new_start: 1,
            new_lines: 2,
            lines: vec!["+a".to_owned(), "+b".to_owned()],
        }]
    );
    assert_eq!(structured_patch("same\n", "same\n"), (Vec::new(), 0, 0));
}

/// 块里的增删行数与 `patch_stats` 一致（`+++` / `---` 文件头不在 `lines` 里，不会被算错）。
#[test]
fn patch_stats_counts_only_body_lines() {
    let (hunks, additions, deletions) = structured_patch("a\nb\n", "a\nB\nC\n");
    assert_eq!(patch_stats(&hunks), (additions, deletions));
    assert_eq!((additions, deletions), (2, 1));
}

/// bash / shell 类工具的识别：与 Node 的正则归一化同义。
#[test]
fn shell_tools_are_recognised() {
    for name in ["Bash", "bash", "Shell", "PowerShell", "powershell", "Terminal"] {
        assert!(bash_ignored(name), "{name}");
    }
    for name in ["Write", "Edit", "NotebookEdit", "MultiEdit"] {
        assert!(!bash_ignored(name), "{name}");
    }
}

/// 线上形状与 Host 的 zod schema 逐字段一致：驼峰、蛇形枚举、空的可选字段不写。
#[test]
fn the_wire_shape_matches_the_host_schema() {
    let (hunks, _, _) = structured_patch("a\n", "b\n");
    let report = FileChangesReport {
        files: 1,
        additions: 1,
        deletions: 1,
        items: vec![FileChangeItem {
            path: "/work/a.txt".to_owned(),
            additions: 1,
            deletions: 1,
            write_count: 1,
            tool_names: vec!["Edit".to_owned()],
            patches: hunks,
        }],
    };
    let value = serde_json::to_value(&report).expect("serializable");
    assert_eq!(value["files"], 1);
    assert_eq!(value["items"][0]["writeCount"], 1);
    assert_eq!(value["items"][0]["toolNames"], json!(["Edit"]));
    assert_eq!(value["items"][0]["patches"][0]["oldStart"], 1);
    assert_eq!(value["items"][0]["patches"][0]["newLines"], 1);

    let preview = RewindPreview {
        can_apply: false,
        safe_files: vec![RewindSafeFile {
            action: RewindAction::Delete,
            operation_count: 2,
            path: "/work/gone.txt".to_owned(),
            tool_names: vec!["Write".to_owned()],
        }],
        unsafe_files: vec![RewindUnsafeFile {
            path: "/work/a.txt".to_owned(),
            reason: RewindUnsafeReason::ExternalModified,
            operation_count: 1,
            tool_names: vec!["Edit".to_owned()],
            current_hash: Some("missing".to_owned()),
            expected_hash: Some("ab".to_owned()),
            message: None,
        }],
        ignored_files: vec![RewindIgnoredFile {
            operation_count: 1,
            path: "/work/x".to_owned(),
            reason: bash_ignored_reason(),
            tool_names: vec!["Bash".to_owned()],
        }],
    };
    let value = serde_json::to_value(&preview).expect("serializable");
    assert_eq!(value["canApply"], false);
    assert_eq!(value["safeFiles"][0]["action"], "delete");
    assert_eq!(value["safeFiles"][0]["operationCount"], 2);
    assert_eq!(value["unsafeFiles"][0]["reason"], "external_modified");
    assert_eq!(value["unsafeFiles"][0]["currentHash"], "missing");
    assert!(value["unsafeFiles"][0].get("message").is_none());
    assert_eq!(value["ignoredFiles"][0]["reason"], "bash_ignored");
}
