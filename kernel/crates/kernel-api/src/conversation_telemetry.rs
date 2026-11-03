//! 会话实时事实（141 审计 §9 第 5 项余项）：`v4/telemetry/event` 通知的线上形状。
//!
//! Host 的契约是 `packages/shared/src/nibi-protocol-v4/telemetry.ts` 的
//! `conversationTelemetryFactSchema`（10 个 kind 的严格判别联合，每支 `.strict()`）。这里只建
//! **内核事件流能如实产出的 8 个 kind**：
//!
//! - `turn.started` / `turn.terminal` / `usage.delta` / `compaction.terminal`；
//! - `stream.chunk` / `tool.lifecycle` / `permission.lifecycle` / `subagent.lifecycle`。
//!
//! 缺的两支与原因：
//! - `model.request.status`：内核的模型端口没有 request / retry / stall 这些可观察事件
//!   （Node 侧来自 `ModelNetworkStatus` 事件），没有采集点就没有事实；
//! - `workflow.lifecycle`：来自动态工作流的 run 进度事件，内核的 run 进度不经过会话事件流。
//!
//! 每个字段都是 Host schema 的白名单字段；可选字段缺席就不写（strict 不认多余键）。

use serde::{Deserialize, Serialize};

/// 事实的公共字段（Host `factBaseFields`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryFactBase {
    /// 契约版本，恒为 1。
    pub version: u8,
    pub event_id: String,
    pub event_seq: u64,
    pub occurred_at: u64,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_command_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// 会话创建期采用的 App Memory 开关；内核不知道时为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_enabled: Option<bool>,
}

impl TelemetryFactBase {
    pub fn new(event_id: String, event_seq: u64, occurred_at: u64, session_id: String) -> Self {
        Self {
            version: 1,
            event_id,
            event_seq,
            occurred_at,
            session_id,
            source_command_id: None,
            turn_id: None,
            memory_enabled: None,
        }
    }
}

/// 工具性能（Host `toolPerformanceFactSchema`）。只填内核真有的字段。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPerformanceFact {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_wait_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_run_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_output_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_output_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timed_out: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_hash: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fs_read_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fs_write_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_match_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_file_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hunk_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub match_attempts: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_kind: Option<String>,
}

/// 一条 `v4/telemetry/event` 通知的载荷。
///
/// `tool.lifecycle` 的字段最多，枚举因此偏大；这是线上契约的扁平形状，装箱只会把 serde 的
/// `flatten` 变成一层间接（每条工具事件都付一次分配），不值得。
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ConversationTelemetryFact {
    /// 一轮开始（Host `turnStartedFactSchema`）。
    #[serde(rename = "turn.started", rename_all = "camelCase")]
    TurnStarted {
        #[serde(flatten)]
        base: TelemetryFactBase,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input_source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        background_source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        automation_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        task_trigger: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scheduled_at: Option<u64>,
    },
    /// 一段流式正文或思考的增量。
    #[serde(rename = "stream.chunk", rename_all = "camelCase")]
    StreamChunk {
        #[serde(flatten)]
        base: TelemetryFactBase,
        /// `thought` 或 `text`。
        channel: String,
        chunk_length: u64,
        first_chunk: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assistant_message_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        part_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
    },
    /// 一个工具调用的生命周期。
    #[serde(rename = "tool.lifecycle", rename_all = "camelCase")]
    ToolLifecycle {
        #[serde(flatten)]
        base: TelemetryFactBase,
        phase: String,
        tool_call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        child_tool_call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        child_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        background: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skill_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skill_qualified_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skill_plugin_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plugin_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        plugin_component: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        skill_source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        performance: Option<ToolPerformanceFact>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        automation_id: Option<String>,
    },
    /// 权限询问的生命周期。
    #[serde(rename = "permission.lifecycle", rename_all = "camelCase")]
    PermissionLifecycle {
        #[serde(flatten)]
        base: TelemetryFactBase,
        phase: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        tool_call_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        child_session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        background: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decision: Option<String>,
    },
    /// 一次模型响应的用量增量。
    #[serde(rename = "usage.delta", rename_all = "camelCase")]
    UsageDelta {
        #[serde(flatten)]
        base: TelemetryFactBase,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_kind: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_hostname: Option<String>,
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
        reasoning_tokens: u64,
        cache_read_tokens: u64,
        cache_write_tokens: u64,
    },
    /// 子代理的生命周期。
    #[serde(rename = "subagent.lifecycle", rename_all = "camelCase")]
    SubagentLifecycle {
        #[serde(flatten)]
        base: TelemetryFactBase,
        phase: String,
        agent_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        agent_type: Option<String>,
        child_session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_call_id: Option<String>,
        background: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
    },
    /// 一轮的终态。
    #[serde(rename = "turn.terminal", rename_all = "camelCase")]
    TurnTerminal {
        #[serde(flatten)]
        base: TelemetryFactBase,
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result_type: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token_count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_call_count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_code: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_message: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_retryable: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        turn_phase: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        background_subagent_result_consumed: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workflow_result_consumed: Option<bool>,
    },
    /// 一次压缩的终态。
    #[serde(rename = "compaction.terminal", rename_all = "camelCase")]
    CompactionTerminal {
        #[serde(flatten)]
        base: TelemetryFactBase,
        operation_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        summary_message_id: Option<String>,
        status: String,
        trigger: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        compact_reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attempt: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_attempts: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        started_at: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ended_at: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pre_compact_token_count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        post_compact_token_count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        true_post_compact_token_count: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model_provider: Option<String>,
    },
}

#[cfg(test)]
#[path = "conversation_telemetry_tests.rs"]
mod tests;
