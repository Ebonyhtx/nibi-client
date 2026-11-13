//! 权限：模式、规则语法、判决链、Bash 只读判定（docs/specs/rust-cli/shell-permissions.md §4）。
//!
//! 判决顺序（[`chain`]）：deny 规则 → 工具自身的检查 → ask 规则 → 模式
//! （bypassPermissions 也遵守 deny、ask 规则与安全路径）→ allow 规则 → 询问；外层再按 dontAsk /
//! auto / plan 改写询问。工具没有自己的检查时，Bash、文件工具、WebFetch 用这里的内置检查。
//!
//! plan 是独立开关（[`ExecutionState`]）：判决用的模式是 plan；plan 的闸门（非只读工具直接拒绝）先于
//! guarded 的单次确认，所以危险命令在 plan 下是拒绝而不是询问。危险命令的识别按**基础模式**
//! （[`execution_of`]），hook 放行也不能把 plan 的拒绝降级成一次确认（Node 3.17.2 `checkPermission`
//! 的顺序，修复线 A1）。
//!
//! 规则只来自配置快照（[`PermissionRules`]，由入口层组装后交进来，“总是允许”落库后由 runtime 换上新的
//! LocalSettings 层；进程里所有会话共用一份权限上下文）。这里不做 IO：cwd、home 与命令
//! 输出目录都从执行环境的端口取。Bash 解析与只读判定复制自 `apps/nibi-cli-rust/crates/{bash-parse,bash}`。

mod bash;
mod bash_cd;
mod bash_compound;
mod bash_inline;
mod bash_paths;
mod bash_subst;
mod bash_suggest;
mod bfs_args;
pub mod chain;
pub mod check;
pub mod classifier;
mod files;
pub mod guarded;
mod parse;
pub mod paths;
pub mod readonly;
mod removal;
pub mod rules;
mod safe_env;
mod shell_argv;
pub mod shell_rules;
mod shell_strip;
mod skill;
mod suggest;
mod suggest_seed;
mod suggest_spec;
pub mod texts;
pub mod web_preapproved;

#[cfg(test)]
mod test_support;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use async_trait::async_trait;
use nibi_kernel_api::env_files::PathStyle;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::orchestration::PermissionGate;
use nibi_kernel_api::permission::{
    ExecutionState, PermissionDecision, PermissionMode, PermissionRule, PermissionRules, ToolPolicy,
};
use nibi_kernel_api::plan::PlanFiles;
use nibi_kernel_api::session_api::DynamicWorkflowGate;
use nibi_kernel_api::tool::{Tool, ToolUseContext};
use serde_json::Value;

pub use parse::{Analysis, Invocation, analyze, is_permission_safe};
pub use suggest::suggestion as bash_suggestion;
pub use suggest_seed::{rule_label as bash_rule_label, rule_seed as bash_rule_seed};

use crate::chain::{Call, Outer};
use crate::check::Inputs;
use crate::classifier::{AutoClassifier, Unavailable};
use crate::paths::PathContext;
use crate::rules::Rules;

/// 判决链的开关。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyOptions {
    /// plan 模式按自动模式的语义走分类器（缺省开启）。
    pub auto_in_plan: bool,
}

impl Default for PolicyOptions {
    fn default() -> Self {
        Self { auto_in_plan: true }
    }
}

/// 通用权限判决链。
///
/// 修复（R1-2）：以前“总是允许”在这里另存一份按会话的规则（`session_rules`），库里还有一份，LocalSettings 层不刷新：
/// 子代理与 `/clear` 之后的新会话（别的会话 ID）又问一次，`/permissions` 也要去重补偿。现在规则只有快照一个来源，
/// 回答落库后 runtime 按 `/permissions` 的路径读回库值换上新快照。
pub struct PolicyGate {
    rules: RwLock<Arc<PermissionRules>>,
    /// Node 群协作会话（`permission.scope = session`）自己的规则集：判决时代替快照里的本机项目规则集
    /// （LocalSettings）。会话 actor 打开这种会话时由 runtime 放进来（修复线 F2）。
    scoped: Mutex<HashMap<SessionId, Vec<nibi_kernel_api::permission::SourcedRule>>>,
    /// 会话级的工具清单（NIBI `createSession.toolAllowlist/toolDenylist`）：工具清单与查找先按它过滤，
    /// 判决链再按规则判。会话关闭时随 `release` 清掉。
    tool_policies: Mutex<HashMap<SessionId, ToolPolicy>>,
    /// 会话的动态工作流灰度门（NIBI Host 的 `dynamicWorkflowEnabled`）：关闭时三个工作流工具不进
    /// 该会话的工具表。没登记 = 不参加灰度（CLI/TUI），工具全注册。
    dynamic_workflows: Mutex<HashMap<SessionId, DynamicWorkflowGate>>,
    /// 没登记门的会话的缺省值（子代理与 actor 会话直接经存储建，不经过内核的会话启动路径）：
    /// Host 进程由入口置成关闭（fail-closed，Agent 工具不能变成绕开灰度的后门）；CLI/TUI 不参加灰度。
    dynamic_workflow_default: Mutex<DynamicWorkflowGate>,
    /// `onDemand` 会话里已经激活工作流工具面的那些（`/workflow`、GUI 的启动/恢复/修订、
    /// 冷恢复扫描历史）。只加不减，Node `dynamicWorkflowToolsActivated` 的同一条语义。
    dynamic_workflow_activated: Mutex<HashSet<SessionId>>,
    /// 本进程有没有接上 DWF 引擎（sidecar）。作者工具与留白补全只在有引擎时进工具表——
    /// 挂一个永远失败的工具体比缺一个工具更糟：模型会据此反复重试。
    workflow_authoring: AtomicBool,
    classifier: Arc<dyn AutoClassifier>,
    options: PolicyOptions,
    /// 会话的附加工作目录（NIBI `createSession.additionalDirectories`）：判决时按会话取，
    /// 与进程级 `--add-dir` 一起进路径根的允许范围（远端机器不带过去，同下）。
    directories: Option<Arc<nibi_kernel_api::session_paths::SessionDirectories>>,
}

impl Default for PolicyGate {
    fn default() -> Self {
        Self::new(PermissionRules::default())
    }
}

impl PolicyGate {
    pub fn new(rules: PermissionRules) -> Self {
        Self {
            rules: RwLock::new(Arc::new(rules)),
            scoped: Mutex::default(),
            tool_policies: Mutex::default(),
            dynamic_workflows: Mutex::default(),
            dynamic_workflow_default: Mutex::new(DynamicWorkflowGate::UNGATED),
            dynamic_workflow_activated: Mutex::default(),
            workflow_authoring: AtomicBool::new(false),
            classifier: Arc::new(Unavailable),
            options: PolicyOptions::default(),
            directories: None,
        }
    }

    #[must_use]
    pub fn with_classifier(mut self, classifier: Arc<dyn AutoClassifier>) -> Self {
        self.classifier = classifier;
        self
    }

    #[must_use]
    pub fn with_options(mut self, options: PolicyOptions) -> Self {
        self.options = options;
        self
    }

    /// 接上会话的附加工作目录（runtime 建一个句柄，与内存里的会话表一起给）。
    #[must_use]
    pub fn with_session_directories(
        mut self,
        directories: Arc<nibi_kernel_api::session_paths::SessionDirectories>,
    ) -> Self {
        self.directories = Some(directories);
        self
    }

    /// 配置重载后换上新的规则快照；进行中的判决用的仍是旧快照。
    pub fn replace_rules(&self, rules: PermissionRules) {
        *self.rules.write().unwrap_or_else(PoisonError::into_inner) = Arc::new(rules);
    }

    fn snapshot(&self) -> Arc<PermissionRules> {
        self.rules
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// 当前的规则快照（`/permissions` 的列表与修改，docs/specs/rust-cli/tui-manage.md §1.1）。
    pub fn rules(&self) -> Arc<PermissionRules> {
        self.snapshot()
    }

    /// Node 群协作会话的规则集（Node `loadProjectPermissionRuleset`：`scope = session` 时只用会话行的规则）：这个
    /// 会话的判决不用本机项目规则集，改用它。修复线 F2：以前续写这种会话时用的是项目规则。
    pub fn scope(
        &self,
        session: &SessionId,
        rules: &nibi_kernel_api::permission::ProjectRules,
    ) {
        self.scoped
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session.clone(), rules.sourced());
    }

    /// 会话关闭时清掉它的群协作规则集（session-lifecycle.md §3.3 的关闭路径；再打开时 runtime 从会话行重放）。
    pub fn release(&self, session: &SessionId) {
        self.scoped
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session);
        self.tool_policies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session);
        self.dynamic_workflows
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session);
        self.dynamic_workflow_activated
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session);
    }

    /// 设置会话级的工具清单（NIBI create/resume 的 toolAllowlist/toolDenylist）。
    pub fn set_tool_policy(&self, session: &SessionId, policy: ToolPolicy) {
        self.tool_policies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session.clone(), policy);
    }

    /// 这个会话的工具清单；没设过时为 None（不限制）。
    pub fn tool_policy(&self, session: &SessionId) -> Option<ToolPolicy> {
        self.tool_policies
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session)
            .cloned()
    }

    /// 设置会话的动态工作流灰度门（Host 的 workspace 策略或 createSession 显式值）。
    pub fn set_dynamic_workflow(&self, session: &SessionId, gate: DynamicWorkflowGate) {
        self.dynamic_workflows
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session.clone(), gate);
    }

    /// 没登记门的会话的缺省值（入口按「是否在服务 Host 协议」设置；缺省不参加灰度）。
    pub fn set_dynamic_workflow_default(&self, gate: DynamicWorkflowGate) {
        *self
            .dynamic_workflow_default
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = gate;
    }

    /// 这个会话的动态工作流灰度门；没登记时用进程缺省（CLI/TUI 不参加灰度）。
    pub fn dynamic_workflow(&self, session: &SessionId) -> DynamicWorkflowGate {
        self.dynamic_workflow_override(session)
            .unwrap_or_else(|| {
                *self
                    .dynamic_workflow_default
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
            })
    }

    /// 登记过的门（子代理继承父会话时要区分「登记为关闭」与「没参加灰度」）。
    pub fn dynamic_workflow_override(&self, session: &SessionId) -> Option<DynamicWorkflowGate> {
        self.dynamic_workflows
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session)
            .copied()
    }

    /// 这个会话此刻能不能看见工作流工具：门开着，且不是「按需模式尚未激活」。
    pub fn dynamic_workflow_visible(&self, session: &SessionId) -> bool {
        let gate = self.dynamic_workflow(session);
        gate.enabled
            && (!gate.on_demand
                || self
                    .dynamic_workflow_activated
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .contains(session))
    }

    /// 激活本会话的工作流工具面（`/workflow`、GUI 的启动/恢复/修订、冷恢复历史扫描）。
    /// 只加不减；激活本身不改变灰度结论（门关着时仍然不可见）。
    pub fn activate_dynamic_workflow(&self, session: &SessionId) {
        self.dynamic_workflow_activated
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session.clone());
    }

    /// 本进程接上了 DWF 引擎（sidecar）：作者工具与留白补全进工具表。
    pub fn set_workflow_authoring(&self, available: bool) {
        self.workflow_authoring.store(available, Ordering::Relaxed);
    }

    /// 本进程有没有 DWF 引擎。
    pub fn workflow_authoring(&self) -> bool {
        self.workflow_authoring.load(Ordering::Relaxed)
    }

    /// 这个会话判决用的快照：群协作会话把 LocalSettings 换成它自己的规则集，其余会话就是当前快照。
    fn snapshot_for(&self, session: &SessionId) -> Arc<PermissionRules> {
        let base = self.snapshot();
        let scoped = self
            .scoped
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session)
            .cloned();
        let Some(scoped) = scoped else {
            return base;
        };
        let mut rules = (*base).clone();
        rules.rules.retain(|rule| {
            rule.source != nibi_kernel_api::permission::RuleSource::LocalSettings
        });
        rules.rules.extend(scoped);
        Arc::new(rules)
    }

    /// 从执行环境取路径事实：cwd 取会话的 shell cwd（会话的当前目录，取不到时用工作区根；与文件工具的
    /// `env_shell::current_dir` 同一来源，tools-files.md §3.3），命令输出目录取同一份 shell 状态。
    async fn path_context(&self, base: &PermissionRules, context: &ToolUseContext) -> PathContext {
        let workspace = &context.workspace;
        let shell = context
            .machine
            .shell()
            .shell_state(workspace, &context.session)
            .await
            .ok();
        let facts = context.machine.info().path_facts(workspace).await.ok();
        // 计划文件与 ExitPlanMode、计划模式 attachment 同一来源（kernel-api `PlanFiles`）：
        // `<工作区>/.nibi/plans/plan-<会话>.md`（tools-more.md §2.2）。
        let plans = facts
            .as_ref()
            .and_then(|facts| PlanFiles::in_workspace(facts, &workspace.root, &context.session));
        let mut roots = vec![workspace.root.as_str().to_owned()];
        // 远端机器的允许范围只有它的工作目录：本机的附加目录不带过去（R3，暂定，remote-exec.md §20.8）。
        if context.machine.is_local() {
            roots.extend(
                base.additional_directories
                    .iter()
                    .map(|dir| dir.as_str().to_owned()),
            );
            // 会话自己的附加目录（NIBI createSession.additionalDirectories）：工作区之外也按"在工作区内"判决。
            if let Some(directories) = &self.directories {
                roots.extend(
                    directories
                        .get(&context.session)
                        .iter()
                        .map(|dir| dir.as_str().to_owned()),
                );
            }
        }
        PathContext {
            cwd: shell.as_ref().map_or_else(
                || workspace.root.as_str().to_owned(),
                |shell| shell.cwd.as_str().to_owned(),
            ),
            roots,
            home: facts
                .as_ref()
                .and_then(|facts| facts.home.as_ref())
                .map(|home| home.as_str().to_owned()),
            style: facts.map_or(PathStyle::Posix, |facts| facts.style),
            internal: shell
                .and_then(|shell| shell.outputs)
                .map(|outputs| vec![outputs.as_str().to_owned()])
                .unwrap_or_default(),
            plans,
        }
    }
}

/// 判决链看的基础权限模式与 plan 开关（Node 3.17.2 `ExecutionState{mode, planEnabled}`）。
///
/// `ToolUseContext.mode` 是判决用的模式（`effective()`，plan 开时是 plan），单看它分不出基础模式是
/// yolo 还是 guarded。`execution` 是会话 actor 的完整快照；早期的单值构造点把它填成
/// `ExecutionState::from(mode)`（plan 时记作“plan + default”），这里按 `mode == Plan` 补回 plan 开关。
fn execution_of(context: &ToolUseContext) -> ExecutionState {
    let state = context.execution;
    ExecutionState {
        mode: state.base_mode(),
        // 旧构造点：`execution` 是 `from(mode)`（plan 时基础模式记 default），判决用的模式是 plan 时补上开关。
        plan: state.plan_enabled() || context.mode == PermissionMode::Plan,
    }
}

impl PolicyGate {
    /// 与 [`PermissionGate::decide`] 相同，另把 `allowed` 当作这一次判决的 allow 规则（skill 的
    /// `allowed-tools`，docs/specs/rust-cli/ext.md §2.5）。
    /// deny、ask 规则仍然优先。
    pub async fn decide_with_allowed(
        &self,
        tool: &dyn Tool,
        input: &Value,
        context: &ToolUseContext,
        allowed: &[PermissionRule],
    ) -> PermissionDecision {
        let base = self.snapshot_for(&context.session);
        let rules = Rules {
            base: &base,
            session: allowed,
        };
        let paths = self.path_context(&base, context).await;
        let root = context.workspace.root.as_str();
        let own = tool.check_permissions(input, context).await;
        let name = tool.name();
        // 修复线 A1（Node 3.17.2 `checkPermission`）：plan 是独立开关，基础模式另取 `execution.mode`。
        // plan 的拒绝先于 guarded 的确认：`chain::inner` 对 plan 下的危险命令直接拒绝，dangerous 的单次
        // 确认只可能在 plan 闸门放过之后执行（Node `checkPlanMode` 的 deny 在 guarded ask 之前）。
        let execution = execution_of(context);
        let base_mode = execution.mode;
        let mode = execution.effective();
        let dangerous = guarded::applies(base_mode, name, input, paths.style);
        let evaluate = |mode: PermissionMode| {
            let inputs = Inputs {
                mode,
                rules: &rules,
                paths: &paths,
                root,
                dangerous,
                hook_check: false,
                full_access: mode == PermissionMode::BypassPermissions,
            };
            let (check, updated) = chain::own(name, own.clone(), input, &inputs);
            chain::inner(name, check, updated, &inputs)
        };
        let result = evaluate(mode);
        let call = Call {
            tool: name,
            input,
            session: &context.session,
            mode,
        };
        let options = Outer {
            auto_in_plan: self.options.auto_in_plan,
            avoid_prompts: base.avoid_prompts,
        };
        chain::outer(
            &call,
            result,
            || evaluate(PermissionMode::AcceptEdits),
            self.classifier.as_ref(),
            options,
        )
        .await
    }
}

#[async_trait]
impl PermissionGate for PolicyGate {
    async fn decide(
        &self,
        tool: &dyn Tool,
        input: &Value,
        context: &ToolUseContext,
    ) -> PermissionDecision {
        self.decide_with_allowed(tool, input, context, &[]).await
    }

    /// hook 放行或询问时仍然生效的检查（不可绕过的权限关卡，
    /// docs/specs/rust-cli/hooks.md §6）：一般按 bypassPermissions 跑内层判决链，仍然拒绝或询问的就是
    /// deny / ask 规则、工具检查的拒绝与规则 / 安全检查的询问（敏感文件也算：`hook_check`）。基础模式是
    /// guarded 时按 guarded 跑（危险命令的 user-once），plan 开着时按 plan 跑（plan 的拒绝在 hook 之前）。
    async fn check_rules(
        &self,
        tool: &dyn Tool,
        input: &Value,
        context: &ToolUseContext,
    ) -> Option<PermissionDecision> {
        let base = self.snapshot_for(&context.session);
        let rules = Rules {
            base: &base,
            session: &[],
        };
        let paths = self.path_context(&base, context).await;
        // guarded 按 guarded 跑：hook 放行时危险命令仍然询问（Node user-once 不让 hook 替用户批准，修复线 F20）。
        // 基础模式从 `execution` 取（修复线 A1）：plan 开着时 `context.mode` 是 plan，基础模式 guarded 的危险
        // 命令仍要让 hook 放行过不了这一关。
        //
        // plan 开着时按 plan 跑（Node 先算权限判决、再套 PreToolUse 的 allow；plan 的拒绝排在 hook 前面）：
        // hook 放行只读调用，不放过 plan 会询问/拒绝的调用——管线拿到 Ask 后会走完整判决链，plan 分支照常生效。
        let execution = execution_of(context);
        let base_mode = execution.mode;
        let mode = if execution.plan {
            PermissionMode::Plan
        } else if base_mode == PermissionMode::Guarded {
            PermissionMode::Guarded
        } else {
            PermissionMode::BypassPermissions
        };
        let inputs = Inputs {
            mode,
            rules: &rules,
            paths: &paths,
            root: context.workspace.root.as_str(),
            dangerous: guarded::applies(base_mode, tool.name(), input, paths.style),
            hook_check: true,
            // 会话本身是 yolo（且 plan 关着）时 hook 放行后也不再询问（工作线 F76）；别的模式这里按 bypass 跑，
            // 但不算完全访问。
            full_access: base_mode == PermissionMode::BypassPermissions && !execution.plan,
        };
        let own = tool.check_permissions(input, context).await;
        let (check, updated) = chain::own(tool.name(), own, input, &inputs);
        match chain::inner(tool.name(), check, updated, &inputs) {
            chain::Inner::Allow { .. } => None,
            chain::Inner::Deny { message } => Some(PermissionDecision::Deny { message }),
            chain::Inner::Ask {
                message,
                suggestions,
                ..
            } => Some(PermissionDecision::Ask {
                message,
                suggestions,
            }),
        }
    }

    /// guarded 的危险命令只批准这一次（Node `approvalMode: "user-once"`，修复线 F20）：执行管线据此不跑
    /// PermissionRequest hooks。路径风格（方言）与判决同一来源（执行环境的 `path_facts`）。
    async fn ask_once(&self, tool: &dyn Tool, input: &Value, context: &ToolUseContext) -> bool {
        // 基础模式是 guarded 才只批准这一次（plan 开着时 `context.mode` 是 plan，见 `execution_of`）。
        let base_mode = execution_of(context).mode;
        if base_mode != PermissionMode::Guarded {
            return false;
        }
        let style = context
            .machine
            .info()
            .path_facts(&context.workspace)
            .await
            .map_or(PathStyle::Posix, |facts| facts.style);
        guarded::applies(base_mode, tool.name(), input, style)
    }
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;
