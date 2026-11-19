//! 归档会话的永久删除（`v4/storage/sessionData/deletionPreview|deletionExecute`）：存储给的范围与文件、内核看到的
//! 「在不在用」→ 预检。预检与执行用同一个 [`preview`]，所以两次算出的 `revision` 只随事实变。
//!
//! ```text
//! SessionStore::deletion_scope(root) ─┐
//! SessionStore::deletion_files(每个) ─┼─► preview(workspace, scope, files, in_use) ─► DeletionPreview{…, revision}
//! 打开着的会话的视图 in_use ──────────┘
//! ```
//!
//! 与上游 0.1.88 的差异：NIBI 的存储端口只有 [`crate::store::SessionStore`]，没有另立 `SessionPurge` 合集；删除凭据的
//! 五个方法作为缺省 `Unsupported` 的方法挂在那条 trait 上（方法名与已有的 `remove_session_files` 区分开）。

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::env::WorkspaceRef;
use crate::ids::SessionId;

/// 一个会话与它的标题（forks 与引用方，界面列出来）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TitledSession {
    pub session: SessionId,
    pub title: String,
}

/// 树里会话的一个附件被树外没删除的会话引用（`nibi-artifact://<session>/<artifact>`，旧记录里可能是
/// `zcode-artifact://`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ArtifactReference {
    pub session: SessionId,
    pub artifact: String,
    /// 按会话 id 排序。
    pub referrers: Vec<TitledSession>,
}

/// 树里一个会话行的版本事实：改了（新消息、改名）或删了，`revision` 就变。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionStamp {
    pub session: SessionId,
    pub updated_ms: u64,
    pub deleted_ms: Option<u64>,
}

/// 根的删除凭据（`session_purge`，迁移 0026）的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Receipt {
    /// 有 `deleting` 的：删到一半，接着删（不再比 revision）。
    Deleting,
    /// 全是 `deleted`：已经删完。
    Deleted,
}

/// 库里的范围（[`crate::store::SessionStore::deletion_scope`]，一次读事务）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeletionScope {
    /// 根与它的自有后代，根在最前；有凭据时是凭据里的会话；根不在库里、也没有凭据时为空。
    pub sessions: Vec<SessionId>,
    /// 根的工作区（会话行的目录与环境）；根不在库里时为 None。
    pub workspace: Option<WorkspaceRef>,
    /// 没删除的、父会话在树里、自己不在树里的会话，按 id 排序。
    pub forks: Vec<TitledSession>,
    /// 按（会话，artifact）排序。
    pub references: Vec<ArtifactReference>,
    /// 与 `sessions` 同序。
    pub stamps: Vec<SessionStamp>,
    /// 库里有 Node 写下的待处理工作（`session_input` admitted、`session_target` active）；有凭据时不看。
    pub pending_work: bool,
    /// 根的删除凭据；没有时为 None。
    pub receipt: Option<Receipt>,
}

/// 开删（[`crate::store::SessionStore::begin_deletion`]）：插凭据的事务里拿它再核对一次。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletionBegin {
    /// 写进凭据的 `operation_id`（协议执行命令的 operationId）。
    pub operation: String,
    /// 确认时的版本事实：事务里读到的不同就不插。
    pub stamps: Vec<SessionStamp>,
    /// 要留下的附件：（会话，artifact id）。
    pub retained: Vec<(SessionId, String)>,
}

/// 开删的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeginOutcome {
    /// 凭据插下了（或本来就有，接着删）。
    Admitted,
    /// 事务里读到的版本事实与确认时的不同。
    Changed,
    /// 事务里看到 Node 写下的待处理工作。
    Running,
}

/// 一个会话的一个文件（相对存储根的路径；`artifact` = 在这个会话的附件目录里）。符号链接算 0 字节的文件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SessionFile {
    pub relative_path: String,
    pub name: String,
    pub artifact: bool,
    pub bytes: u64,
}

/// 为什么不能删（预检的 `blockedReason`，执行的 `blocked{reason}`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum DeletionBlock {
    /// 树里有会话在用（阻止，不自动停）。
    Running,
    /// 执行时的范围与确认时的不同。
    Changed,
    /// 根在别的工作区（会话的路由粘住）：前端按前置条件拒绝，什么都不删。
    OtherWorkspace,
    /// 根不在库里、也没有凭据：树为空。
    NotFound,
}

/// 保留的附件文件：引用对上了这个会话的附件目录里文件名含 artifact id 的文件；对不上时文件名记 artifact id。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RetainedArtifact {
    pub session: SessionId,
    pub artifact: String,
    pub file_name: String,
    pub referrers: Vec<TitledSession>,
}

/// 预检。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletionPreview {
    pub sessions: Vec<SessionId>,
    pub forks: Vec<TitledSession>,
    pub retained: Vec<RetainedArtifact>,
    pub deleted_files: usize,
    pub blocked: Option<DeletionBlock>,
    /// 凭据有 `deleting`：删到一半。
    pub incomplete: bool,
    /// 凭据全是 `deleted`：已经删完。
    pub completed: bool,
    pub revision: String,
}

impl DeletionPreview {
    /// 删的时候保留的附件文件名，按会话。
    pub fn kept_files(&self, session: &SessionId) -> Vec<String> {
        self.retained
            .iter()
            .filter(|retained| &retained.session == session)
            .map(|retained| retained.artifact.clone())
            .collect()
    }
}

/// 执行的结局。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeletionOutcome {
    Deleted,
    Blocked(DeletionBlock),
    /// 删文件或删行失败（行还在，重试会再预检）：诊断原文。
    Incomplete(String),
}

/// 执行的结果：结局、删的会话（根在最前）与保留的附件文件数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeletionResult {
    pub outcome: DeletionOutcome,
    pub sessions: Vec<SessionId>,
    pub retained: usize,
}

/// `revision` 的输入：顺序固定（范围、文件、阻止），值只随事实变。
#[derive(Serialize)]
struct RevisionDigest<'a> {
    stamps: &'a [SessionStamp],
    forks: &'a [TitledSession],
    references: &'a [ArtifactReference],
    files: Vec<(&'a str, u64)>,
    blocked: Option<DeletionBlock>,
}

/// 预检（预检与执行共用）：`files` 是 `scope.sessions` 每个会话的文件（同序），`in_use` 是打开着的会话里有在用的。
pub fn preview(
    workspace: &WorkspaceRef,
    scope: &DeletionScope,
    files: &[(SessionId, Vec<SessionFile>)],
    in_use: bool,
) -> DeletionPreview {
    let retained: Vec<RetainedArtifact> = scope
        .references
        .iter()
        .flat_map(|reference| retained_files(reference, files))
        .collect();
    let kept = |session: &SessionId, file: &SessionFile| {
        file.artifact
            && retained
                .iter()
                .any(|retained| &retained.session == session && retained.file_name == file.name)
    };
    let deleted_files = files
        .iter()
        .flat_map(|(session, files)| files.iter().map(move |file| (session, file)))
        .filter(|(session, file)| !kept(session, file))
        .count();
    // 顺序同上游：别的工作区最先，然后是在用，最后是树为空
    let blocked = if scope.workspace.as_ref().is_some_and(|own| own != workspace) {
        Some(DeletionBlock::OtherWorkspace)
    } else if in_use || scope.pending_work {
        Some(DeletionBlock::Running)
    } else if scope.sessions.is_empty() {
        Some(DeletionBlock::NotFound)
    } else {
        None
    };
    let digest = RevisionDigest {
        stamps: &scope.stamps,
        forks: &scope.forks,
        references: &scope.references,
        files: files
            .iter()
            .flat_map(|(_, files)| {
                files
                    .iter()
                    .map(|file| (file.relative_path.as_str(), file.bytes))
            })
            .collect(),
        blocked,
    };
    let revision = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_string(&digest)
                .unwrap_or_default()
                .as_bytes()
        )
    );
    DeletionPreview {
        sessions: scope.sessions.clone(),
        forks: scope.forks.clone(),
        retained,
        deleted_files,
        blocked,
        incomplete: scope.receipt == Some(Receipt::Deleting),
        completed: scope.receipt == Some(Receipt::Deleted),
        revision,
    }
}

/// 一条引用保留的文件：这个会话的附件里文件名含 artifact id 的，每个一项；一个都没有时记 artifact id 本身。
fn retained_files(
    reference: &ArtifactReference,
    files: &[(SessionId, Vec<SessionFile>)],
) -> Vec<RetainedArtifact> {
    let retained = |file_name: &str| RetainedArtifact {
        session: reference.session.clone(),
        artifact: reference.artifact.clone(),
        file_name: file_name.to_owned(),
        referrers: reference.referrers.clone(),
    };
    let matched: Vec<RetainedArtifact> = files
        .iter()
        .filter(|(session, _)| session == &reference.session)
        .flat_map(|(_, files)| files.iter())
        .filter(|file| file.artifact && file.name.contains(&reference.artifact))
        .map(|file| retained(&file.name))
        .collect();
    if matched.is_empty() {
        vec![retained(&reference.artifact)]
    } else {
        matched
    }
}

#[cfg(test)]
#[path = "deletion_tests.rs"]
mod tests;
