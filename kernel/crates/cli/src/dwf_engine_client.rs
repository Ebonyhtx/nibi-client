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
    /// amend-resume 的转录种子（消费过导入的 actor 才带；建会话时兑现）。
    seed: Option<rust_cli_kernel_api::workflow::WorkflowActorSeed>,
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
    /// 宿主铸的锚点（中枢启动 `launch-`、修订 `settings-`）：终态通知的 `<tool-use-id>`。
    /// resume 不铸新锚点——通知用 journal 行上的原值（sidecar 的 notice 事实带来）。
    tool_call_id: Option<String>,
    actors: Mutex<HashMap<String, ActorHandle>>,
    verdicts: Mutex<HashMap<String, oneshot::Sender<Value>>>,
    cancels: Mutex<HashMap<String, CancellationToken>>,
}

impl RunState {
    fn new(parent: SessionId, cwd: String, tool_call_id: Option<String>) -> Self {
        Self {
            parent,
            cwd,
            tool_call_id,
            actors: Mutex::new(HashMap::new()),
            verdicts: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
        }
    }
}

/// 一个模型引用的解析结果：规范串 `providerId/modelId[$level]`，或失败原因（候选清单在
/// `message` 里）。语义与 Node `resolveModelReference` 同规（docs/dynamic-workflow/launch.md
/// 「`subagent_model` resolves by specificity」）：
///
///   1. `providerId/modelId` 全称精确命中；
///   2. 裸 `modelId` 在目录默认选择的 provider 下有 → 取它，别的 provider 也有同名无所谓；
///   3. 裸 `modelId` 只在别的 provider 下有 → 拒绝（不替用户跨账单）。
///
/// 全部比较大小写不敏感。目录里没有默认选择时没有边界可守：裸名唯一就取、多个即歧义。
/// `$level` 在场必须是该模型的合法档位（用注册表自己的拼写）；缺席时取目录默认档（档位表的
/// 最后一个，Node `model-catalog-port` 的同一读法），模型没有档位就不带。Rust 目录只列可用的
/// 模型，Node 的 `disabled` 档在这里落成 `not_found`。
pub(crate) fn resolve_model_reference(
    catalog: &rust_cli_kernel_api::provider::ModelCatalog,
    text: &str,
) -> Result<String, String> {
    let trimmed = text.trim();
    let (reference, level) = match trimmed.split_once('$') {
        Some((reference, level)) => (reference, Some(level)),
        None => (trimmed, None),
    };
    let qualified = reference.split_once('/');
    let mut matches: Vec<&rust_cli_kernel_api::provider::CatalogModel> = catalog
        .models
        .iter()
        .filter(|entry| match qualified {
            Some((provider_ref, model_ref)) => {
                entry.provider.eq_ignore_ascii_case(provider_ref)
                    && entry.model.eq_ignore_ascii_case(model_ref)
            }
            None => entry.model.eq_ignore_ascii_case(reference),
        })
        .collect();
    if matches.is_empty() {
        let ids: Vec<String> = catalog
            .models
            .iter()
            .map(|entry| format!("{}/{}", entry.provider, entry.model))
            .collect();
        return Err(match ids.is_empty() {
            true => "No models are configured on this host.".to_owned(),
            false => format!(
                "No configured model matches `{text}`. Available models: {}.",
                ids.join(", ")
            ),
        });
    }
    // provider 边界（第 2、3 档）：裸名绝不悄悄落到另一个 provider 上。
    let default = catalog.default.as_ref();
    let home: Vec<_> = match (qualified.is_none(), default) {
        (true, Some(default)) => {
            let guarded: Vec<_> = matches
                .iter()
                .copied()
                .filter(|entry| entry.provider.eq_ignore_ascii_case(&default.provider))
                .collect();
            if guarded.is_empty() {
                let ids: Vec<String> = matches
                    .iter()
                    .map(|entry| format!("{}/{}", entry.provider, entry.model))
                    .collect();
                return Err(format!(
                    "The model `{text}` exists only under other providers ({}); pass the fully qualified id to cross that boundary.",
                    ids.join(", ")
                ));
            }
            guarded
        }
        _ => matches.split_off(0),
    };
    let entry = match home.as_slice() {
        [only] => *only,
        many => many
            .iter()
            .copied()
            .find(|entry| {
                default.is_some_and(|default| {
                    entry.provider.eq_ignore_ascii_case(&default.provider)
                        && entry.model.eq_ignore_ascii_case(&default.model)
                })
            })
            .ok_or_else(|| {
                let ids: Vec<String> = many
                    .iter()
                    .map(|entry| format!("{}/{}", entry.provider, entry.model))
                    .collect();
                format!("`{text}` is ambiguous: {}.", ids.join(", "))
            })?,
    };
    // 档位：注册表自己的拼写胜出；缺席取默认档（最后一个），模型没有档位就不带。
    let level = match level {
        Some(level) => Some(
            entry
                .reasoning_levels
                .iter()
                .find(|candidate| candidate.eq_ignore_ascii_case(level))
                .ok_or_else(|| {
                    let levels = entry.reasoning_levels.join(", ");
                    format!(
                        "The model `{}` has no reasoning level `{level}` (it offers: {levels}).",
                        entry.model
                    )
                })?,
        ),
        None => entry.reasoning_levels.last(),
    };
    Ok(match level {
        Some(level) => format!("{}/{}${}", entry.provider, entry.model, level),
        None => format!("{}/{}", entry.provider, entry.model),
    })
}

struct EngineShared {
    command: SidecarCommand,
    spawner: Spawner,
    ids: Arc<dyn Ids>,
    machine: MachineEnv,
    database: PathBuf,
    /// 模型目录（脚本点名模型的解析，launch.md「Models the script names」）：sidecar 报名字，
    /// 这里对着本机目录解成规范串绑定表。
    models: Arc<dyn rust_cli_kernel_api::provider::ModelDirectory>,
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
        models: Arc<dyn rust_cli_kernel_api::provider::ModelDirectory>,
    ) -> Self {
        Self {
            shared: Arc::new(EngineShared {
                command,
                spawner,
                ids,
                machine,
                database,
                models,
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
                let ordinal = params["actor"]["ordinal"].as_i64().unwrap_or(0);
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
                // 种子按 (sourceSessionId, messageCount) 透传——兑现是宿主的事（node-store 的
                // 种子复制，建会话时幂等）。
                let seed = if params["seed"].is_object() {
                    Some(rust_cli_kernel_api::workflow::WorkflowActorSeed {
                        source_session_id: params["seed"]["sourceSessionId"]
                            .as_str()
                            .unwrap_or_default()
                            .to_owned(),
                        message_count: params["seed"]["messageCount"].as_u64().unwrap_or_default(),
                    })
                } else {
                    None
                };
                run.actors
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(site.clone(), ActorHandle {
                        child: child.clone(),
                        prompt,
                        label,
                        name,
                        selection,
                        seed,
                    });
                tracing::debug!(event = "dwf.actor.stored", site = %site);
                // `workflow.lifecycle` 的 `actor-spawned`：子代理会话 ↔ actor ↔ 父会话的归属事实
                // （Node 的 `DynamicWorkflowRunProgress` → 埋点同源）。没有启动输入 id 时
                // `sourceCommandId` 缺席（Node 的 launchInputId 内核拿不到）。
                let kernel = shared
                    .kernel
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .as_ref()
                    .and_then(Weak::upgrade);
                if let Some(kernel) = kernel {
                    let fact = rust_cli_kernel_api::session_api::WorkflowLifecycleFact {
                        run_id: run_id.to_owned(),
                        phase: rust_cli_kernel_api::session_api::WorkflowLifecyclePhase::ActorSpawned,
                        tool_call_id: run.tool_call_id.clone(),
                        agent_id: Some(format!("{site}@{ordinal}")),
                        child_session_id: Some(child.as_str().to_owned()),
                        status: None,
                        stop_reason: None,
                        error_message: None,
                        source_command_id: None,
                    };
                    if !kernel.note_workflow_lifecycle(&run.parent, fact) {
                        tracing::debug!(
                            event = "dwf.lifecycle.no_session",
                            run = run_id,
                            phase = "actor-spawned"
                        );
                    }
                }
                if let Some(id) = &id {
                    process.respond(id, json!({"session": child.as_str()}));

                }
            }
            "models/resolve" => {
                // 脚本点名的模型（launch.md「Models the script names」）：sidecar 报名字（与沿用的
                // 前驱绑定表），这里对着本机目录解成规范串；解不出来的原样退回（sidecar 按
                // compile_failed / model_unavailable 拒绝，旧 run 不动）。
                let params = &message["params"];
                let names: Vec<&str> = params["names"]
                    .as_array()
                    .map(|names| names.iter().filter_map(|name| name.as_str()).collect())
                    .unwrap_or_default();
                let inherited = params["inherited"].clone();
                let models = shared.models.clone();
                let resolved = async {
                    let catalog = models.catalog().await;
                    let mut bindings = serde_json::Map::new();
                    let mut unresolved: Vec<Value> = Vec::new();
                    for name in names {
                        let previous = inherited.get(name).and_then(Value::as_str);
                        let answer = match previous {
                            Some(previous) => resolve_model_reference(&catalog, previous)
                                .map_err(|message| {
                                    format!(
                                        "\"{name}\" keeps the model the amended run bound it to, \
                                         {previous}, which cannot be used now. {message}"
                                    )
                                }),
                            None => resolve_model_reference(&catalog, name).map_err(|message| {
                                format!("The model \"{name}\" named in the script cannot be used: {message}")
                            }),
                        };
                        match answer {
                            Ok(canonical) => {
                                bindings.insert(name.to_owned(), json!(canonical));
                            }
                            Err(message) => unresolved.push(json!({"name": name, "message": message})),
                        }
                    }
                    json!({"bindings": bindings, "unresolved": unresolved})
                }
                .await;
                if let Some(id) = &id {
                    process.respond(id, resolved);
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
                let params = &message["params"];
                // 改变开集的四类事件让该 run 在父会话的提醒钟里重新得到一对（Node
                // noteWorkflowReminderRunEvent 的同一事件词表）：钟板在 runtime，经 kernel 的
                // 端口转发。run 不在进程表里（上一世的）没有父会话可转。
                if matches!(
                    params["type"].as_str(),
                    Some("escalation-raised" | "escalation-resolved" | "hole-reached" | "hole-filled")
                ) && let Some(run) = shared
                    .runs
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(params["runId"].as_str().unwrap_or_default())
                    .cloned()
                {
                    let kernel = shared
                        .kernel
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .as_ref()
                        .and_then(Weak::upgrade);
                    if let Some(blocked) = kernel.as_ref().and_then(|kernel| kernel.workflow_blocked())
                    {
                        blocked.open_set_changed(
                            &run.parent,
                            params["runId"].as_str().unwrap_or_default(),
                        );
                    }
                }
                if params["type"] == "hole-reached" {                    // 留白到达的通知（Node notifyHoleReached 同一条后台任务路）：sidecar 的
                    // run/event 带完整载荷（事件原文 + 编译期事实 + run 展示元数据），宿主组
                    // `<workflow-hole>` 信封与 kind:"hole" 的 manifest 投给父会话。run 还在飞
                    // （停驻在留白上），进程表里有它的父会话。
                    if let Some(run) = shared
                        .runs
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .get(params["runId"].as_str().unwrap_or_default())
                        .cloned()
                        && let Some((text, manifest)) =
                            crate::dwf_run_notification::compose_hole_reached_notice(
                                params["runId"].as_str().unwrap_or_default(),
                                &params["hole"],
                                params["name"].as_str(),
                                params["scriptPath"].as_str(),
                            )
                        {
                            let origin_meta = serde_json::json!({
                                "backgroundSource": "workflow",
                                "title": params["name"]
                                    .as_str()
                                    .unwrap_or(params["runId"].as_str().unwrap_or_default()),
                                "workId": params["runId"],
                                "workflowNotification": manifest,
                            });
                            let kernel = shared
                                .kernel
                                .lock()
                                .unwrap_or_else(PoisonError::into_inner)
                                .as_ref()
                                .and_then(Weak::upgrade);
                            match kernel.as_ref().and_then(|kernel| kernel.workflow_notices()) {
                                Some(notices) => {
                                    notices.notify_with(&run.parent, text, Some(origin_meta))
                                }
                                None => {
                                    tracing::warn!(event = "dwf.hole.no_notices", run = %params["runId"])
                                }
                            }
                        }
                }
                if params["type"] == "run-stalled" {
                    // run 级停滞的 run 中通知（Node notifyRunStalled 同一条后台任务路）：20 分钟
                    // 没有一次成功的模型请求、期间至少排定过一次重试——生产可达（provider 故障），
                    // 文案说死「不需要模型做任何事」。载荷形状不对就跳过并记日志（观察面不抛异常）。
                    if let Some(run) = shared
                        .runs
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .get(params["runId"].as_str().unwrap_or_default())
                        .cloned()
                    {
                        match crate::dwf_run_notification::compose_stall_notice(
                            params["runId"].as_str().unwrap_or_default(),
                            params["name"].as_str(),
                            &params["stall"],
                        ) {
                            Some((text, manifest)) => {
                                let origin_meta = serde_json::json!({
                                    "backgroundSource": "workflow",
                                    "title": params["name"]
                                        .as_str()
                                        .unwrap_or(params["runId"].as_str().unwrap_or_default()),
                                    "workId": params["runId"],
                                    "workflowNotification": manifest,
                                });
                                let kernel = shared
                                    .kernel
                                    .lock()
                                    .unwrap_or_else(PoisonError::into_inner)
                                    .as_ref()
                                    .and_then(Weak::upgrade);
                                match kernel.as_ref().and_then(|kernel| kernel.workflow_notices()) {
                                    Some(notices) => {
                                        notices.notify_with(&run.parent, text, Some(origin_meta))
                                    }
                                    None => {
                                        tracing::warn!(event = "dwf.stall.no_notices", run = %params["runId"])
                                    }
                                }
                            }
                            None => tracing::warn!(
                                event = "dwf.stall.malformed",
                                run = %params["runId"],
                                payload = %params["stall"]
                            ),
                        }
                    }
                }
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
                let run = shared
                    .runs
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .get(run_id)
                    .cloned();
                if let Some(run) = run {
                    // `workflow.lifecycle` 的 `run-settled`：该 run 全部子代理的终态（Node 的
                    // `DynamicWorkflowRunProgress` → 埋点同源）。被修订替代的 run 也有结算事实。
                    let kernel = shared
                        .kernel
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .as_ref()
                        .and_then(Weak::upgrade);
                    if let Some(kernel) = kernel
                        && let Some(status) = params["settlement"]["status"]
                            .as_str()
                            .filter(|status| matches!(*status, "completed" | "errored" | "stopped"))
                    {
                        let stop_reason = (status == "stopped")
                            .then(|| params["settlement"]["reason"].as_str())
                            .flatten()
                            .filter(|reason| !reason.is_empty())
                            .map(str::to_owned);
                        // 错误原文照引擎事件（errored 恒带；stopped 只对 provider / interrupted 带）；
                        // user / model 停下没有原文，用固定文案加原因（Node 同文案）。
                        let engine_message = params["settlement"]["error"]["message"]
                            .as_str()
                            .filter(|message| !message.is_empty())
                            .map(str::to_owned);
                        let error_message = if status == "completed" {
                            None
                        } else {
                            engine_message.or_else(|| {
                                (status == "stopped").then(|| match stop_reason.as_deref() {
                                    Some(reason) => format!("Workflow run stopped ({reason})"),
                                    None => "Workflow run stopped".to_owned(),
                                })
                            })
                        };
                        let fact = rust_cli_kernel_api::session_api::WorkflowLifecycleFact {
                            run_id: run_id.to_owned(),
                            phase:
                                rust_cli_kernel_api::session_api::WorkflowLifecyclePhase::RunSettled,
                            tool_call_id: run.tool_call_id.clone(),
                            agent_id: None,
                            child_session_id: None,
                            status: Some(status.to_owned()),
                            stop_reason,
                            error_message,
                            source_command_id: None,
                        };
                        if !kernel.note_workflow_lifecycle(&run.parent, fact) {
                            tracing::debug!(
                                event = "dwf.lifecycle.no_session",
                                run = run_id,
                                phase = "run-settled"
                            );
                        }
                    }
                    // 被修订替代的 run 不发终态通知（Node coordinator 同一条裁决）：停下它的那次
                    // AmendWorkflow 的工具结果就是模型对这次停止的全部所知，再来一条会把它送进
                    // 「去修订它」的循环。
                    let superseded = params["settlement"]["status"] == "stopped"
                        && params["settlement"]["reason"] == "superseded";
                    // 终态通知进父会话（Node 的后台任务结算通知同一条 `task-notification` 路）：
                    // 锚点宿主铸的用宿主的，resume 沿用 journal 行上的原值，都没有按 Node 的
                    // 兜底合成 `resume-` 前缀。
                    let facts = crate::dwf_run_notification::RunNoticeFacts::parse(&params["notice"]);
                    let tool_use_id = run
                        .tool_call_id
                        .clone()
                        .or_else(|| facts.tool_call_id.clone())
                        .unwrap_or_else(|| format!("resume-{run_id}"));
                    let composed = if superseded {
                        None
                    } else {
                        crate::dwf_run_notification::compose_run_settled_notice(
                            run_id,
                            Some(&tool_use_id),
                            &facts,
                            &params["settlement"],
                        )
                    };
                    if let Some((text, manifest)) = composed {
                        let kernel = shared
                            .kernel
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .as_ref()
                            .and_then(Weak::upgrade);
                        // 结构化 originMeta（Node `buildWorkflowNotificationOriginMeta`
                        // 同形）：base 三键 + 终态 manifest 载荷。title 与 manifest 的 summary
                        // 同源——通知主题（run 行的名字，缺席退回 runId）。
                        let mut origin_meta = serde_json::json!({
                            "backgroundSource": "workflow",
                            "title": facts.name.as_deref().unwrap_or(run_id),
                            "workId": run_id,
                        });
                        origin_meta["workflowNotification"] = manifest;
                        match kernel.as_ref().and_then(|kernel| kernel.workflow_notices()) {
                            Some(notices) => {
                                notices.notify_with(&run.parent, text, Some(origin_meta))
                            }
                            None => {
                                tracing::warn!(event = "dwf.run.settled.no_notices", run = run_id)
                            }
                        }
                    }
                }
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
                seed: actor.seed.clone(),
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
        // messageCount 随文本同车：sidecar 据它补写 ask 节点的 messageBoundary（先数后报——
        // 宿主在交出本轮结果之前已经数好）。
        process.notify("ask/reply", json!({
                "runId": run_id,
                "instance": params["instance"],
                "kind": "text",
                "text": turn.text,
                "messageCount": turn.message_count,
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
        // `launch-` 前缀：中枢启动的合成锚点，与设置轮的 `settings-` 同族（launch.md 的键名）。
        let tool_call_id = format!("launch-{}", self.shared.ids.uuid());
        self.register_run(
            &run_id,
            RunState::new(parent.clone(), cwd.clone(), Some(tool_call_id.clone())),
        );
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        let mut params = json!({
            "runId": run_id,
            "parentSessionId": parent.as_str(),
            "cwd": cwd,
            "dbPath": self.shared.database.display().to_string(),
            "savedName": request.name,
            // 锚点落 dwf_run.tool_call_id（Node 的 run 行同一条写法；GUI 从中枢打开实例详情按它）。
            "toolCallId": tool_call_id,
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
        // 启动轮材料（中枢直接启动）：解析 saved 定义的引擎原样转交，宿主写启动轮。
        let launch_turn = if reply["name"].as_str().is_some() {
            Some(rust_cli_kernel_api::workflow::WorkflowLaunchTurn {
                name: reply["name"].as_str().unwrap_or_default().to_owned(),
                scope: reply["scope"].as_str().unwrap_or_default().to_owned(),
                path: reply["path"].as_str().map(str::to_owned),
                description: reply["description"].as_str().map(str::to_owned),
                args: reply.get("args").filter(|args| !args.is_null()).cloned(),
                script: reply["script"].as_str().map(str::to_owned),
            })
        } else {
            None
        };
        Ok(WorkflowRunStarted {
            run_id,
            tool_call_id,
            superseded_run_id: None,
            settings_turn: None,
            launch_turn,
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
        self.register_run(
            run_id,
            RunState::new(SessionId::new(parent), cwd.to_owned(), None),
        );
        Ok(WorkflowRunStarted {
            run_id: run_id.to_owned(),
            tool_call_id: format!("resume-{}", self.shared.ids.uuid()),
            superseded_run_id: None,
            settings_turn: None,
            launch_turn: None,
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
                RunState::new(SessionId::new(parent), cwd.to_owned(), Some(tool_call_id.clone())),
            );
        }
        // 设置轮材料（引擎算好的「改了什么」）：原样交给协议层写会话记录。`predecessorRunId`
        // 只在铸出后继时在场——缺席即就地生效，渲染端据此只画一行（与 Node 的元数据同一条读法）。
        let successor = started_run != request.run_id;
        let settings_turn = reply["settings"].as_object().map(|settings| {
            let mut amend = serde_json::Map::new();
            if successor {
                amend.insert("predecessorRunId".into(), json!(request.run_id));
            }
            for (key, value) in settings {
                amend.insert(key.clone(), value.clone());
            }
            rust_cli_kernel_api::workflow::WorkflowSettingsTurn {
                name: reply["name"].as_str().map(str::to_owned),
                amend: Value::Object(amend),
            }
        });
        Ok(WorkflowRunStarted {
            run_id: started_run,
            tool_call_id,
            superseded_run_id: reply["supersededRunId"].as_str().map(str::to_owned),
            settings_turn,
            launch_turn: None,
        })
    }

    async fn cancel(&self, run_id: &str) -> Result<(), WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        process.notify("cancel", json!({"runId": run_id}));
        Ok(())
    }

    async fn hub_list_saved_workflows(
        &self,
        workspace_path: &str,
        scope: &str,
    ) -> Result<Value, WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        let reply = process
            .request(
                "workflows/list",
                json!({ "workspacePath": workspace_path, "scope": scope }),
            )
            .await
            .map_err(|error| WorkflowEngineError::with_message("start_failed", error))?;
        Ok(reply)
    }

    async fn hub_get_saved_workflow(
        &self,
        workspace_path: &str,
        name: &str,
        scope: &str,
    ) -> Result<Value, WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        let reply = process
            .request(
                "workflows/get",
                json!({ "workspacePath": workspace_path, "name": name, "scope": scope }),
            )
            .await
            .map_err(|error| WorkflowEngineError::with_message("start_failed", error))?;
        Ok(reply)
    }

    async fn hub_save_workflow_from_run(
        &self,
        workspace_path: &str,
        run_id: &str,
        name: &str,
        meta: Value,
        scope: &str,
        overwrite: bool,
    ) -> Result<Value, WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        // dbPath 与 holes/fill 同源：journal 是 run 记录的家，脚本正文从它读。
        let reply = process
            .request(
                "workflows/save",
                json!({
                    "workspacePath": workspace_path,
                    "runId": run_id,
                    "dbPath": self.shared.database.display().to_string(),
                    "name": name,
                    "meta": meta,
                    "scope": scope,
                    "overwrite": overwrite,
                }),
            )
            .await
            .map_err(|error| WorkflowEngineError::with_message("start_failed", error))?;
        Ok(reply)
    }

    async fn hub_update_saved_workflow_meta(
        &self,
        workspace_path: &str,
        name: &str,
        meta: Value,
        scope: &str,
    ) -> Result<Value, WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        let reply = process
            .request(
                "workflows/updateMeta",
                json!({
                    "workspacePath": workspace_path,
                    "name": name,
                    "meta": meta,
                    "scope": scope,
                }),
            )
            .await
            .map_err(|error| WorkflowEngineError::with_message("start_failed", error))?;
        Ok(reply)
    }

    async fn hub_delete_saved_workflow(
        &self,
        workspace_path: &str,
        name: &str,
        scope: &str,
    ) -> Result<Value, WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        let reply = process
            .request(
                "workflows/delete",
                json!({ "workspacePath": workspace_path, "name": name, "scope": scope }),
            )
            .await
            .map_err(|error| WorkflowEngineError::with_message("start_failed", error))?;
        Ok(reply)
    }

    async fn hub_move_saved_workflow(
        &self,
        workspace_path: &str,
        name: &str,
    ) -> Result<Value, WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        let reply = process
            .request(
                "workflows/move",
                json!({ "workspacePath": workspace_path, "name": name }),
            )
            .await
            .map_err(|error| WorkflowEngineError::with_message("start_failed", error))?;
        Ok(reply)
    }

    async fn hub_find_saved_workflow_for_run(
        &self,
        workspace_path: &str,
        run_id: &str,
        candidates: Value,
    ) -> Result<Value, WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        // dbPath 与 save 同源：三规则里两条要读 run 记录（脚本与名字），候选规则不读也照收。
        let reply = process
            .request(
                "workflows/forRun",
                json!({
                    "workspacePath": workspace_path,
                    "runId": run_id,
                    "dbPath": self.shared.database.display().to_string(),
                    "candidates": candidates,
                }),
            )
            .await
            .map_err(|error| WorkflowEngineError::with_message("start_failed", error))?;
        Ok(reply)
    }

    async fn fill_target(
        &self,
        run_id: &str,
    ) -> Result<rust_cli_kernel_api::workflow::WorkflowFillTarget, WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        let reply = process
            .request(
                "holes",
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
                reply["message"].as_str().unwrap_or("the run could not be read"),
            ));
        }
        Ok(rust_cli_kernel_api::workflow::WorkflowFillTarget {
            name: reply["name"].as_str().map(str::to_owned),
            draft_path: reply["draftPath"].as_str().map(str::to_owned),
            status: reply["status"].as_str().unwrap_or("running").to_owned(),
            stop_reason: reply["stopReason"].as_str().map(str::to_owned),
            holes: reply["holes"]
                .as_array()
                .map(|holes| {
                    holes
                        .iter()
                        .map(|hole| rust_cli_kernel_api::workflow::WorkflowFillTargetHole {
                            site_id: hole["siteId"].as_str().unwrap_or_default().to_owned(),
                            name: hole["name"].as_str().unwrap_or_default().to_owned(),
                            hole_type: hole["type"].as_str().unwrap_or("unknown").to_owned(),
                            line: hole["line"].as_u64(),
                            waiting: hole["waiting"].as_bool().unwrap_or(false),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
    }

    async fn fill_hole(
        &self,
        session: &SessionId,
        run_id: &str,
        hole_id: &str,
        body: &str,
    ) -> Result<rust_cli_kernel_api::workflow::WorkflowFillOutcome, WorkflowEngineError> {
        let process = self.ensure_process().map_err(|error| {
            WorkflowEngineError::with_message("start_failed", error)
        })?;
        let reply = process
            .request(
                "fill",
                json!({
                    "runId": run_id,
                    "holeId": hole_id,
                    "body": body,
                    "dbPath": self.shared.database.display().to_string(),
                    "parentSessionId": session.as_str(),
                }),
            )
            .await
            .map_err(|error| WorkflowEngineError::with_message("start_failed", error))?;
        if reply["ok"].as_bool() == Some(true) {
            return Ok(rust_cli_kernel_api::workflow::WorkflowFillOutcome::Filled {
                phases_added: reply["phasesAdded"]
                    .as_array()
                    .map(|names| {
                        names
                            .iter()
                            .filter_map(|name| name.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                script_path: reply["scriptPath"].as_str().map(str::to_owned),
                script_text: reply["scriptText"].as_str().unwrap_or_default().to_owned(),
            });
        }
        Ok(rust_cli_kernel_api::workflow::WorkflowFillOutcome::Refused {
            reason: reply["reason"].as_str().unwrap_or("hole_not_waiting").to_owned(),
            message: reply["message"].as_str().unwrap_or_default().to_owned(),
            diagnostics: reply["diagnostics"]
                .as_array()
                .map(|diagnostics| {
                    diagnostics
                        .iter()
                        .map(|diagnostic| {
                            rust_cli_kernel_api::workflow::WorkflowFillDiagnostic {
                                line: diagnostic["line"].as_u64().unwrap_or_default(),
                                column: diagnostic["column"].as_u64().unwrap_or_default(),
                                message: diagnostic["message"]
                                    .as_str()
                                    .unwrap_or_default()
                                    .to_owned(),
                                code: diagnostic["code"].as_u64().unwrap_or_default(),
                                in_fill: diagnostic["inFill"].as_bool().unwrap_or(false),
                            }
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
}

/// 让读线程在测试里能构造一个 `SidecarEngine` 的共享状态；生产代码不用。
#[cfg(test)]
#[path = "dwf_engine_client_tests.rs"]
mod tests;
