//! X02：Rust 侧内置工具注册表与 `packages/shared/src/kernel-contract/tool-parity.json` 的机械对拍。
//!
//! 覆盖：`nibi-kernel-tools` 能静态构造的全部内置工具（名称、只读标记、`check_permissions`
//! 的 Ask 行为）与错误码分类；TodoRead / TodoWrite 由 `nibi-kernel-agents` 注册，这里把它们
//! 的工具实例并入枚举（canonical 的 `side: both` 要求 Rust 侧“存在”）。Agent/Task/Skill/MCP/
//! 插件工具由其他 crate/运行时组装，不在此层，排除项写在 canonical 的 `scope.excluded` 与
//! `kernel-contract/README.md`。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_api::env::EnvError;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::orchestration::{PermissionGate, ToolRegistry};
use nibi_kernel_api::permission::PermissionDecision;
use nibi_kernel_api::testing::{
    FixedClock, MemoryStore, ScriptedInteractions, ScriptedModel, selection,
};
use nibi_kernel_api::tool::{Tool, ToolError, ToolUseContext};
use nibi_kernel_api::topic::{
    SessionReads, SessionSnapshot, TopicPort, TopicResource, TopicResourceRead,
};
use nibi_kernel_api::workflow::{
    WorkflowQuestionResolved, WorkflowQuestions, WorkflowRunDetail, WorkflowRunIntrospection,
};
use nibi_kernel_prompts::models::ToolSearchSetting;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::test_more::Ctx;
use crate::{
    BashTool, BuiltinTools, CronBoard, FileTools, FillWorkflowHoleTool, GetWorkflowRunTool,
    MonitorTool, ReadFileState, ReportFindingsTool, ResolveWorkflowQuestionTool,
    ScheduleWakeupTool, ToolCatalog, app_control_tools, authoring_tools, cron_tools_with, file_tools,
    interaction_tools, session_control_tools, topic_tools, web_tools, worktree_tools,
};

/// canonical 清单；路径从 crate 根推仓库根（kernel/crates/tools → ../../../packages/...）。
const CANONICAL: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/shared/src/kernel-contract/tool-parity.json"
));

#[derive(Debug, Clone, Deserialize)]
struct Canonical {
    version: u32,
    counts: Counts,
    scope: Scope,
    tools: Vec<ToolSpec>,
    permissions: Permissions,
    #[serde(rename = "errorCodes")]
    error_codes: Vec<ErrorCodeSpec>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Counts {
    tools: usize,
    node_tools: usize,
    rust_tools: usize,
    permissions: usize,
    error_codes: usize,
}

#[derive(Debug, Clone, Deserialize)]
struct Scope {
    excluded: Vec<Excluded>,
}

#[derive(Debug, Clone, Deserialize)]
struct Excluded {
    name: String,
    side: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolSpec {
    name: String,
    side: String,
    #[allow(dead_code)]
    permission: Option<String>,
    read_only: Option<bool>,
    #[allow(dead_code)]
    node_read_only: Option<bool>,
    rust_read_only: Option<bool>,
    #[allow(dead_code)]
    needs_approval: Option<bool>,
    #[allow(dead_code)]
    always_ask: Option<bool>,
    rust_asks: Option<bool>,
    #[allow(dead_code)]
    note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct Permissions {
    side: String,
    #[allow(dead_code)]
    source: String,
    names: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ErrorCodeSpec {
    name: String,
    side: String,
    #[allow(dead_code)]
    node: Option<String>,
    rust: Option<String>,
}

fn canonical() -> Canonical {
    serde_json::from_str(CANONICAL).expect("tool-parity.json 必须可解析")
}

/// 权限不在这里测：一律放行。
struct AllowAll;

#[async_trait]
impl PermissionGate for AllowAll {
    async fn decide(
        &self,
        _tool: &dyn Tool,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        PermissionDecision::Allow {
            updated_input: None,
        }
    }
}

struct NoQuestions;

#[async_trait]
impl WorkflowQuestions for NoQuestions {
    async fn resolve(
        &self,
        _session: &SessionId,
        qid: &str,
        _answer: &str,
    ) -> WorkflowQuestionResolved {
        WorkflowQuestionResolved::Answered {
            qid: qid.to_owned(),
        }
    }
}

struct NoRunDetail;

#[async_trait]
impl WorkflowRunIntrospection for NoRunDetail {
    async fn run_detail(
        &self,
        _session: &SessionId,
        _run_id: &str,
    ) -> Result<Option<WorkflowRunDetail>, nibi_kernel_api::store::StoreError> {
        Ok(None)
    }
}

struct EmptyReads;

#[async_trait]
impl SessionReads for EmptyReads {
    async fn snapshot(&self, _session: &SessionId) -> Result<SessionSnapshot, String> {
        Ok(SessionSnapshot::default())
    }
}

/// 静态对拍用的话题端口：`ReadTopicResource` 的注册门要求端口在场，但这里不执行真实读取。
struct StubTopic;

#[async_trait]
impl TopicPort for StubTopic {
    async fn read(&self, _request: &TopicResourceRead) -> Result<TopicResource, String> {
        Err("unavailable".to_owned())
    }

    async fn cancel(&self, _request_id: &str, _task_id: &str) {}

    async fn reply(&self, _request: Value) -> Result<Value, String> {
        Err("unavailable".to_owned())
    }
}

/// 按 runtime 的组装顺序枚举 `nibi-kernel-tools` 的内置工具注册表。
fn registry() -> Vec<Arc<dyn Tool>> {
    let state = Arc::new(ReadFileState::default());
    let files = FileTools::new(state, Arc::new(AllowAll));
    let clock: Arc<dyn nibi_kernel_api::clock::Clock> = Arc::new(FixedClock(0));
    let board = CronBoard::new(clock.clone(), None);
    let catalog = Arc::new(ToolCatalog::new(ToolSearchSetting::default()));
    let engine_slot = Arc::new(std::sync::Mutex::new(None));
    let models_slot = Arc::new(std::sync::Mutex::new(None));
    let builtin = BuiltinTools::new(file_tools(&files))
        // 让 Glob / Grep 在 Bash 在场时也暴露，否则注册表只能看到一层裁剪后的表面。
        .with_search_opt_in(true)
        .with_leading(Arc::new(BashTool::new()))
        .with_tools(interaction_tools(&catalog, true))
        .with_tools(web_tools(
            crate::SideModel {
                model: Arc::new(ScriptedModel::new(Vec::new())),
                selection: selection(),
            },
            clock,
        ))
        .with_tools(cron_tools_with(&board, false, None))
        .with_tools(vec![Arc::new(ScheduleWakeupTool::new(&board))])
        .with_tools(vec![Arc::new(MonitorTool::new())])
        .with_tools(vec![Arc::new(ReportFindingsTool::new())])
        .with_tools(authoring_tools(
            engine_slot.clone(),
            models_slot,
            Some(selection()),
            Arc::new(MemoryStore::default()),
        ))
        .with_tools(vec![Arc::new(ResolveWorkflowQuestionTool::new(Arc::new(
            NoQuestions,
        )))])
        .with_tools(vec![Arc::new(GetWorkflowRunTool::new(
            Arc::new(NoRunDetail),
            Arc::new(FixedClock(0)),
        ))])
        .with_tools(vec![Arc::new(FillWorkflowHoleTool::new(engine_slot))])
        .with_tools(worktree_tools(&Arc::new(crate::WorktreeBoard::default())))
        // 会话控制 8 个工具：端口槽在入口拿到 Arc<LocalKernel> 之后注入；对拍只看名字、只读标记与 Ask。
        .with_tools(session_control_tools(Arc::new(std::sync::OnceLock::new())))
        // App-exclusive 的 4 个工具：只在 App 入口装端口后由 runtime 注册；对拍同样只看
        // 名字、只读标记与 Ask 行为。
        .with_tools(app_control_tools(Arc::new(std::sync::OnceLock::new())))
        .with_tools(topic_tools(
            Arc::new(EmptyReads),
            Some(Arc::new(StubTopic)),
        ));
    let mut tools = builtin.tools();
    // TodoRead / TodoWrite 是 agents 层的工具（与 Node 同名、同语义）；X02 的 Rust 覆盖面包含它们。
    tools.extend(nibi_kernel_agents::todo_tools(Arc::new(
        nibi_kernel_agents::MemoryTodos::default(),
    )));
    tools
}

fn probe_input(name: &str) -> Value {
    if name == "Bash" {
        // 明确带写副作用，避免只读命令把 `is_read_only` 翻成 true。
        json!({"command": "rm -rf nibi-parity-probe"})
    } else {
        json!({})
    }
}

fn is_ask(decision: &PermissionDecision) -> bool {
    matches!(decision, PermissionDecision::Ask { .. })
}

fn error_kind(error: &ToolError) -> &'static str {
    match error {
        ToolError::InvalidInput { .. } => "invalid_input",
        ToolError::Cancelled => "cancelled",
        ToolError::Environment(_) => "environment",
        ToolError::Failed { .. } => "failed",
        ToolError::Unsupported { .. } => "unsupported",
    }
}

/// 每个 `ToolError` 变体一个样本；`error_kind` 的 match 是穷尽的，新增变体会编译失败。
/// 同时核对 serde 的 `kind` 与 match 标签一致，防止只改变体序列化名造成错误码漂移。
fn rust_error_kinds() -> Vec<&'static str> {
    let samples = [
        ToolError::InvalidInput {
            message: String::new(),
        },
        ToolError::Cancelled,
        ToolError::Environment(EnvError::NotFound {
            path: String::new(),
        }),
        ToolError::Failed {
            message: String::new(),
        },
        ToolError::Unsupported {
            what: String::new(),
        },
    ];
    for error in &samples {
        let serialized = serde_json::to_value(error).expect("ToolError 必须可序列化");
        assert_eq!(
            serialized.get("kind").and_then(Value::as_str),
            Some(error_kind(error)),
            "ToolError 序列化 kind 与 canonical 标签不一致"
        );
    }
    samples.iter().map(error_kind).collect()
}

fn difference(actual: &HashSet<&str>, expected: &HashSet<&str>) -> Vec<String> {
    let mut errors = Vec::new();
    for name in expected.difference(actual) {
        errors.push(format!("missing:{name}"));
    }
    for name in actual.difference(expected) {
        errors.push(format!("unexpected:{name}"));
    }
    errors.sort();
    errors
}

/// 纯比较函数：门禁与 mutation 用例共用。返回错误消息；空数组表示一致。
async fn compare_rust_registry(document: &Canonical, tools: &[Arc<dyn Tool>]) -> Vec<String> {
    let mut errors = Vec::new();
    if document.version != 1 {
        let version = document.version;
        errors.push(format!("version 必须是 1（当前 {version}）"));
    }

    if document.counts.tools != document.tools.len() {
        let declared = document.counts.tools;
        let actual = document.tools.len();
        errors.push(format!("counts.tools {declared} != {actual}"));
    }
    let node_tools = document
        .tools
        .iter()
        .filter(|tool| tool.side != "rust")
        .count();
    let rust_tools = document
        .tools
        .iter()
        .filter(|tool| tool.side != "node")
        .count();
    if document.counts.node_tools != node_tools {
        let declared = document.counts.node_tools;
        errors.push(format!("counts.nodeTools {declared} != {node_tools}"));
    }
    if document.counts.rust_tools != rust_tools {
        let declared = document.counts.rust_tools;
        errors.push(format!("counts.rustTools {declared} != {rust_tools}"));
    }
    if document.counts.permissions != document.permissions.names.len() {
        let declared = document.counts.permissions;
        let actual = document.permissions.names.len();
        errors.push(format!("counts.permissions {declared} != {actual}"));
    }
    if document.counts.error_codes != document.error_codes.len() {
        let declared = document.counts.error_codes;
        let actual = document.error_codes.len();
        errors.push(format!("counts.errorCodes {declared} != {actual}"));
    }
    if document.permissions.side != "node" {
        let side = &document.permissions.side;
        errors.push(format!("permissions.side 必须是 node（当前 {side}）"));
    }
    if document
        .permissions
        .names
        .iter()
        .collect::<HashSet<_>>()
        .len()
        != document.permissions.names.len()
    {
        errors.push("permissions.names 有重复".to_owned());
    }
    if document
        .error_codes
        .iter()
        .map(|code| code.name.as_str())
        .collect::<HashSet<_>>()
        .len()
        != document.error_codes.len()
    {
        errors.push("errorCodes 有重复 name".to_owned());
    }
    for tool in &document.tools {
        if !matches!(tool.side.as_str(), "both" | "node" | "rust") {
            let name = &tool.name;
            let side = &tool.side;
            errors.push(format!("{name}: side 非法（{side}）"));
        }
    }

    let mut actual: HashMap<&str, &Arc<dyn Tool>> = HashMap::new();
    for tool in tools {
        if actual.insert(tool.name(), tool).is_some() {
            let name = tool.name();
            errors.push(format!("duplicate rust tool: {name}"));
        }
    }

    let expected: Vec<&ToolSpec> = document
        .tools
        .iter()
        .filter(|tool| tool.side == "both" || tool.side == "rust")
        .collect();
    let excluded: Vec<&Excluded> = document
        .scope
        .excluded
        .iter()
        .filter(|tool| tool.side == "both" || tool.side == "rust")
        .collect();
    let mut expected_names: HashSet<&str> =
        expected.iter().map(|tool| tool.name.as_str()).collect();
    expected_names.extend(excluded.iter().map(|tool| tool.name.as_str()));
    let actual_names: HashSet<&str> = actual.keys().copied().collect();
    errors.extend(difference(&actual_names, &expected_names));

    let context = Ctx::new(Arc::new(ScriptedInteractions::default())).build();
    for spec in expected {
        let Some(tool) = actual.get(spec.name.as_str()) else {
            continue;
        };
        match spec.rust_read_only.or(spec.read_only) {
            None => {
                let name = &spec.name;
                errors.push(format!("{name}: canonical 缺少 readOnly/rustReadOnly"));
            }
            Some(expected_read_only) => {
                let actual_read_only = tool.is_read_only(&probe_input(&spec.name));
                if actual_read_only != expected_read_only {
                    let name = &spec.name;
                    errors.push(format!(
                        "{name}: readOnly 漂移（canonical {expected_read_only}，Rust {actual_read_only}）"
                    ));
                }
            }
        }
        match spec.rust_asks {
            None => {
                let name = &spec.name;
                errors.push(format!("{name}: canonical 缺少 rustAsks"));
            }
            Some(expected_ask) => {
                let actual_ask = is_ask(
                    &tool
                        .check_permissions(&probe_input(&spec.name), &context)
                        .await,
                );
                if actual_ask != expected_ask {
                    let name = &spec.name;
                    errors.push(format!(
                        "{name}: rustAsks 漂移（canonical {expected_ask}，Rust {actual_ask}）"
                    ));
                }
            }
        }
    }

    for spec in &document.tools {
        if spec.side == "node" && actual.contains_key(spec.name.as_str()) {
            let name = &spec.name;
            errors.push(format!(
                "{name}: canonical 标记为 Node 单侧，但 Rust 注册表注册了它"
            ));
        }
    }
    for excluded_tool in excluded {
        if !actual.contains_key(excluded_tool.name.as_str()) {
            let name = &excluded_tool.name;
            errors.push(format!(
                "{name}: 已登记为 Rust 排除项，但 Rust 注册表里不存在"
            ));
        }
    }

    let expected_rust_errors: HashSet<&str> = document
        .error_codes
        .iter()
        .filter(|code| code.side == "both" || code.side == "rust")
        .map(|code| {
            let name = code.name.as_str();
            code.rust
                .as_deref()
                .unwrap_or_else(|| panic!("{name}: side 要求 rust 字段"))
        })
        .collect();
    let actual_errors: HashSet<&str> = rust_error_kinds().into_iter().collect();
    errors.extend(difference(&actual_errors, &expected_rust_errors));

    errors
}

#[tokio::test]
async fn rust_registry_matches_canonical() {
    let errors = compare_rust_registry(&canonical(), &registry()).await;
    assert!(errors.is_empty(), "\n{}", errors.join("\n"));
}

/// X02 schema/结果预算对拍的确定性导出入口。
///
/// 只在显式设置 `NIBI_DUAL_KERNEL_CONTRACT_OUT` 时写文件；正常 `cargo test` 下直接返回，
/// 不产生额外产物。由 `scripts/check-dual-kernel-parity.mjs --check/--update` 以
/// `cargo test -p nibi-kernel-tools --lib dump_tool_contract_for_dual_kernel_parity -- --exact`
/// 调用，所以导出的是测试同款注册表，不另建一套组装。
#[test]
fn dump_tool_contract_for_dual_kernel_parity() {
    let Some(output) = std::env::var_os("NIBI_DUAL_KERNEL_CONTRACT_OUT") else {
        return;
    };
    let tools = registry();
    let mut entries: Vec<Value> = tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.name(),
                "inputSchema": tool.input_schema(),
                "maxResultSizeChars": tool.max_result_size_chars(),
            })
        })
        .collect();
    entries.sort_by(|left, right| {
        left["name"]
            .as_str()
            .unwrap_or_default()
            .cmp(right["name"].as_str().unwrap_or_default())
    });
    let document = json!({
        "version": 1,
        "side": "rust",
        "tools": entries,
    });
    let bytes = serde_json::to_vec_pretty(&document).expect("tool contract 必须可序列化");
    std::fs::write(&output, bytes).expect("写不出 NIBI_DUAL_KERNEL_CONTRACT_OUT");
}

#[tokio::test]
async fn registry_has_no_duplicate_names() {
    let tools = registry();
    let names: HashSet<&str> = tools.iter().map(|tool| tool.name()).collect();
    assert_eq!(names.len(), tools.len(), "注册表存在重名工具");
}

#[tokio::test]
async fn mutation_deleting_a_canonical_tool_is_red() {
    let mut document = canonical();
    document.tools.retain(|tool| tool.name != "Read");
    let errors = compare_rust_registry(&document, &registry()).await;
    assert!(
        errors.iter().any(|error| error == "unexpected:Read"),
        "{errors:#?}"
    );
}

#[tokio::test]
async fn mutation_flipping_read_only_is_red() {
    let mut document = canonical();
    let read = document
        .tools
        .iter_mut()
        .find(|tool| tool.name == "Read")
        .expect("Read");
    read.read_only = Some(false);
    let errors = compare_rust_registry(&document, &registry()).await;
    assert!(
        errors
            .iter()
            .any(|error| error.contains("Read: readOnly 漂移")),
        "{errors:#?}"
    );
}

#[tokio::test]
async fn mutation_flipping_rust_asks_is_red() {
    let mut document = canonical();
    let create = document
        .tools
        .iter_mut()
        .find(|tool| tool.name == "CreateWorkflow")
        .expect("CreateWorkflow");
    create.rust_asks = Some(false);
    let errors = compare_rust_registry(&document, &registry()).await;
    assert!(
        errors
            .iter()
            .any(|error| error.contains("CreateWorkflow: rustAsks 漂移")),
        "{errors:#?}"
    );
}

#[tokio::test]
async fn mutation_marking_a_node_only_tool_as_both_is_red() {
    let mut document = canonical();
    let task_output = document
        .tools
        .iter_mut()
        .find(|tool| tool.name == "TaskOutput")
        .expect("TaskOutput");
    task_output.side = "both".to_owned();
    let errors = compare_rust_registry(&document, &registry()).await;
    assert!(
        errors.iter().any(|error| error == "missing:TaskOutput"),
        "{errors:#?}"
    );
}

#[tokio::test]
async fn mutation_deleting_an_error_code_is_red() {
    let mut document = canonical();
    document
        .error_codes
        .retain(|code| code.name != "invalid_input");
    let errors = compare_rust_registry(&document, &registry()).await;
    assert!(
        errors
            .iter()
            .any(|error| error == "unexpected:invalid_input"),
        "{errors:#?}"
    );
}
