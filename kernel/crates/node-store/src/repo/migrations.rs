// 复制自 apps/nibi-cli-rust/crates/state/src/node/migrations.rs（feat/rs 79b6691c55）。
//! Node 会话库的迁移（`adapters/.../session-store/migrations.ts`），SQL 原文逐字节内嵌
//! （docs/specs/rust-m11-node-storage.md §2.2）。
//!
//! 与复制来源的差异：Node 已把 `zcode_database_identity` 迁移改号为 `0024_session_database_identity`
//! （SQL 与校验和不变），这里随 Node；`previous_ids` 对应 Node 的 `previousIds`。0025 是 NIBI 的
//! `nibi_database_identity` 改名（上游 0.1.88 没有这一条），0026 是上游的
//! `0025_session_permanent_deletion`（归档会话的永久删除）。
use nibi_kernel_base::include_lf;
use sha2::{Digest, Sha256};

pub struct Migration {
    pub id: &'static str,
    pub app_version: &'static str,
    pub sql: &'static str,
    /// Node `previousIds`：旧账本 id 已应用时只补记新 id，不重跑 SQL。
    pub previous_ids: &'static [&'static str],
    /// Node `touchedTables`：Node 迁移前只备份这些表，一张都不存在时不备份（`createMigrationBackup`）；本工程据它判断能不能在有数据的库上补
    /// （docs/specs/rust-cli/node-store.md §2）。
    pub touched_tables: &'static [&'static str],
}

macro_rules! migration {
    ($id:literal, $version:literal, [$($table:literal),*]) => {
        migration!($id, $version, [$($table),*], [])
    };
    ($id:literal, $version:literal, [$($table:literal),*], [$($previous:literal),*]) => {
        Migration {
            id: $id,
            app_version: $version,
            // 修复线 F56：以前用 `include_str!`，Windows 检出成 CRLF 时 SQL 带 `\r`，校验和与 Node 不同（Node 的 SQL
            // 在 JS 模板字符串里，只有 LF），0.1.52 打不开用户的库。现在 `.gitattributes` 固定 LF，`include_lf!` 在
            // 文本含 `\r` 时编译失败（docs/specs/rust-cli/node-store.md §2.1）。
            sql: include_lf!(concat!("migrations/", $id, ".sql")),
            previous_ids: &[$($previous),*],
            touched_tables: &[$($table),*],
        }
    };
}

/// Node `SQLITE_MIGRATIONS`，按执行顺序。
pub const MIGRATIONS: [Migration; 26] = [
    migration!(
        "0001_base_session_store",
        "0.2.0",
        [
            "input_history",
            "message",
            "part",
            "permission",
            "session",
            "session_entry",
            "todo"
        ]
    ),
    migration!("0002_local_setting", "0.2.0", ["local_setting"]),
    migration!(
        "0003_backfill_permission_local_setting",
        "0.2.0",
        ["local_setting"]
    ),
    migration!("0004_session_target", "0.7.0", ["session_target"]),
    migration!(
        "0005_session_target_accounting",
        "0.7.0",
        ["session_target", "session_target_next"]
    ),
    migration!(
        "0006_input_history_attachments",
        "0.11.0",
        ["input_history"]
    ),
    migration!(
        "0007_workflow_script_runtime",
        "0.13.0",
        [
            "session",
            "session_task_link",
            "workflow_activity",
            "workflow_definition",
            "workflow_event",
            "workflow_run"
        ]
    ),
    migration!(
        "0008_workflow_definition_scope",
        "0.13.0",
        ["workflow_definition"]
    ),
    migration!("0009_session_title_metadata", "0.14.0", ["session"]),
    migration!(
        "0010_usage_observability",
        "0.15.0",
        ["model_usage", "tool_usage", "turn_usage"]
    ),
    migration!(
        "0011_session_target_summary_title",
        "0.15.0",
        ["session_target"]
    ),
    migration!("0012_session_trace_id", "0.15.0", ["session"]),
    migration!(
        "0013_session_target_active_run_accounting",
        "0.15.0",
        ["session_target"]
    ),
    migration!("0014_message_part_sequence", "0.15.0", ["message", "part"]),
    migration!(
        "0015_message_part_sequence_backfill_and_guard",
        "0.15.2",
        ["message", "part"]
    ),
    migration!("0016_session_input_ledger", "0.15.2", ["session_input"]),
    migration!(
        "0017_session_input_start_now_delivery",
        "0.15.2",
        ["session_input", "session_input_before_start_now"]
    ),
    migration!(
        "0018_session_input_failed_status",
        "0.15.2",
        ["session_input", "session_input_before_failed_status"]
    ),
    migration!(
        "0019_dwf_journal",
        "0.16.5",
        ["dwf_run", "dwf_actor", "dwf_artifact", "dwf_node", "dwf_event"]
    ),
    migration!(
        "0020_provider_model_selection",
        "0.16.5",
        ["message", "part", "session_entry"]
    ),
    migration!("0021_official_glm_selection", "0.16.5", ["session_entry"]),
    migration!(
        "0022_backfilled_session_reasoning",
        "0.16.5",
        ["session_entry"]
    ),
    migration!(
        "0023_session_soft_delete_outcome",
        "0.16.9",
        ["session"],
        ["0020_session_soft_delete_outcome"]
    ),
    migration!(
        "0024_session_database_identity",
        "0.16.9",
        ["zcode_database_identity"]
    ),
    // NIBI 把身份表改名为 `nibi_database_identity`（与 Node 分家后的品牌化）；只改表名，不碰数据。
    // 表清单与 Node 的 `SQLITE_MIGRATIONS` 一致（改名前后的两个名字都算被碰到的表）。
    migration!(
        "0025_session_database_identity_rename",
        "4.0.3",
        ["zcode_database_identity", "nibi_database_identity"]
    ),
    // 归档会话的永久删除（上游 0.1.88 的 0025）：删除凭据、运行态表与写入守卫的触发器。
    migration!(
        "0026_session_permanent_deletion",
        "0.17.1",
        ["session_purge", "session_runtime_presence"]
    ),
];

/// Node `migrationChecksum`：`sha256(sql.trim())` 的十六进制。
pub fn checksum(sql: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(nibi_kernel_base::js::string::trim(sql).as_bytes())
    )
}

#[cfg(test)]
#[path = "migrations_tests.rs"]
mod tests;
