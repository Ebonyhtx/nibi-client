//! 工作流控制轮的会话记录（docs/dynamic-workflow/launch.md「The launch turn」与「The settings
//! turn」）：引擎受理一次中枢启动 / 修订之后，往父会话排一条 controlOnly 的合成输入——模型可见
//! 的记录（启动轮 / 已修订），GUI 的运行卡与冷恢复读 `metadata.workflowLaunch`。
//!
//! 与 Node 宿主（`startSavedWorkflowRun` / `amendWorkflowRunSettings` → controlOnly 轮）同形：
//! 同一条规范句（逐字移植，它进 provider transcript 不本地化）、同一个元数据形状与上界、同一条
//! 「成功后的记录失败只记日志」的规矩。真正落会话的是会话 actor 的 `Command::WorkflowLaunch`
//! （排队时机、存储编码在那一侧）。

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_kernel_api::session_api::Command;
use rust_cli_kernel_api::workflow::{WorkflowLaunchTurn, WorkflowRunStarted};
use serde_json::{Value, json};

/// 中枢直接启动要发的启动轮：`(Command::WorkflowLaunch, 会话)`；引擎没给材料（非 saved 路径）
/// 即缺席。元数据键序照 Node 的 `boundWorkflowLaunchMeta`；三项上界同款（args 4KB 超界换成
/// 标记袋、description 500 字符截断加省略号、script 256k 字符超界整体缺席）。
pub fn launch_turn(
    session: &SessionId,
    started: &WorkflowRunStarted,
) -> Option<(SessionId, Command)> {
    let launch: &WorkflowLaunchTurn = started.launch_turn.as_ref()?;
    let mut meta = json!({
        "runId": started.run_id,
        "toolCallId": started.tool_call_id,
        "name": launch.name,
        "scope": launch.scope,
    });
    if let Some(path) = &launch.path {
        meta["path"] = json!(path);
    }
    if let Some(args) = &launch.args {
        meta["args"] = bound_args(args);
    }
    if let Some(description) = &launch.description {
        meta["description"] = json!(ellipsize(description, WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS));
    }
    // display（因果图投影）是宿主分析面，引擎路径没有——整块缺席，侧板图随之缺席（与
    // GetWorkflowRun v1 的缺块同一条读法）。
    if let Some(script) = &launch.script
        && script.chars().count() <= WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS
    {
        meta["script"] = json!(script);
    }
    let text =
        build_launch_message_text(&launch.name, &launch.scope, &started.run_id, launch.args.as_ref());
    Some((
        session.clone(),
        Command::WorkflowLaunch {
            text,
            launch: meta,
        },
    ))
}

/// `boundWorkflowLaunchMeta` 的三项上界（contracts 里的同名常量）。
const WORKFLOW_LAUNCH_ARGS_MAX_BYTES: usize = 4_096;
const WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS: usize = 500;
const WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS: usize = 256_000;

/// args 序列化超界即整体换成单条标记袋（真实实参走模型面的规范句，那份不截断）。
fn bound_args(args: &Value) -> Value {
    let bytes = serde_json::to_vec(args).map(|raw| raw.len()).unwrap_or(0);
    if bytes > WORKFLOW_LAUNCH_ARGS_MAX_BYTES {
        json!({"…": format!("arguments omitted ({bytes} bytes)")})
    } else {
        args.clone()
    }
}

/// 字符上界的截断：超界取前 `max - 1` 个字符加省略号（Node 的同款做法，总长仍在上界内）。
fn ellipsize(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 启动轮的模型面规范句（英文，不本地化——它进 provider transcript，是模型下一回合读到的东西）。
/// 有实参时把实参以 JSON 块附上；末句无条件劝阻重复启动（run 已在飞，进度以通知形式回来）。
/// Node `buildLaunchMessageText` 的逐字移植。
fn build_launch_message_text(name: &str, scope: &str, run_id: &str, args: Option<&Value>) -> String {
    let mut lines = vec![format!(
        "Started the saved workflow \"{name}\" ({scope}) from the workflows hub as run {run_id}."
    )];
    let has_args = args
        .and_then(|args| args.as_object())
        .is_some_and(|args| !args.is_empty());
    if has_args {
        let pretty = serde_json::to_string_pretty(args.unwrap_or(&Value::Null))
            .unwrap_or_else(|_| "{}".to_owned());
        lines.push(String::new());
        lines.push("Arguments:".to_owned());
        lines.push("```json".to_owned());
        lines.push(pretty);
        lines.push("```".to_owned());
    }
    lines.push(String::new());
    lines.push(
        "Progress and results arrive as background notifications; do not start it again."
            .to_owned(),
    );
    lines.join("\n")
}

/// 引擎受理修订之后要发的控制轮：`(Command::WorkflowLaunch, 会话, 命令 ID)`；没有材料（引擎没给
/// `settings`）即缺席。
pub fn settings_turn(
    session: &SessionId,
    request_run_id: &str,
    started: &WorkflowRunStarted,
) -> Option<(SessionId, Command)> {
    let turn = started.settings_turn.as_ref()?;
    let amend = turn.amend.as_object()?;
    // 就地生效（同一个 runId）没有前驱可指；Node 的元数据同一条读法（缺席即就地生效）。
    let in_place = started.run_id == request_run_id;
    // 键序照 Node 的 `boundWorkflowLaunchMeta`：runId、toolCallId、name?、amend。
    let mut meta = json!({
        "runId": started.run_id,
        "toolCallId": started.tool_call_id,
    });
    if let Some(name) = &turn.name {
        meta["name"] = json!(name);
    }
    meta["amend"] = if in_place {
        json!(Value::Object(
            amend
                .iter()
                .filter(|(key, _)| key.as_str() != "predecessorRunId")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        ))
    } else {
        json!(Value::Object(amend.clone()))
    };
    let text = build_settings_message_text(SettingsTurnText {
        name: turn.name.as_deref(),
        previous: request_run_id,
        run_id: &started.run_id,
        superseded: started.superseded_run_id.is_some(),
        amend: &meta["amend"],
    });
    Some((
        session.clone(),
        Command::WorkflowLaunch {
            text,
            launch: meta,
        },
    ))
}

/// 设置轮的模型面规范句（英文，不本地化——它进 provider transcript）。只说改过的设置；两个
/// `null` 各有一句话。末句劝阻模型再动这个 run：它已经在跑，进展以通知回来。
///
/// 两种结局在这里分岔，判据就是 `amend.predecessorRunId` 在不在场（缺席即就地生效，与元数据同
/// 一条读法）：修订出了一个新 run，就地调并发则还是同一个 run——照修订那句话写下去，模型会去找
/// 一个根本不存在的 run B。Node `buildSettingsMessageText` 的逐字移植。
pub fn build_settings_message_text(input: SettingsTurnText<'_>) -> String {
    let SettingsTurnText {
        name,
        previous,
        run_id,
        superseded,
        amend,
    } = input;
    let in_place = amend["predecessorRunId"].is_null();
    let lead = format!(
        "Changed the settings of workflow run {previous}{} from the GUI: {}.",
        name.map(|name| format!(" (\"{name}\")"))
            .unwrap_or_default(),
        settings_change_clauses(amend, in_place).join("; "),
    );
    let closing =
        "Progress and results arrive as background notifications; do not amend, resume or restart it.";
    if in_place {
        let kept = if amend["maxConcurrency"]["to"].is_null() {
            format!("Run {previous} keeps running with no limit")
        } else {
            format!("Run {previous} keeps running under the new limit")
        };
        return [lead, format!("{kept}; nothing was stopped and no new run was started."), closing.to_owned()].join(" ");
    }
    let relation = if superseded {
        "supersedes"
    } else {
        "takes over from"
    };
    [
        lead,
        format!(
            "The same script continues as run {run_id}, which {relation} run {previous} and imports everything run {previous} finished as cache."
        ),
        closing.to_owned(),
    ]
    .join(" ")
}

/// 「改了什么」的分句（Node `settingsChangeClauses`）。就地生效那一条要把主语说全
/// （「at most n of **its subagents**」）：那条路上没有模型分句在前，一句「at most n of them」
/// 就没有了指代对象。
fn settings_change_clauses(amend: &Value, in_place: bool) -> Vec<String> {
    let mut changes = Vec::new();
    let model = &amend["subagentModel"];
    if !model.is_null() {
        changes.push(if model["to"].is_null() {
            "its subagents are back on the session model".to_owned()
        } else {
            format!("its subagents now run on {}", model["to"].as_str().unwrap_or_default())
        });
    }
    let bound = &amend["maxConcurrency"];
    if !bound.is_null() {
        changes.push(if bound["to"].is_null() {
            "the limit on subagents at once is back to the default".to_owned()
        } else if in_place {
            format!("at most {} of its subagents run at once", bound["to"])
        } else {
            format!("at most {} of them run at once", bound["to"])
        });
    }
    changes
}

/// [`build_settings_message_text`] 的入参。
pub struct SettingsTurnText<'a> {
    pub name: Option<&'a str>,
    pub previous: &'a str,
    pub run_id: &'a str,
    pub superseded: bool,
    /// Node `WorkflowSettingsAmendMeta` 的 JSON。
    pub amend: &'a Value,
}

#[cfg(test)]
#[path = "workflow_settings_turn_tests.rs"]
mod tests;
