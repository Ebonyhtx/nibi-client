// 复制自 apps/zcode-cli-rust/crates/state/src/node/open.rs（feat/rs 79b6691c55）。
//! 打开 Node 会话库：Node `SqliteSessionStore.openStartup` 与 `runSqliteSessionMigrationsAsync`
//! （`migration-runner.ts`）、`sqlite-migrations/runner.ts` 的 `migrateExclusive`
//! （docs/specs/rust-m11-node-storage.md §2.2、§8）。
//!
//! 与复制来源的差异：
//! - 启动进度（`Progress`）只为 `--prepare-storage` 握手报告（app-server 的存储准备入口，Node
//!   `runSqliteSessionMigrationsAsync` 的 `onProgress`）；常规打开传空报告，帧的顺序与 Node 相同。
//! - 账本按 Node `previousIds` 接管旧 id（只补记账本，不重跑 SQL），不再写死 0023 的特例预检。
//! - 迁移前备份没有复制：已有业务数据的库若还缺已知迁移，拒绝打开（`backup_required`），
//!   由 Node CLI / App 先升级。全新库没有要保护的表，照常补齐（docs/specs/rust-cli/node-store.md §2）。
use super::migrations::{MIGRATIONS, Migration, checksum};
use super::open_error::Attempt;
pub use super::open_error::StartupError;
use rusqlite::{Connection, ErrorCode, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::{Duration, Instant};

/// 业务连接等锁的时长（Node `DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS`）。
pub const BUSY_TIMEOUT: Duration = Duration::from_millis(5_000);
/// 迁移等写锁的总预算（Node `DEFAULT_SQLITE_MIGRATION_WAIT_MS`）。
pub const MIGRATION_LOCK_WAIT: Duration = Duration::from_secs(60 * 60);
/// 迁移期间 SQLite 只短暂等待，由外层退避重试。
const MIGRATION_BUSY_TIMEOUT: Duration = Duration::from_millis(25);
const RETRY_INITIAL_MS: u64 = 10;
const RETRY_MAX_MS: u64 = 200;
const LEDGER_DDL: &str = "create table if not exists schema_migration (
      id text primary key, checksum text not null, app_version text, time_applied integer not null
    )";

/// Node `DatabaseMigrationFacts`。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Facts {
    /// `none`、`initialize` 或 `upgrade`。
    pub kind: &'static str,
    pub executed: usize,
    /// `committed` 在 Node 里总等于 `executed`（失败时整体回滚，不会只提交一半）。
    pub committed: usize,
    /// 锁内、版本 SQL 之前账本里的最后一个 id（Node `lastAppliedMigrationId`；账本为空是 None）。
    /// 只在 prepare-storage 的进度帧里上报。
    pub last_applied: Option<String>,
    /// 账本基线已经读过：Node 的 facts 对象从这里起带 `lastAppliedMigrationId` 键（空账本是
    /// `null`），之前没有这个键。
    pub baseline_read: bool,
}

/// 一步迁移进度（Node `SqliteMigrationProgress` 的等价物；帧的组装在调用方）。
pub struct Progress<'a> {
    /// `checking`、`waiting_for_lock`、`migrating`、`committing`、`ready`、`failed`。
    pub phase: &'static str,
    /// 迁移事实（`checking` 的前两步与 `waiting_for_lock` 没有）。
    pub facts: Option<&'a Facts>,
    /// 正在执行的迁移（`migrating`）或失败点（`failed`）。
    pub migration_id: Option<&'a str>,
    /// 已应用的迁移数（`migrating`）。
    pub completed: usize,
    /// 已知迁移的总数（Node 传 `SQLITE_MIGRATIONS.length`，不是待执行的数）。
    pub total: usize,
    /// 失败的分类码（`failed`；Node `classifyDatabaseStartupError` 的结果）。
    pub error_code: Option<&'a str>,
    /// 失败的 SQLite 主结果码（`failed`，Node `errcode`）。
    pub sqlite_code: Option<i32>,
}

/// 进度报告；阻塞线程里同步调用，只做帧的组装与写出。共享闭包（调用方的序号与
/// 「传输已断」标记走原子量/Cell）。
pub type Report<'a> = &'a (dyn Fn(&Progress<'_>) + 'a);

/// 打开 `path` 并补齐 Node 的已知迁移。`lock_wait` 是等待其他写者的上限；`now_ms` 写进账本。
pub fn open(
    path: &Path,
    lock_wait: Duration,
    now_ms: u64,
) -> Result<(Connection, Facts), StartupError> {
    open_with_progress(path, lock_wait, now_ms, &|_| {})
}

/// 同 [`open`]，另把 Node `onProgress` 的每一步交给 `report`（`--prepare-storage` 握手用）。
/// 打开与迁移的每个失败都先经 `report` 报 `failed`（Node `openProtocolStartupStorage` 的 catch：
/// 迁移阶段的失败由 runner 报，更早的失败在这里报），随后调用方自己再报一份。
pub fn open_with_progress(
    path: &Path,
    lock_wait: Duration,
    now_ms: u64,
    report: Report<'_>,
) -> Result<(Connection, Facts), StartupError> {
    let report_failed = |error: &StartupError| {
        report(&Progress {
            phase: "failed",
            facts: None,
            migration_id: error.migration_id,
            completed: 0,
            total: MIGRATIONS.len(),
            error_code: Some(error.code),
            sqlite_code: error.sqlite_code,
        });
    };
    let display = path.display().to_string();
    let conn = match Connection::open(path) {
        Ok(conn) => conn,
        Err(e) => {
            let mut error = StartupError::sqlite(
                &e,
                &format!("Failed to open SQLite session database at {display}"),
            );
            error.code = "open_failed";
            report_failed(&error);
            return Err(error);
        }
    };
    let context = format!("SQLite setup failed for {display}");
    if let Err(error) = conn
        .busy_timeout(MIGRATION_BUSY_TIMEOUT)
        .map_err(|e| StartupError::sqlite(&e, &context))
    {
        report_failed(&error);
        return Err(error);
    }
    let mut runner = Runner {
        conn: &conn,
        path: &display,
        memory: display == ":memory:",
        deadline: Instant::now() + lock_wait,
        now_ms,
        report,
        facts: None,
    };
    let migrated = runner.steps();
    if !conn.is_autocommit() {
        // 先回滚，再把失败交给调用方；业务不能拿到仍在事务内的连接。
        let _ = conn.execute_batch("rollback");
    }
    // 迁移结束（含失败）恢复业务连接的 5 秒等待，不继承迁移期间的短超时。
    let restored = conn.busy_timeout(BUSY_TIMEOUT);
    let facts = migrated.inspect_err(|error| runner.failed(error));
    restored.map_err(|e| StartupError::sqlite(&e, &context))?;
    let facts = facts?;
    Ok((conn, facts))
}

/// Node 的 databaseId（`createHash("sha256").update(dbPath).digest("hex")`）：同一个库总是同一个
/// ID，且与 Node 逐字节一致（Host 按它归并迁移基线）；路径明文不出进程。Node 的 dbPath 是
/// `path.resolve` 的产物（Windows 上分隔符全为 `\`），这里把混用分隔符归一后再散列。
pub fn session_database_id(path: &Path) -> String {
    let text = path.to_string_lossy();
    let normalized = if cfg!(windows) {
        text.replace('/', "\\")
    } else {
        text.to_string()
    };
    let digest = Sha256::digest(normalized.as_bytes());
    let mut id = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(id, "{byte:02x}");
    }
    id
}

struct Runner<'a> {
    conn: &'a Connection,
    path: &'a str,
    memory: bool,
    deadline: Instant,
    now_ms: u64,
    report: Report<'a>,
    /// 迁移事实（Node 的 `migration` 对象）：预检后建，账本基线、每个迁移与提交逐步更新；
    /// 失败帧带最后一次的事实。
    facts: Option<Facts>,
}

impl Runner<'_> {
    fn sql<T>(&self, result: rusqlite::Result<T>, context: &str) -> Result<T, Attempt> {
        result.map_err(|e| Attempt {
            busy: e.sqlite_error_code() == Some(ErrorCode::DatabaseBusy),
            error: StartupError::sqlite(&e, &format!("{context} for {}", self.path)),
        })
    }

    /// Node `acquire`：只对其他写者造成的 `SQLITE_BUSY` 退避重试。
    fn acquire<T>(
        &self,
        mut operation: impl FnMut(&Self) -> Result<T, Attempt>,
    ) -> Result<T, StartupError> {
        let mut delay = RETRY_INITIAL_MS;
        let mut waiting = false;
        loop {
            let attempt = match operation(self) {
                Ok(value) => return Ok(value),
                Err(attempt) if !attempt.busy => return Err(attempt.error),
                Err(attempt) => attempt,
            };
            let now = Instant::now();
            if now >= self.deadline {
                let mut timeout = StartupError::new(
                    "lock_timeout",
                    format!(
                        "Timed out waiting for SQLite migration lock at {}",
                        self.path
                    ),
                );
                timeout.sqlite_code = attempt.error.sqlite_code;
                return Err(timeout);
            }
            if !waiting {
                waiting = true;
                (self.report)(&Progress {
                    phase: "waiting_for_lock",
                    facts: self.facts.as_ref(),
                    migration_id: None,
                    completed: 0,
                    total: MIGRATIONS.len(),
                    error_code: None,
                    sqlite_code: None,
                });
            }
            // 本函数只在存储的阻塞线程里运行（docs/specs/rust-cli/node-store.md §3）。
            std::thread::sleep((self.deadline - now).min(Duration::from_millis(delay)));
            delay = (delay * 2).min(RETRY_MAX_MS);
        }
    }

    /// Node `onProgress` 的等价物（同一事件序列，帧由调用方组装）。
    fn report_progress(&self, phase: &'static str, migration_id: Option<&str>, completed: usize) {
        (self.report)(&Progress {
            phase,
            facts: self.facts.as_ref(),
            migration_id,
            completed,
            total: MIGRATIONS.len(),
            error_code: None,
            sqlite_code: None,
        });
    }

    /// 失败帧：错误码与迁移点原样带出（Node `progress("failed", …)`）。
    fn failed(&self, error: &StartupError) {
        (self.report)(&Progress {
            phase: "failed",
            facts: self.facts.as_ref(),
            migration_id: error.migration_id,
            completed: 0,
            total: MIGRATIONS.len(),
            error_code: Some(error.code),
            sqlite_code: error.sqlite_code,
        });
    }

    fn steps(&mut self) -> Result<Facts, StartupError> {
        // Node 的开头一帧 checking（migration 对象还没建，无事实）。
        (self.report)(&Progress {
            phase: "checking",
            facts: None,
            migration_id: None,
            completed: 0,
            total: MIGRATIONS.len(),
            error_code: None,
            sqlite_code: None,
        });
        self.sql(
            self.conn.execute_batch("pragma foreign_keys = on"),
            "SQLite setup failed",
        )
        .map_err(|a| a.error)?;
        self.acquire(Self::journal_mode)?;
        let kind = self.acquire(Self::preflight)?;
        self.facts = Some(Facts {
            kind,
            executed: 0,
            committed: 0,
            last_applied: None,
            baseline_read: false,
        });
        self.report_progress("checking", None, 0);
        self.acquire(|r| {
            r.sql(
                r.conn.execute_batch("begin immediate"),
                "SQLite migration lock failed",
            )
        })?;
        self.sql(
            self.conn.execute_batch(LEDGER_DDL),
            "SQLite migration initialization failed",
        )
        .map_err(|a| a.error)?;
        // Node 在跑版本 SQL 之前读一次账本的最后一个 id（`lastAppliedMigrationId`），本轮不更新它。
        let baseline: Option<String> = self
            .sql(
                self.conn
                    .query_row(
                        "select id from schema_migration order by id desc limit 1",
                        [],
                        |r| r.get(0),
                    )
                    .optional(),
                "SQLite migration ledger read failed",
            )
            .map_err(|a| a.error)?;
        if let Some(facts) = self.facts.as_mut() {
            facts.last_applied = baseline;
            facts.baseline_read = true;
        }
        let pending = self.pending()?;
        // 缺陷修复（修复线 F12，双进程迁移竞争）：原来按预检的 `kind == "upgrade"` 拒绝。预检在等写锁之前读库，等锁
        // 期间旧版 Node 可能已建表、补了它知道的迁移并提交，预检的结论过期，结果在已有业务表的库上直接补迁移。Node
        // 在 `migrateExclusive` 的事务里按当时的表决定备份（`createMigrationBackup`）；这里同样在事务里重新判定。
        if !pending.is_empty() && self.has_data().map_err(|a| a.error)? {
            let ids: Vec<&str> = pending.iter().map(|m| m.id).collect();
            return Err(StartupError::new(
                "backup_required",
                format!(
                    "SQLite session database {} needs migrations {} that rust-cli cannot back up yet; open it once with the Node CLI or App first",
                    self.path,
                    ids.join(", ")
                ),
            ));
        }
        for migration in &pending {
            if let Some(facts) = self
                .facts
                .as_mut()
                .filter(|facts| facts.kind == "none")
            {
                facts.kind = "upgrade";
            }
            let context = format!("SQLite migration {} failed", migration.id);
            let tag = |attempt: Attempt| {
                let mut error = attempt.error;
                error.migration_id = Some(migration.id);
                error
            };
            let completed = self.facts.as_ref().map_or(0, |facts| facts.executed);
            self.report_progress("migrating", Some(migration.id), completed);
            self.sql(self.apply(migration), &context).map_err(tag)?;
            let ledger = self.conn.execute(
                "insert into schema_migration (id,checksum,app_version,time_applied) values (?,?,?,?)",
                params![migration.id, checksum(migration.sql), migration.app_version, self.now_ms as i64],
            );
            self.sql(ledger, &context).map_err(tag)?;
            if let Some(facts) = self.facts.as_mut() {
                facts.executed += 1;
            }
        }
        self.report_progress("committing", None, 0);
        self.sql(
            self.conn.execute_batch("commit"),
            "SQLite migration commit failed",
        )
        .map_err(|a| a.error)?;
        if let Some(facts) = self.facts.as_mut() {
            facts.committed = facts.executed;
        }
        self.report_progress("ready", None, 0);
        Ok(self.facts.clone().unwrap_or(Facts {
            kind,
            executed: 0,
            committed: 0,
            last_applied: None,
            baseline_read: false,
        }))
    }

    /// Node `migrateExclusive` 的账本核对：已应用的 id（含 `previousIds`）逐个比校验和；只有旧 id
    /// 时补记新 id。返回还要执行的迁移。
    fn pending(&self) -> Result<Vec<&'static Migration>, StartupError> {
        let mut pending = vec![];
        for migration in &MIGRATIONS {
            let sum = checksum(migration.sql);
            let mut applied = vec![];
            for &id in std::iter::once(&migration.id).chain(migration.previous_ids) {
                if let Some(stored) = self.applied(id).map_err(|a| a.error)? {
                    ensure_checksum(id, &stored, &sum, self.path)?;
                    applied.push(id);
                }
            }
            match applied.first() {
                None => pending.push(migration),
                Some(first) if !applied.contains(&migration.id) => {
                    // 改号只沿用旧结果，不能重新执行 SQL。
                    let adopt = self.conn.execute(
                        "insert into schema_migration(id,checksum,app_version,time_applied)
          select ?,checksum,app_version,time_applied from schema_migration where id=?",
                        params![migration.id, first],
                    );
                    self.sql(adopt, "SQLite migration ledger update failed")
                        .map_err(|a| a.error)?;
                }
                Some(_) => {}
            }
        }
        Ok(pending)
    }

    /// 必须是 WAL（`:memory:` 库报告 `memory`）。
    fn journal_mode(&self) -> Result<(), Attempt> {
        let read = |sql: &str| {
            self.sql(
                self.conn.query_row(sql, [], |r| r.get::<_, String>(0)),
                "SQLite journal mode check failed",
            )
            .map(|mode| mode.to_lowercase())
        };
        let accepted = |mode: &str| mode == "wal" || (self.memory && mode == "memory");
        if accepted(&read("pragma journal_mode")?) {
            return Ok(());
        }
        let mode = read("pragma journal_mode = wal")?;
        if accepted(&mode) {
            return Ok(());
        }
        Err(StartupError::new(
            "sql_failed",
            format!(
                "SQLite refused WAL journal mode for {}; received {mode}",
                self.path
            ),
        )
        .into())
    }

    /// Node `inspectMigrationKind`：已应用的已知迁移逐个比校验和，再判定种类。
    fn preflight(&self) -> Result<&'static str, Attempt> {
        let context = "SQLite migration preflight failed";
        let ledger: bool = self.sql(
            self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration')",
                [],
                |r| r.get(0),
            ),
            context,
        )?;
        let mut pending = false;
        for migration in &MIGRATIONS {
            let applied = if ledger {
                self.applied(migration.id)?
            } else {
                None
            };
            match applied {
                Some(applied) => {
                    ensure_checksum(migration.id, &applied, &checksum(migration.sql), self.path)?;
                }
                None => pending = true,
            }
        }
        if !pending {
            return Ok("none");
        }
        Ok(if self.has_data()? {
            "upgrade"
        } else {
            "initialize"
        })
    }

    /// 库里有账本以外的表（Node `inspectMigrationKind` 的 `hasDataTables`）。
    fn has_data(&self) -> Result<bool, Attempt> {
        self.sql(
            self.conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migration', 'sqlite_sequence'))",
                [],
                |r| r.get(0),
            ),
            "SQLite migration preflight failed",
        )
    }

    /// 0023 用 Node 的 `apply`：列已存在时不重复 ADD COLUMN（旧版本曾以 0020 提前发布）。
    fn apply(&self, migration: &Migration) -> rusqlite::Result<()> {
        if migration.id != "0023_session_soft_delete_outcome" {
            return self.conn.execute_batch(migration.sql);
        }
        for (name, kind) in [("time_deleted", "integer"), ("last_outcome", "text")] {
            let exists: bool = self.conn.query_row(
                "select exists(select 1 from pragma_table_info('session') where name=?)",
                [name],
                |r| r.get(0),
            )?;
            if !exists {
                self.conn
                    .execute_batch(&format!("alter table session add column {name} {kind}"))?;
            }
        }
        Ok(())
    }

    fn applied(&self, id: &str) -> Result<Option<String>, Attempt> {
        self.sql(
            self.conn
                .query_row(
                    "select checksum from schema_migration where id = ?",
                    [id],
                    |r| r.get(0),
                )
                .optional(),
            "SQLite migration ledger read failed",
        )
    }
}

fn ensure_checksum(
    id: &'static str,
    applied: &str,
    current: &str,
    path: &str,
) -> Result<(), StartupError> {
    if applied == current {
        return Ok(());
    }
    let mut error = StartupError::new(
        "checksum_mismatch",
        format!(
            "SQLite migration checksum mismatch for {id}. Historical migrations are immutable; add a new migration instead. ({path})"
        ),
    );
    error.migration_id = Some(id);
    Err(error)
}

#[cfg(test)]
#[path = "open_tests.rs"]
mod tests;
