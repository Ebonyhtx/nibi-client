//! 预检的纯函数：阻止的顺序、保留的附件与 `revision` 只随事实变。
use super::*;
use crate::env::EnvPath;
use crate::ids::EnvironmentId;

fn workspace(root: &str) -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(root),
    }
}

fn file(path: &str, name: &str, artifact: bool, bytes: u64) -> SessionFile {
    SessionFile {
        relative_path: path.to_owned(),
        name: name.to_owned(),
        artifact,
        bytes,
    }
}

fn scope() -> DeletionScope {
    let root = SessionId::new("sess_root");
    let child = SessionId::new("sess_child");
    DeletionScope {
        sessions: vec![root.clone(), child.clone()],
        workspace: Some(workspace("/w")),
        forks: vec![TitledSession {
            session: SessionId::new("sess_fork"),
            title: "fork".to_owned(),
        }],
        references: vec![ArtifactReference {
            session: root.clone(),
            artifact: "shared".to_owned(),
            referrers: vec![TitledSession {
                session: SessionId::new("sess_fork"),
                title: "fork".to_owned(),
            }],
        }],
        stamps: vec![
            SessionStamp {
                session: root,
                updated_ms: 10,
                deleted_ms: None,
            },
            SessionStamp {
                session: child,
                updated_ms: 2,
                deleted_ms: None,
            },
        ],
        pending_work: false,
        receipt: None,
    }
}

fn files() -> Vec<(SessionId, Vec<SessionFile>)> {
    vec![
        (
            SessionId::new("sess_root"),
            vec![
                file("cli/artifacts/sess_root/shared.png", "shared.png", true, 3),
                file(
                    "cli/artifacts/sess_root/private.png",
                    "private.png",
                    true,
                    4,
                ),
                file(
                    "cli/rollout/model-io-sess_root.jsonl",
                    "model-io-sess_root.jsonl",
                    false,
                    5,
                ),
            ],
        ),
        (SessionId::new("sess_child"), Vec::new()),
    ]
}

#[test]
fn preview_keeps_the_referenced_attachment_and_counts_the_rest() {
    let preview = preview(&workspace("/w"), &scope(), &files(), false);
    assert_eq!(preview.blocked, None);
    assert_eq!(preview.sessions.len(), 2);
    assert_eq!(preview.forks.len(), 1);
    assert_eq!(preview.retained.len(), 1);
    assert_eq!(preview.retained[0].artifact, "shared");
    assert_eq!(preview.retained[0].file_name, "shared.png");
    assert_eq!(preview.deleted_files, 2);
    assert!(!preview.incomplete && !preview.completed);
    assert_eq!(preview.revision.len(), 64);
}

#[test]
fn the_revision_only_moves_when_the_facts_do() {
    let first = preview(&workspace("/w"), &scope(), &files(), false).revision;
    assert_eq!(
        first,
        preview(&workspace("/w"), &scope(), &files(), false).revision
    );
    let mut changed = scope();
    changed.stamps[0].updated_ms = 11;
    assert_ne!(
        first,
        preview(&workspace("/w"), &changed, &files(), false).revision
    );
    // 在不在用也算事实
    assert_ne!(
        first,
        preview(&workspace("/w"), &scope(), &files(), true).revision
    );
}

#[test]
fn blocks_follow_the_upstream_order() {
    // 别的工作区最先
    assert_eq!(
        preview(&workspace("/other"), &scope(), &files(), true).blocked,
        Some(DeletionBlock::OtherWorkspace)
    );
    assert_eq!(
        preview(&workspace("/w"), &scope(), &files(), true).blocked,
        Some(DeletionBlock::Running)
    );
    let mut pending = scope();
    pending.pending_work = true;
    assert_eq!(
        preview(&workspace("/w"), &pending, &files(), false).blocked,
        Some(DeletionBlock::Running)
    );
    let empty = DeletionScope::default();
    assert_eq!(
        preview(&workspace("/w"), &empty, &[], false).blocked,
        Some(DeletionBlock::NotFound)
    );
}

#[test]
fn a_receipt_is_reported_as_incomplete_or_completed() {
    let mut deleting = scope();
    deleting.receipt = Some(Receipt::Deleting);
    let partial = preview(&workspace("/w"), &deleting, &files(), false);
    assert!(partial.incomplete && !partial.completed);
    let mut deleted = scope();
    deleted.receipt = Some(Receipt::Deleted);
    let done = preview(&workspace("/w"), &deleted, &files(), false);
    assert!(done.completed && !done.incomplete);
}
