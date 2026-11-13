//! 桌面 Automations 的 Host 端口（Node `AutomationPort`）：会话里的 `CronCreate` /
//! `CronUpdate` / `CronList` / `CronDelete` 把定义交给 Host 的 `AutomationService`，Host 仍是
//! 任务记录、调度、卡片与历史的唯一 owner。
//!
//! 只有 App 入口装这个端口；CLI/TUI 没有 Host 时沿用本机 `CronBoard`（会话任务与
//! `.nibi/scheduled_tasks.json`）。两边字段面相同，存储不同，不能互相伪造记录。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cron_store::{CronScheduleRule, CronScheduleUnit};

/// Host 的一条 automation（`nibiAutomationProtocolSchema`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRecord {
    pub automation_id: String,
    pub title: String,
    pub cron_expr: String,
    pub prompt: String,
    #[serde(default)]
    pub enabled: bool,
    pub lifecycle_status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<u64>,
    #[serde(default)]
    pub run_count: u64,
    #[serde(default)]
    pub recurring: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_runs: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_rule: Option<CronScheduleRule>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_selection: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

/// 新建 automation 的协议入参（`automation/create`）。
#[derive(Debug, Clone, Default)]
pub struct AutomationCreate {
    pub title: Option<String>,
    /// 兼容/展示 cron；`delay_minutes` 存在时由 Host 用真实时钟覆盖。
    pub cron: String,
    pub prompt: String,
    pub delay_minutes: Option<u32>,
    pub model_selection: Option<Value>,
    pub mode: Option<String>,
    pub target_task_id: Option<String>,
    pub bot_delivery_target: Option<Value>,
    pub recurring: bool,
    pub max_runs: Option<u32>,
    pub interval_unit: Option<CronScheduleUnit>,
    pub interval: Option<u32>,
}

/// 有限次数的补丁：缺省不改、null 清除、数字设置。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutomationMaxRuns {
    Keep,
    Clear,
    Set(u32),
}

/// 更新 automation 的协议入参（`automation/update`）；`None` 表示不改。
#[derive(Debug, Clone)]
pub struct AutomationUpdate {
    pub automation_id: String,
    pub title: Option<String>,
    pub cron: Option<String>,
    pub prompt: Option<String>,
    pub recurring: Option<bool>,
    pub max_runs: AutomationMaxRuns,
    pub interval_unit: Option<CronScheduleUnit>,
    pub interval: Option<u32>,
}

/// Host 反向请求失败；`code` 是 JSON-RPC 错误码（`-32601` 表示 Host 不支持该方法）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutomationError {
    pub code: i64,
    pub message: String,
}

impl AutomationError {
    pub fn new(code: i64, message: String) -> Self {
        Self { code, message }
    }
}

/// Host 的 automation 端口。实现方负责把 DTO 映射成协议参数，并在 Host 不支持时给出
/// 可判别的错误码。
#[async_trait]
pub trait AutomationPort: Send + Sync {
    async fn create(&self, request: AutomationCreate) -> Result<AutomationRecord, AutomationError>;

    async fn update(&self, request: AutomationUpdate) -> Result<AutomationRecord, AutomationError>;

    async fn list(&self) -> Result<Vec<AutomationRecord>, AutomationError>;

    async fn delete(&self, automation_id: &str) -> Result<bool, AutomationError>;

    /// 当前会话是否已经绑定某个 automation（`automation/checkTaskBinding`）。旧 Host 返回
    /// `-32601` 时实现方按 Node 同一条兼容路径回退到列表筛选；其他错误必须 fail-closed。
    async fn task_binding(&self, target_task_id: &str) -> Result<bool, AutomationError>;
}

/// 本轮输入携带的执行事实（`sendText` 的 `automationId` / `botDeliveryTarget`）。
///
/// Host 只在定时任务执行轮的 `sendText` 里带 `automationId`；它不能写进会话级配置，否则绑定会话
/// 里用户后来主动发的一轮会永久失去修改任务的能力。`botDeliveryTarget` 同样只属于当前轮，
/// 用于在 Bot 会话里创建的 automation 回推原群。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFacts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub automation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_delivery_target: Option<Value>,
}
