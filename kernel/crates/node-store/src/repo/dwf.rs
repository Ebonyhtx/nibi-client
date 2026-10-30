//! DWF run 的只读仓储（`dwf_run`，migration 0019）。引擎在 Node 侧写，Rust 只读
//! （docs/rust-kernel-dwf-design-2026-10-30.md 的路线 C）。
use anyhow::Result;
use rusqlite::{Connection, params};
use rust_cli_kernel_api::workflow::DynamicWorkflowRun;

/// 一个会话发起的 run（按 `time_created` 升序，与 Node 的 run 列表一致）。
pub fn list(conn: &Connection, session: &str) -> Result<Vec<DynamicWorkflowRun>> {
    let mut query = conn.prepare_cached(
        "select id, parent_session_id, cwd, name, status, resumed_from, tool_call_id,
                spent_tokens, time_created, time_updated
         from dwf_run where parent_session_id = ? order by time_created, rowid",
    )?;
    let rows = query.query_map(params![session], |row| {
        Ok(DynamicWorkflowRun {
            id: row.get(0)?,
            session_id: row.get(1)?,
            cwd: row.get(2)?,
            name: row.get(3)?,
            status: row.get(4)?,
            resumed_from: row.get(5)?,
            tool_call_id: row.get(6)?,
            spent_tokens: row.get::<_, i64>(7)?.max(0) as u64,
            created_at: row.get::<_, i64>(8)?.max(0) as u64,
            updated_at: row.get::<_, i64>(9)?.max(0) as u64,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

#[cfg(test)]
#[path = "dwf_tests.rs"]
mod tests;
