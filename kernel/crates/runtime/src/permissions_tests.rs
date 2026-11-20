//! `/permissions` 的列表组成与修改后的快照（tui-manage.md §1.1、§1.4）。
use nibi_kernel_api::env::{EnvPath, OperationContext, Origin, WorkspaceRef};
use nibi_kernel_api::ids::{
    EnvironmentId, Generation, OperationId, OwnerEpoch, RunId, SessionId, ToolUseId,
};
use std::sync::Arc;

use nibi_kernel_api::orchestration::{
    InteractionAnswer, InteractionRequest, Interactions, OrchestrationError, PermissionGate,
};
use nibi_kernel_api::permission::{
    ExecutionState, PermissionDecision, PermissionMode, RuleBehavior,
};
use nibi_kernel_api::testing::{MemoryStore, UnusedEnvironment, local_services, machine};
use nibi_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::*;

fn workspace() -> WorkspaceRef {
    WorkspaceRef {
        environment: EnvironmentId::new("local"),
        root: EnvPath::new("/Users/dev/project"),
    }
}

fn sourced(source: RuleSource, behavior: RuleBehavior, text: &str) -> SourcedRule {
    SourcedRule {
        source,
        behavior,
        rule: parse_rule(text),
    }
}

fn gate() -> PolicyGate {
    PolicyGate::new(PermissionRules {
        version: 3,
        rules: vec![
            sourced(RuleSource::UserSettings, RuleBehavior::Deny, "WebFetch"),
            sourced(RuleSource::LocalSettings, RuleBehavior::Allow, "Glob"),
            sourced(
                RuleSource::CliArg,
                RuleBehavior::Allow,
                "Bash(git status:*)",
            ),
        ],
        ..PermissionRules::default()
    })
}

fn texts(rules: &[SourcedRule]) -> Vec<(RuleSource, RuleBehavior, String)> {
    rules
        .iter()
        .map(|rule| (rule.source, rule.behavior, format_rule(&rule.rule)))
        .collect()
}

async fn add(store: &MemoryStore, behavior: RuleBehavior, text: &str) {
    store
        .change_project_rules(
            &workspace(),
            ProjectRulesChange {
                behavior,
                replace: false,
                add: vec![parse_rule(text)],
                remove: Vec::new(),
            },
        )
        .await
        .unwrap();
}

/// 列表：LocalSettings 从 db 现读（快照里的 Glob 是启动时的旧值），会话规则来自快照（进程里共用，R1-2 之后
/// 没有按会话的副本，也不用去重）。
#[tokio::test]
async fn the_listing_reads_local_settings_fresh() {
    let gate = PolicyGate::new(PermissionRules {
        version: 3,
        rules: vec![
            sourced(RuleSource::UserSettings, RuleBehavior::Deny, "WebFetch"),
            sourced(RuleSource::LocalSettings, RuleBehavior::Allow, "Glob"),
            sourced(RuleSource::Session, RuleBehavior::Allow, "Edit"),
        ],
        ..PermissionRules::default()
    });
    let store = MemoryStore::default();
    add(&store, RuleBehavior::Allow, "Read").await;
    let query = PermissionRulesQuery {
        workspace: workspace(),
        session: Some(SessionId::new("ses_1")),
    };
    let rules = listing(&gate, &store, &query).await.unwrap();
    assert_eq!(
        texts(&rules),
        [
            (
                RuleSource::UserSettings,
                RuleBehavior::Deny,
                "WebFetch".to_owned()
            ),
            (
                RuleSource::LocalSettings,
                RuleBehavior::Allow,
                "Read".to_owned()
            ),
            (RuleSource::Session, RuleBehavior::Allow, "Edit".to_owned()),
        ]
    );
}

/// “总是允许”落库后（db 里已有规则），判决链读回同一份规则集：快照的 LocalSettings 层换成库值（R1-2）。
#[tokio::test]
async fn a_committed_always_allow_replaces_the_local_layer() {
    let gate = Arc::new(gate());
    let store = Arc::new(MemoryStore::default());
    add(&store, RuleBehavior::Allow, "Bash(npm test:*)").await;
    let shared = SharedRules {
        gate: gate.clone(),
        store: store.clone(),
    };
    shared.local_rules_committed(&workspace()).await;
    let snapshot = gate.rules();
    assert_eq!(snapshot.version, 4);
    assert_eq!(
        texts(&snapshot.rules),
        [
            (
                RuleSource::UserSettings,
                RuleBehavior::Deny,
                "WebFetch".to_owned()
            ),
            (
                RuleSource::LocalSettings,
                RuleBehavior::Allow,
                "Bash(npm test:*)".to_owned()
            ),
            (
                RuleSource::CliArg,
                RuleBehavior::Allow,
                "Bash(git status:*)".to_owned()
            ),
        ]
    );
}

struct Bash;

#[async_trait::async_trait]
impl Tool for Bash {
    fn name(&self) -> &str {
        "Bash"
    }

    fn input_schema(&self) -> Value {
        json!({"type": "object"})
    }

    fn description(&self, _context: &PromptContext) -> String {
        String::new()
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        PermissionDecision::Passthrough
    }

    async fn call(
        &self,
        _input: Value,
        _context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        Err(ToolError::Unsupported {
            what: "test".to_owned(),
        })
    }
}

struct NoAnswers;

#[async_trait::async_trait]
impl Interactions for NoAnswers {
    async fn ask(
        &self,
        _session: &SessionId,
        _request: InteractionRequest,
    ) -> Result<InteractionAnswer, OrchestrationError> {
        Err(OrchestrationError::Unsupported {
            what: "test".to_owned(),
        })
    }
}

fn context_with(execution: ExecutionState) -> ToolUseContext {
    ToolUseContext {
        session: SessionId::new("s1"),
        run: RunId::new("r1"),
        tool_use: ToolUseId::new("toolu_1"),
        agent: None,
        workspace: WorkspaceRef {
            environment: EnvironmentId::new("local"),
            root: EnvPath::new("/w"),
        },
        mode: execution.effective(),
        execution,
        cancel: CancellationToken::new(),
        machine: machine(Arc::new(UnusedEnvironment)),
        local: local_services(Arc::new(UnusedEnvironment)),
        artifacts: Arc::new(MemoryStore::default()),
        interactions: Arc::new(NoAnswers),
        operation: OperationContext {
            environment: EnvironmentId::new("local"),
            generation: Generation::new("g"),
            owner_epoch: OwnerEpoch::LOCAL,
            operation: OperationId::new("op"),
            origin: Origin::Agent {
                session: SessionId::new("s1"),
                run: RunId::new("r1"),
            },
        },
    }
}

/// 修复线 A1：执行管线拿到的 `SharedRules` 必须把 `ask_once` 转给 `PolicyGate`，否则 guarded（含 plan +
/// guarded）的危险命令会跑 PermissionRequest hooks，hook 就能替用户批准（trait 缺省是 false）。
#[tokio::test]
async fn the_runtime_gate_forwards_the_single_use_ask() {
    let gate = Arc::new(PolicyGate::default());
    let shared = SharedRules {
        gate: gate.clone(),
        store: Arc::new(MemoryStore::default()),
    };
    let tool = Bash;
    let input = json!({"command": "rm -rf build"});
    for execution in [
        ExecutionState::from(PermissionMode::Guarded),
        ExecutionState::from(PermissionMode::Guarded).with_plan(true),
    ] {
        assert!(
            shared
                .ask_once(&tool, &input, &context_with(execution))
                .await,
            "{execution:?}"
        );
    }
    assert!(
        !shared
            .ask_once(
                &tool,
                &input,
                &context_with(ExecutionState::from(PermissionMode::Default))
            )
            .await
    );
}

#[tokio::test]
async fn changes_go_to_the_store_and_replace_the_snapshot() {
    let gate = gate();
    let store = MemoryStore::default();
    let session = SessionId::new("ses_1");
    let request = |change| PermissionRulesChange {
        workspace: workspace(),
        session: Some(session.clone()),
        change,
    };
    let rules = change(
        &gate,
        &store,
        request(RuleChange::Add {
            behavior: RuleBehavior::Allow,
            rules: vec![" Bash(rm *) ".to_owned()],
        }),
    )
    .await
    .unwrap();
    // 快照里的 LocalSettings 换成落库后的规则集（旧的 Glob 不在 db 里，被换掉），版本加一。
    let snapshot = gate.rules();
    assert_eq!(snapshot.version, 4);
    assert_eq!(
        texts(&snapshot.rules),
        [
            (
                RuleSource::UserSettings,
                RuleBehavior::Deny,
                "WebFetch".to_owned()
            ),
            (
                RuleSource::LocalSettings,
                RuleBehavior::Allow,
                "Bash(rm *)".to_owned()
            ),
            (
                RuleSource::CliArg,
                RuleBehavior::Allow,
                "Bash(git status:*)".to_owned()
            ),
        ]
    );
    assert_eq!(rules.len(), 3);
    // 删除 LocalSettings 的允许规则：db 与快照里都没有了。
    let local = sourced(RuleSource::LocalSettings, RuleBehavior::Allow, "Bash(rm *)");
    change(&gate, &store, request(RuleChange::Remove { rule: local }))
        .await
        .unwrap();
    assert!(
        store
            .project_rules(&workspace())
            .await
            .unwrap()
            .allow
            .is_empty()
    );
    assert_eq!(gate.rules().rules.len(), 2);
    // 命令行规则只在内存里去掉；配置文件规则只读。
    let cli = sourced(
        RuleSource::CliArg,
        RuleBehavior::Allow,
        "Bash(git status:*)",
    );
    let rules = change(&gate, &store, request(RuleChange::Remove { rule: cli }))
        .await
        .unwrap();
    assert_eq!(rules.len(), 1);
    let user = sourced(RuleSource::UserSettings, RuleBehavior::Deny, "WebFetch");
    let refused = change(&gate, &store, request(RuleChange::Remove { rule: user }))
        .await
        .unwrap_err();
    assert!(refused.to_string().contains("read-only"), "{refused}");
    assert_eq!(gate.rules().rules.len(), 1);
}

/// PermissionRequest hook 的 `updatedPermissions`（permission-updates.md §2.4）：`Local` 落本机项目规则集并读回
/// （加、换、删），`Session` 只进触发它的会话的内存层（子代理不改父会话）。
#[tokio::test]
async fn hook_permission_updates_land_where_their_destination_says() {
    use nibi_kernel_api::permission::PermissionRule;
    use nibi_kernel_api::permission_updates::{PermissionUpdate, UpdatePlace};

    let gate = Arc::new(PolicyGate::default());
    let store = Arc::new(MemoryStore::default());
    let shared = SharedRules {
        gate: gate.clone(),
        store: store.clone(),
    };
    let child = SessionId::new("ses_child");
    let rule = |tool: &str, content: Option<&str>| PermissionRule {
        tool: tool.to_owned(),
        content: content.map(str::to_owned),
    };
    let updates = [
        PermissionUpdate::AddRules {
            place: UpdatePlace::Local,
            behavior: RuleBehavior::Allow,
            rules: vec![rule("Bash", Some("npm test"))],
        },
        PermissionUpdate::ReplaceRules {
            place: UpdatePlace::Local,
            behavior: RuleBehavior::Allow,
            rules: vec![rule("Read", None)],
        },
        PermissionUpdate::RemoveRules {
            place: UpdatePlace::Local,
            behavior: RuleBehavior::Deny,
            rules: vec![rule("Write", None)],
        },
        PermissionUpdate::AddRules {
            place: UpdatePlace::Session,
            behavior: RuleBehavior::Deny,
            rules: vec![rule("Bash", Some("rm -rf /"))],
        },
    ];
    shared
        .apply_permission_updates(&child, &workspace(), &updates)
        .await
        .unwrap();
    // 本机项目规则集：换（replaceRules）之后只剩 Read；删除不存在的 deny 不影响。
    let project = store.project_rules(&workspace()).await.unwrap();
    assert_eq!(project.allow, [rule("Read", None)]);
    assert!(project.deny.is_empty() && project.ask.is_empty());
    // 判决链：Local 读回；Session 只在子会话。
    let snapshot = gate.rules();
    assert!(
        snapshot
            .rules
            .iter()
            .any(|known| known.source == RuleSource::LocalSettings
                && known.rule == rule("Read", None))
    );
    let context_for = |session: &str| {
        let mut context = context_with(ExecutionState::default());
        context.session = SessionId::new(session);
        context
    };
    let decision = |session: &str| {
        let gate = gate.clone();
        let context = context_for(session);
        async move {
            gate.check_rules(&Bash, &json!({"command": "rm -rf /"}), &context)
                .await
        }
    };
    assert!(
        matches!(
            decision("ses_child").await,
            Some(PermissionDecision::Deny { .. })
        ),
        "the child session sees its hook deny rule"
    );
    assert!(
        !matches!(
            decision("ses_parent").await,
            Some(PermissionDecision::Deny { .. })
        ),
        "the parent session does not see the child's hook rule"
    );
}
