//! `/permissions` 的列表与修改（docs/specs/rust-cli/tui-manage.md §1.1）。
//!
//! 判决链只看 `PolicyGate` 的快照；LocalSettings 的持久值只在会话存储（Node 的 `local_setting`）。
//! 修改先落库，再用落库后读回的规则集换上新快照（快照是 db 的投影，不另存）。“总是允许”的回答走同一条路径
//! （[`SharedRules`]）。

use std::sync::Arc;

use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::orchestration::PermissionGate;
use nibi_kernel_api::permission::{
    PermissionDecision, PermissionRule, PermissionRules, PermissionRulesChange,
    PermissionRulesQuery, ProjectRules, RuleChange, RuleSource, SourcedRule,
};
use nibi_kernel_api::permission_updates::{PermissionUpdate, UpdatePlace, absolute_only};
use nibi_kernel_api::session_api::KernelError;
use nibi_kernel_api::store::{ProjectRulesChange, SessionStore, StoreError};
use nibi_kernel_api::tool::{Tool, ToolUseContext};
use nibi_kernel_policy::PolicyGate;
use serde_json::Value;

pub use nibi_kernel_policy::rules::{format_rule, parse_rule};
// Bash 询问框“不再询问”一行的种子与文字（shell-permissions.md §4.10，工作线 F72）：tui 不依赖 policy。
pub use nibi_kernel_policy::{bash_rule_label, bash_rule_seed};

fn kernel_error(error: StoreError) -> KernelError {
    match error {
        StoreError::Unsupported { what } => KernelError::Unsupported { what },
        other => KernelError::Failed {
            message: other.to_string(),
        },
    }
}

/// 列表：快照里的配置文件规则、db 现读的 LocalSettings、命令行规则与会话规则（只在内存里，进程里共用）。
pub(crate) async fn listing(
    gate: &PolicyGate,
    store: &dyn SessionStore,
    query: &PermissionRulesQuery,
) -> Result<Vec<SourcedRule>, KernelError> {
    let snapshot = gate.rules();
    let local = match store.project_rules(&query.workspace).await {
        Ok(rules) => rules.sourced(),
        // 不支持的存储：用快照里启动时读到的。
        Err(StoreError::Unsupported { .. }) => snapshot
            .rules
            .iter()
            .filter(|rule| rule.source == RuleSource::LocalSettings)
            .cloned()
            .collect(),
        Err(error) => return Err(kernel_error(error)),
    };
    let from = |sources: &[RuleSource]| {
        snapshot
            .rules
            .iter()
            .filter(|rule| sources.contains(&rule.source))
            .cloned()
            .collect::<Vec<_>>()
    };
    let mut rules = from(&[RuleSource::UserSettings, RuleSource::ProjectSettings]);
    rules.extend(local);
    rules.extend(from(&[RuleSource::CliArg, RuleSource::Session]));
    Ok(rules)
}

/// 换上新快照：其余来源不变，LocalSettings 换成落库后读回的规则集。
fn replace_local(gate: &PolicyGate, local: &ProjectRules) {
    let snapshot = gate.rules();
    let keep = |sources: &[RuleSource]| {
        snapshot
            .rules
            .iter()
            .filter(|rule| sources.contains(&rule.source))
            .cloned()
            .collect::<Vec<_>>()
    };
    let mut rules = keep(&[RuleSource::UserSettings, RuleSource::ProjectSettings]);
    rules.extend(local.sourced());
    rules.extend(keep(&[RuleSource::CliArg, RuleSource::Session]));
    gate.replace_rules(PermissionRules {
        version: snapshot.version + 1,
        rules,
        ..(*snapshot).clone()
    });
}

/// 读回 `workspace` 的本机项目规则集，换上新的 LocalSettings 层（“总是允许”落库之后）。读不出时保留旧快照。
async fn reload_local(gate: &PolicyGate, store: &dyn SessionStore, workspace: &WorkspaceRef) {
    match store.project_rules(workspace).await {
        Ok(rules) => replace_local(gate, &rules),
        Err(StoreError::Unsupported { .. }) => {}
        Err(error) => tracing::warn!(%error, "the local permission rules could not be read back"),
    }
}

/// 执行管线用的判决链：判决交给 [`PolicyGate`]；“总是允许”落库后读回库值、换上 LocalSettings 层
/// （shell-permissions.md §5）。规则只有快照一个来源，进程里的主线程、子代理与之后的会话共用一份权限上下文。
pub(crate) struct SharedRules {
    pub(crate) gate: Arc<PolicyGate>,
    pub(crate) store: Arc<dyn SessionStore>,
}

/// 会话行的权限记录（Node `updateSession({permission})` 的形状）：保留 `mode` 等规则以外的键，三类规则写成
/// `{toolName, ruleContent?}`（hook 的 `Session`/`Local` 规则更新落这里）。
fn session_rules_value(
    rules: &ProjectRules,
    current: Option<serde_json::Value>,
) -> serde_json::Value {
    let list = |rules: &[PermissionRule]| {
        rules
            .iter()
            .map(|rule| match &rule.content {
                Some(content) => serde_json::json!({"toolName": rule.tool, "ruleContent": content}),
                None => serde_json::json!({"toolName": rule.tool}),
            })
            .collect::<Vec<_>>()
    };
    let mut value = match current {
        Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
        _ => serde_json::json!({"version": 1, "scope": "session"}),
    };
    value["version"] = serde_json::json!(1);
    value["scope"] = serde_json::json!("session");
    for (key, rules) in [
        ("allow", &rules.allow),
        ("deny", &rules.deny),
        ("ask", &rules.ask),
    ] {
        if rules.is_empty() {
            if let Some(object) = value.as_object_mut() {
                object.remove(key);
            }
        } else {
            value[key] = serde_json::json!(list(rules));
        }
    }
    value
}

#[async_trait::async_trait]
impl PermissionGate for SharedRules {
    async fn decide(
        &self,
        tool: &dyn Tool,
        input: &Value,
        context: &ToolUseContext,
    ) -> PermissionDecision {
        self.gate.decide(tool, input, context).await
    }

    async fn check_rules(
        &self,
        tool: &dyn Tool,
        input: &Value,
        context: &ToolUseContext,
    ) -> Option<PermissionDecision> {
        self.gate.check_rules(tool, input, context).await
    }

    /// guarded 的危险命令只批准这一次：执行管线据此不跑 PermissionRequest hooks（修复线 A1）。不转发时
    /// 用 trait 的缺省 `false`，hook 就能替用户批准——单元测试直接打 `PolicyGate` 看不出来，生产走这里。
    async fn ask_once(&self, tool: &dyn Tool, input: &Value, context: &ToolUseContext) -> bool {
        self.gate.ask_once(tool, input, context).await
    }

    async fn local_rules_committed(&self, workspace: &WorkspaceRef) {
        reload_local(&self.gate, self.store.as_ref(), workspace).await;
    }

    /// 群协作会话的“总是允许”落在会话行：重读它并换掉这个会话的规则层（gate 的快照只在会话打开时
    /// 取过一次）。
    async fn session_rules_committed(
        &self,
        session: &nibi_kernel_api::ids::SessionId,
        _workspace: &WorkspaceRef,
    ) {
        match self.store.session_rules(session).await {
            Ok(Some(rules)) => self.gate.scope(session, &rules),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(%error, session = %session.as_str(),
                    "the session permission rules could not be read back")
            }
        }
    }

    /// PermissionRequest hook 的 `updatedPermissions`（permission-updates.md §2.4）：`Session` 的规则进判决链的
    /// 会话内存层；`Local` 的规则落本机项目规则集（群协作会话落自己的会话行）；目录进/出这个会话的附加目录。
    /// `SetMode` 不在这里（模式的 owner 是会话 actor）。任何一步失败都回错误，调用方只记日志、这次调用照 hook
    /// 的结论走（fail-closed：没落下的更新只影响以后的询问）。
    async fn apply_permission_updates(
        &self,
        session: &nibi_kernel_api::ids::SessionId,
        workspace: &WorkspaceRef,
        updates: &[PermissionUpdate],
    ) -> Result<(), String> {
        if updates.is_empty() {
            return Ok(());
        }
        let updates = absolute_only(updates, &workspace.root);
        // 会话层（只在内存）。
        self.gate.apply_hook_rules(session, &updates);
        // 附加目录：只改这个会话的判决范围；本机项目规则集里没有保存附加目录的字段（与 Node 的规则集同形）。
        for update in &updates {
            match update {
                PermissionUpdate::AddDirectories { directories, .. } => {
                    self.gate.add_directories(session, directories);
                }
                PermissionUpdate::RemoveDirectories { directories, .. } => {
                    self.gate.remove_directories(session, directories);
                }
                PermissionUpdate::AddRules { .. }
                | PermissionUpdate::ReplaceRules { .. }
                | PermissionUpdate::RemoveRules { .. }
                | PermissionUpdate::SetMode { .. } => {}
            }
        }
        // 本机的规则：群协作会话（`scope = session`）写会话行，其余写本机项目规则集。
        let local: Vec<&PermissionUpdate> = updates
            .iter()
            .filter(|update| {
                matches!(
                    update,
                    PermissionUpdate::AddRules {
                        place: UpdatePlace::Local,
                        ..
                    } | PermissionUpdate::ReplaceRules {
                        place: UpdatePlace::Local,
                        ..
                    } | PermissionUpdate::RemoveRules {
                        place: UpdatePlace::Local,
                        ..
                    }
                )
            })
            .collect();
        if local.is_empty() {
            return Ok(());
        }
        match self.store.session_rules(session).await {
            Ok(Some(mut rules)) => {
                for update in &local {
                    nibi_kernel_api::permission_updates::apply_to_project_rules(&mut rules, update);
                }
                let current = self
                    .store
                    .session_permission(session)
                    .await
                    .map_err(|error| error.to_string())?;
                self.store
                    .set_session_permission(session, session_rules_value(&rules, current))
                    .await
                    .map_err(|error| error.to_string())?;
                self.gate.scope(session, &rules);
                Ok(())
            }
            // 没有会话行（普通会话），或存储不支持会话行（测试/嵌入）：落本机项目规则集。
            Ok(None) | Err(StoreError::Unsupported { .. }) => {
                for update in &local {
                    let Some(change) = project_change(update) else {
                        continue;
                    };
                    self.store
                        .change_project_rules(workspace, change)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                // 落库后读回，换上 LocalSettings 层（与“总是允许”同一条路径）。
                reload_local(&self.gate, self.store.as_ref(), workspace).await;
                Ok(())
            }
            Err(error) => Err(error.to_string()),
        }
    }
}

/// `Local` 的规则更新 → 本机项目规则集的一次修改；不是规则更新时 None。
fn project_change(update: &PermissionUpdate) -> Option<ProjectRulesChange> {
    match update {
        PermissionUpdate::AddRules {
            behavior, rules, ..
        } => Some(ProjectRulesChange {
            behavior: *behavior,
            replace: false,
            add: rules.clone(),
            remove: Vec::new(),
        }),
        PermissionUpdate::ReplaceRules {
            behavior, rules, ..
        } => Some(ProjectRulesChange {
            behavior: *behavior,
            replace: true,
            add: rules.clone(),
            remove: Vec::new(),
        }),
        PermissionUpdate::RemoveRules {
            behavior, rules, ..
        } => Some(ProjectRulesChange {
            behavior: *behavior,
            replace: false,
            add: Vec::new(),
            remove: rules.clone(),
        }),
        PermissionUpdate::SetMode { .. }
        | PermissionUpdate::AddDirectories { .. }
        | PermissionUpdate::RemoveDirectories { .. } => None,
    }
}

async fn change_local(
    gate: &PolicyGate,
    store: &dyn SessionStore,
    request: &PermissionRulesChange,
    change: ProjectRulesChange,
) -> Result<(), KernelError> {
    let rules = store
        .change_project_rules(&request.workspace, change)
        .await
        .map_err(kernel_error)?;
    replace_local(gate, &rules);
    Ok(())
}

/// 一次修改，返回修改后的列表。
pub(crate) async fn change(
    gate: &PolicyGate,
    store: &dyn SessionStore,
    request: PermissionRulesChange,
) -> Result<Vec<SourcedRule>, KernelError> {
    match &request.change {
        RuleChange::Add { behavior, rules } => {
            let add: Vec<PermissionRule> = rules
                .iter()
                .map(|text| text.trim())
                .filter(|text| !text.is_empty())
                .map(parse_rule)
                .collect();
            let change = ProjectRulesChange {
                behavior: *behavior,
                replace: false,
                add,
                remove: Vec::new(),
            };
            change_local(gate, store, &request, change).await?;
        }
        RuleChange::Remove { rule } => match rule.source {
            RuleSource::LocalSettings => {
                let change = ProjectRulesChange {
                    behavior: rule.behavior,
                    replace: false,
                    add: Vec::new(),
                    remove: vec![rule.rule.clone()],
                };
                change_local(gate, store, &request, change).await?;
            }
            // 命令行与会话规则只在内存里去掉（cliArg、session 两种来源）。
            RuleSource::CliArg | RuleSource::Session => {
                let snapshot = gate.rules();
                let rules = snapshot
                    .rules
                    .iter()
                    .filter(|known| *known != rule)
                    .cloned()
                    .collect();
                gate.replace_rules(PermissionRules {
                    version: snapshot.version + 1,
                    rules,
                    ..(*snapshot).clone()
                });
            }
            RuleSource::UserSettings | RuleSource::ProjectSettings => {
                return Err(KernelError::Failed {
                    message: format!(
                        "{} comes from a read-only source and cannot be modified here",
                        format_rule(&rule.rule)
                    ),
                });
            }
        },
    }
    let query = PermissionRulesQuery {
        workspace: request.workspace,
        session: request.session,
    };
    listing(gate, store, &query).await
}

#[cfg(test)]
#[path = "permissions_tests.rs"]
mod tests;
