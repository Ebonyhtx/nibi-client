//! `app-server --stdio --prepare-storage`（Node `prepareProtocolStartupStorage`，Host 的存储准备
//! Worker/子进程）：只准备会话库，不起 Provider/MCP/内核，也不进协议读循环。一个常驻的
//! current-thread runtime 只为异步文件读/建目录服务；打开库在当前线程阻塞跑，30 秒的确认等待用
//! 一个 stdin 读线程 + `recv_timeout`。stdout 全程只写有界的控制帧，日志照常只进文件。
//!
//! 握手（`zcodeStoragePreparationFrameSchema`）：
//! 1. 报 `startup/storagePath {path}`（会话库的绝对路径；库的位置只来自用户级配置与环境变量——
//!    Node 的协议入口 `createConfig({env})` 没有项目层，这里同一范围）。
//! 2. 等 Host 的一行 `startup/storagePathReady {reuse?}`：30 秒超时（`startup_status_timeout`）、
//!    EOF（`transport_closed`）、超过 1024 字节、非法 JSON 或方法名/键不对（`sql_failed`）都按
//!    失败处理。
//! 3. `reuse=false` 时打开并补齐迁移，过程以 `startup/storageState` 上报（node-store 的
//!    `open_with_progress`，与 Node `runSqliteSessionMigrationsAsync` 的 onProgress 同一序列）。
//! 4. 报 `startup/storagePrepared`，退出码 0。任何失败：打开层先报一份（本尝试的 attemptId 与
//!    递增序号；迁移前的失败由这里代报），再由这里报一份全新 attemptId、序号 1、elapsedMs 0 的
//!    （Node 两层 catch 的同一形状），退出码 1。

use std::io::{BufRead, Write};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use rust_cli_node_store::{NodeIds, OpenProgress, StartupError, SystemClock};
use rust_cli_paths::StorageSettings;
use serde_json::{Map, Value, json};

use crate::config;
use crate::setup;

/// 确认帧的单行上限（Node `prepareProtocolStartupStorage` 的 1024）。
const ACK_MAX_LINE: usize = 1024;
/// 等确认帧的时限（Node 的 30 秒；Host 侧同样是 30 秒的首帧门）。
const ACK_TIMEOUT: Duration = Duration::from_secs(30);

/// Node `databaseStartupErrorCodeSchema` 的值；不在这个集合里的码（只有 `backup_required`——
/// 迁移前备份还没有实现的那条拒绝路径）按 `sql_failed` 报，否则 Host 的 schema 解析会把整行当坏帧。
const ERROR_CODES: [&str; 12] = [
    "storage_full",
    "permission_denied",
    "io_error",
    "out_of_memory",
    "corrupt",
    "open_failed",
    "lock_timeout",
    "checksum_mismatch",
    "sql_failed",
    "startup_status_timeout",
    "transport_closed",
    "unsupported_runtime",
];

pub(crate) fn dispatch() -> ExitCode {
    let startup = match crate::capture() {
        Ok(startup) => startup,
        Err(error) => {
            crate::output::eprint_line(&format!("zcode: {error:#}"));
            return ExitCode::FAILURE;
        }
    };
    match run(startup) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            crate::output::eprint_line(&format!("zcode: {error:#}"));
            ExitCode::FAILURE
        }
    }
}

/// 一次打开尝试的进度帧（Node `openProtocolStartupStorage`）：attemptId 与序号从 checking 起递增；
/// 传输断了就静音（打开照常完成或失败，结果不再上报）。
struct States {
    attempt: String,
    database: String,
    sequence: AtomicU64,
    started: u64,
    ids: Arc<NodeIds>,
    dead: AtomicBool,
}

impl States {
    fn new(attempt: String, database: String, started: u64, ids: Arc<NodeIds>) -> Self {
        Self {
            attempt,
            database,
            sequence: AtomicU64::new(0),
            started,
            ids,
            dead: AtomicBool::new(false),
        }
    }

    fn send(&self, mut state: Map<String, Value>) -> bool {
        if self.dead.load(Ordering::Acquire) {
            return false;
        }
        // Node `nibiProtocolNotifications.storageStartup`：`{method: "startup/storageState", params}`。
        let mut params = Map::new();
        params.insert("schemaVersion".into(), json!(1));
        params.insert("attemptId".into(), json!(self.attempt));
        params.insert(
            "sequence".into(),
            json!(self.sequence.fetch_add(1, Ordering::Relaxed) + 1),
        );
        params.insert("databaseId".into(), json!(self.database));
        params.insert("databaseKind".into(), json!("session"));
        params.append(&mut state);
        let frame = json!({ "method": "startup/storageState", "params": params });
        let ok = write_line(&frame);
        if !ok {
            self.dead.store(true, Ordering::Release);
        }
        ok
    }

    /// Node `openProtocolStartupStorage.report` 的一帧（迁移事实、migrating 的 completed/total、
    /// failed 的错误码与迁移点）。
    fn send_progress(&self, progress: &OpenProgress) {
        let mut state = Map::new();
        state.insert("phase".into(), json!(progress.phase));
        state.insert(
            "elapsedMs".into(),
            json!(self.ids.now_ms().saturating_sub(self.started)),
        );
        if let Some(facts) = progress.facts {
            let mut migration = json!({
                "kind": facts.kind,
                "executedCount": facts.executed,
                "committedCount": facts.committed,
            });
            // Node 的 facts 对象从基线读取起带 lastAppliedMigrationId 键（空账本也是 null），之前没有。
            if facts.baseline_read {
                let last = facts
                    .last_applied
                    .as_deref()
                    .map_or(Value::Null, |value| json!(value));
                migration["lastAppliedMigrationId"] = last;
            }
            state.insert("migration".into(), migration);
        }
        if progress.phase == "migrating" {
            state.insert("completed".into(), json!(progress.completed));
            state.insert("total".into(), json!(progress.total));
        }
        if let Some(id) = progress.migration_id {
            state.insert("migrationId".into(), json!(id));
        }
        if let ("failed", Some(code)) = (progress.phase, progress.error_code) {
            state.insert("errorCode".into(), json!(code));
            if let Some(sqlite) = progress.sqlite_code {
                state.insert("sqliteCode".into(), json!(sqlite));
            }
        }
        self.send(state);
    }

    /// 失败帧：`phase: "failed"` 加分类码与细节（迁移点、SQLite 主结果码）。
    fn send_failure(&self, code: &str, error: &StartupError) -> bool {
        let mut state = Map::new();
        state.insert("phase".into(), json!("failed"));
        state.insert("elapsedMs".into(), json!(0));
        state.insert("errorCode".into(), json!(code));
        if let Some(sqlite) = error.sqlite_code {
            state.insert("sqliteCode".into(), json!(sqlite));
        }
        if let Some(id) = error.migration_id {
            state.insert("migrationId".into(), json!(id));
        }
        self.send(state)
    }
}

/// `startup/storageState` 与握手帧都走这一条写路径；失败即视为传输断开。
fn write_line(frame: &Value) -> bool {
    let mut out = std::io::stdout().lock();
    let Ok(mut text) = serde_json::to_string(frame) else {
        return false;
    };
    text.push('\n');
    out.write_all(text.as_bytes())
        .and_then(|()| out.flush())
        .is_ok()
}

fn run(startup: crate::Startup) -> anyhow::Result<()> {
    let clock = Arc::new(SystemClock::new(startup.zone.clone()));
    let ids = Arc::new(NodeIds::new(clock));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let paths = setup::storage_paths(&startup, &StorageSettings::default());
    // Node `createConfig({env})`：库的位置只来自用户级配置与环境变量（没有项目层）。
    let layer = runtime.block_on(config::user_storage_layer(&paths, &startup.env));
    let settings = StorageSettings {
        session_db_path: layer.session_db_path.as_deref(),
        storage_dir: layer.dir.as_deref(),
    };
    let paths = setup::storage_paths(&startup, &settings);
    let db_path = paths.database().as_path().to_path_buf();
    // 路径通知先于打开（Host 的观测边界在写库之前，Node 同序）。
    if !write_line(&json!({
        "method": "startup/storagePath",
        "params": { "path": db_path.display().to_string() },
    })) {
        anyhow::bail!("storage preparation transport closed");
    }
    let reuse = match acknowledge() {
        Ok(reuse) => reuse,
        // 确认失败只报一份（Node 的 openProtocolStartupStorage 还没开始，catch 直接落在这里）。
        Err(error) => {
            let fresh = States::new(
                ids.uuid(),
                rust_cli_node_store::session_database_id(&db_path),
                ids.now_ms(),
                ids.clone(),
            );
            let synthetic = StartupError::for_frame(error.code, error.message);
            fresh.send_failure(error.code, &synthetic);
            anyhow::bail!("storage preparation failed: {synthetic}");
        }
    };
    // reuse 只由同一次 Host 准备的成功路径授予：不打开连接，但 storagePrepared 照发（Node 同）。
    let database = rust_cli_node_store::session_database_id(&db_path);
    let started = ids.now_ms();
    let result = if reuse {
        Ok(())
    } else {
        let states = States::new(ids.uuid(), database.clone(), started, ids.clone());
        prepare(&runtime, &states, ids.clone(), &db_path)
    };
    match result {
        Ok(()) => {
            if !write_line(&json!({ "method": "startup/storagePrepared", "params": {} })) {
                anyhow::bail!("storage preparation transport closed");
            }
            Ok(())
        }
        Err((error, _reported)) => {
            // 打开层（迁移失败的 failed）与 prepare()（建目录的 failed）已经报过本尝试的一份；
            // 这里再报 Node `prepareProtocolStartupStorage` catch 的那份（全新 attemptId）。
            let fresh = States::new(ids.uuid(), database, started, ids.clone());
            fresh.send_failure(frame_code(error.code), &error);
            Err(anyhow::anyhow!("storage preparation failed: {error}"))
        }
    }
}

/// 不在 Node 枚举里的码按 `sql_failed` 报（帧的 schema 拒绝其他值）。
fn frame_code(code: &str) -> &str {
    if ERROR_CODES.contains(&code) {
        code
    } else {
        "sql_failed"
    }
}

/// 建父目录（Node `openStartup` 的 mkdir 在迁移之前；失败 `open_failed`）并阻塞打开库。
/// 返回是否已经由打开层报过 failed（迁移阶段的失败由 node-store 报）。
fn prepare(
    runtime: &tokio::runtime::Runtime,
    states: &States,
    ids: Arc<NodeIds>,
    db_path: &std::path::Path,
) -> Result<(), (StartupError, bool)> {
    // Node `openProtocolStartupStorage` 的第一帧（打开尝试自己的 checking，elapsedMs 0）。
    states.send_progress(&OpenProgress {
        phase: "checking",
        facts: None,
        migration_id: None,
        completed: 0,
        total: 0,
        error_code: None,
        sqlite_code: None,
    });
    let directory = db_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    let created = match directory {
        Some(directory) => runtime.block_on(rust_cli_fs::create_dir_all(directory)),
        None => Ok(()),
    };
    if let Err(error) = created {
        // Node 的 openProtocolStartupStorage catch：本尝试的 attemptId 报一份（调用方再报全新的）。
        let failure = StartupError::for_frame(
            "open_failed",
            format!(
                "Failed to open SQLite session database at {}: {error}",
                db_path.display()
            ),
        );
        states.send_failure("open_failed", &failure);
        return Err((failure, false));
    }
    let writer = states;
    let report = move |progress: &OpenProgress| writer.send_progress(progress);
    match rust_cli_node_store::open_with_progress(
        db_path,
        rust_cli_node_store::MIGRATION_LOCK_WAIT,
        ids.now_ms(),
        &report,
    ) {
        Ok((connection, _facts)) => {
            // Node：准备完即关连接（prepare 模式不持库）。
            drop(connection);
            Ok(())
        }
        // 打开层已经报过 failed（同 attemptId）。
        Err(error) => Err((error, true)),
    }
}

/// 等一帧 `startup/storagePathReady`（Node：30 秒、1024 字节、strict schema）。
fn acknowledge() -> Result<bool, AckError> {
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        // EOF（Host 关掉输入）与读失败都是传输断开；只有真正读到一行才走确认帧的解析。
        let read = match std::io::stdin().lock().read_line(&mut line) {
            Ok(0) => Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "storage preparation input closed",
            )),
            other => other.map(|_| line),
        };
        let _ = sender.send(read);
    });
    let line = match receiver.recv_timeout(ACK_TIMEOUT) {
        Ok(Ok(line)) => line,
        Ok(Err(error)) => {
            return Err(AckError {
                code: "transport_closed",
                message: format!("storage acknowledgement read failed: {error}"),
            });
        }
        Err(_) => {
            return Err(AckError {
                code: "startup_status_timeout",
                message: "Storage observation handshake timed out".to_owned(),
            });
        }
    };
    let invalid = || AckError {
        code: "sql_failed",
        message: "Invalid storage acknowledgement".to_owned(),
    };
    if line.len() > ACK_MAX_LINE {
        return Err(invalid());
    }
    let Ok(value) = serde_json::from_str::<Value>(&line) else {
        return Err(invalid());
    };
    // strict：method 必须对，除 method/reuse 外不能有别的键，reuse 必须是布尔或缺席。
    if value.get("method").and_then(Value::as_str) != Some("startup/storagePathReady") {
        return Err(invalid());
    }
    let object = value.as_object().ok_or_else(invalid)?;
    if object.keys().any(|key| key != "method" && key != "reuse") {
        return Err(invalid());
    }
    match object.get("reuse") {
        None => Ok(false),
        Some(Value::Bool(reuse)) => Ok(*reuse),
        Some(_) => Err(invalid()),
    }
}

/// 确认帧的失败：分类码就是帧里的 errorCode（都在 Node 的枚举里）。
struct AckError {
    code: &'static str,
    message: String,
}
