//! 桌面 Automations 的 Host 端实现（Node `createProtocolAutomationPort` 的同名反向请求）：
//! 内核里的 cron 工具经这条端口把定义交给 Host，Host 负责记录、调度、卡片与历史。
//!
//! 与 `topic.rs` 同一种形态：`Context::peer.request` 发 `automation/*`，Host 的
//! `nibiAgentService` 处理并回包；连接断开时等着的请求一起失败。

use async_trait::async_trait;
use nibi_kernel_api::automation::{
    AutomationCreate, AutomationError, AutomationMaxRuns, AutomationPort, AutomationRecord,
    AutomationUpdate,
};
use nibi_kernel_protocol_core::rpc::codes;
use serde_json::{Map, Value, json};

use crate::context::Context;

pub const CREATE: &str = "automation/create";
pub const UPDATE: &str = "automation/update";
pub const LIST: &str = "automation/list";
pub const DELETE: &str = "automation/delete";
pub const CHECK_TASK_BINDING: &str = "automation/checkTaskBinding";

/// 一条 automation 请求的上限：Host 的数据库与调度都很快；卡住时让回合失败，不无限等。
const LIMIT_SECONDS: u64 = 60;

pub struct HostAutomation {
    context: std::sync::Arc<Context>,
}

impl HostAutomation {
    pub fn new(context: std::sync::Arc<Context>) -> Self {
        Self { context }
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, AutomationError> {
        match tokio::time::timeout(
            std::time::Duration::from_secs(LIMIT_SECONDS),
            self.context.peer.request(method, &params),
        )
        .await
        {
            Err(_) => Err(AutomationError::new(
                0,
                format!("{method} timed out after {LIMIT_SECONDS}s"),
            )),
            Ok(Err(error)) => Err(AutomationError::new(error.code, error.message)),
            Ok(Ok(answer)) => Ok(answer),
        }
    }

    fn automation(answer: &Value) -> Result<AutomationRecord, AutomationError> {
        let value = answer
            .get("automation")
            .cloned()
            .ok_or_else(|| AutomationError::new(0, "automation reply has no record".to_owned()))?;
        serde_json::from_value(value).map_err(|error| {
            AutomationError::new(0, format!("automation reply is malformed: {error}"))
        })
    }
}

/// `automation/create` 的参数；只放 Host schema 认识的字段，`None` 一律省略。
fn create_params(request: &AutomationCreate) -> Value {
    let mut params = Map::new();
    params.insert("cronExpr".to_owned(), json!(request.cron));
    params.insert("prompt".to_owned(), json!(request.prompt));
    params.insert("recurring".to_owned(), json!(request.recurring));
    if let Some(title) = request.title.as_ref() {
        params.insert("title".to_owned(), json!(title));
    }
    if let Some(minutes) = request.delay_minutes {
        params.insert("relativeDelayMinutes".to_owned(), json!(minutes));
    }
    if let Some(model) = request.model_selection.as_ref() {
        params.insert("modelSelection".to_owned(), model.clone());
    }
    if let Some(mode) = request.mode.as_ref() {
        params.insert("mode".to_owned(), json!(mode));
    }
    if let Some(target) = request.target_task_id.as_ref() {
        params.insert("targetTaskId".to_owned(), json!(target));
    }
    if let Some(bot) = request.bot_delivery_target.as_ref() {
        params.insert("botDeliveryTarget".to_owned(), bot.clone());
    }
    if let Some(max_runs) = request.max_runs {
        params.insert("maxRuns".to_owned(), json!(max_runs));
    }
    if let Some(unit) = request.interval_unit {
        params.insert("intervalUnit".to_owned(), json!(unit.as_str()));
    }
    if let Some(interval) = request.interval {
        params.insert("interval".to_owned(), json!(interval));
    }
    Value::Object(params)
}

/// `automation/update` 的参数；`maxRuns` 的三种补丁语义在这里落成三种 JSON 形状。
fn update_params(request: &AutomationUpdate) -> Value {
    let mut params = Map::new();
    params.insert("automationId".to_owned(), json!(request.automation_id));
    if let Some(title) = request.title.as_ref() {
        params.insert("title".to_owned(), json!(title));
    }
    if let Some(cron) = request.cron.as_ref() {
        params.insert("cronExpr".to_owned(), json!(cron));
    }
    if let Some(prompt) = request.prompt.as_ref() {
        params.insert("prompt".to_owned(), json!(prompt));
    }
    if let Some(recurring) = request.recurring {
        params.insert("recurring".to_owned(), json!(recurring));
    }
    match request.max_runs {
        AutomationMaxRuns::Keep => {}
        AutomationMaxRuns::Clear => {
            params.insert("maxRuns".to_owned(), Value::Null);
        }
        AutomationMaxRuns::Set(value) => {
            params.insert("maxRuns".to_owned(), json!(value));
        }
    }
    if let Some(unit) = request.interval_unit {
        params.insert("intervalUnit".to_owned(), json!(unit.as_str()));
    }
    if let Some(interval) = request.interval {
        params.insert("interval".to_owned(), json!(interval));
    }
    Value::Object(params)
}

#[async_trait]
impl AutomationPort for HostAutomation {
    async fn create(&self, request: AutomationCreate) -> Result<AutomationRecord, AutomationError> {
        let answer = self.request(CREATE, create_params(&request)).await?;
        Self::automation(&answer)
    }

    async fn update(&self, request: AutomationUpdate) -> Result<AutomationRecord, AutomationError> {
        let answer = self.request(UPDATE, update_params(&request)).await?;
        Self::automation(&answer)
    }

    async fn list(&self) -> Result<Vec<AutomationRecord>, AutomationError> {
        let answer = self.request(LIST, json!({})).await?;
        let values = answer
            .get("automations")
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| AutomationError::new(0, "automation list has no rows".to_owned()))?;
        values
            .into_iter()
            .map(|value| {
                serde_json::from_value(value).map_err(|error| {
                    AutomationError::new(0, format!("automation row is malformed: {error}"))
                })
            })
            .collect()
    }

    async fn delete(&self, automation_id: &str) -> Result<bool, AutomationError> {
        let answer = self
            .request(DELETE, json!({"automationId": automation_id}))
            .await?;
        Ok(answer["deleted"].as_bool().unwrap_or(false))
    }

    async fn task_binding(&self, target_task_id: &str) -> Result<bool, AutomationError> {
        match self
            .request(CHECK_TASK_BINDING, json!({"targetTaskId": target_task_id}))
            .await
        {
            Ok(answer) => Ok(answer["bound"].as_bool().unwrap_or(false)),
            // 旧 Host 没有这个方法：与 Node 同一条兼容路径，用列表按 targetTaskId 判断。
            // 列表也失败时把错误往上抛（调用方 fail-closed，不能当成“未绑定”）。
            Err(error) if error.code == codes::METHOD_NOT_FOUND => Ok(self
                .list()
                .await?
                .iter()
                .any(|automation| automation.target_task_id.as_deref() == Some(target_task_id))),
            Err(error) => Err(error),
        }
    }
}

#[cfg(test)]
#[path = "automation_tests.rs"]
mod tests;
