//! NIBI 的 v4 命令契约（Step 2 第一切片）。
//!
//! 与上游 `inbound.json` 的差别（Rust 规划 §5.2.1 / 合并计划 §2.2）：
//!
//! - 命令全集以 NIBI 的 `commandPayloadSchemas`（34 个）为准；上游多出的
//!   `setHighspeedMetrics` 不在 NIBI 协议面里，收到即拒绝；
//! - CAS 集合：15 个必须带 `baseRevision`，其中 5 个 row-targeting 还必须带
//!   `baseLogEpoch`（字符串，trim 后非空）——与 Node `parseCommandEnvelope` 同判；
//! - NIBI 已删除的功能 fail-closed：`createSession.offPeakToolEnabled`、
//!   `sendText.offPeakTaskId / offPeakRunType / highspeedMeta` 收到即 invalid payload；
//! - `modelExecution requires modelSelection` 的 superRefine 镜像适用于
//!   `sendText` / `editUserQuery` / `sendQueuedNow`。
//!
//! schema 文件由 `scripts/kernel-baseline/generate-nibi-command-schema.ts` 从 NIBI 的
//! zod 单一来源生成（`--check` 守着），不要手改。

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

use rust_cli_protocol_core::schema::Node;
use serde_json::Value;

const NIBI_COMMANDS: &str = include_str!("../schema/nibi-commands.json");

/// NIBI 已删除功能的字段：出现在 payload 里按 invalid payload 处理，而不是剥掉。
const REMOVED_CREATE_SESSION_FIELDS: &[&str] = &["offPeakToolEnabled"];
const REMOVED_SEND_TEXT_FIELDS: &[&str] = &["offPeakTaskId", "offPeakRunType", "highspeedMeta"];

/// createSession 里内核当前还不消费的 NIBI 字段（R12/R23：照搬上游会静默丢这些）。
/// 处理器实现一项就从中删一项；列表非空时 `create_session` 至少要 warn。
/// 已消费：config.modelSelection/mode/planEnabled/followupMode、config.provider/model/thought、
/// permissionScope（literal 校验后忽略——kernel 默认 session-scoped）
/// （2026-10-30 起作选择回落）、firstInput.text/mode/planEnabled（input_meta 捕获）、
/// mcpServers（2026-10-30 起经 `Kernel::start_session_mcp` 装进会话，见 `commands::create_session`）。
pub const CREATE_SESSION_FIELDS_NOT_YET_CONSUMED: &[&str] = &[
    "additionalDirectories",
    "dynamicWorkflowEnabled",
    "dynamicWorkflowMode",
    "firstInput.attachments",
];

/// 编译好的 NIBI 命令契约。
pub struct NibiCommands {
    commands: HashMap<String, Node>,
    requires_revision: HashSet<String>,
    requires_epoch: HashSet<String>,
}

impl NibiCommands {
    pub fn parse(text: &str) -> Result<Self, String> {
        let data: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
        let commands = data["commands"]
            .as_object()
            .ok_or("the commands section is not an object")?
            .iter()
            .map(|(name, schema)| {
                Node::compile(schema)
                    .map(|node| (name.clone(), node))
                    .map_err(|error| format!("{name}: {error}"))
            })
            .collect::<Result<HashMap<_, _>, _>>()?;
        let declared = data["commandTypes"]
            .as_array()
            .ok_or("the commandTypes section is missing")?
            .iter()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        if declared.len() != commands.len()
            || declared.iter().any(|name| !commands.contains_key(name))
        {
            return Err("commandTypes and commands sections disagree".to_owned());
        }
        let requires_revision = string_set(&data["requiresBaseRevision"])?;
        let requires_epoch = string_set(&data["requiresBaseLogEpoch"])?;
        Ok(Self {
            commands,
            requires_revision,
            requires_epoch,
        })
    }

    /// 随 crate 带的生成物（编译一次）。解析失败时返回空契约：所有命令都被拒绝
    /// （fail-closed），`cargo test` 会立刻抓住。
    pub fn get() -> &'static Self {
        static CONTRACT: OnceLock<NibiCommands> = OnceLock::new();
        CONTRACT.get_or_init(|| {
            Self::parse(NIBI_COMMANDS).unwrap_or_else(|error| {
                tracing::error!(event = "protocol.nibi_commands.invalid", error = %error, "the nibi command schema does not compile");
                Self {
                    commands: HashMap::new(),
                    requires_revision: HashSet::new(),
                    requires_epoch: HashSet::new(),
                }
            })
        })
    }

    /// 信封 + payload 的 NIBI 校验；错误是给 ACK 的说明文字（`proto.invalidPayload`）。
    pub fn validate(&self, envelope: &Value) -> Result<(), String> {
        let kind = envelope["type"].as_str().unwrap_or_default();
        let node = self
            .commands
            .get(kind)
            .ok_or_else(|| format!("unknown command type {kind}"))?;
        if envelope["commandId"].as_str().is_none_or(str::is_empty) {
            return Err("/commandId must be a non-empty string".to_owned());
        }
        if envelope["clientId"].as_str().is_none_or(str::is_empty) {
            return Err("/clientId must be a non-empty string".to_owned());
        }
        if !envelope["sessionId"].is_null() && envelope["sessionId"].as_str().is_none() {
            return Err("/sessionId must be a string or null".to_owned());
        }
        if let Some(revision) = envelope
            .get("baseRevision")
            .filter(|value| !value.is_null())
            && revision.as_u64().is_none()
        {
            return Err("/baseRevision must be a non-negative integer".to_owned());
        }
        if let Some(epoch) = envelope
            .get("baseLogEpoch")
            .filter(|value| !value.is_null())
            && epoch.as_str().is_none_or(|epoch| epoch.trim().is_empty())
        {
            return Err("/baseLogEpoch must be a non-empty string".to_owned());
        }
        let payload = &envelope["payload"];
        node.validate(payload, "/payload")?;
        if self.requires_revision.contains(kind)
            && envelope.get("baseRevision").is_none_or(Value::is_null)
        {
            return Err("CAS commands require baseRevision and baseLogEpoch".to_owned());
        }
        if self.requires_epoch.contains(kind)
            && envelope.get("baseLogEpoch").is_none_or(Value::is_null)
        {
            return Err("CAS commands require baseRevision and baseLogEpoch".to_owned());
        }
        if matches!(kind, "sendText" | "editUserQuery" | "sendQueuedNow")
            && payload.get("modelExecution").is_some()
            && payload.get("modelSelection").is_none()
        {
            return Err(
                "/payload/modelExecution: modelExecution requires modelSelection".to_owned(),
            );
        }
        let removed = removed_fields(kind, payload);
        if !removed.is_empty() {
            return Err(format!(
                "removed NIBI fields must not be sent: {}",
                removed.join(", ")
            ));
        }
        Ok(())
    }

    /// createSession 里内核当前还不消费的字段（照上游只会静默丢；这里点名上报）。
    pub fn unsupported_create_session_fields(payload: &Value) -> Vec<&'static str> {
        CREATE_SESSION_FIELDS_NOT_YET_CONSUMED
            .iter()
            .copied()
            .filter(|field| path_present(payload, field))
            .collect()
    }
}

/// 便捷入口：用随 crate 带的契约校验一个命令信封。
pub fn validate(envelope: &Value) -> Result<(), String> {
    NibiCommands::get().validate(envelope)
}

fn removed_fields(kind: &str, payload: &Value) -> Vec<&'static str> {
    let removed: &[&str] = match kind {
        "createSession" => REMOVED_CREATE_SESSION_FIELDS,
        "sendText" => REMOVED_SEND_TEXT_FIELDS,
        _ => &[],
    };
    removed
        .iter()
        .copied()
        .filter(|field| payload.get(*field).is_some_and(|value| !value.is_null()))
        .collect()
}

fn path_present(payload: &Value, field: &str) -> bool {
    let mut current = payload;
    for segment in field.split('.') {
        current = &current[segment];
        if current.is_null() {
            return false;
        }
    }
    true
}

fn string_set(value: &Value) -> Result<HashSet<String>, String> {
    Ok(value
        .as_array()
        .ok_or("expected an array of command names")?
        .iter()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect())
}

#[cfg(test)]
#[path = "nibi_commands_tests.rs"]
mod tests;
