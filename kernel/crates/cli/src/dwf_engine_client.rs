//! DWF 引擎 sidecar 的客户端（路线 C）：起 Node CLI 的 `__nibi-dwf-engine`，说 LF-JSON。
//!
//! 分工：引擎、沙箱与 journal 在 sidecar；模型、工具、权限在这里。driver 的每个方法都是一条
//! 回到本进程的 RPC，本模块把它转成 [`Kernel::run_workflow_actor`] 与文件端口的调用。
//!
//! 线协议见 `docs/rust-kernel-dwf-design-2026-10-30.md` §3.2 与
//! `apps/zcode-cli/packages/cli/src/dwf-engine-command.ts` 的文件头。两条不变式：
//!
//! 1. 读线程是唯一的读者；写都经 stdin 的异步锁。`submit` 只等**受理**，结算走 `run/settled`。
//! 2. typed ask 的 repair/nudge 循环在这一侧：`run_workflow_actor` 跑一轮 → 把 `submit_result`
//!    交给引擎 → 等 `ask/verdict` → reject 时把 violations 作为下一条消息再跑一轮。

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use rust_cli_base::Spawner;
use rust_cli_kernel_api::clock::Ids;
use rust_cli_kernel_api::env::{EnvPath, ReadFile, WorkspaceRef};
use rust_cli_kernel_api::env_files::{GlobFiles, GrepMode, GrepOutcome, GrepSearch};
use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::machine::MachineEnv;
use rust_cli_kernel_api::session_api::Kernel;
use rust_cli_kernel_api::workflow::{
    WorkflowAmend, WorkflowEngine, WorkflowEngineError, WorkflowRunStarted, WorkflowStart,
};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

/// 启动命令（`NIBI_DWF_ENGINE_CMD` 的 JSON）：桌面是 Electron Helper + `nibi.cjs`，
/// 开发是 `node` / `tsx` + 源码入口。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarCommand {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl SidecarCommand {
    /// `{"command": "...", "args": [...], "env": {"ELECTRON_RUN_AS_NODE": "1"}}`。
    pub fn parse(text: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
        let command = value["command"]
            .as_str()
            .filter(|command| !command.trim().is_empty())
            .ok_or("NIBI_DWF_ENGINE_CMD needs a non-empty `command`")?
            .to_owned();
        let args = value["args"]
            .as_array()
            .map(|args| {
                args.iter()
                    .filter_map(|arg| arg.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let env = value["env"]
            .as_object()
            .map(|env| {
                env.iter()
                    .filter_map(|(key, value)| {
                        Some((key.clone(), value.as_str()?.to_owned()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self { command, args, env })
    }
}

/// 一条在飞请求的 id 与等待者。
struct Process {
    child: tokio::process::Child,
    /// 写线程排队的行（stdin 归写线程独占；调用方不持锁过 await）。
    lines: tokio::sync::mpsc::UnboundedSender<String>,
    pending: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    next: AtomicU64,
}

impl Drop for Process {
    fn drop(&mut self) {
        // 客户端随内核释放时回收 sidecar（它只是这个会话的引擎）。
        let _ = self.child.start_kill();
    }
}

impl Process {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = format!("r{}", self.next.fetch_add(1, Ordering::Relaxed) + 1);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id.clone(), tx);
        let line = json!({"id": id, "method": method, "params": params}).to_string();
        self.lines
            .send(format!("{line}
"))
            .map_err(|_| "the sidecar closed its stdin".to_owned())?;
        rx.await
            .map_err(|_| "the sidecar closed the request".to_owned())
    }

    fn notify(&self, method: &str, params: Value) {
        let line = json!({"method": method, "params": params}).to_string();
        let _ = self.lines.send(format!("{line}
"));
    }

    fn respond(&self, id: &Value, result: Value) {
        let line = json!({"id": id, "result": result}).to_string();
        let _ = self.lines.send(format!("{line}
"));
    }
}

/// actor 子会话的固定属性（`actor/create` 的 persona 落到这里）。
#[derive(Clone)]
struct ActorHandle {
    child: SessionId,
    prompt: String,
    label: String,
    /// persona 的有效名（`agent("poet")` 的 `"poet"`）；匿名 actor 缺席。
    name: Option<String>,
    /// run 级的子代理选型（`amendWorkflowSettings` 的 `subagentModel` / `run-launched`）；
    /// 缺席 = 内核默认（父会话的默认选型）。
    selection: Option<rust_cli_kernel_api::model::ModelSelection>,
}

/// 一次 run 的宿主侧状态。
struct RunState {
    parent: SessionId,
    cwd: String,
    actors: Mutex<HashMap<String, ActorHandle>>,
    verdicts: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    cancels: Mutex<HashMap<String, CancellationToken>>,
}

impl RunState {
    fn new(parent: SessionId, cwd: String) -> Self {
        Self {
            parent,
            cwd,
            actors: Mutex::new(HashMap::new()),
            verdicts: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
        }
    }
}

struct EngineShared {
    command: SidecarCommand,
    spawner: Spawner,
    ids: Arc<dyn Ids>,
    machine: MachineEnv,
    database: PathBuf,
    kernel: Mutex<Option<Weak<dyn Kernel>>>,
    process: Mutex<Option<Arc<Process>>>,
    runs: Mutex<HashMap<String, Arc<RunState>>>,
}

/// sidecar 引擎（`WorkflowEngine` 的实现）。
pub struct SidecarEngine {
    shared: Arc<EngineShared>,
}

impl SidecarEngine {
    pub fn new(
        command: SidecarCommand,
        spawner: Spawner,
        ids: Arc<dyn Ids>,
        machine: MachineEnv,
        database: PathBuf,
    ) -> Self {
        Self {
            shared: Arc::new(EngineShared {
                command,
                spawner,
                ids,
                machine,
                database,
                kernel: Mutex::new(None),
                process: Mutex::new(None),
                runs: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// 内核建好之后接上（actor 轮与快照都经它）。
    pub fn attach_kernel(&self, kernel: Arc<dyn Kernel>) {
        *self
            .shared
            .kernel
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(Arc::downgrade(&kernel));
    }

    fn kernel(&self) -> Result<Arc<dyn Kernel>, WorkflowEngineError> {
        self.shared
            .kernel
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .and_then(Weak::upgrade)
            .ok_or_else(|| {
                WorkflowEngineError::with_message("start_failed", "the kernel is not attached")
            })
    }

    /// 起（或复用）sidecar 进程；读线程在第一次用到时启动。
    fn ensure_process(&self) -> Result<Arc<Process>, String> {
        let mut slot = self
            .shared
            .process
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(process) = slot.as_ref() {
            return Ok(process.clone());
        }
        let mut command = rust_cli_proc::command(&self.shared.command.command);
        command.args(&self.shared.command.args);
        command.envs(self.shared.command.env.iter().map(|(k, v)| (k, v)));
        command.stdin(Stdio::piped());
        command.stdout(Stdio::piped());
        command.stderr(Stdio::inherit());
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdin = child.stdin.take().ok_or("the sidecar has no stdin")?;
        let stdout = child.stdout.take().ok_or("the sidecar has no stdout")?;
        let (lines, mut outgoing) = tokio::sync::mpsc::unbounded_channel::<String>();
        let process = Arc::new(Process {
            child,
            lines,
            pending: Mutex::new(HashMap::new()),
            next: AtomicU64::new(0),
        });
        self.shared.spawner.spawn("dwf-engine-writer", async move {
            let mut stdin = stdin;
            while let Some(line) = outgoing.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.flush().await.is_err() {
                    break;
                }
            }
        });
        let shared = self.shared.clone();
        let reader = process.clone();
        self.shared.spawner.spawn("dwf-engine-reader", async move {
            read_loop(shared, reader, stdout).await;
        });
        *slot = Some(process.clone());
        Ok(process)
    }

    /// 把一次 run 的元数据登记下来（`submit` 之前）。
    fn register_run(&self, run_id: &str, state: RunState) {
        self.shared
            .runs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(run_id.to_owned(), Arc::new(state));
    }

    /// 世界读取：`glob` / `read` / `grep`（其余 op 明确拒绝，脚本可 catch）。
    async fn world_read(&self, run: &RunState, op: &str, args: &[Value]) -> Result<Value, String> {
        let workspace = WorkspaceRef {
            environment: rust_cli_kernel_api::ids::EnvironmentId::new(
                rust_cli_kernel_api::env_registry::LOCAL_MACHINE,
            ),
            root: EnvPath::new(run.cwd.clone()),
        };
        let text = |index: usize| args.get(index).and_then(Value::as_str).map(str::to_owned);
        match op {
            "glob" => {
                let pattern = text(0).ok_or("glob needs a pattern")?;
                let list = self
                    .shared
                    .machine
                    .search()
                    .glob(
                        &workspace,
                        GlobFiles {
                            root: EnvPath::new(run.cwd.clone()),
                            pattern,
                            limit: 2_001,
                            hidden: false,
                            respect_ignore: true,
                        },
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                let mut files = list.files;
                if files.len() > 2_000 {
                    return Err("files.glob: over 2000 files match (the cap)".to_owned());
                }
                files.sort_by(|a, b| a.as_str().cmp(b.as_str()));
                Ok(json!(files))
            }
            "read" => {
                let path = text(0).ok_or("read needs a path")?;
                let file = self
                    .shared
                    .machine
                    .files()
                    .read_file(&workspace, ReadFile {
                        path: EnvPath::new(resolve_path(&run.cwd, &path)),
                    })
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(Value::String(
                    String::from_utf8_lossy(&file.bytes).into_owned(),
                ))
            }
            "grep" => {
                let pattern = text(0).ok_or("grep needs a pattern")?;
                let glob = text(1);
                let found = self
                    .shared
                    .machine
                    .search()
                    .grep(
                        &workspace,
                        GrepSearch {
                            root: EnvPath::new(run.cwd.clone()),
                            pattern,
                            case_insensitive: false,
                            multiline: false,
                            globs: glob.into_iter().collect(),
                            file_type: None,
                            hidden: false,
                            mode: GrepMode::Content { before: 0, after: 0 },
                        },
                    )
                    .await
                    .map_err(|error| error.to_string())?;
                let mut hits = Vec::new();
                let GrepOutcome::Content { files } = found else {
                    return Ok(Value::Array(Vec::new()));
                };
                for file in files {
                    for line in file.lines {
                        if line.kind != rust_cli_kernel_api::env_files::GrepLineKind::Match {
                            continue;
                        }
                        hits.push(json!({
                            "path": relative_path(&run.cwd, file.path.as_str()),
                            "line": line.line_number,
                            "text": line.text,
                        }));
                        if hits.len() > 2_000 {
                            return Err("files.grep: over 2000 matches (the cap)".to_owned());
                        }
                    }
                }
                Ok(Value::Array(hits))
            }
            other => Err(format!("world read `{other}` is not supported by the Rust host yet")),
        }
    }
}

fn resolve_path(cwd: &str, path: &str) -> String {
    let absolute = std::path::Path::new(path).is_absolute()
        || (path.len() > 2 && path.as_bytes()[1] == b':');
    if absolute {
        path.to_owned()
    } else {
        format!("{}/{}", cwd.trim_end_matches(['/', '\\']), path.replace('\\', "/"))
    }
}

fn relative_path(cwd: &str, path: &str) -> String {
    let prefix = format!("{}/", cwd.trim_end_matches(['/', '\\']));
    path.strip_prefix(&prefix).unwrap_or(path).to_owned()
}

/// 读线程：响应按 id 交回等待者；请求/通知在这里分派。
async fn read_loop<R>(shared: Arc<EngineShared>, process: Arc<Process>, stdout: R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = message.get("id").cloned();
        let method = message["method"].as_str().map(str::to_owned);
        if let (Some(id), None) = (id.clone(), method.as_deref()) {
            // 响应（id + 无 method）。
            let key = id.as_str().unwrap_or_default().to_owned();
            let waiter = process
                .pending
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&key);
            if let Some(waiter) = waiter {
                let _ = waiter.send(message["result"].clone());
            }
            continue;
        }
        let Some(method) = method else { continue };
        match method.as_str() {
            "actor/create" => {
                let params = &message["params"];
                tracing::info!(
                    event = "dwf.actor.create",
                    run = params["runId"].as_str().unwrap_or_default(),
                    site = params["actor"]["siteId"].as_str().unwrap_or_default(),
                );
                let run_id = params["runId"].as_str().unwrap_or_default();
                let Some(run) = shared
                    .runs
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(run_id)
                    .cloned()
                else {
                    if let Some(id) = &id {
                        process.respond(id, json!({"error": format!("unknown run {run_id}")}));
                    }
                    continue;
                };
                let site = params["actor"]["siteId"].as_str().unwrap_or("actor").to_owned();
                let persona = &params["persona"];
                let prompt = persona["system"].as_str().unwrap_or_default().to_owned();
                let name = persona["name"]
                    .as_str()
                    .filter(|name| !name.is_empty())
                    .map(str::to_owned);
                let label = name.clone().unwrap_or_else(|| site.clone());
                // 本 run 的子代理选型（规范串在 sidecar 侧已解析成结构化选择）。
                let selection = serde_json::from_value::<
                    rust_cli_kernel_api::model::ModelSelection,
                >(params["model"].clone())
                .ok();
                let child = SessionId::new(format!(
                    "sess_dwf_{}",
                    shared.ids.uuid().replace(['-', ':'], "")
                ));
                run.actors
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(site.clone(), ActorHandle {
                        child: child.clone(),
                        prompt,
                        label,
                        name,
                        selection,
                    });
                tracing::debug!(event = "dwf.actor.stored", site = %site);
                if let Some(id) = &id {
                    process.respond(id, json!({"session": child.as_str()}));

                }
            }
            "world/read" => {
                let params = &message["params"];
                let run_id = params["runId"].as_str().unwrap_or_default().to_owned();
                let op = params["op"].as_str().unwrap_or_default().to_owned();
                let args = params["args"].as_array().cloned().unwrap_or_default();
                let run = {
                    let runs = shared
                        .runs
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner);
                    runs.get(&run_id).cloned()
                };
                let result = match run {
                    Some(run) => {
                        let engine = SidecarEngine {
                            shared: shared.clone(),
                        };
                        engine.world_read(&run, &op, &args).await
                    }
                    None => Err(format!("unknown run {run_id}")),
                };
                if let Some(id) = &id {
                    match result {
                        Ok(value) => process.respond(id, value),
                        Err(error) => {
                            process.respond(id, json!({"error": error}));
                        }
                    }
                }
            }
            "ask/start" => {
                let params = message["params"].clone();
                let spawner = shared.spawner.clone();
                let shared = shared.clone();
                let process = process.clone();
                spawner.spawn("dwf-engine-ask", async move {
                    run_ask(shared, process, params).await;
                });
            }
            "ask/verdict" => {
                let params = &message["params"];
                let run_id = params["runId"].as_str().unwrap_or_default();
                let key = params["key"].as_str().unwrap_or_default();
                if let Some(run) = shared
                    .runs
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(run_id)
                    .cloned()
                {
                    let waiter = run
                        .verdicts
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .remove(key);
                    if let Some(waiter) = waiter {
                        let _ = waiter.send(params["verdict"].clone());
                    }
                }
            }
            "ask/cancel" => {
                let params = &message["params"];
                let run_id = params["runId"].as_str().unwrap_or_default();
                let key = params["key"].as_str().unwrap_or_default();
                if let Some(run) = shared
                    .runs
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(run_id)
                    .cloned()
                {
                    if let Some(cancel) = run
                        .cancels
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .get(key)
                    {
                        cancel.cancel();
                    }
                    // 唤醒等 verdict 的循环（repair 被取消）。
                    let waiter = run
                        .verdicts
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .remove(key);
                    if let Some(waiter) = waiter {
                        let _ = waiter.send(json!({"kind": "cancelled"}));
                    }
                }
            }
            "run/event" => {
                tracing::debug!(event = "dwf.run.event", payload = %message["params"]);
            }
            "run/settled" => {
                let params = &message["params"];
                let run_id = params["runId"].as_str().unwrap_or_default();
                tracing::info!(
                    event = "dwf.run.settled",
                    run = run_id,
                    settlement = %params["settlement"]
                );
                shared
                    .runs
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(run_id);
            }
            other => {
                tracing::warn!(method = other, "unknown sidecar method");
            }
        }
    }
    // 进程结束：清掉进程槽，下一次调用重新起。
    if let Ok(mut slot) = shared.process.lock() {
        *slot = None;
    }
}

/// 一次 ask 的循环：跑 actor 轮 → 交提交/文本给引擎 → 按裁决 repair/nudge。
async fn run_ask(shared: Arc<EngineShared>, process: Arc<Process>, params: Value) {
    let run_id = params["runId"].as_str().unwrap_or_default().to_owned();
    tracing::info!(
        event = "dwf.ask.start",
        run = %run_id,
        key = params["key"].as_str().unwrap_or_default(),
        typed = params["typed"].as_bool().unwrap_or(false),
    );
    let key = params["key"].as_str().unwrap_or_default().to_owned();
    let site = params["instance"]["siteId"].as_str().unwrap_or_default().to_owned();
    // ask 指向的是**actor 会话**（`actor/create` 回来的 id），不是 actor 站点；按会话找。
    let session_id = params["session"]["id"].as_str().unwrap_or_default().to_owned();
    let typed = params["typed"].as_bool().unwrap_or(false);
    let instructions = params["instructions"].as_str().unwrap_or_default().to_owned();
    let schema = params["schema"].clone();
    let Some(run) = shared
        .runs
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&run_id)
        .cloned()
    else {
        return;
    };
    tracing::debug!(event = "dwf.ask.run", run = %run_id);
    let Some(actor) = run
        .actors
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .values()
        .find(|actor| actor.child.as_str() == session_id)
        .cloned()
    else {
        tracing::warn!(event = "dwf.ask.actor_missing", run = %run_id, session = %session_id);
        process.notify("ask/reply", json!({
                "runId": run_id,
                "instance": params["instance"],
                "kind": "fail",
                "payload": {"code": "ActorMissing", "message": format!("actor {site} was never created")},
            }));
        return;
    };
    let kernel = {
        let slot = shared
            .kernel
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match slot.as_ref().and_then(Weak::upgrade) {
            Some(kernel) => kernel,
            None => {
                tracing::warn!(event = "dwf.ask.no_kernel", run = %run_id);
                return;
            }
        }
    };
    tracing::debug!(event = "dwf.ask.kernel", run = %run_id);
    let cancel = CancellationToken::new();
    run.cancels
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(key.clone(), cancel.clone());
    let mut message = instructions;
    let mut first = true;
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let request = rust_cli_kernel_api::workflow::WorkflowActorRequest {
            actor: rust_cli_kernel_api::workflow::WorkflowActorSpec {
                parent: run.parent.as_str().to_owned(),
                child: actor.child.as_str().to_owned(),
                workspace: Some(run.cwd.clone()),
                prompt: actor.prompt.clone(),
                label: actor.label.clone(),
                selection: actor.selection.clone(),
                mode: None,
                allow: None,
                deny: Vec::new(),
                max_turns: None,
                submit_schema: if typed { Some(schema.clone()) } else { None },
                run_id: run_id.clone(),
                actor: format!("{site}@{}", params["instance"]["ordinal"].as_u64().unwrap_or(1)),
                actor_name: actor.name.clone(),
                // ask 实例键与 sidecar 的 `key` 同一个（`site@ordinal`）：升级预算按它计。
                ask: key.clone(),
            },
            message: message.clone(),
            first,
        };
        let outcome = kernel
            .run_workflow_actor(request, Some(cancel.clone()))
            .await;
        let turn = match outcome {
            Ok(turn) => turn,
            Err(error) => {
                process.notify("ask/reply", json!({
                        "runId": run_id,
                        "instance": params["instance"],
                        "kind": "fail",
                        "payload": {"code": "ActorFailed", "message": error.to_string()},
                    }));
                break;
            }
        };
        tracing::info!(
            event = "dwf.ask.turn",
            run = %run_id,
            stopped = %turn.stopped,
            submitted = turn.submitted.is_some(),
            text_len = turn.text.len(),
        );
        // 回合本身失败（模型/工具链出错）：与 Node 的 `onTurnRejected` 同义，ask 失败而不是把错误
        // 文本当成答案交回去。
        if turn.stopped == "failed" {
            process.notify("ask/reply", json!({
                    "runId": run_id,
                    "instance": params["instance"],
                    "kind": "fail",
                    "payload": {
                        "code": "ActorFailed",
                        "message": turn.error.clone().unwrap_or_else(|| "the actor turn failed".to_owned()),
                    },
                }));
            break;
        }
        if typed && turn.submitted.is_some() {
            let (tx, rx) = oneshot::channel();
            run.verdicts
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(key.clone(), tx);
            process.notify("ask/reply", json!({
                    "runId": run_id,
                    "instance": params["instance"],
                    "kind": "submit",
                    "payload": turn.submitted,
                }));
            let verdict = match rx.await {
                Ok(verdict) => verdict,
                Err(_) => break,
            };
            match verdict["kind"].as_str() {
                Some("accept") => break,
                Some("reject") => {
                    message = format!(
                        "Your submission was rejected: {}. Submit a corrected result.",
                        verdict["violations"]
                    );
                    first = false;
                    continue;
                }
                Some("nudge") => {
                    message = "Continue the task and submit the result with submit_result.".to_owned();
                    first = false;
                    continue;
                }
                // 取消 / 未知裁决：收口。
                _ => break,
            }
        }
        process.notify("ask/reply", json!({
                "runId": run_id,
                "instance": params["instance"],
                "kind": "text",
                "text": turn.text,
            }));
        break;
    }
    run.cancels
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&key);
}

#[async_trait::async_trait]
impl WorkflowEngine for SidecarEngine {
    async fn start_saved(
        &self,
        parent: &SessionId,
        request: WorkflowStart,
    ) -> Result<WorkflowRunStarted, WorkflowEngineError> {
        let kernel = self.kernel()?;
        let view = kernel.session_snapshot(parent).await.map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error.to_string())
        })?;
        let cwd = view.meta.workspace.root.as_str().to_owned();
        let run_id = format!("dwfrun-{}", self.shared.ids.uuid());
        let tool_call_id = format!("call-{}", self.shared.ids.uuid());
        self.register_run(&run_id, RunState::new(parent.clone(), cwd.clone()));
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        let mut params = json!({
            "runId": run_id,
            "parentSessionId": parent.as_str(),
            "cwd": cwd,
            "dbPath": self.shared.database.display().to_string(),
            "savedName": request.name,
        });
        if let Some(scope) = request.scope {
            params["scope"] = json!(scope);
        }
        if let Some(args) = request.args {
            params["args"] = args;
        }
        let reply = process.request("submit", params).await
            .map_err(|error| WorkflowEngineError::with_message("start_failed", error))?;
        if reply["ok"].as_bool() != Some(true) {
            self.shared
                .runs
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .remove(&run_id);
            return Err(WorkflowEngineError::with_message(
                reply["reason"].as_str().unwrap_or("start_failed"),
                reply["message"].as_str().unwrap_or("the workflow could not start"),
            ));
        }
        Ok(WorkflowRunStarted {
            run_id,
            tool_call_id,
            superseded_run_id: None,
        })
    }

    async fn resume(
        &self,
        run_id: &str,
        _name: Option<&str>,
    ) -> Result<WorkflowRunStarted, WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        let reply = process
            .request(
                "resume",
                json!({
                    "runId": run_id,
                    "dbPath": self.shared.database.display().to_string(),
                }),
            )
            .await
            .map_err(|error| WorkflowEngineError::with_message("start_failed", error))?;
        if reply["ok"].as_bool() != Some(true) {
            return Err(WorkflowEngineError::with_message(
                reply["reason"].as_str().unwrap_or("start_failed"),
                reply["message"].as_str().unwrap_or("the workflow could not resume"),
            ));
        }
        // 引擎把 run 的父会话与 cwd 从 journal 读回来；恢复的 run 重新登记，供 actor RPC 使用。
        let parent = reply["parentSessionId"].as_str().unwrap_or_default();
        let cwd = reply["cwd"].as_str().unwrap_or_default();
        self.register_run(run_id, RunState::new(SessionId::new(parent), cwd.to_owned()));
        Ok(WorkflowRunStarted {
            run_id: run_id.to_owned(),
            tool_call_id: format!("resume-{}", self.shared.ids.uuid()),
            superseded_run_id: None,
        })
    }

    async fn amend(&self, request: WorkflowAmend) -> Result<WorkflowRunStarted, WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        let run_id = format!("dwfrun-{}", self.shared.ids.uuid());
        let tool_call_id = format!("settings-{}", self.shared.ids.uuid());
        let mut params = json!({
            "predecessorRunId": request.run_id,
            "runId": run_id,
            "toolCallId": tool_call_id,
            "dbPath": self.shared.database.display().to_string(),
        });
        // 三态原样递过去：缺席 = 沿用，`null` = 回到默认，值 = 设定（归一在 sidecar，与宿主同表）。
        if let Some(model) = request.subagent_model {
            params["subagentModel"] = json!(model);
        }
        if let Some(bound) = request.max_concurrency {
            params["maxConcurrency"] = json!(bound);
        }
        let reply = process
            .request("amend", params)
            .await
            .map_err(|error| WorkflowEngineError::with_message("start_failed", error))?;
        if reply["ok"].as_bool() != Some(true) {
            return Err(WorkflowEngineError::with_message(
                reply["reason"].as_str().unwrap_or("start_failed"),
                reply["message"].as_str().unwrap_or("the workflow run could not be amended"),
            ));
        }
        let started_run = reply["runId"].as_str().unwrap_or_default().to_owned();
        if started_run != request.run_id {
            // 后继 run：登记它的父会话与 cwd，供 actor RPC 使用。就地调并发（同一个 runId）不用重登记。
            let parent = reply["parentSessionId"].as_str().unwrap_or_default();
            let cwd = reply["cwd"].as_str().unwrap_or_default();
            self.register_run(
                &started_run,
                RunState::new(SessionId::new(parent), cwd.to_owned()),
            );
        }
        Ok(WorkflowRunStarted {
            run_id: started_run,
            tool_call_id,
            superseded_run_id: reply["supersededRunId"].as_str().map(str::to_owned),
        })
    }

    async fn cancel(&self, run_id: &str) -> Result<(), WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        process.notify("cancel", json!({"runId": run_id}));
        Ok(())
    }
}

/// 让读线程在测试里能构造一个 `SidecarEngine` 的共享状态；生产代码不用。
#[cfg(test)]
#[path = "dwf_engine_client_tests.rs"]
mod tests;
