//! 会话存储与 Artifact 的本地实现：Node CLI 的 `db.sqlite`（docs/specs/rust-cli/README.md §5，
//! 细则见 docs/specs/rust-cli/node-store.md）。
//!
//! 把内核提交的事实映射成 Node 的 session / message / part / session_entry 记录，记录格式与 Node
//! 逐字节一致，Node CLI / App 能读、能续写；不新增表、列或迁移。冷加载从 Node 记录构建内核
//! 形状的消息（活动分支、压缩边界）。
//!
//! 并发：每个进程一个连接，首次使用时打开并补齐迁移；所有数据库访问都在阻塞线程里串行执行
//! （`nibi_kernel_base::blocking`），不在 async 线程上做同步 IO。
mod append;
mod artifacts;
mod branch;
mod clock;
mod compaction;
mod facts;
mod fork;
mod fork_clone;
mod frontend_records;
mod hydrate;
mod ids;
mod load;
mod mode;
mod node_checkpoints;
mod notices;
mod operations;
mod project_mode;
mod project_rules;
mod query;
mod records;
mod repo;
mod rewind;
mod state;
mod task_lists;
mod tool_content;
mod tool_parts;
mod usage;
mod usage_query;
mod usage_stats;
mod workspace_trust;

use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use rusqlite::Connection;
use std::collections::HashMap;

use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::ids::{ArtifactId, MessageId, SessionId};
use nibi_kernel_api::permission::{PermissionMode, ProjectRules};
use nibi_kernel_api::store::{
    ArtifactPurpose, ArtifactRef, ArtifactStore, CommitReceipt, FactBatch, ForkReceipt,
    LoadedSession, MessageTime, SessionDirectoryEntry, SessionDirectoryQuery, SessionFilter,
    SessionFork, SessionIndexFact, SessionKind, SessionMeta, SessionPage, SessionQuery,
    SessionStore, SessionSummary, StoreError,
};
use nibi_kernel_api::workspace_trust::TrustKey;
use nibi_kernel_paths::StoragePaths;
use serde_json::{Value, json};

pub use artifacts::uri as artifact_uri;
pub use clock::{FixedOffset, SystemClock, TimeZone};
pub use ids::{NodeIds, RandomUuids, UuidSource};
// `--prepare-storage` 握手（app-server 的存储准备入口）需要的打开进度与库身份；
// 仓储本身仍是 crate 私有，这里只放出这一条窄缝。
pub use repo::open::{
    Facts as OpenFacts, MIGRATION_LOCK_WAIT, Progress as OpenProgress, Report as OpenReport,
    StartupError, open, open_with_progress, session_database_id,
};
// DWF journal 的事件读面（run 详情的 `pendingQuestions` / logTail 数据源；写入走
// `SessionStore::append_workflow_event`）。
pub use repo::dwf::{
    EventRow as DwfEventRow, JournalQuestion, events as dwf_events, pending_questions,
};

/// 本机执行环境的 ID（与入口 crate 相同）。只有它的会话写进本地库；`workspace_id` 为 NULL。
pub const LOCAL_ENVIRONMENT: &str = "local";

pub struct NodeStore {
    paths: StoragePaths,
    /// 记录的时间与随机 id：入口建的同一份 `NodeIds`（带着注入的 Clock）也交给内核（`Ports.ids`），记录与内核
    /// 生成的 ID 同源（F7，审查 R2-11、R1-15；以前本 crate 自带 `RecordSource`）。测试注入固定时钟与顺序 uuid。
    ids: Arc<NodeIds>,
    /// 本进程唯一的连接；首次使用时打开。只在阻塞线程里加锁，锁不跨 await。
    connection: Arc<Mutex<Option<Connection>>>,
    /// 会话库所在的目录已经建好（Node 打开会话库前递归建目录）。并发的第一次调用可能都建一次，建目录是
    /// 幂等的。
    database_dir: AtomicBool,
    /// 会话行的 `version`（Node 写 CLI 版本）：入口给的本工程版本（docs/specs/rust-cli/version.md §4），
    /// node-store 不读自己的包版本。没设时为空串（测试与工具）。
    version: String,
}

impl NodeStore {
    pub fn new(paths: StoragePaths, ids: Arc<NodeIds>) -> Self {
        Self {
            paths,
            ids,
            connection: Arc::new(Mutex::new(None)),
            database_dir: AtomicBool::new(false),
            version: String::new(),
        }
    }

    /// 新建会话行写入的版本（入口 crate 的 `VERSION`）。
    pub fn with_version(mut self, version: impl Into<String>) -> Self {
        self.version = version.into();
        self
    }

    pub fn paths(&self) -> &StoragePaths {
        &self.paths
    }

    /// 在阻塞线程里用连接执行 `work`；连接不存在时先打开并补齐迁移。
    async fn with_db<T, F>(&self, work: F) -> Result<T, StoreError>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection, &NodeIds) -> Result<T, StoreError> + Send + 'static,
    {
        let connection = self.connection.clone();
        let ids = self.ids.clone();
        let path = self.paths.database().as_path().to_path_buf();
        // 缺陷修复 R2-8：目录原来在阻塞线程里直接用 std::fs 建，豁免理由“nibi-kernel-fs 没有建目录的函数”已经
        // 过时；现在经 fs 的唯一入口，打开连接之前建一次。
        if !self.database_dir.load(Ordering::Acquire) {
            if let Some(parent) = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                nibi_kernel_fs::create_dir_all(parent).await.map_err(storage)?;
            }
            self.database_dir.store(true, Ordering::Release);
        }
        nibi_kernel_base::blocking(move || {
            // 上一次在持锁时 panic：rusqlite 的事务在展开时已回滚，连接仍可用。
            let mut slot = connection.lock().unwrap_or_else(PoisonError::into_inner);
            let conn = match &mut *slot {
                Some(conn) => conn,
                empty => empty.insert(open_database(&path, ids.now_ms())?),
            };
            work(conn, ids.as_ref())
        })
        .await
        .map_err(storage)?
    }
}

fn open_database(path: &Path, now_ms: u64) -> Result<Connection, StoreError> {
    let (conn, _) =
        repo::open::open(path, repo::open::MIGRATION_LOCK_WAIT, now_ms).map_err(storage)?;
    Ok(conn)
}

pub(crate) fn storage(error: impl Display) -> StoreError {
    StoreError::Storage {
        message: error.to_string(),
    }
}

/// 仓储错误（rusqlite / anyhow）统一成 `StoreError::Storage`。
pub(crate) trait OrStorage<T> {
    fn storage(self) -> Result<T, StoreError>;
}

impl<T, E: Display> OrStorage<T> for Result<T, E> {
    fn storage(self) -> Result<T, StoreError> {
        self.map_err(storage)
    }
}

fn create_input(meta: &SessionMeta, version: &str) -> Result<repo::sessions::Create, StoreError> {
    if meta.workspace.environment.as_str() != LOCAL_ENVIRONMENT {
        return Err(facts::unsupported("sessions of a remote environment"));
    }
    let directory = meta.workspace.root.as_str();
    let task_type = match meta.kind {
        SessionKind::Interactive => None,
        SessionKind::Subagent => Some("subagent_child"),
        SessionKind::Fork => Some("fork"),
        SessionKind::SelectionSideChat => Some("selection_side_chat"),
    };
    // fork 的标题是 `Fork of <原会话标题>`，来源同 Node `buildForkedSessionInput`：generated。其余会话
    // 标题为空时记为 default；首条真实输入按 Node `titleFromInput` 补上（append）。
    let title_source = if matches!(
        meta.kind,
        SessionKind::Fork | SessionKind::SelectionSideChat
    ) {
        "generated"
    } else if meta.title.is_empty() {
        "default"
    } else {
        "first_input"
    };
    Ok(repo::sessions::Create {
        id: meta.id.as_str().to_owned(),
        project_id: ids::project_id(directory),
        workspace_id: None,
        parent_id: meta.parent.as_ref().map(|p| p.as_str().to_owned()),
        trace_id: Some(meta.trace.as_str().to_owned()),
        task_type: task_type.map(str::to_owned),
        slug: ids::slugify(meta.id.as_str()),
        directory: directory.to_owned(),
        path: Some(directory.to_owned()),
        title: meta.title.clone(),
        title_source: Some(title_source.to_owned()),
        version: version.to_owned(),
        // Node 写 `config.mode ?? "build"`；内核随后提交的 ModeChanged 会更新它。
        permission: Some(json!({"mode": "build"})),
        time_created: Some(i64::try_from(meta.created_at_ms).unwrap_or(i64::MAX)),
    })
}

#[async_trait]
impl SessionStore for NodeStore {
    async fn create(&self, meta: SessionMeta) -> Result<(), StoreError> {
        let input = create_input(&meta, &self.version)?;
        self.with_db(move |conn, ids| {
            let now = i64::try_from(ids.now_ms()).unwrap_or(i64::MAX);
            repo::sessions::create(conn, &input, now).storage()
        })
        .await
    }

    async fn commit(
        &self,
        session: &SessionId,
        batch: FactBatch,
    ) -> Result<CommitReceipt, StoreError> {
        let session = session.clone();
        self.with_db(move |conn, ids| facts::commit(conn, &session, &batch, ids))
            .await
    }

    async fn load(&self, session: &SessionId) -> Result<LoadedSession, StoreError> {
        let session = session.clone();
        let (mut loaded, checkpoints) = self
            .with_db(move |conn, _| load::load(conn, &session))
            .await?;
        loaded.checkpoints = node_checkpoints::resolve(self.paths.artifacts(), checkpoints).await;
        Ok(loaded)
    }

    async fn session_index_fact(
        &self,
        session: &SessionId,
    ) -> Result<Option<SessionIndexFact>, StoreError> {
        let session = session.clone();
        self.with_db(move |conn, _| load::index_fact(conn, &session))
            .await
    }

    async fn message_times(
        &self,
        session: &SessionId,
    ) -> Result<HashMap<MessageId, MessageTime>, StoreError> {
        let session = session.clone();
        self.with_db(move |conn, _| load::message_times(conn, &session))
            .await
    }

    async fn list(&self, filter: SessionFilter) -> Result<Vec<SessionSummary>, StoreError> {
        self.with_db(move |conn, _| load::list(conn, &filter)).await
    }

    /// legacy `session/list` 的目录读面（Node `listSessions` / `getSession`）。
    async fn session_directory(
        &self,
        query: SessionDirectoryQuery,
    ) -> Result<Vec<SessionDirectoryEntry>, StoreError> {
        self.with_db(move |conn, _| load::directory(conn, &query))
            .await
    }

    /// ← 项目页与 `/resume` 页的会话（修复线 F29，node-store.md §5.1）。
    async fn query_sessions(&self, query: SessionQuery) -> Result<SessionPage, StoreError> {
        self.with_db(move |conn, _| query::query(conn, &query))
            .await
    }

    /// Node `setCustomSessionTitle`（node-store.md §5.1）。
    async fn rename(&self, session: &SessionId, title: &str) -> Result<(), StoreError> {
        let (session, title) = (session.clone(), title.to_owned());
        self.with_db(move |conn, ids| query::rename(conn, &session, &title, ids.now_ms()))
            .await
    }

    /// Node `softDeleteSession`（node-store.md §5.1）。
    async fn delete(&self, session: &SessionId) -> Result<(), StoreError> {
        let session = session.clone();
        self.with_db(move |conn, ids| query::delete(conn, &session, ids.now_ms()))
            .await
    }

    /// Node `/fork` 的新会话，一个事务写完（docs/specs/rust-cli/node-store.md §4.8）。
    async fn fork(&self, fork: SessionFork) -> Result<ForkReceipt, StoreError> {
        self.with_db(move |conn, ids| fork::fork(conn, &fork, ids))
            .await
    }

    /// 本机项目规则集（Node `getProjectPermission`）；项目 ID 由工作区根按 Node 规则算出。
    async fn project_rules(&self, workspace: &WorkspaceRef) -> Result<ProjectRules, StoreError> {
        let project = ids::project_id(workspace.root.as_str());
        self.with_db(move |conn, _| project_rules::read(conn, &project))
            .await
    }

    /// Node 群协作会话自己的规则集（修复线 F2，`project_rules::session_read`）。
    async fn session_rules(&self, session: &SessionId) -> Result<Option<ProjectRules>, StoreError> {
        let session = session.as_str().to_owned();
        self.with_db(move |conn, _| project_rules::session_read(conn, &session))
            .await
    }

    /// Node `updateSession({permission})`：`createSession.permissionScope: "session"` 创建后立即写会话行。
    async fn set_session_permission(
        &self,
        session: &SessionId,
        permission: Value,
    ) -> Result<(), StoreError> {
        let session = session.clone();
        self.with_db(move |conn, ids| {
            let now = i64::try_from(ids.now_ms()).unwrap_or(i64::MAX);
            let update = repo::sessions::Update {
                id: session.as_str().to_owned(),
                permission: Some(permission),
                ..Default::default()
            };
            match repo::sessions::update(conn, &update, now).storage()? {
                0 => Err(StoreError::NotFound { session }),
                _ => Ok(()),
            }
        })
        .await
    }

    /// `/permissions` 的修改（docs/specs/rust-cli/tui-manage.md §1.1）：项目 ID 同 [`Self::project_rules`]。
    async fn change_project_rules(
        &self,
        workspace: &WorkspaceRef,
        change: nibi_kernel_api::store::ProjectRulesChange,
    ) -> Result<ProjectRules, StoreError> {
        let project = ids::project_id(workspace.root.as_str());
        self.with_db(move |conn, ids| project_rules::change(conn, &project, ids.now_ms(), &change))
            .await
    }

    /// 本机项目的持久模式（Node `getProjectPermissionMode`，docs/specs/rust-cli/config.md §2.2）。
    async fn project_mode(
        &self,
        workspace: &WorkspaceRef,
    ) -> Result<Option<PermissionMode>, StoreError> {
        let project = ids::project_id(workspace.root.as_str());
        self.with_db(move |conn, _| project_mode::read(conn, &project))
            .await
    }

    /// `/usage` 的 API 时长（docs/specs/rust-cli/usage.md §4）。
    async fn metering(
        &self,
        session: &SessionId,
    ) -> Result<nibi_kernel_api::metering::SessionMetering, StoreError> {
        let session = session.clone();
        self.with_db(move |conn, _| {
            facts::live_session(conn, &session)?;
            usage_query::metering(conn, session.as_str())
        })
        .await
    }

    /// footer 的请求统计（usage.md §4.1，修复线 F27）：本会话完成的主回合请求的聚合。
    async fn request_stats(
        &self,
        session: &SessionId,
    ) -> Result<nibi_kernel_api::metering::RequestStats, StoreError> {
        let session = session.clone();
        self.with_db(move |conn, _| {
            facts::live_session(conn, &session)?;
            usage_stats::request_stats(conn, session.as_str())
        })
        .await
    }

    /// 活动统计的原始聚合（usage.md §5.2）。
    async fn activity(
        &self,
        query: nibi_kernel_api::metering::ActivityQuery,
    ) -> Result<nibi_kernel_api::metering::ActivityStats, StoreError> {
        self.with_db(move |conn, _| usage_query::activity(conn, &query))
            .await
    }

    /// 工作区信任（docs/specs/rust-cli/workspace-trust.md §2.3）：候选里第一个有记录的键。
    async fn trusted_workspace(
        &self,
        candidates: &[TrustKey],
    ) -> Result<Option<TrustKey>, StoreError> {
        let candidates = candidates.to_vec();
        self.with_db(move |conn, _| workspace_trust::find(conn, &candidates))
            .await
    }

    /// 跨会话的入站与回执（cross-session.md §2.2）：只读。
    async fn entries(
        &self,
        session: &SessionId,
        kind: &str,
    ) -> Result<Vec<(String, serde_json::Value)>, StoreError> {
        let (session, kind) = (session.as_str().to_owned(), kind.to_owned());
        self.with_db(move |conn, _| operations::kind_entries(conn, &session, &kind))
            .await
    }

    /// 前端记录（缺口 G2）：原样写成 `session_entry`，不在会话事务里（记录不是会话状态）。
    async fn put_record(
        &self,
        session: &SessionId,
        record: &nibi_kernel_api::store::FrontendRecord,
    ) -> Result<(), StoreError> {
        let (session, record) = (session.as_str().to_owned(), record.clone());
        self.with_db(move |conn, ids| frontend_records::put(conn, &session, &record, ids.now_ms()))
            .await
    }

    async fn records(
        &self,
        session: &SessionId,
        kind: &str,
    ) -> Result<Vec<nibi_kernel_api::store::FrontendRecord>, StoreError> {
        let (session, kind) = (session.as_str().to_owned(), kind.to_owned());
        self.with_db(move |conn, _| frontend_records::list(conn, &session, &kind))
            .await
    }

    /// 会话发起的 DWF run（`dwf_run`，只读）。
    async fn workflow_runs(
        &self,
        session: &SessionId,
    ) -> Result<Vec<nibi_kernel_api::workflow::DynamicWorkflowRun>, StoreError> {
        let session = session.as_str().to_owned();
        self.with_db(move |conn, _| repo::dwf::list(conn, &session).map_err(storage))
            .await
    }

    /// amend-resume 的种子兑现（fork_clone 的种子复制；两条跳过规则与确定性 id 同一条约定）。
    async fn fulfill_actor_seed(
        &self,
        target: &SessionId,
        source: &SessionId,
        message_count: u64,
    ) -> Result<nibi_kernel_api::workflow::SeedFulfillment, StoreError> {
        let work = (
            target.as_str().to_owned(),
            source.as_str().to_owned(),
            message_count,
            self.ids.now_ms(),
        );
        self.with_db(move |conn, _| {
            crate::fork_clone::fulfill_actor_seed(conn, work.3, &work.0, &work.1, work.2 as usize)
                .map_err(storage)
        })
        .await
    }

    /// 一个会话已落库的消息条数（ask 边界记账的值；与种子复制同一条口径）。
    async fn session_message_count(&self, session: &SessionId) -> Result<u64, StoreError> {
        let session = session.as_str().to_owned();
        self.with_db(move |conn, _| repo::messages::message_count(conn, &session).map_err(storage))
            .await
    }

    /// `workflows/runs`（NIBI 协议中枢）的运行历史页（journal 直读，跨会话；SQL 与终态拆解
    /// 逐字对齐 Node 的 `listRuns` / `decodeRunListItem`）。
    async fn workflow_runs_page(
        &self,
        cwd: Option<String>,
        name: Option<String>,
        limit: usize,
    ) -> Result<Vec<nibi_kernel_api::workflow::WorkflowRunPageRow>, StoreError> {
        self.with_db(move |conn, _| {
            repo::dwf::list_runs_hub(conn, cwd.as_deref(), name.as_deref(), limit)
                .map_err(storage)
                .map(|rows| {
                    rows.into_iter()
                        .map(|row| nibi_kernel_api::workflow::WorkflowRunPageRow {
                            artifacts: if row.artifacts.is_empty() {
                                None
                            } else {
                                Some(
                                    row.artifacts
                                        .into_iter()
                                        .take(8)
                                        .map(nibi_kernel_api::workflow::WorkflowRunArtifact::from)
                                        .collect(),
                                )
                            },
                            args: row.args,
                            created_at: row.created_at,
                            cwd: row.cwd,
                            name: row.name,
                            parent_session_id: row.parent_session_id,
                            run_id: row.run_id,
                            spent_tokens: row.spent_tokens,
                            status: row.status,
                            stop_reason: row.stop_reason,
                            tool_call_id: row.tool_call_id,
                            updated_at: row.updated_at,
                        })
                        .collect()
                })
        })
        .await
    }

    /// 追加一条 DWF run 事件（`dwf_event`，序号与写入同一条语句——Node `appendEvent` 同形）。
    async fn append_workflow_event(
        &self,
        run_id: &str,
        event_type: &str,
        payload_json: String,
    ) -> Result<(), StoreError> {
        let work = (
            run_id.to_owned(),
            event_type.to_owned(),
            payload_json,
            self.ids.now_ms(),
        );
        self.with_db(move |conn, _| {
            repo::dwf::append_event(conn, &work.0, &work.1, &work.2, work.3).map_err(storage)?;
            Ok(())
        })
        .await
    }

    /// 一个 run 的详情读面（journal 全部事实 + 终态拆解 + 冷回放待答问题；
    /// 停驻注册表的活项由运行时的合成读面并进来）。
    async fn workflow_run_detail(
        &self,
        session: &SessionId,
        run_id: &str,
    ) -> Result<Option<nibi_kernel_api::workflow::WorkflowRunDetail>, StoreError> {
        let work = (session.as_str().to_owned(), run_id.to_owned());
        self.with_db(move |conn, _| {
            repo::dwf::run_detail(conn, &work.0, &work.1).map_err(storage)
        })
        .await
    }

    /// 记下工作区已信任（upsert；不在会话事务里）。
    async fn trust_workspace(&self, key: &TrustKey) -> Result<(), StoreError> {
        let key = key.clone();
        self.with_db(move |conn, ids| workspace_trust::record(conn, &key, ids.now_ms()))
            .await
    }

    /// `ListWorkflowRuns`：按项目 cwd 跨会话枚举（journal 是逐项目的，不是逐会话的）。
    async fn workflow_runs_by_cwd(
        &self,
        cwd: &str,
        limit: usize,
        statuses: Option<&[String]>,
    ) -> Result<Vec<nibi_kernel_api::workflow::WorkflowRunListRow>, StoreError> {
        let work = (cwd.to_owned(), limit, statuses.map(<[String]>::to_vec));
        self.with_db(move |conn, _| {
            repo::run_queries::list_by_cwd(
                conn,
                &work.0,
                work.1,
                work.2.as_deref(),
            )
            .map_err(storage)
        })
        .await
    }

    // ——— v4 查询面（141 审计 §9 第 2 项）———
    //
    // 六条读面共用一条授权链（run 行存在 ∧ `parent_session_id` 是本会话；见
    // `repo::run_queries` 的文件头），拒绝一律归一成空结果。

    async fn workflow_run_summaries(
        &self,
        session: &SessionId,
        limit: usize,
    ) -> Result<Vec<nibi_kernel_api::workflow::WorkflowRunSummaryRow>, StoreError> {
        let session = session.as_str().to_owned();
        self.with_db(move |conn, _| {
            repo::run_queries::summaries(conn, &session, limit).map_err(storage)
        })
        .await
    }

    async fn workflow_run_events(
        &self,
        session: &SessionId,
        run_id: &str,
        query: nibi_kernel_api::workflow::WorkflowRunEventQuery,
    ) -> Result<nibi_kernel_api::workflow::WorkflowRunEventPage, StoreError> {
        let work = (session.as_str().to_owned(), run_id.to_owned());
        self.with_db(move |conn, _| {
            repo::run_queries::events(conn, &work.0, &work.1, query).map_err(storage)
        })
        .await
    }

    async fn workflow_run_artifacts(
        &self,
        session: &SessionId,
        run_id: &str,
    ) -> Result<Option<Vec<nibi_kernel_api::workflow::WorkflowRunArtifactDetail>>, StoreError>
    {
        let work = (session.as_str().to_owned(), run_id.to_owned());
        self.with_db(move |conn, _| {
            repo::run_queries::artifacts(conn, &work.0, &work.1).map_err(storage)
        })
        .await
    }

    async fn workflow_run_artifact_items(
        &self,
        session: &SessionId,
        run_id: &str,
        query: nibi_kernel_api::workflow::WorkflowRunArtifactItemQuery,
    ) -> Result<nibi_kernel_api::workflow::WorkflowRunArtifactItemPage, StoreError> {
        let work = (session.as_str().to_owned(), run_id.to_owned());
        self.with_db(move |conn, _| {
            repo::run_queries::artifact_items(conn, &work.0, &work.1, &query).map_err(storage)
        })
        .await
    }

    /// 一个产物版本的字节：先在库里走完 ①②（run 属于本会话）与 ③（journal 里有该版本的
    /// completed 行），拿到**行上的** uri 之后才碰 store。
    ///
    /// 读 store 走 [`ArtifactStore::find`] + [`ArtifactStore::get`]：uri 里的 id 只用于在会话
    /// 产物目录里按 id 后缀找回文件，**绝不当路径用**（与 `readArtifact` 同一条纪律）。
    async fn workflow_run_artifact_bytes(
        &self,
        session: &SessionId,
        run_id: &str,
        artifact_id: &str,
        version: u64,
    ) -> Result<Option<(Vec<u8>, Option<String>)>, StoreError> {
        let work = (
            session.as_str().to_owned(),
            run_id.to_owned(),
            artifact_id.to_owned(),
        );
        let located = self
            .with_db(move |conn, _| {
                repo::run_queries::artifact_version_uri(conn, &work.0, &work.1, &work.2, version)
                    .map_err(storage)
            })
            .await?;
        let Some((uri, content_type)) = located else {
            return Ok(None);
        };
        // uri 的 owner 必须是本会话（`artifact_version_uri` 已保证 run 归属；这里再比一次是因为
        // 行上的 uri 来自 journal，而 journal 是外部写入面——两处各判一次，同一个 id 不会在两层
        // 上得到不同解释）。
        let Some((owner, id)) = parse_artifact_uri(&uri) else {
            return Ok(None);
        };
        if owner != session.as_str() {
            return Ok(None);
        }
        let Some(artifact) = self.find(session, &ArtifactId::new(id)).await? else {
            return Ok(None);
        };
        let bytes = self.get(&artifact).await?;
        Ok(Some((bytes, content_type)))
    }

    async fn workflow_run_workspace(
        &self,
        session: &SessionId,
        run_id: &str,
    ) -> Result<Option<Vec<nibi_kernel_api::workflow::WorkflowRunWorkspaceNode>>, StoreError>
    {
        let work = (session.as_str().to_owned(), run_id.to_owned());
        self.with_db(move |conn, _| {
            repo::run_queries::workspace_nodes(conn, &work.0, &work.1).map_err(storage)
        })
        .await
    }

    async fn workflow_run_node_result(
        &self,
        session: &SessionId,
        run_id: &str,
        site_id: &str,
        ordinal: u64,
        max_bytes: u64,
    ) -> Result<Option<nibi_kernel_api::workflow::WorkflowRunNodeResult>, StoreError> {
        let work = (
            session.as_str().to_owned(),
            run_id.to_owned(),
            site_id.to_owned(),
        );
        self.with_db(move |conn, _| {
            repo::run_queries::node_result(conn, &work.0, &work.1, &work.2, ordinal, max_bytes)
                .map_err(storage)
        })
        .await
    }

    async fn app_usage(
        &self,
        query: nibi_kernel_api::usage::AppUsageQuery,
    ) -> Result<nibi_kernel_api::usage::AppUsage, StoreError> {
        self.with_db(move |conn, _| usage_query::app_usage(conn, &query))
            .await
    }

    async fn session_usage(
        &self,
        session: &SessionId,
    ) -> Result<nibi_kernel_api::usage::SessionUsage, StoreError> {
        let session = session.as_str().to_owned();
        self.with_db(move |conn, _| usage_query::session_usage(conn, &session))
            .await
    }
}

/// `nibi-artifact://<会话>/<artifact>` 的两段（百分号解码）。形状不对时为 None。
///
/// 与 runtime 的同名私有函数逐字同义：那一份给附件读取用（它会解 data URL），这一份只取两段
/// 交给 [`ArtifactStore::find`]。分开写是因为两处的上层语义不同（附件要 mime 与解码后的字节，
/// 产物读面要原始字节与行上的 contentType），而共用一个函数会把两套错误语义拧在一起。
fn parse_artifact_uri(uri: &str) -> Option<(String, String)> {
    let rest = uri.strip_prefix(nibi_kernel_api::persisted_output::ARTIFACT_SCHEME)?;
    let (owner, id) = rest.split_once('/')?;
    if owner.is_empty() || id.is_empty() || id.contains('/') {
        return None;
    }
    Some((percent_decode(owner)?, percent_decode(id)?))
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[async_trait]
impl ArtifactStore for NodeStore {
    async fn put(
        &self,
        session: &SessionId,
        purpose: ArtifactPurpose,
        media_type: String,
        bytes: Vec<u8>,
    ) -> Result<ArtifactRef, StoreError> {
        let artifact = ArtifactRef {
            session: session.clone(),
            id: ArtifactId::new(artifacts::artifact_id(&self.ids.uuid())),
            purpose,
            media_type,
            size: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
        };
        let path = artifacts::path(self.paths.artifacts(), &artifact);
        let options = nibi_kernel_fs::WriteOptions {
            mode: nibi_kernel_fs::FileMode::Default,
            temp_name: nibi_kernel_fs::TempName::Hidden,
            parent: nibi_kernel_fs::ParentDir::Create,
            rename_retry: &[],
        };
        // 临时文件写完、fsync、rename 之后才返回引用：拿到引用的一方读到的一定是完整内容。
        nibi_kernel_fs::atomic_write(path.as_path(), &bytes, options)
            .await
            .map_err(storage)?;
        Ok(artifact)
    }

    async fn get(&self, artifact: &ArtifactRef) -> Result<Vec<u8>, StoreError> {
        let path: PathBuf = artifacts::path(self.paths.artifacts(), artifact)
            .as_path()
            .to_path_buf();
        // 缺陷修复 R2-8：原来在阻塞线程里直接 std::fs::read，豁免理由“nibi-kernel-fs 还没有读文件的函数”已经
        // 过时；现在经 fs 的 `read_optional`。
        let bytes = match nibi_kernel_fs::read_optional(&path).await.map_err(storage)? {
            Some(bytes) => Some(bytes),
            // Node 写的产物（checkpoint，修复线 F12）用 Node 的文件名：按 Node 的读法找含 artifact id 的文件。
            None => node_checkpoints::read_node_named(self.paths.artifacts(), artifact).await?,
        }
        .ok_or_else(|| storage(format!("artifact {} is missing", artifact.id)))?;
        if u64::try_from(bytes.len()).ok() != Some(artifact.size) {
            return Err(storage(format!(
                "artifact {} has {} bytes, expected {}",
                artifact.id,
                bytes.len(),
                artifact.size
            )));
        }
        Ok(bytes)
    }

    /// 修复线 F18：Read 读落盘位置时按会话与 id 找回引用（大小、用途、类型取自文件），再经 `get` 核对大小。
    async fn find(
        &self,
        session: &SessionId,
        id: &ArtifactId,
    ) -> Result<Option<ArtifactRef>, StoreError> {
        artifacts::find(self.paths.artifacts(), session, id).await
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "records_tests.rs"]
mod records_tests;

#[cfg(test)]
#[path = "records_tools_tests.rs"]
mod records_tools_tests;

#[cfg(test)]
#[path = "hydrate_tests.rs"]
mod hydrate_tests;

#[cfg(test)]
#[path = "hydrate_notice_tests.rs"]
mod hydrate_notice_tests;

#[cfg(test)]
#[path = "title_tests.rs"]
mod title_tests;

#[cfg(test)]
#[path = "user_image_tests.rs"]
mod user_image_tests;

#[cfg(test)]
#[path = "compat_tests.rs"]
mod compat_tests;

#[cfg(test)]
#[path = "node_checkpoints_tests.rs"]
mod node_checkpoints_tests;

#[cfg(test)]
#[path = "artifacts_find_tests.rs"]
mod artifacts_find_tests;

#[cfg(test)]
#[path = "model_connection_tests.rs"]
mod model_connection_tests;

#[cfg(test)]
#[path = "resume_sentinel_tests.rs"]
mod resume_sentinel_tests;

#[cfg(test)]
#[path = "frontend_records_tests.rs"]
mod frontend_records_tests;

#[cfg(test)]
#[path = "directory_tests.rs"]
mod directory_tests;
