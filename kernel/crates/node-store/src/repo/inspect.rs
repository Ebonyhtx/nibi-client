//! 会话库的只读检查（`nibi doctor`）：不打开写连接、不执行迁移，只读 `schema_migration`
//! 账本里已应用的迁移，与内嵌的 [`MIGRATIONS`] 比较得出待执行的迁移。
//!
//! 打开时用 SQLite 的只读标志；库被其他进程占着也能读（WAL 下读旧快照）。

use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use super::migrations::MIGRATIONS;

/// 只读等待写锁的时间（doctor 不该拖住用户的库）。
const BUSY_TIMEOUT: Duration = Duration::from_millis(500);

/// 账本与当前已知迁移的比较结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaFacts {
    /// 账本里的迁移 id（按写入顺序）。
    pub applied: Vec<String>,
    /// 当前代码有、账本里还没有的迁移 id（按执行顺序）。
    pub pending: Vec<String>,
}

/// 只读检查已存在的 `path` 处的会话库（调用方先确认文件存在；不存在时不必调用）。
///
/// - `Ok(facts)`：库可读（没有 `schema_migration` 表时按空账本处理，所有迁移都待执行）；
/// - `Err`：不是 SQLite 库、打不开或读失败（调用方按 storage 检查失败处理）。
pub fn inspect_schema(path: &Path) -> io::Result<SchemaFacts> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(io::Error::other)?;
    connection
        .busy_timeout(BUSY_TIMEOUT)
        .map_err(io::Error::other)?;
    let has_ledger: i64 = connection
        .query_row(
            "select count(*) from sqlite_master where type = 'table' and name = 'schema_migration'",
            [],
            |row| row.get(0),
        )
        .map_err(io::Error::other)?;
    let mut applied = Vec::new();
    if has_ledger > 0 {
        let mut statement = connection
            .prepare("select id from schema_migration order by rowid")
            .map_err(io::Error::other)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(io::Error::other)?;
        for row in rows {
            applied.push(row.map_err(io::Error::other)?);
        }
    }
    let known: HashSet<&str> = applied.iter().map(String::as_str).collect();
    let pending = MIGRATIONS
        .iter()
        .filter(|migration| {
            !known.contains(migration.id)
                && !migration
                    .previous_ids
                    .iter()
                    .any(|previous| known.contains(previous))
        })
        .map(|migration| migration.id.to_owned())
        .collect();
    Ok(SchemaFacts { applied, pending })
}

#[cfg(test)]
#[path = "inspect_tests.rs"]
mod tests;
