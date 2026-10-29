//! 入站参数的校验（docs/specs/rust-cli/app-protocol.md §7）：schema 由上游脚本从 App 的 zod 生成
//! （`schema/inbound.json`，NIBI 分家时删掉了 offPeak 方法段与整段 commands——命令契约改由
//! [`crate::nibi_commands`] 从 NIBI 的 zod 生成物校验），这里按方法编译一次，校验失败回 `-32602`。

use std::collections::HashMap;
use std::sync::OnceLock;

use rust_cli_protocol_core::rpc::RpcError;
use rust_cli_protocol_core::schema::Node;
use serde_json::Value;

const INBOUND: &str = include_str!("../schema/inbound.json");

/// 编译好的入站 schema。
pub struct Inbound {
    methods: HashMap<String, Node>,
    replies: HashMap<String, Node>,
}

fn compile(section: &Value) -> Result<HashMap<String, Node>, String> {
    section
        .as_object()
        .ok_or("the schema section is not an object")?
        .iter()
        .map(|(name, schema)| {
            Node::compile(schema)
                .map(|node| (name.clone(), node))
                .map_err(|error| format!("{name}: {error}"))
        })
        .collect()
}

impl Inbound {
    pub fn parse(text: &str) -> Result<Self, String> {
        let data: Value = serde_json::from_str(text).map_err(|error| error.to_string())?;
        Ok(Self {
            methods: compile(&data["methods"])?,
            replies: compile(&data["replies"])?,
        })
    }

    /// 随 crate 带的 schema（编译一次）。schema 文件由生成脚本写、`--check` 守着，编译失败是构建错误：测试覆盖。
    pub fn get() -> &'static Self {
        static INBOUND_SCHEMA: OnceLock<Inbound> = OnceLock::new();
        INBOUND_SCHEMA.get_or_init(|| {
            Self::parse(INBOUND).unwrap_or_else(|error| {
                tracing::error!(event = "protocol.schema.invalid", error = %error, "the inbound schema does not compile");
                Self {
                    methods: HashMap::new(),
                    replies: HashMap::new(),
                }
            })
        })
    }

    /// 方法的参数；没有登记 schema 的方法不校验。缺省的参数按 `{}` 校验（JSON-RPC 允许省略 params）。
    pub fn method(&self, method: &str, params: &Value) -> Result<(), RpcError> {
        let Some(node) = self.methods.get(method) else {
            return Ok(());
        };
        let empty = Value::Object(Default::default());
        let params = if params.is_null() { &empty } else { params };
        node.validate(params, "").map_err(|error| {
            RpcError::invalid_params(format!("Invalid params for {method}: {error}"))
                .with_data(serde_json::json!({"issue": error}))
        })
    }

    /// 命令的 payload 与跨字段规则。错误是给 ACK 的说明文字。
    ///
    /// NIBI 分家后命令契约以 [`crate::nibi_commands`] 为准（34 个命令、CAS 集合、
    /// 已删字段 fail-closed）；上游 `inbound.json` 的 `commands` 段只留作 schema
    /// 来源对照，不再用于命令校验。
    pub fn command(&self, envelope: &Value) -> Result<(), String> {
        crate::nibi_commands::validate(envelope)
    }

    /// 本端发出的请求得到的回复。
    pub fn reply(&self, method: &str, result: &Value) -> Result<(), String> {
        match self.replies.get(method) {
            Some(node) => node.validate(result, ""),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
#[path = "inbound_tests.rs"]
mod tests;
