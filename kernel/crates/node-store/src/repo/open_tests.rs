// 复制自 apps/zcode-cli-rust/crates/state/src/node/open_tests.rs（feat/rs 79b6691c55）。
use super::*;
use std::sync::mpsc;
use std::sync::Mutex;

fn open_at(path: &Path, wait: Duration) -> Result<(Connection, Facts), StartupError> {
    open(path, wait, 7)
}

fn ledger(conn: &Connection) -> Vec<(String, String, String, i64)> {
    conn.prepare("select id, checksum, app_version, time_applied from schema_migration order by id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[test]
fn a_new_database_gets_every_node_migration_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let (conn, facts) = open_at(&path, MIGRATION_LOCK_WAIT).unwrap();
    assert_eq!(
        facts,
        Facts {
            kind: "initialize",
            executed: 24,
            committed: 24,
            last_applied: None,
            baseline_read: true,
        }
    );
    let rows = ledger(&conn);
    let mut migrations: Vec<_> = MIGRATIONS.iter().collect();
    migrations.sort_by_key(|m| m.id);
    assert_eq!(rows.len(), migrations.len());
    for (row, migration) in rows.iter().zip(migrations) {
        assert_eq!(
            row,
            &(
                migration.id.to_owned(),
                checksum(migration.sql),
                migration.app_version.to_owned(),
                7
            )
        );
    }
    let mode: String = conn
        .query_row("pragma journal_mode", [], |r| r.get(0))
        .unwrap();
    let keys: i64 = conn
        .query_row("pragma foreign_keys", [], |r| r.get(0))
        .unwrap();
    assert_eq!((mode.as_str(), keys), ("wal", 1));
    drop(conn);

    let (_, facts) = open_at(&path, MIGRATION_LOCK_WAIT).unwrap();
    assert_eq!(
        facts,
        Facts {
            kind: "none",
            executed: 0,
            committed: 0,
            last_applied: Some("0024_session_database_identity".to_owned()),
            baseline_read: true,
        }
    );
}

#[test]
fn foreign_migrations_tables_and_columns_are_ignored() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    open_at(&path, MIGRATION_LOCK_WAIT).unwrap();
    {
        let conn = Connection::open(&path).unwrap();
        // 官方构建的 0017_todo_state_revision、旧 Rust 的 0023_session_database_identity 与未来的迁移。
        conn.execute_batch(
            "insert into schema_migration values ('0025_future_feature','x','3.12.0',1);
             insert into schema_migration values ('0017_todo_state_revision','y','0.15.2',1);
             insert into schema_migration values ('0023_session_database_identity','z','0.16.9',1);
             create table todo_state(session_id text primary key, todo_revision integer not null, time_updated integer not null);",
        )
        .unwrap();
    }
    let (conn, facts) = open_at(&path, MIGRATION_LOCK_WAIT).unwrap();
    assert_eq!(facts.kind, "none");
    let tables: i64 = conn
        .query_row(
            "select count(*) from sqlite_master where type='table' and name='todo_state'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tables, 1);
}

#[test]
fn a_changed_checksum_stops_startup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    open_at(&path, MIGRATION_LOCK_WAIT).unwrap();
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "update schema_migration set checksum = 'x' where id = '0005_session_target_accounting'",
        [],
    )
    .unwrap();
    let error = open_at(&path, MIGRATION_LOCK_WAIT).unwrap_err();
    assert_eq!(error.code, "checksum_mismatch");
    assert_eq!(error.migration_id, Some("0005_session_target_accounting"));
}

/// 已有业务数据的库缺已知迁移：迁移前备份还没有实现，拒绝打开且不改库。
#[test]
fn a_gap_in_a_database_with_data_waits_for_node() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    open_at(&path, MIGRATION_LOCK_WAIT).unwrap();
    let conn = Connection::open(&path).unwrap();
    conn.execute(
        "delete from schema_migration where id = '0022_backfilled_session_reasoning'",
        [],
    )
    .unwrap();
    let error = open_at(&path, MIGRATION_LOCK_WAIT).unwrap_err();
    assert_eq!(error.code, "backup_required");
    let count: i64 = conn
        .query_row("select count(*) from schema_migration", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 23);
}

#[test]
fn another_writer_makes_startup_wait_or_time_out() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    open_at(&path, MIGRATION_LOCK_WAIT).unwrap();
    let holder = Connection::open(&path).unwrap();
    holder.execute_batch("begin immediate").unwrap();
    let error = open_at(&path, Duration::from_millis(300)).unwrap_err();
    assert_eq!(error.code, "lock_timeout");

    let (release, released) = mpsc::channel();
    let waiter = std::thread::spawn(move || {
        let result = open_at(&path, Duration::from_secs(5));
        release.send(()).ok();
        result.map(drop)
    });
    std::thread::sleep(Duration::from_millis(100));
    holder.execute_batch("commit").unwrap();
    waiter.join().unwrap().unwrap();
    released.recv().unwrap();
}

/// Node `previousIds`：只有旧 id 时补记新 id，不重复 ADD COLUMN；校验和仍然核对。
#[test]
fn a_legacy_migration_id_is_adopted_without_rerunning_sql() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let (conn, _) = open_at(&path, MIGRATION_LOCK_WAIT).unwrap();
    conn.execute(
        "update schema_migration set id='0020_session_soft_delete_outcome' where id='0023_session_soft_delete_outcome'",
        [],
    )
    .unwrap();
    drop(conn);
    let (conn, facts) = open_at(&path, MIGRATION_LOCK_WAIT).unwrap();
    assert_eq!(facts.executed, 0);
    let ids: i64 = conn
        .query_row(
            "select count(*) from schema_migration where id='0023_session_soft_delete_outcome'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(ids, 1);
    conn.execute(
        "update schema_migration set checksum='invalid' where id='0020_session_soft_delete_outcome'",
        [],
    )
    .unwrap();
    assert_eq!(
        open_at(&path, MIGRATION_LOCK_WAIT).unwrap_err().code,
        "checksum_mismatch"
    );
}

/// 双进程迁移竞争（docs/specs/rust-cli/node-store.md §2、§6 第 12 段）：本进程等写锁期间，旧版 Node（0.16.5）补齐了它
/// 知道的前 22 个迁移并提交。拿到锁时库里已有业务表、又缺改 session 表的 0023 与 0024，与之后再打开同一个库一样拒绝
/// （`backup_required`），不改库；Node 此时在事务里先备份 session 表再补。
#[test]
fn an_older_writer_that_migrates_while_we_wait_still_needs_a_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let holder = Connection::open(&path).unwrap();
    // 旧版的连接已切 WAL：等锁的一方先通过 WAL 检查与预检（读到空库），再在 begin immediate 上等。
    let mode: String = holder
        .query_row("pragma journal_mode = wal", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mode, "wal");
    holder.execute_batch("begin immediate").unwrap();
    holder.execute_batch(LEDGER_DDL).unwrap();
    for migration in &MIGRATIONS[..22] {
        holder.execute_batch(migration.sql).unwrap();
        holder
            .execute(
                "insert into schema_migration values (?, ?, ?, 1)",
                params![migration.id, checksum(migration.sql), migration.app_version],
            )
            .unwrap();
    }
    let waiter = {
        let path = path.clone();
        std::thread::spawn(move || open_at(&path, Duration::from_secs(5)).map(drop))
    };
    std::thread::sleep(Duration::from_millis(200));
    holder.execute_batch("commit").unwrap();
    let error = waiter.join().unwrap().unwrap_err();
    assert_eq!(error.code, "backup_required");
    assert_eq!(
        open_at(&path, MIGRATION_LOCK_WAIT).unwrap_err().code,
        "backup_required"
    );
    let count: i64 = holder
        .query_row("select count(*) from schema_migration", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 22);
}

/// `--prepare-storage` 的进度序列（Node `runSqliteSessionMigrationsAsync` 的 onProgress 同一顺序）：
/// 全新库 checking → checking(事实) → migrating×24 → committing → ready；已就绪的库只有 checking、
/// checking(事实)、ready；损坏的库报 failed 且带分类码。帧字段由调用方组装，这里看 Progress 序列。
#[test]
fn progress_reports_the_node_sequence() {
    type Seen = Vec<(String, Option<(String, usize, usize, Option<String>)>, Option<String>, usize)>;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let seen: Mutex<Seen> = Mutex::new(Vec::new());
    let report = |progress: &Progress<'_>| {
        seen.lock().unwrap().push((
            progress.phase.to_owned(),
            progress
                .facts
                .map(|f| (f.kind.to_owned(), f.executed, f.committed, f.last_applied.clone())),
            progress.migration_id.map(str::to_owned),
            progress.completed,
        ));
    };
    open_with_progress(&path, MIGRATION_LOCK_WAIT, 7, &report).unwrap();
    let fresh = seen.lock().unwrap().clone();
    seen.lock().unwrap().clear();
    assert_eq!(
        fresh
            .iter()
            .filter(|(phase, ..)| phase == "migrating")
            .count(),
        MIGRATIONS.len()
    );
    for (index, (_phase, facts, migration_id, completed)) in
        fresh.iter().filter(|(p, ..)| p == "migrating").enumerate()
    {
        let (kind, executed, committed, _) = facts.as_ref().unwrap();
        assert_eq!((kind.as_str(), *executed, *committed), ("initialize", index, 0));
        assert_eq!(migration_id.as_deref(), Some(MIGRATIONS[index].id));
        assert_eq!(*completed, index);
    }
    let (phase, facts, ..) = fresh.last().unwrap();
    assert_eq!(phase, "ready");
    // Node 的 lastAppliedMigrationId 是跑版本 SQL 之前账本的最后一个 id：全新库是 null。
    assert_eq!(
        facts.as_ref().unwrap(),
        &(
            "initialize".to_owned(),
            MIGRATIONS.len(),
            MIGRATIONS.len(),
            None
        )
    );
    // 第一帧 checking 还没有事实（Node 的 migration 对象在预检后才建）。
    assert_eq!(fresh[0].0, "checking");
    assert!(fresh[0].1.is_none());
    assert_eq!(fresh[1].0, "checking");
    assert_eq!(fresh[1].1.as_ref().unwrap().0, "initialize");

    open_with_progress(&path, MIGRATION_LOCK_WAIT, 7, &report).unwrap();
    let ready = seen.lock().unwrap().clone();
    seen.lock().unwrap().clear();
    let phases: Vec<&str> = ready.iter().map(|(phase, ..)| phase.as_str()).collect();
    // Node 的 onCommitting 无条件触发（没有待执行迁移也是 committing → ready）。
    assert_eq!(phases, ["checking", "checking", "committing", "ready"]);
    // 事实帧在基线读取之前（lastAppliedMigrationId 还没设），ready 帧带上它。
    let (_, facts, ..) = &ready[1];
    assert_eq!(
        facts.as_ref().unwrap(),
        &("none".to_owned(), 0, 0, None)
    );
    let (_, facts, ..) = &ready[3];
    assert_eq!(
        facts.as_ref().unwrap(),
        &(
            "none".to_owned(),
            0,
            0,
            Some("0024_session_database_identity".to_owned())
        )
    );

    // 损坏库：failed 帧带分类码（corrupt），且之前没有 ready。
    let corrupt = b"this is not a database";
    let options = rust_cli_fs::WriteOptions {
        mode: rust_cli_fs::FileMode::Default,
        temp_name: rust_cli_fs::TempName::Hidden,
        parent: rust_cli_fs::ParentDir::Create,
        rename_retry: &[],
    };
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(rust_cli_fs::atomic_write(&path, &corrupt[..], options))
        .unwrap();
    let error = open_with_progress(&path, Duration::from_millis(300), 7, &report).unwrap_err();
    assert_eq!(error.code, "corrupt");
    let failed = seen.lock().unwrap().clone();
    assert_eq!(failed.last().unwrap().0, "failed");
    assert!(!failed.iter().any(|(phase, ..)| phase == "ready"));
}

/// Node 的 databaseId：路径的 sha256 十六进制（与 `createHash("sha256").update(dbPath)` 一致）。
#[test]
fn the_database_id_matches_node() {
    let path = Path::new("C:\\Users\\dev\\.zcode\\cli\\db\\db.sqlite");
    assert_eq!(
        session_database_id(path),
        "9e8c79c27312770d1359036d8695b327cc4e25139da10763d1d27d8b5b87ed13"
    );
    // Node 的 dbPath 是 `path.resolve` 的产物：Windows 上混用分隔符归一成 `\`（同一个库同一个 ID）。
    assert_eq!(
        session_database_id(Path::new("C:\\Users\\dev\\.zcode/cli/db/db.sqlite")),
        session_database_id(path)
    );
}
