//! 会话库互认（阶段 1 首项）：Rust node-store 冷开 NIBI Node 内核现场生成的库。
//!
//! 测试默认跳过；由 `scripts/kernel-baseline/run-node-store-interop.mjs` 用
//! `NIBI_INTEROP_DB` / `NIBI_INTEROP_HOME` 指向一份隔离数据根后执行：
//!
//!   cargo test -p rust-cli-node-store --test nibi_interop -- --nocapture
//!
//! 断言：
//! 1. 迁移账本仍是 Node 的 0001–0024（数量与 checksum 由 node-store 打开时自行校验）；
//! 2. Node 写的会话在 Rust 侧可见，且 `load` 能读出消息；
//! 3. 冷开是只读语义：账本行数与 max(id) 在打开前后不变。

use std::path::PathBuf;
use std::sync::Arc;

use rust_cli_kernel_api::env::{EnvPath, WorkspaceRef};
use rust_cli_kernel_api::ids::{EnvironmentId, SessionId};
use rust_cli_kernel_api::store::{SessionFilter, SessionStore};
use rust_cli_node_store::{NodeIds, NodeStore, SystemClock};
use rust_cli_paths::{StoragePaths, StorageSettings};

/// Node 账本 id 形如 `0001_base_session_store`；取前四位的数字。
fn migration_number(id: &str) -> i64 {
    id.trim()
        .split('_')
        .next()
        .expect("migration id is non-empty")
        .parse::<i64>()
        .expect("migration id starts with a number")
}

fn required_env(name: &str) -> Option<String> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Some(value),
        _ => None,
    }
}

#[tokio::test]
async fn cold_opens_database_generated_by_node_kernel() {
    let Some(database) = required_env("NIBI_INTEROP_DB") else {
        eprintln!("skip: set NIBI_INTEROP_DB/NIBI_INTEROP_HOME to run the Node/Rust interop test");
        return;
    };
    let Some(home) = required_env("NIBI_INTEROP_HOME") else {
        eprintln!("skip: NIBI_INTEROP_DB is set but NIBI_INTEROP_HOME is missing");
        return;
    };
    let database = PathBuf::from(database);
    let home = PathBuf::from(home);
    assert!(
        database.is_file(),
        "interop db missing: {}",
        database.display()
    );

    // 直接读一次 Node 库，拿到会话与它所属的目录；这一步只用 rusqlite，不经过 node-store，
    // 避免“Rust 自己写了一条记录再自己读回来”的假阳性。
    let (ledger_before, session_id, directory) = {
        let connection = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("open interop db read-only");
        let ledger: Vec<String> = connection
            .prepare("select id from schema_migration order by id")
            .expect("prepare ledger query")
            .query_map([], |row| row.get(0))
            .expect("query ledger")
            .collect::<Result<_, _>>()
            .expect("collect ledger");
        let ledger: Vec<i64> = ledger.iter().map(|id| migration_number(id)).collect();
        let (session_id, directory): (String, String) = connection
            .query_row(
                "select id, directory from session order by time_created desc limit 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("select newest session");
        (ledger, session_id, directory)
    };

    assert_eq!(
        ledger_before,
        (1..=24).collect::<Vec<_>>(),
        "Node database must use ledger 0001-0024"
    );

    let settings = StorageSettings {
        session_db_path: database.to_str(),
        storage_dir: home.to_str(),
    };
    let paths = StoragePaths::resolve(&settings, &home, &home);
    let store = NodeStore::new(paths, Arc::new(NodeIds::new(Arc::new(SystemClock::utc()))));

    let workspace = WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new(directory),
    };
    let sessions = store
        .list(SessionFilter {
            workspace,
            limit: 50,
        })
        .await
        .expect("rust node-store lists Node sessions");
    assert!(
        sessions
            .iter()
            .any(|session| session.id.as_str() == session_id),
        "Rust list must contain Node session {session_id}"
    );

    let loaded = store
        .load(&SessionId::new(session_id.clone()))
        .await
        .expect("rust node-store loads Node session");
    assert_eq!(loaded.meta.id.as_str(), session_id);

    // 冷开不得新增/改写账本。
    let ledger_after: Vec<i64> = {
        let connection = rusqlite::Connection::open_with_flags(
            &database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .expect("reopen interop db read-only");
        let ids: Vec<String> = connection
            .prepare("select id from schema_migration order by id")
            .expect("prepare ledger query")
            .query_map([], |row| row.get(0))
            .expect("query ledger")
            .collect::<Result<_, _>>()
            .expect("collect ledger");
        ids.iter().map(|id| migration_number(id)).collect()
    };
    assert_eq!(
        ledger_before, ledger_after,
        "cold open must not change the migration ledger"
    );

    eprintln!(
        "interop ok: {} sessions visible, loaded {}",
        sessions.len(),
        session_id
    );
}
