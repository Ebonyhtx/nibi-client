//! `zcode app-server --stdio [--surface desktop]`（docs/specs/rust-cli/app-protocol.md §3.7、§10）：App 的 Host 经 stdio
//! 拉起的协议前端。参数照 Host 现在给 Node 的（`ZA:nibiAgentProcessManager.ts` 的 `applyPresentationSurfaceToCommand`）。
//!
//! 组装与 `-p` 相同的内核（同一套提示词与工具，Surface 是交互形态；不问工作区信任、不连远端机器、
//! 不登记跨会话通信），区别只在注入的东西：平台层的账号凭据来源经 Host（G8），前端是 `protocol-nibi`。
//! 写者先起：Host 要求拉起后 30 s 内有 `startup/storageState`。
//!
//! 标题生成与桌面 Node 一致：首条人类输入后发一次 `session_title` 侧请求（`TitleModel`），
//! 用户可见的标题、标题来源与这条请求的用量行都按 Node 的口径。

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;
use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::EnvironmentId;
use nibi_kernel_api::machine::Files;
use nibi_kernel_api::provider::ModelDirectory;
use nibi_kernel_api::store::{SessionFilter, SessionStore};
use nibi_kernel_base::TaskScope;
use nibi_kernel_base::secret::EnvSnapshot;
use nibi_kernel_env_local::{LocalCronStore, LocalEnvironment, LocalMcpTransport};
use nibi_kernel_node_store::{NodeIds, NodeStore, SystemClock};
use nibi_kernel_paths::StorageSettings;
use nibi_kernel_protocol_core::connection::{self, Options};
use nibi_kernel_protocol_nibi::{Context, Defaults, HostHeaders, Startup};
use nibi_kernel_runtime::{
    ContextConfig, Defaults as KernelDefaults, LocalKernel, PluginSnapshotLoader, Ports, Surface,
    TitleModel,
};

use crate::args::names_search_tools;
use crate::output::eprint_line;
use crate::{
    LOCAL_ENVIRONMENT, VERSION, config, limits, log, mcp, model_io, models, options, setup,
};

/// 会话级插件快照加载器：每个 `session/create` 重新读配置、已安装清单与 license。
struct SessionPluginLoader {
    home: PathBuf,
    env: EnvSnapshot,
    paths: nibi_kernel_paths::StoragePaths,
    files: Arc<dyn Files>,
}

#[async_trait]
impl PluginSnapshotLoader for SessionPluginLoader {
    async fn load(&self, workspace: &WorkspaceRef) -> nibi_kernel_ext::plugins::Loaded {
        let inputs = config::ConfigInputs {
            files: self.files.as_ref(),
            workspace,
            paths: &self.paths,
            process_env: &self.env,
            flag: None,
            paid_license: Some(crate::read_paid_license_from(&self.home, &self.env)),
        };
        config::plugin_snapshot(&inputs).await
    }
}

/// 子命令的参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Parsed {
    /// `--surface`（Host 给 `desktop`）。P1 不按它改提示词（app-protocol.md §13 第 4 项）。
    pub(crate) surface: Option<String>,
    /// `--prepare-storage`（Host 的存储准备入口；`prepare_storage.rs`）：不进协议读循环，
    /// 所以不要求 `--stdio`（Host 的 Worker/子进程 argv 恒带它，单独给也接受）。
    pub(crate) prepare_storage: bool,
}

/// `app-server` 子命令；不是它时为 None。只认 `--stdio`、`--surface` 与 `--prepare-storage`。
pub(crate) fn parse(args: &[String]) -> Option<Result<Parsed, String>> {
    let (first, rest) = args.split_first()?;
    if first != "app-server" {
        return None;
    }
    let mut stdio = false;
    let mut surface = None;
    let mut prepare_storage = false;
    let mut rest = rest.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--stdio" => stdio = true,
            "--prepare-storage" => prepare_storage = true,
            "--surface" => match rest.next() {
                Some(value) => surface = Some(value.clone()),
                None => {
                    return Some(Err(
                        "error: option '--surface <surface>' argument missing".into()
                    ));
                }
            },
            other => match other.strip_prefix("--surface=") {
                Some(value) => surface = Some(value.to_owned()),
                None => return Some(Err(format!("error: unknown option '{other}'"))),
            },
        }
    }
    if !stdio && !prepare_storage {
        return Some(Err("error: app-server needs --stdio".to_owned()));
    }
    Some(Ok(Parsed {
        surface,
        prepare_storage,
    }))
}

/// `executor` 与 `app-server` 两个子命令（不走常规命令行参数的解析）：是其中之一时返回退出码。
pub(crate) fn dispatch(args: &[String]) -> Option<ExitCode> {
    // `nibi executor`（远端执行 R1 / R2，remote-exec.md §12、§18.6、§19.3）：执行器模式，不读凭据、不开会话库。
    if let Some(parsed) = crate::executor::parse(args) {
        return Some(crate::executor::main(parsed));
    }
    let parsed = match parse(args)? {
        Ok(parsed) => parsed,
        Err(message) => {
            eprint_line(&message);
            return Some(ExitCode::FAILURE);
        }
    };
    // 存储准备（Node `prepareProtocolStartupStorage` 的对等物）：握手 + 迁移，不起 async 前端。
    if parsed.prepare_storage {
        return Some(crate::prepare_storage::dispatch());
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprint_line(&format!("nibi: cannot start the async runtime: {error}"));
            return Some(ExitCode::FAILURE);
        }
    };
    Some(match runtime.block_on(run(parsed)) {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            eprint_line(&format!("nibi: {error:#}"));
            ExitCode::FAILURE
        }
    })
}

/// 浏览器 broker 的本地 socket：Unix 落在入口解析的临时目录，Windows 用命名管道。
/// 每个进程一个随机名；`node_repl` 子进程按环境里的路径连接。
#[expect(
    clippy::disallowed_methods,
    reason = "entry crate resolves the temp directory once (§4)"
)]
fn browser_socket_path() -> String {
    let id = format!(
        "{:016x}{:016x}",
        nibi_kernel_base::random::u64(),
        nibi_kernel_base::random::u64()
    );
    if cfg!(windows) {
        format!(r"\\.\pipe\nibi-node-repl-browser-{id}")
    } else {
        std::env::temp_dir()
            .join(format!("nibi-node-repl-browser-{id}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

/// 会话库的不透明 ID：Node `createHash("sha256").update(dbPath)` 的同一十六进制（同一个库总是
/// 同一个 ID，不带路径；Host 按它归并迁移基线，两内核必须一致）。
fn database_id(path: &std::path::Path) -> String {
    nibi_kernel_node_store::session_database_id(path)
}

async fn run(parsed: Parsed) -> Result<u8> {
    let startup = crate::capture()?;
    // 用户配置/插件清单/会话库都要先按入口环境定位：Node 的 `NIBI_STORAGE_DIR`
    // 在 spawn 边界映射成 `NIBI_STORAGE_DIR`，这里若用默认值会读真实用户根，
    // 隔离运行与 Host 管理面就会各自看见不同的 config/plugins。
    let storage = StorageSettings {
        session_db_path: startup
            .env
            .get("NIBI_SESSION_DB_PATH")
            .or_else(|| startup.env.get("NIBI_SESSION_DB")),
        storage_dir: startup.env.get("NIBI_STORAGE_DIR"),
    };
    let paths = setup::storage_paths(&startup, &storage);
    let clock = Arc::new(SystemClock::new(startup.zone.clone()));
    // 日志只写文件：stdout 是协议（logging.md §6）。
    let run_log = log::RunLog::start(paths.logs().as_path().to_path_buf(), clock.clone());
    tracing::info!(
        event = "process.start",
        version = VERSION,
        mode = "app-server",
        surface = parsed.surface.as_deref().unwrap_or("none"),
        pid = std::process::id(),
        "process started"
    );
    let scope = TaskScope::root("app-server", |panic| {
        tracing::error!(event = "task.panic", scope = %panic.scope, task = panic.task, message = %panic.message, "a task panicked");
    });
    let options = Options::default();
    let (peer, writer) = connection::start(tokio::io::stdout(), &scope.spawner(), options);
    let context = Arc::new(Context::new(peer, clock.clone()));
    let stop = crate::signals::Stop::listen();
    let model_io = model_io::ModelIo::default();
    let result = serve(
        startup,
        paths,
        clock,
        context,
        scope.spawner(),
        &model_io,
        &stop,
    )
    .await;
    model_io.flush().await;
    let code = match &result {
        Ok(()) => stop.code().unwrap_or(0),
        Err(_) => 1,
    };
    tracing::info!(event = "process.exit", code, "process exiting");
    // 写者写完队列里剩下的帧再退出。
    drop(writer);
    let _ = scope.close(Duration::from_secs(2)).await;
    run_log.flush().await;
    result.map(|()| code)
}

async fn serve(
    startup: crate::Startup,
    paths: nibi_kernel_paths::StoragePaths,
    clock: Arc<SystemClock>,
    context: Arc<Context>,
    spawner: nibi_kernel_base::Spawner,
    model_io: &model_io::ModelIo,
    stop: &crate::signals::Stop,
) -> Result<()> {
    let state = Startup::new(context.clone(), database_id(paths.database().as_path()));
    state.checking().await;
    // Browser Use 的模型面是 `node_repl` 的 `js` 工具；它经本地 socket 把命令交回这里，再变成
    // `interaction/browser*` 反向请求。Host 声明它有 browser executor 时才起这个 broker。
    let browser_broker = if startup.env.get("NIBI_HOST_BROWSER_BROKER") == Some("1") {
        let socket = browser_socket_path();
        match nibi_kernel_protocol_nibi::browser::start(context.clone(), socket.clone(), &spawner) {
            Ok(broker) => {
                let token = broker.token().to_owned();
                context.set_browser_broker(Arc::new(broker));
                Some((socket, token))
            }
            Err(error) => {
                tracing::warn!(
                    %error,
                    "the browser broker could not start; Browser Use stays unavailable"
                );
                None
            }
        }
    } else {
        None
    };
    let egress = setup::egress(&startup).await?;
    // 缺口 G8：账号模型的凭据向 Host 要（与 Node 相同经反向请求）；API key 的 provider 不受影响。
    let platform = Arc::new(
        setup::platform(&startup, &paths, egress.clone(), clock.clone())?
            .with_header_source(Arc::new(HostHeaders::new(context.clone()))),
    );
    let account = platform.clone();
    let shell =
        crate::shell::config(startup.env.clone(), &startup.temp, !names_search_tools(&[])).await;
    // Bash 命令的资源事实（`process/toolExecResource`，141 审计 §9 F3）：执行环境写这一头，
    // 协议 server 读另一头转发成通知。
    let (tool_telemetry, tool_exec_channel) =
        nibi_kernel_protocol_nibi::telemetry::ToolExecChannel::channel();
    // MCP 进程的生命周期事件（`process/mcpTelemetry`）：ext 写这一头，协议 server 转发。
    let (mcp_telemetry, mcp_events) = tokio::sync::mpsc::unbounded_channel();
    // 本进程的读数（`process/resourceSample` 与 MCP 五分钟采样共用一份）。
    let process_metrics: Arc<dyn nibi_kernel_api::process_metrics::ProcessMetrics> =
        Arc::new(nibi_kernel_env_local::process_metrics::LocalProcessMetrics::new());
    let monitor = options::monitor(startup.explicit.assume, shell.bash.is_some());
    let mcp_transport = Arc::new(LocalMcpTransport::new(
        shell.ledger.clone(),
        shell.env.clone(),
        Some(egress.clone()),
    ));
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new(LOCAL_ENVIRONMENT),
        root: EnvPath::new(startup.cwd.to_string_lossy()),
    };
    let env = Arc::new(
        LocalEnvironment::new(Some(startup.home.clone()))
            .with_shell(shell)
            .with_tool_telemetry(tool_telemetry)
            .with_web(egress.clone()),
    );
    let environments = setup::environments(env, mcp_transport);
    let local_machine = environments.local_machine();
    let config = config::assemble(&config::ConfigInputs {
        files: local_machine.files().as_ref(),
        workspace: &workspace,
        paths: &paths,
        process_env: &startup.env,
        flag: None,
        paid_license: Some(crate::read_paid_license(&startup)),
    })
    .await;
    let paths = setup::storage_paths(&startup, &config.storage.settings());
    let ids = Arc::new(NodeIds::new(clock.clone()));
    let store = Arc::new(NodeStore::new(paths.clone(), ids.clone()).with_version(VERSION));
    // 会话库：打开一次（node-store 在打开连接时校验迁移）；失败时报 failed，不再往下组装。
    if let Err(error) = store
        .list(SessionFilter {
            workspace: workspace.clone(),
            limit: 1,
        })
        .await
    {
        tracing::warn!(event = "app.storage.failed", error = %error, "opening the session database failed");
        state.failed("open_failed").await;
        anyhow::bail!("opening the session database failed: {error}");
    }
    let device = setup::device_id(&paths, ids.clone());
    // 显式覆盖（`NIBI_API_KEY`）时没有模型目录（与 TUI 的 `main.rs` 同一判据）；
    // `startup.explicit` 马上随 `models::assemble` 移走，先算出来。
    let explicit = startup
        .explicit
        .api_key
        .as_ref()
        .is_some_and(|key| !key.expose().is_empty());
    let models::Assembled {
        model,
        selection,
        limits: model_limits,
        // 交互面（桌面客户端的 agent）：没选出模型时不在这里失败，用户能现加供应商，原因随会话提示。
        notice: _,
    } = models::assemble(
        egress.clone(),
        platform.clone(),
        startup.explicit,
        (None, None),
        (clock.clone(), device),
        true,
    )
    .await;
    let var = |name: &str| startup.env.get(name).map(str::to_owned);
    let headers = crate::request_headers::request_headers(&var, VERSION, ids.clone());
    let model = model
        .with_stream_idle(options::stream_idle(&startup.env))
        .with_overload_retries_in_sandbox(options::is_sandbox(&startup.env))
        .with_max_output_tokens(startup.max_output_tokens)
        .with_request_headers(headers.map_err(anyhow::Error::msg)?);
    let model = model_io.attach(
        model,
        model_io::Target {
            env: &startup.env,
            paths: &paths,
            storage_dir: config.storage.dir.as_deref(),
            base: &startup.cwd,
            settings: account.settings().clone(),
        },
    );
    let ports = Ports {
        model: Arc::new(model),
        environments,
        store: store.clone(),
        artifacts: store.clone(),
        clock: clock.clone(),
        ids: ids.clone(),
    };
    let mode = config::initial_mode(None, config.mode, store.as_ref(), &workspace).await;
    let kernel_defaults = KernelDefaults {
        selection: selection.clone(),
        mode,
        max_turns: None,
        search_tools: names_search_tools(&[]),
        task_tools: options::task_tools(&startup.env),
        limits: limits::limits(&startup.env, startup.max_output_tokens),
    };
    let mut context_config = ContextConfig::new(Surface::Interactive);
    context_config.memory_dir = options::memory_dir(
        local_machine.files().as_ref(),
        &paths,
        &workspace,
        &startup.env,
    )
    .await;
    let compact = options::compact(&startup.env, startup.max_output_tokens, model_limits);
    let mcp_flags = mcp::McpFlags {
        tool_search: limits::tool_search(&startup.env).allows(),
        ..mcp::McpFlags::default()
    };
    let mut extensions = setup::extensions(
        local_machine.files().as_ref(),
        &workspace,
        (&startup.env, &startup.cwd, &startup.home),
        (&mcp_flags, &[]),
        (&[], &paths.mcp_machines()),
        &config,
    )
    .await;
    // 浏览器 broker 的 socket/token 只交给内核装配的 `node_repl` 子进程（runtime 只按白名单复制）。
    if let Some((socket, token)) = &browser_broker
        && let Some(env) = extensions.node_repl_env.as_mut()
    {
        env.insert(
            "NIBI_NODE_REPL_BROWSER_BROKER_SOCKET".to_owned(),
            socket.clone(),
        );
        env.insert(
            "NIBI_NODE_REPL_BROWSER_BROKER_TOKEN".to_owned(),
            token.clone(),
        );
    }
    // 插件按会话解析：启动只加载元数据（skill/命令/agent/hooks 与工作区目录），MCP 连接由会话快照
    // 各建一套——避免启动快照 + 会话快照两套连接，同时保留 `workspace/readPresentation` 的插件命令。
    extensions.config.plugin_mcp_per_session = true;
    extensions.plugin_loader = Some(Arc::new(SessionPluginLoader {
        home: startup.home.clone(),
        env: startup.env.clone(),
        paths: paths.clone(),
        files: local_machine.files().clone(),
    }));
    extensions.monitor = monitor;
    // 话题能力（`ReadSessionContext` 的话题附件与 `ReplyToChannel`）：Host 是数据所有者，
    // 内核经反向请求 `topic/resource/read` 与 `bot/channel/reply` 找它。
    extensions.topic = Some(Arc::new(nibi_kernel_protocol_nibi::HostTopic::new(
        context.clone(),
    )));
    // 桌面 Automations：模型侧的 CronCreate/CronUpdate/CronList/CronDelete 交给 Host 的
    // AutomationService（记录、卡片、编辑页与历史都在 Host），不在内核另存一份。
    extensions.automation = Some(Arc::new(nibi_kernel_protocol_nibi::HostAutomation::new(
        context.clone(),
    )));
    // `mcpId` 的盐：桌面注入的设备标识；没有时 ext 退回进程级随机串（跨进程不可关联）。
    extensions.mcp_telemetry = Some(nibi_kernel_ext::McpTelemetrySetup {
        sink: mcp_telemetry,
        id_salt: startup
            .env
            .get("NIBI_TELEMETRY_DEVICE_MID")
            .unwrap_or_default()
            .to_owned(),
    });
    // MCP Apps 的 UI 事件（`pluginUi.*` 增量，141 审计 §9 第 6 项）：ext 写这一头，协议 server
    // 按会话投进 live 投影。
    let (mcp_ui_events, mcp_ui_receiver) = tokio::sync::mpsc::unbounded_channel();
    extensions.mcp_ui = Some(mcp_ui_events);
    // MCP 的 OAuth 令牌端口（Node 的 `AuthProvider`）：与登录共用一份凭据文件。
    extensions.mcp_oauth = Some(setup::mcp_oauth(
        setup::nibi_store(
            &|key| startup.env.get(key).map(str::to_owned),
            paths.credentials().as_path().to_path_buf(),
        ),
        egress.clone(),
        clock.clone(),
    ));
    extensions.cron_store = Some(Arc::new(LocalCronStore::new(
        &workspace.root,
        clock.clone(),
    )));
    let kernel = LocalKernel::with_extensions(
        ports,
        kernel_defaults,
        context_config,
        compact,
        store.clone(),
        extensions,
    );
    // 会话标题（titles.md §2）：桌面与 TUI 同一套生成——首条人类输入后一次 `session_title`
    // 侧请求，Node 桌面同样发。显式 API key 覆盖时没有模型目录，辅助选项不补。
    let directory: Option<Arc<dyn ModelDirectory>> =
        (!explicit).then(|| platform.clone() as Arc<dyn ModelDirectory>);
    let title_model = kernel.ports().model.clone();
    let kernel = kernel
        .with_titles(TitleModel {
            model: title_model,
            directory,
        })
        // 本进程在服务 Host 协议：动态工作流的灰度缺省是「没有策略 = 关闭」，与 CLI/TUI 的
        // 「不参加灰度、工具全注册」分开。
        .with_host_serving();
    // DWF 引擎 sidecar（路线 C）：Host/开发经 `NIBI_DWF_ENGINE_CMD` 指过来；缺席时三条 DWF 命令保持
    // `fault.command.capabilityUnsupported`。
    let workflow_engine = startup.env.get("NIBI_DWF_ENGINE_CMD").and_then(|text| {
        match crate::dwf_engine_client::SidecarCommand::parse(text) {
            Ok(command) => Some(Arc::new(crate::dwf_engine_client::SidecarEngine::new(
                command,
                spawner.clone(),
                ids.clone(),
                local_machine.clone(),
                paths.database().as_path().to_path_buf(),
                platform.clone(),
                store.clone(),
            ))),
            Err(error) => {
                tracing::warn!(
                    event = "app.dwf.engine.invalid",
                    error = %error,
                    "NIBI_DWF_ENGINE_CMD is invalid; workflow commands stay unsupported"
                );
                None
            }
        }
    });
    let kernel = match &workflow_engine {
        Some(engine) => kernel.with_workflow_engine(
            engine.clone() as Arc<dyn nibi_kernel_api::workflow::WorkflowEngine>
        ),
        None => kernel,
    };
    kernel.replace_hooks(config.hooks.clone());
    // 工作区钩子的评审（NIBI `requestWorkspaceHookReview` 等四条命令）：用户层 hooks 参与 digest 的
    // 默认超时与输出上限，信任记录落 `~/.nibi` 的共享信任库（与 Node CLI、App 同一份文件）。
    let kernel = kernel.with_hook_review(
        config::user_hooks(&paths).await,
        Arc::new(nibi_kernel_platform::HookTrustStore::new(
            paths.hook_trust_store(config.storage.dir.as_deref()),
        )),
    );
    let local = config::local_rules(kernel.ports().store.as_ref(), &workspace).await;
    kernel.replace_permission_rules(
        config.permission_rules(local, crate::args::cli_rules(&[], &[], Vec::new())),
    );
    let kernel = Arc::new(kernel);
    kernel.set_paid_plugin_gate(crate::paid_plugin_gate(&startup.home, &startup.env));
    kernel.start_extensions().await;
    // 常驻会话池：目标 8 / 高水位 16 / 空闲 10 分钟；请求租约释放触发收敛，60 s sampler 兜底。
    kernel.start_resident_pool();
    if let Some(engine) = workflow_engine {
        engine.attach_kernel(kernel.clone() as Arc<dyn nibi_kernel_api::session_api::Kernel>);
    }
    state.ready().await;
    let defaults = Defaults {
        selection,
        mode,
        environment: EnvironmentId::new(LOCAL_ENVIRONMENT),
    };
    let input = tokio::io::BufReader::new(tokio::io::stdin());
    // 进程资源遥测（`process/resourceSample`，141 审计 §9 F3）：桌面资源面板的 `cli_chat` 泳道读它。
    // 只量本进程——切到 Rust 内核后那个进程就是内核，Host 采不到。
    let telemetry = nibi_kernel_protocol_nibi::telemetry::ResourceTelemetry::start(
        context.clone(),
        process_metrics.clone(),
        &spawner,
    );
    // 网络捕获（`process/networkCapture` → `process/networkRequests`，141 审计 §9 F3）：Host 开关，
    // CLI 把出站请求的批次送回去。观察者装在本进程唯一的出口上，所以覆盖全部出站路径。
    let capture = nibi_kernel_protocol_nibi::telemetry::Capture::new(context.clone(), &spawner);
    egress.observe(capture.observer());
    // 读到 Host 关掉输入或收到退出信号时结束（Host 回收整棵进程树）。
    tokio::select! {
        result = nibi_kernel_protocol_nibi::serve_with_capture(
            input,
            context,
            kernel,
            defaults,
            spawner,
            Options::default(),
            nibi_kernel_protocol_nibi::telemetry::TelemetryPorts {
                capture: Some(capture),
                tool_exec: Some(tool_exec_channel),
                mcp_events: Some(mcp_events),
                mcp_ui_events: Some(mcp_ui_receiver),
                mcp_resource: Some(nibi_kernel_protocol_nibi::telemetry::McpResourcePorts {
                    sampler: Arc::new(nibi_kernel_env_local::process_sampler::LocalProcessSampler::new()),
                    metrics: process_metrics,
                }),
            },
        ) => {
            result?;
        }
        () = stop.token.cancelled() => {}
    }
    telemetry.stop();
    Ok(())
}

#[cfg(test)]
#[path = "app_server_tests.rs"]
mod tests;
