#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    reason = "tests use temporary databases and plain file IO (README §4)"
)]

use rusqlite::Connection;

use super::*;

fn database(applied: &[&str]) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    let connection = Connection::open(&path).unwrap();
    connection
        .execute_batch(
            "create table schema_migration (
               id text primary key, checksum text not null, app_version text, time_applied integer not null
             )",
        )
        .unwrap();
    for (index, id) in applied.iter().enumerate() {
        connection
            .execute(
                "insert into schema_migration (id, checksum, app_version, time_applied) values (?1, 'x', '0.0.0', ?2)",
                rusqlite::params![id, index as i64],
            )
            .unwrap();
    }
    (dir, path)
}

#[test]
fn an_empty_database_has_every_migration_pending() {
    let (_dir, path) = database(&[]);
    let facts = inspect_schema(&path).unwrap();
    assert!(facts.applied.is_empty());
    assert_eq!(facts.pending.len(), MIGRATIONS.len());
    assert_eq!(facts.pending[0], MIGRATIONS[0].id);
}

#[test]
fn applied_ids_are_reported_in_order_and_removed_from_pending() {
    let (_dir, path) = database(&[MIGRATIONS[0].id, MIGRATIONS[1].id]);
    let facts = inspect_schema(&path).unwrap();
    assert_eq!(facts.applied, [MIGRATIONS[0].id, MIGRATIONS[1].id]);
    assert_eq!(facts.pending.len(), MIGRATIONS.len() - 2);
    assert!(!facts.pending.contains(&MIGRATIONS[0].id.to_owned()));
}

#[test]
fn a_database_without_the_ledger_is_treated_as_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    Connection::open(&path).unwrap();
    let facts = inspect_schema(&path).unwrap();
    assert!(facts.applied.is_empty());
    assert_eq!(facts.pending.len(), MIGRATIONS.len());
}

/// 旧账本 id 已应用时新 id 不再算待执行（`previousIds`）。
#[test]
fn a_previous_id_satisfies_the_renamed_migration() {
    let renamed = MIGRATIONS
        .iter()
        .find(|migration| !migration.previous_ids.is_empty())
        .unwrap();
    let previous = renamed.previous_ids[0];
    let (_dir, path) = database(&[previous]);
    let facts = inspect_schema(&path).unwrap();
    assert_eq!(facts.applied, [previous]);
    assert!(!facts.pending.contains(&renamed.id.to_owned()));
}

#[test]
fn a_file_that_is_not_sqlite_is_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("db.sqlite");
    std::fs::write(&path, b"not a database").unwrap();
    assert!(inspect_schema(&path).is_err());
}
