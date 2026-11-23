//! TaskOutput（Node `TaskOutput`，docs/subagent-respond-to-coordinator.md 的配套工具）：读一个后台任务
//! （本机的后台命令或后台子代理）的状态与输出。描述与 schema 在 `prompts/tools/TaskOutput.json`。
//!
//! 任务的事实只有两处：后台命令在执行环境的账本里（与 TaskStop 同一条查询），子代理在 `live::Live` 与
//! 子会话的 `subagent_result` 里。这里只按查询时刻整理，不另记任务表。

use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_api::env_shell::{BackgroundStatus, BackgroundTask};
use nibi_kernel_api::ids::{AgentId, SessionId, ShellTaskId};
use nibi_kernel_api::machine::MachineEnv;
use nibi_kernel_api::permission::PermissionDecision;
use nibi_kernel_api::tool::{
    PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::Core;
use crate::live::{AgentState, LiveAgent};
use crate::report::Ending;
use crate::restore;

const NAME: &str = "TaskOutput";

/// 等待期间的轮询间隔（Node `TASK_OUTPUT_POLL_INTERVAL_MS`）。
const POLL_MS: u64 = 100;
/// `timeout` 的缺省值与上限（Node contract）。
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
/// display 里 `taskStatus` / `output` 的界（shared `tool-result-metadata.ts`）。
const DISPLAY_STATUS_CHARS: usize = 64;
const DISPLAY_OUTPUT_CHARS: usize = 2_000;
/// 给模型的结果超过这个字符数时落盘为 Artifact（Node `TASK_OUTPUT_PERSIST_THRESHOLD_CHARS`）。
const MODEL_CHARS: usize = 100_000;
/// 后台命令输出的读取上限（Node 运行中的前缀是 30,000 字节）。
const OUTPUT_TAIL_BYTES: u64 = 30_000;

#[derive(Deserialize)]
struct Input {
    task_id: String,
    #[serde(default)]
    block: Option<bool>,
    #[serde(default)]
    timeout: Option<u64>,
}

/// 一个任务的快照（agent 与命令整理成同一形状）。
struct Snapshot {
    task_id: String,
    task_type: &'static str,
    status: String,
    output: String,
    error: Option<String>,
    running: bool,
}

fn agent_status(agent: &LiveAgent) -> &'static str {
    match &agent.state {
        AgentState::Running { .. } => "running",
        // 停放的子代理这一轮跑完了，但还会被唤醒续跑（终态通知还没送出）：任务本身仍是活的。
        AgentState::Parked(_) => "running",
        AgentState::Finished(Ending::Completed) => "completed",
        AgentState::Finished(Ending::Failed) => "failed",
        AgentState::Finished(Ending::Killed | Ending::KilledParked) => "killed",
    }
}

pub(crate) struct TaskOutputTool {
    pub(crate) core: Arc<Core>,
}

impl TaskOutputTool {
    /// 子代理只在它自己派生的范围内可见（与 TaskStop 同一条规则）。
    fn visible(&self, agent: &LiveAgent, context: &ToolUseContext) -> bool {
        match &context.agent {
            None => agent.root == context.session,
            Some(_) => agent.parent == context.session,
        }
    }

    /// 后台命令要问的机器与会话（TaskStop 的同一条规则：本机 + 连上的远端）。
    fn machines(&self, context: &ToolUseContext) -> Vec<MachineEnv> {
        let registry = &self.core.ports.machines;
        let mut machines = vec![context.machine.clone()];
        machines.extend(
            registry
                .machines()
                .machines
                .iter()
                .filter_map(|remote| registry.machine(&remote.name)),
        );
        machines
    }

    fn command_sessions(&self, context: &ToolUseContext) -> Vec<SessionId> {
        let mut sessions = vec![context.session.clone()];
        if context.agent.is_none() {
            sessions.extend(self.core.live.with(|agents| {
                agents
                    .values()
                    .filter(|agent| agent.root == context.session)
                    .map(|agent| agent.child.clone())
                    .collect::<Vec<_>>()
            }));
        }
        sessions
    }

    /// 一个任务的快照；不认识时为 None。
    async fn snapshot(
        &self,
        id: &str,
        context: &ToolUseContext,
    ) -> Result<Option<Snapshot>, ToolError> {
        if let Some(agent) = self
            .core
            .live
            .get(&AgentId::new(id))
            .filter(|agent| self.visible(agent, context))
        {
            let status = agent_status(&agent).to_owned();
            let running = agent.is_live();
            let (output, error) = if running {
                (String::new(), None)
            } else {
                // 终态的结果正文在子会话的 `subagent_result`（与重启恢复、TaskOutput 同源）。
                match restore::latest_result(&self.core, &agent.child, &agent.agent).await {
                    Ok(Some(result)) => (result.text, result.error),
                    Ok(None) => (String::new(), None),
                    Err(error) => {
                        tracing::warn!(agent = %agent.agent, %error, "the subagent result could not be read");
                        (String::new(), None)
                    }
                }
            };
            return Ok(Some(Snapshot {
                task_id: id.to_owned(),
                task_type: "local_agent",
                status,
                output,
                error,
                running,
            }));
        }
        for machine in self.machines(context) {
            for session in self.command_sessions(context) {
                let key = BackgroundTask {
                    session: session.clone(),
                    task: ShellTaskId::new(id),
                };
                let Ok(Some(info)) = machine.background().background_command(key.clone()).await
                else {
                    continue;
                };
                let output = match machine
                    .background()
                    .background_output_tail(key, OUTPUT_TAIL_BYTES)
                    .await
                {
                    Ok(Some(tail)) => String::from_utf8_lossy(&tail.bytes).into_owned(),
                    _ => String::new(),
                };
                return Ok(Some(Snapshot {
                    task_id: id.to_owned(),
                    task_type: "local_bash",
                    status: info.status.as_str().to_owned(),
                    output,
                    error: None,
                    running: info.status == BackgroundStatus::Running,
                }));
            }
        }
        Ok(None)
    }

    /// 等任务到终态（Node `waitForTask`：100ms 一次，不越过 `timeout`）。
    async fn wait(
        &self,
        id: &str,
        timeout: u64,
        context: &ToolUseContext,
    ) -> Result<Option<Snapshot>, ToolError> {
        let deadline = self.core.ports.clock.now_ms().saturating_add(timeout);
        loop {
            let Some(snapshot) = self.snapshot(id, context).await? else {
                return Ok(None);
            };
            if !snapshot.running || self.core.ports.clock.now_ms() >= deadline {
                return Ok(Some(snapshot));
            }
            tokio::select! {
                _ = context.cancel.cancelled() => return Err(ToolError::Cancelled),
                () = tokio::time::sleep(std::time::Duration::from_millis(POLL_MS)) => {}
            }
        }
    }
}

/// 模型看到的全文（Node `formatTaskOutputModelContent`）。
fn model_content(retrieval: &str, task: Option<&Snapshot>) -> String {
    let mut blocks = vec![format!("<retrieval_status>{retrieval}</retrieval_status>")];
    if let Some(task) = task {
        blocks.push(format!("<task_id>{}</task_id>", task.task_id));
        blocks.push(format!("<task_type>{}</task_type>", task.task_type));
        blocks.push(format!("<status>{}</status>", task.status));
        let output = task.output.trim_end();
        if !output.trim().is_empty() {
            blocks.push(format!("<output>\n{output}\n</output>"));
        }
        if let Some(error) = &task.error {
            blocks.push(format!("<error>{error}</error>"));
        }
    }
    blocks.join("\n\n")
}

/// 按 UTF-16 单元截断（shared schema 的 `max` 按 JS 字符串长度算）。
fn first_units(text: &str, units: usize) -> String {
    let mut out = String::with_capacity(text.len());
    let mut used = 0;
    for character in text.chars() {
        let length = character.len_utf16();
        if used + length > units {
            break;
        }
        used += length;
        out.push(character);
    }
    out
}

/// 界面的 display（shared `task_output`）：只带有界的状态与输出，不复制 provider XML。
fn display(retrieval: &str, task: Option<&Snapshot>) -> Value {
    let mut out = json!({"kind": "task_output", "retrievalStatus": retrieval});
    let Some(task) = task else {
        return out;
    };
    if !task.status.is_empty() {
        out["taskStatus"] = json!(first_units(&task.status, DISPLAY_STATUS_CHARS));
    }
    let output = task.output.trim_end();
    if !output.trim().is_empty() {
        out["output"] = json!(first_units(output, DISPLAY_OUTPUT_CHARS));
        if output.encode_utf16().count() > DISPLAY_OUTPUT_CHARS {
            out["truncated"] = json!(true);
        }
    }
    out
}

#[async_trait]
impl Tool for TaskOutputTool {
    fn name(&self) -> &str {
        NAME
    }

    fn aliases(&self) -> &[&str] {
        &["AgentOutputTool", "BashOutputTool", "AgentOutput", "BashOutput"]
    }

    /// 延迟加载（Node `shouldDefer: true`）。
    fn should_defer(&self) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some("read output/logs from a background task")
    }

    fn input_schema(&self) -> Value {
        nibi_kernel_prompts::tool(NAME).map_or(Value::Null, |prompt| prompt.input_schema.clone())
    }

    fn description(&self, _context: &PromptContext) -> String {
        nibi_kernel_prompts::tool(NAME).map_or_else(String::new, |prompt| prompt.description.clone())
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(MODEL_CHARS)
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        value: Value,
        context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let input: Input = serde_json::from_value(value).map_err(|error| ToolError::InvalidInput {
            message: error.to_string(),
        })?;
        if input.task_id.trim().is_empty() {
            return Err(ToolError::Failed {
                message: "Task ID is required".to_owned(),
            });
        }
        let block = input.block.unwrap_or(true);
        let timeout = input.timeout.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS);
        let (retrieval, task) = if block {
            match self.wait(&input.task_id, timeout, &context).await? {
                None => {
                    return Ok(ToolOutput {
                        content: vec![nibi_kernel_api::message::ToolResultContent::Text {
                            text: format!(
                                "<tool_use_error>No task found with ID: {}</tool_use_error>",
                                input.task_id
                            ),
                        }],
                        is_error: true,
                        display: Value::Null,
                    });
                }
                Some(snapshot) if snapshot.running => ("timeout", Some(snapshot)),
                Some(snapshot) => ("success", Some(snapshot)),
            }
        } else {
            match self.snapshot(&input.task_id, &context).await? {
                None => {
                    return Ok(ToolOutput {
                        content: vec![nibi_kernel_api::message::ToolResultContent::Text {
                            text: format!(
                                "<tool_use_error>No task found with ID: {}</tool_use_error>",
                                input.task_id
                            ),
                        }],
                        is_error: true,
                        display: Value::Null,
                    });
                }
                Some(snapshot) if snapshot.running => ("not_ready", Some(snapshot)),
                Some(snapshot) => ("success", Some(snapshot)),
            }
        };
        Ok(ToolOutput {
            content: vec![nibi_kernel_api::message::ToolResultContent::Text {
                text: model_content(retrieval, task.as_ref()),
            }],
            is_error: false,
            display: display(retrieval, task.as_ref()),
        })
    }
}

#[cfg(test)]
#[path = "task_output_tests.rs"]
mod tests;
