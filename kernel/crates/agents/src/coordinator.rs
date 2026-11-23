//! 子代理的 `RespondToCoordinator`（docs/subagent-respond-to-coordinator.md）：child-only 工具，把一条
//! 回复投给 coordinator（父 runtime）。收件人由运行时的绑定决定（子代理身份 + owner + 顶层会话），模型只有
//! `summary` 与 `message` 两个字段，不能选择或覆盖目标。
//!
//! 投递复用后台通知的排队/唤醒路径（[`crate::routing::deliver`]，`AgentNoticeKind::SubagentMessage`）：
//! own 在跑就排进邮箱、在工具边界并入；停放就续跑；已结束或没有 owner 就送顶层会话，由会话 actor
//! 开 model-only 轮。成功只表示回复已同步进入父 runtime 的队列，不表示父模型已读取。

use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_api::agents::AgentNoticeKind;
use nibi_kernel_api::ids::{AgentId, SessionId};
use nibi_kernel_api::message::ToolResultContent;
use nibi_kernel_api::orchestration::{ToolRegistry, ToolSnapshot};
use nibi_kernel_api::permission::PermissionDecision;
use nibi_kernel_api::tool::{PromptContext, Tool, ToolError, ToolOutput, ToolProgress, ToolUseContext};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::Core;
use crate::live::{LiveAgent, Notice};
use crate::routing;
use crate::toolset::ToolRule;

/// 工具名（agent 定义的点名清单与 deny 名单按它判）。
pub(crate) const NAME: &str = "RespondToCoordinator";

/// `summary` / `message` 的长度上限（Node contract：200 与 20,000 个 UTF-16 单元）。
const SUMMARY_LIMIT: usize = 200;
const MESSAGE_LIMIT: usize = 20_000;

/// 结果里给模型的字符上限（Node `maxOutputBytes: 4096`）。
const MODEL_OUTPUT_LIMIT: usize = 4_096;

/// 成功结果里固定的续做指引（Node `formatRespondToCoordinatorModelContent`）。
const CONTINUATION: &str =
    "Continue the current task unless the coordinator explicitly changed or ended it.";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    summary: String,
    message: String,
}

/// 子代理工具面上的 coordinator 回复工具：按这次运行的子代理身份构造。
pub(crate) struct RespondToCoordinator {
    core: Arc<Core>,
    agent: AgentId,
    agent_type: String,
    owner: Option<AgentId>,
    root: SessionId,
}

impl RespondToCoordinator {
    pub(crate) fn new(core: Arc<Core>, agent: &LiveAgent) -> Self {
        Self {
            core,
            agent: agent.agent.clone(),
            agent_type: agent.definition.agent_type.clone(),
            owner: agent.owner.clone(),
            root: agent.root.clone(),
        }
    }

    /// provider 可见的 carrier：字段按 Node `formatSubagentMessage` 的 XML 转义。
    fn carrier(&self, input: &Input) -> String {
        format!(
            "<subagent-message>\n\
             <agent-id>{}</agent-id>\n\
             <agent-type>{}</agent-type>\n\
             <summary>{}</summary>\n\
             <message>{}</message>\n\
             </subagent-message>",
            escape(self.agent.as_str()),
            escape(&self.agent_type),
            escape(&input.summary),
            escape(&input.message),
        )
    }
}

/// Node `escapeXml`：`& < > ' "` 五个字符。
fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

/// 一个长度上限的检查（zod 的 `max` 按 UTF-16 单元数）。
fn too_long(value: &str, limit: usize) -> bool {
    value.encode_utf16().count() > limit
}

#[async_trait]
impl Tool for RespondToCoordinator {
    fn name(&self) -> &str {
        NAME
    }

    /// 延迟加载（Node `shouldDefer: true`）：子代理从延迟清单里看到名字，再用 ToolSearch 载入 schema。
    fn should_defer(&self) -> bool {
        true
    }

    fn search_hint(&self) -> Option<&str> {
        Some("reply to the coordinator that owns this subagent")
    }

    fn input_schema(&self) -> Value {
        nibi_kernel_prompts::tool(NAME).map_or(Value::Null, |prompt| prompt.input_schema.clone())
    }

    fn description(&self, _context: &PromptContext) -> String {
        nibi_kernel_prompts::tool(NAME).map_or_else(String::new, |prompt| prompt.description.clone())
    }

    /// 会话内的控制动作：不读文件，也不写工作区（Node `readOnly: false`、`sideEffectScope: "session"`）。
    fn is_concurrency_safe(&self, _input: &Value) -> bool {
        true
    }

    fn max_result_size_chars(&self) -> Option<usize> {
        Some(MODEL_OUTPUT_LIMIT)
    }

    async fn check_permissions(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> PermissionDecision {
        // Node `needsApproval: false`、`allowedInPlanMode: true`：session-local 的回复不需要审批。
        PermissionDecision::Allow {
            updated_input: None,
        }
    }

    async fn call(
        &self,
        value: Value,
        _context: ToolUseContext,
        _progress: mpsc::Sender<ToolProgress>,
    ) -> Result<ToolOutput, ToolError> {
        let input: Input = serde_json::from_value(value).map_err(|error| ToolError::InvalidInput {
            message: error.to_string(),
        })?;
        // 长度上限按 zod 的写法报错（schema 的 minLength/maxLength 不在管线的 JSON Schema
        // 子集里，形状与 validate.rs 的缺失/类型错误同一条）。
        let issue = |detail: String| ToolError::InvalidInput {
            message: format!("{NAME} failed due to the following issue:\n{detail}"),
        };
        if input.summary.is_empty() {
            return Err(issue(
                "The parameter `summary` must contain at least 1 character".to_owned(),
            ));
        }
        if too_long(&input.summary, SUMMARY_LIMIT) {
            return Err(issue(format!(
                "The parameter `summary` must contain at most {SUMMARY_LIMIT} characters"
            )));
        }
        if input.message.is_empty() {
            return Err(issue(
                "The parameter `message` must contain at least 1 character".to_owned(),
            ));
        }
        if too_long(&input.message, MESSAGE_LIMIT) {
            return Err(issue(format!(
                "The parameter `message` must contain at most {MESSAGE_LIMIT} characters"
            )));
        }
        let response_id = format!("response_{}", self.core.ports.ids.uuid());
        let notice = Notice {
            from: self.agent.clone(),
            // 不是终态（coordinator 回复不结束任务）；会话的 `BackgroundWork` 也不认它。
            status: "running",
            envelope: self.carrier(&input),
            kind: AgentNoticeKind::SubagentMessage,
            stall: None,
        };
        // 投递路径不失败：owner 在跑就排进邮箱，停放就续跑，否则送顶层会话。
        let wake = self.core.live.with(|agents| {
            routing::deliver(
                agents,
                &self.core.hub,
                self.owner.as_ref(),
                &self.root,
                notice,
            )
        });
        routing::wake(&self.core, wake.into_iter().collect()).await;
        Ok(ToolOutput {
            content: vec![ToolResultContent::Text {
                text: format!("Response {response_id} was queued for the coordinator. {CONTINUATION}"),
            }],
            is_error: false,
            display: json!({"kind": "respond_to_coordinator", "status": "success"}),
        })
    }
}

/// 子代理注册表上的 coordinator 回复工具（Node `appendChildControlTool`）：定义的点名清单不含它也照样给
/// （[`ToolRule::allows`] 的 control 分支），但全局 / agent 的 deny 名单仍然生效。
pub(crate) struct Tools {
    inner: Arc<dyn ToolRegistry>,
    rule: ToolRule,
    tool: Arc<dyn Tool>,
}

impl Tools {
    pub(crate) fn new(inner: Arc<dyn ToolRegistry>, rule: ToolRule, tool: Arc<dyn Tool>) -> Self {
        Self { inner, rule, tool }
    }

    fn allowed(&self) -> bool {
        self.rule.allows(NAME)
    }

    fn append(&self, tools: &mut Vec<Arc<dyn Tool>>) {
        if self.allowed() && !tools.iter().any(|tool| tool.name() == NAME) {
            tools.push(self.tool.clone());
        }
    }
}

impl ToolRegistry for Tools {
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        let mut tools = self.inner.tools();
        self.append(&mut tools);
        tools
    }

    fn find(&self, name: &str) -> Option<Arc<dyn Tool>> {
        if name == NAME && self.allowed() {
            return Some(self.tool.clone());
        }
        self.inner.find(name)
    }

    fn find_for(&self, session: &SessionId, name: &str) -> Option<Arc<dyn Tool>> {
        if name == NAME && self.allowed() {
            return Some(self.tool.clone());
        }
        self.inner.find_for(session, name)
    }

    fn keeps_order(&self) -> bool {
        self.inner.keeps_order()
    }

    fn snapshot(&self, session: &SessionId) -> ToolSnapshot {
        let mut snapshot = self.inner.snapshot(session);
        self.append(&mut snapshot.tools);
        snapshot
    }

    fn mcp(&self) -> Option<Arc<dyn nibi_kernel_api::mcp_state::McpConnections>> {
        self.inner.mcp()
    }

    fn mcp_for(
        &self,
        session: &SessionId,
    ) -> Option<Arc<dyn nibi_kernel_api::mcp_state::McpConnections>> {
        self.inner.mcp_for(session)
    }

    fn session_mcp(
        &self,
        session: &SessionId,
    ) -> Option<Arc<dyn nibi_kernel_api::mcp_state::McpConnections>> {
        self.inner.session_mcp(session)
    }

    fn inherit_session_mcp(&self, parent: &SessionId, child: &SessionId) {
        self.inner.inherit_session_mcp(parent, child);
    }
}

#[cfg(test)]
#[path = "coordinator_tests.rs"]
mod tests;
