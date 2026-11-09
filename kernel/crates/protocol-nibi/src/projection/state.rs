//! 会话状态的 A 区字段（`snapshot.ts`）：control、availability、inputRouting、meta、config、usage、queue、
//! pendingInteractions。每个函数给出整段的值（`state.updated` 是字段级整体替换，不深合并）。

use nibi_kernel_api::message::Usage;
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::PermissionMode;
use serde_json::{Value, json};

/// 会话的阶段（`sessionPhaseSchema`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Draft,
    Running,
    CompletedSuccess,
    CompletedInterrupted,
    Error,
}

impl Phase {
    pub fn name(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Running => "running",
            Self::CompletedSuccess => "completedSuccess",
            Self::CompletedInterrupted => "completedInterrupted",
            Self::Error => "error",
        }
    }

    pub fn ended(self) -> bool {
        matches!(
            self,
            Self::CompletedSuccess | Self::CompletedInterrupted | Self::Error
        )
    }
}

/// 在跑的前台工作（`activeWorkSummarySchema`，P1 只有主回合）。
#[derive(Debug, Clone, PartialEq)]
pub struct ActiveWork {
    pub execution: String,
    pub command: Option<String>,
    pub started_at: u64,
}

/// 回合失败的说明（`sessionErrorInfoSchema`）。
#[derive(Debug, Clone, PartialEq)]
pub struct LastError {
    pub message: String,
    pub at: u64,
}

pub fn control(phase: Phase, active: Option<&ActiveWork>, error: Option<&LastError>) -> Value {
    let running = phase == Phase::Running;
    let works: Vec<Value> = active
        .filter(|_| running)
        .map(|work| {
            let mut value = json!({
                "kind": "primaryTurn",
                "foregroundExecutionId": work.execution,
                "startedAt": work.started_at,
            });
            if let Some(command) = &work.command {
                value["sourceCommandId"] = json!(command);
            }
            value
        })
        .into_iter()
        .collect();
    json!({
        "phase": phase.name(),
        "sessionEnded": phase.ended(),
        "canStop": running,
        "stopState": if running { "stoppable" } else { "idle" },
        "stopTargetKind": if running { "assistant" } else { "unknown" },
        "activeWorks": works,
        "lastError": error.map(|error| json!({
            "code": "fault.turn.failed",
            "message": error.message,
            "recoverable": true,
            "at": error.at,
            "source": "runtime",
        })),
        "apiRetry": null,
    })
}

fn allowed() -> Value {
    json!({"allowed": true})
}

fn denied(reason: &str) -> Value {
    json!({"allowed": false, "reasonCode": reason})
}

/// 操作是否可用。P1 不支持的命令（fork、compact、立即发送排队项）标成不可用，原因是 `proto.unsupportedCommand`。
pub fn availability() -> Value {
    let unsupported = "proto.unsupportedCommand";
    json!({
        "fork": denied(unsupported),
        "compact": denied(unsupported),
        "switchModelConfig": allowed(),
        "setFollowupMode": allowed(),
        "queueEdit": allowed(),
        "sendQueuedNow": denied(unsupported),
        "pauseGoal": denied("noGoalToPause"),
        "resumeGoal": denied("noGoalToResume"),
    })
}

/// 跟进的方式（`followupMode`）：运行中输入入队还是插话。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Followup {
    Queue,
    Guide,
}

impl Followup {
    pub fn name(self) -> &'static str {
        match self {
            Self::Queue => "queue",
            Self::Guide => "guide",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "queue" => Some(Self::Queue),
            "guide" => Some(Self::Guide),
            _ => None,
        }
    }
}

pub fn input_routing(phase: Phase, followup: Followup) -> Value {
    match (phase, followup) {
        (Phase::Running, Followup::Queue) => json!({"mode": "enqueue"}),
        (Phase::Running, Followup::Guide) => json!({"mode": "guide"}),
        _ => json!({"mode": "startNow"}),
    }
}

pub fn meta(title: &str, generated: bool) -> Value {
    json!({
        "title": title,
        "titleSource": if title.is_empty() { "default" } else if generated { "generated" } else { "custom" },
    })
}

/// App 的模型选择（`modelSelectionSchema`）。
pub fn selection(selection: &ModelSelection) -> Value {
    let mut value = json!({"providerId": selection.provider, "modelId": selection.model});
    if let Some(level) = &selection.reasoning {
        value["options"] = json!({"reasoningLevel": level});
    }
    value
}

/// App 的模式名（Node 的写法：default → build 等，README §5）。
pub fn mode_name(mode: PermissionMode) -> &'static str {
    mode.node_name()
}

/// 会话配置（`sessionConfigStateSchema`）。
pub fn config(
    current: &ModelSelection,
    mode: PermissionMode,
    plan: bool,
    followup: Followup,
    levels: &[String],
) -> Value {
    let mut value = json!({
        "provider": current.provider,
        "model": current.model,
        "thought": current.reasoning.clone().unwrap_or_default(),
        "thoughtLevels": levels,
        "followupMode": followup.name(),
        "mode": mode_name(mode),
        "planEnabled": plan,
    });
    // `modelSelection` 是稀疏的选择意图（schema 里 optional），Node 只在真的选过模型时才写。
    // 还没选模型时 provider/model 是空串，照 `selection()` 写出去就是
    // `{providerId: "", modelId: ""}`——`modelSelectionSchema` 要求两者非空，整份快照会被
    // schema 拒收，客户端报 `fault.subscription.contentRejected`（2026-11-09 真机：草稿预热
    // 会话打不开新建任务页）。这里与 Node 同口径：空选择时不写这个键。
    if !current.provider.trim().is_empty() && !current.model.trim().is_empty() {
        value["modelSelection"] = selection(current);
    }
    value
}

pub fn usage(
    context: Option<(u64, u64)>,
    total: &Usage,
    breakdown: &[nibi_kernel_api::context_usage::ContextBreakdownItem],
) -> Value {
    // 会话级缓存命中率：输入总量按「未缓存 + 缓存读 + 缓存写」算（Anthropic 的 input_tokens 不含缓存），
    // 与 Node `recordMainTurnCacheHitUsage` 同一口径。contextUsage 面板读 contextWindow.cache。
    let total_input = total
        .input_tokens
        .saturating_add(total.cache_read_input_tokens)
        .saturating_add(total.cache_creation_input_tokens);
    let hit_rate = if total_input > 0 {
        Some(total.cache_read_input_tokens as f64 / total_input as f64)
    } else {
        None
    };
    json!({
        "contextWindow": context.map(|(used, max)| {
            let mut window = json!({
                "usedTokens": used,
                "maxTokens": max,
                "autoCompactThresholdTokens": null,
                "cache": {
                    "inputTokens": total_input,
                    "cacheReadTokens": total.cache_read_input_tokens,
                    "cacheWriteTokens": total.cache_creation_input_tokens,
                    "hitRate": hit_rate,
                },
            });
            if !breakdown.is_empty() {
                window["breakdown"] = json!(breakdown);
            }
            window
        }),
        "cumulative": {
            "inputTokens": total.input_tokens,
            "outputTokens": total.output_tokens,
            "cacheReadTokens": total.cache_read_input_tokens,
            "cacheWriteTokens": total.cache_creation_input_tokens,
        },
    })
}

pub fn add_usage(total: &mut Usage, usage: &Usage) {
    total.input_tokens += usage.input_tokens;
    total.output_tokens += usage.output_tokens;
    total.cache_creation_input_tokens += usage.cache_creation_input_tokens;
    total.cache_read_input_tokens += usage.cache_read_input_tokens;
}

/// 权限询问的选项（与 Node 的 V4 投影同一组）：允许一次、本项目一直允许、拒绝。
pub fn permission_options() -> Value {
    json!([
        {"optionId": "allowOnce", "label": "Allow once", "kind": "allowOnce",
            "response": {"decision": "allow", "reason": "Approved once"}},
        {"optionId": "allowAlways", "label": "Always allow in this project", "kind": "allowAlways",
            "response": {"decision": "allow", "reason": "Approved for this project"}},
        {"optionId": "deny", "label": "Deny", "kind": "deny",
            "response": {"decision": "deny", "reason": "The user doesn't want to proceed with this tool use."}},
    ])
}

/// “完全访问”选项（与 Node 的 V4 投影相同）：选它时会话切到 yolo（bypassPermissions）并放行这一次。
pub fn full_access_option() -> Value {
    json!({"optionId": "fullAccess", "label": "Full access", "kind": "custom",
        "response": {"decision": "deny", "reason": "Full access requires V4 approval"}})
}

/// AskUserQuestion 的 userInput 投影里 `prompt` 的文案（Node `core/tool/handlers/ask-user-question.ts`
/// 的 permission reason；界面以结构化 `questions` 为主，这里与 Node 逐字一致）。
pub const ASK_QUESTION_PROMPT: &str =
    "AskUserQuestion pauses execution to collect answers from the user";

/// ExitPlanMode 的 userInput 投影里 `prompt` 的文案（Node 的 permission reason）。
pub const EXIT_PLAN_MODE_REASON: &str =
    "ExitPlanMode changes session mode after user plan approval";

pub const ASK_USER_QUESTION_TOOL: &str = "AskUserQuestion";
pub const EXIT_PLAN_MODE_TOOL: &str = "ExitPlanMode";

/// 提问的结构化载荷（Node `normalizeAskUserQuestionPayloadQuestion`）：每个选项补上 `value`
/// （模型输入没有这个字段，缺省等于 label），`multiSelect` 只在为真时写出。
pub fn question_payloads(questions: &Value) -> Value {
    Value::Array(
        questions
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|question| {
                        let text = question["question"].as_str()?;
                        let header = question["header"].as_str().unwrap_or(text);
                        let options: Vec<Value> = question["options"]
                            .as_array()
                            .map(|options| {
                                options
                                    .iter()
                                    .filter_map(|option| {
                                        let label = option["label"].as_str()?;
                                        let mut out = serde_json::Map::new();
                                        out.insert("value".into(), json!(label));
                                        out.insert("label".into(), json!(label));
                                        if let Some(description) = option["description"].as_str() {
                                            out.insert("description".into(), json!(description));
                                        }
                                        if let Some(preview) = option["preview"].as_str() {
                                            out.insert("preview".into(), json!(preview));
                                        }
                                        Some(Value::Object(out))
                                    })
                                    .collect()
                            })
                            .unwrap_or_default();
                        let mut out = serde_json::Map::new();
                        out.insert("question".into(), json!(text));
                        out.insert("header".into(), json!(header));
                        out.insert("options".into(), Value::Array(options));
                        if question["multiSelect"].as_bool() == Some(true) {
                            out.insert("multiSelect".into(), json!(true));
                        }
                        Some(Value::Object(out))
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

/// 计划审批的结构化载荷（Node `createExitPlanModeApprovalQuestion`）：一道“Approve”题。
pub fn plan_approval_questions() -> Value {
    json!([{
        "question": EXIT_PLAN_MODE_REASON,
        "header": "Plan",
        "options": [{
            "value": "approve",
            "label": "Approve",
            "description": "Exit plan mode and start implementation.",
        }],
    }])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selection(provider: &str, model: &str) -> ModelSelection {
        ModelSelection {
            provider: provider.to_owned(),
            model: model.to_owned(),
            reasoning: None,
            connection: None,
        }
    }

    /// 还没选模型（草稿预热、未配置 provider）时不能写 `modelSelection`：schema 要求
    /// providerId/modelId 非空，写出去整份快照会被拒（`fault.subscription.contentRejected`）。
    #[test]
    fn an_unselected_model_omits_the_sparse_selection() {
        let config = config(
            &selection("", ""),
            PermissionMode::Default,
            false,
            Followup::Queue,
            &[],
        );
        assert!(config.get("modelSelection").is_none());
        // provider/model 仍是空串：Node 的初始快照也是这个形状，UI 据此显示「未选择」。
        assert_eq!(config["provider"], "");
        assert_eq!(config["model"], "");
    }

    #[test]
    fn a_selected_model_carries_its_sparse_selection() {
        let config = config(
            &selection("p", "m"),
            PermissionMode::Default,
            false,
            Followup::Queue,
            &[],
        );
        assert_eq!(config["modelSelection"]["providerId"], "p");
        assert_eq!(config["modelSelection"]["modelId"], "m");
    }
}
