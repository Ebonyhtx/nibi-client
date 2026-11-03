//! MCP 进程遥测（141 审计 §9 F3）：`process/mcpTelemetry` 的三类事件与 `mcpId` 的编码。
//!
//! Node 侧是 `createMcpTelemetryTracker`（`apps/zcode-cli/packages/adapters/src/mcp/telemetry.ts`）。
//! 三类事件进 ARMS 的稳定性面板：`process_start`、`process_crash`、`session_startup`（`memory` 那类
//! 已被五分钟资源采样取代，bootstrap 不再发，这里也不产生）。
//!
//! **`mcpId` 是隐私红线上的设计**：默认（`plugin` / `custom`）不是服务器名，而是
//! `HMAC-SHA256(idSalt, serverName)` 的前 12 位十六进制——同一个服务器在同一个设备上稳定可关联，
//! 换设备或不看明文都不可还原。只有 `builtin` 用可读的名字（`builtin:` + 百分号编码的段）。
//!
//! `idSalt` 来自 `NIBI_TELEMETRY_DEVICE_MID`（桌面注入）；没有时用进程级的随机串（Node 退回
//! `traceContext.traceId` 的同一姿态：不可跨进程关联）。

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// `builtin` 的 `mcpId` 前缀。
pub const BUILTIN_PREFIX: &str = "builtin:";
/// `mcpId` 里摘要的长度（Node `digest("hex").slice(0, 12)`）。
const DIGEST_LEN: usize = 12;

/// 事件里的 `mcpSource`：`builtin` / `plugin` / `custom`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpSource {
    Builtin,
    Plugin,
    Custom,
}

impl McpSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Builtin => "builtin",
            Self::Plugin => "plugin",
            Self::Custom => "custom",
        }
    }
}

/// 服务器名与来源（Node `resolveMcpSource` + 插件命名空间的两段规则）。
///
/// `plugin_scope` 是配置里的 scope：NIBI 的插件服务器名可能是 `plugin:<name>:<key>`，也可能只是
/// 插件名；两种都算插件来源，插件名分别取第二段或整个名字。
pub fn resolve_source(server_name: &str, plugin_scope: bool) -> McpSource {
    if server_name == "node_repl" {
        return McpSource::Builtin;
    }
    if plugin_scope || server_name.starts_with("plugin:") {
        return McpSource::Plugin;
    }
    McpSource::Custom
}

/// 插件名（`plugin:<name>:<key>` 的第二段）；不是插件来源时 `None`。
pub fn plugin_name(server_name: &str, plugin_scope: bool) -> Option<String> {
    if resolve_source(server_name, plugin_scope) != McpSource::Plugin {
        return None;
    }
    let name = server_name
        .strip_prefix("plugin:")
        .unwrap_or(server_name)
        .split(':')
        .next()
        .unwrap_or_default()
        .trim();
    (!name.is_empty()).then(|| name.to_owned())
}

/// `mcpId`：内置服务器用可读名，其余用加盐摘要（见模块注释）。
pub fn mcp_id(server_name: &str, source: McpSource, id_salt: &str) -> String {
    if source == McpSource::Builtin {
        let public = server_name.strip_prefix("plugin:").unwrap_or(server_name);
        return format!(
            "{BUILTIN_PREFIX}{}",
            public
                .split(':')
                .map(encode_segment)
                .collect::<Vec<_>>()
                .join(":")
        );
    }
    let digest = hmac_sha256(id_salt.as_bytes(), server_name.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{}:{}", source.as_str(), &hex[..DIGEST_LEN])
}

/// 一个段的名字编码（Node `encodeMcpIdSegment`）：`A-Za-z0-9._~-` 原样，其余按 UTF-8 字节写 `%HH`。
/// 逐字节编码，避免孤立 surrogate 那类非法字符串（Rust 的 `str` 本来不存在）。
pub fn encode_segment(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        let character = char::from(*byte);
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '~' | '-') {
            out.push(character);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// HMAC-SHA256（RFC 2104）。只用 sha2，不引入 hmac crate。
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut block = [0_u8; BLOCK];
    if key.len() > BLOCK {
        let digest = Sha256::digest(key);
        block[..32].copy_from_slice(&digest);
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|byte| byte ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(block.map(|byte| byte ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

/// 一次进程启动的遥测身份（`process/childProcesses` 与五分钟采样都用它）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpProcessIdentity {
    pub mcp_id: String,
    /// 这一次进程启动的随机标识（`randomUUID()` 的替代）。
    pub instance_id: String,
    /// 启动的墙钟（毫秒）。
    pub started_at_ms: u64,
}

/// 一条 `process/mcpTelemetry` 事件（Host `zcodeMcpTelemetryEventSchema`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum McpTelemetryEvent {
    /// 服务器进程起来了。
    #[serde(rename_all = "camelCase")]
    ProcessStart {
        arch: String,
        occurred_at: u64,
        platform: String,
        mcp_id: String,
        mcp_instance_id: String,
        mcp_isolation: String,
        mcp_source: String,
    },
    /// 服务器进程自己退出了（不是我们关的）。
    ///
    /// `exit_code` / `signal` 在 Host schema 里可空：Rust 的传输层只看见「进程退出了」，
    /// 没有拿退出码的地方，所以如实报 `null`，不用 0 冒充。
    #[serde(rename_all = "camelCase")]
    ProcessCrash {
        affected_session_count: u32,
        arch: String,
        exit_code: Option<i32>,
        occurred_at: u64,
        platform: String,
        signal: Option<String>,
        uptime_ms: u64,
        mcp_id: String,
        mcp_instance_id: String,
        mcp_isolation: String,
        mcp_source: String,
    },
    /// 一个会话的 MCP 首次取快照：配置了几个、连上几个、几个有进程。
    #[serde(rename_all = "camelCase")]
    SessionStartup {
        arch: String,
        configured_count: u32,
        connected_count: u32,
        failed_count: u32,
        occurred_at: u64,
        platform: String,
        process_count: u32,
        session_id: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231 测试向量 2：key "Jefe"、data "what do ya want for nothing?"。
    #[test]
    fn the_hmac_matches_rfc_4231() {
        let digest = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            hex,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    /// 长 key（超过一个块）先摘要再当 key（RFC 2104）。
    #[test]
    fn a_long_key_is_hashed_first() {
        let long = [0xaa_u8; 100];
        let digest = hmac_sha256(&long, b"message");
        let hashed = Sha256::digest(long);
        assert_eq!(digest, hmac_sha256(&hashed, b"message"));
    }

    /// 插件 / 自定义服务器：`plugin:<12 位十六进制>`，同一盐同名字稳定，不同名字不同。
    #[test]
    fn plugin_ids_are_salted_digests() {
        let first = mcp_id("plugin:math:server", McpSource::Plugin, "device-1");
        assert!(first.starts_with("plugin:"));
        assert_eq!(first.len(), "plugin:".len() + 12);
        assert!(first["plugin:".len()..]
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(
            first,
            mcp_id("plugin:math:server", McpSource::Plugin, "device-1")
        );
        assert_ne!(
            first,
            mcp_id("plugin:math:server", McpSource::Plugin, "device-2")
        );
        assert_ne!(first, mcp_id("other", McpSource::Custom, "device-1"));
        assert!(mcp_id("other", McpSource::Custom, "device-1").starts_with("custom:"));
    }

    /// 内置服务器用可读名，段编码与 Node `encodeMcpIdSegment` 一致（只留安全字符）。
    #[test]
    fn builtin_ids_are_readable_and_encoded() {
        assert_eq!(mcp_id("node_repl", McpSource::Builtin, "x"), "builtin:node_repl");
        assert_eq!(
            mcp_id("plugin:math:tools/v2", McpSource::Builtin, "x"),
            "builtin:math:tools%2Fv2"
        );
        assert_eq!(encode_segment("a b"), "a%20b");
        // 非 ASCII 按 UTF-8 字节编码。
        assert_eq!(encode_segment("中"), "%E4%B8%AD");
    }

    /// 来源与插件名：`plugin:` 前缀与配置的插件 scope 都算插件。
    #[test]
    fn the_source_follows_the_name_and_the_scope() {
        assert_eq!(resolve_source("node_repl", false), McpSource::Builtin);
        assert_eq!(
            resolve_source("plugin:math:server", false),
            McpSource::Plugin
        );
        assert_eq!(resolve_source("math", true), McpSource::Plugin);
        assert_eq!(resolve_source("github", false), McpSource::Custom);
        assert_eq!(
            plugin_name("plugin:math:server", false),
            Some("math".to_owned())
        );
        assert_eq!(plugin_name("math", true), Some("math".to_owned()));
        assert_eq!(plugin_name("github", false), None);
        assert_eq!(plugin_name("node_repl", false), None);
    }

    /// 事件线上形状：`kind` 是蛇形，字段是驼峰，可选字段缺失时不写（Host schema 是 strict）。
    #[test]
    fn the_event_shape_is_camel_case() {
        let event = McpTelemetryEvent::ProcessStart {
            arch: "x64".to_owned(),
            occurred_at: 1,
            platform: "linux".to_owned(),
            mcp_id: "custom:0123456789ab".to_owned(),
            mcp_instance_id: "inst".to_owned(),
            mcp_isolation: "session".to_owned(),
            mcp_source: "custom".to_owned(),
        };
        let value = serde_json::to_value(&event).expect("serializable");
        assert_eq!(value["kind"], "process_start");
        assert_eq!(value["occurredAt"], 1);
        assert_eq!(value["mcpInstanceId"], "inst");
        assert_eq!(value["mcpIsolation"], "session");
        let crash = McpTelemetryEvent::ProcessCrash {
            affected_session_count: 0,
            arch: "arm64".to_owned(),
            exit_code: None,
            occurred_at: 2,
            platform: "darwin".to_owned(),
            signal: None,
            uptime_ms: 5,
            mcp_id: "custom:0123456789ab".to_owned(),
            mcp_instance_id: "inst".to_owned(),
            mcp_isolation: "workspace".to_owned(),
            mcp_source: "custom".to_owned(),
        };
        let value = serde_json::to_value(&crash).expect("serializable");
        assert_eq!(value["kind"], "process_crash");
        assert!(value["exitCode"].is_null());
        assert!(value["signal"].is_null());
        assert_eq!(value["uptimeMs"], 5);
    }
}
