//! 工作区 MCP 信任的装载闸门（A5/A6）。
//!
//! Host（`packages/desktop/src/main/mcpWorkspaceTrust/index.ts`）按「工作区身份 + server 名 + 声明
//! 摘要」写入用户域 `workspace-mcp-trust-v1.json`；入口（`crates/cli`）读同一份文件，把
//! [`ProjectMcpTrust`] 注入 [`super::McpSettings`]。本模块只做纯计算与准入：
//!
//! - [`declaration_digest`] 与 Host 的 `computeWorkspaceMcpDeclarationDigest` 是同一算法；
//! - [`ProjectMcpTrust::admits`] 决定 `McpScope::Project` 的服务器能否装载；
//! - [`ProjectMcpTrust::rejection`] 给出稳定诊断原因。
//!
//! 未启用（`ProjectMcpTrust::default()`）时不拦截，只用于非 Host 嵌入与既有单测；CLI 入口总是
//! 注入启用后的快照。存储损坏、工作区身份不符、摘要变化或缺记录一律拒绝。

use std::collections::{BTreeMap, BTreeSet};

use nibi_kernel_api::mcp::{McpOAuthConfig, McpProtocolVersion, McpTransportConfig};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::config::{McpScope, McpServer};

/// 从信任文件读出的一条记录（Host schema 的子集；不参与摘要的字段在入口丢弃）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectMcpTrustRecord {
    pub workspace_identity: String,
    pub server_name: String,
    pub declaration_digest: String,
}

/// 一个工作区的项目 MCP 信任快照。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectMcpTrust {
    /// 是否启用闸门。Host 入口注入时总是 true；库的默认构造不启用。
    enforced: bool,
    workspace_identity: String,
    /// server 名 → 当前声明摘要（发现层算好）。
    declarations: BTreeMap<String, String>,
    /// 本工作区已信任的摘要。
    trusted: BTreeSet<String>,
    /// 有记录、但摘要与当前声明不符的 server 名（诊断“声明已变化”）。
    stale: BTreeSet<String>,
    /// 信任文件损坏/不可读：fail closed。
    corrupt: bool,
}

/// 拒绝原因（诊断事件与测试共用；不进入模型上下文）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectMcpRejection {
    /// 没有当前摘要的授权记录。
    PendingTrust,
    /// 有记录，但摘要已变化。
    DeclarationChanged,
    /// 信任文件损坏或不可读。
    TrustStoreCorrupt,
}

impl ProjectMcpRejection {
    pub fn reason(self) -> &'static str {
        match self {
            Self::PendingTrust => "workspace_mcp_pending_trust",
            Self::DeclarationChanged => "workspace_mcp_declaration_changed",
            Self::TrustStoreCorrupt => "workspace_mcp_trust_store_corrupt",
        }
    }
}

impl ProjectMcpTrust {
    /// 用入口读到的记录构造启用后的快照。记录里属于其他工作区的条目被忽略。
    pub fn from_records(
        workspace_identity: &str,
        servers: &[McpServer],
        records: Vec<ProjectMcpTrustRecord>,
        corrupt: bool,
    ) -> Self {
        let mut declarations = BTreeMap::new();
        for server in servers
            .iter()
            .filter(|server| server.scope == McpScope::Project)
        {
            declarations.insert(
                server.name.clone(),
                declaration_digest(workspace_identity, server),
            );
        }
        let mut trusted = BTreeSet::new();
        let mut stale = BTreeSet::new();
        for record in records {
            if record.workspace_identity != workspace_identity {
                continue;
            }
            match declarations.get(&record.server_name) {
                Some(digest) if *digest == record.declaration_digest => {
                    trusted.insert(record.declaration_digest);
                }
                Some(_) => {
                    stale.insert(record.server_name);
                }
                // 记录对应的声明已从配置里删除：不影响其他服务器，也不需要诊断。
                None => {}
            }
        }
        Self {
            enforced: true,
            workspace_identity: workspace_identity.to_owned(),
            declarations,
            trusted,
            stale,
            corrupt,
        }
    }

    pub fn is_enforced(&self) -> bool {
        self.enforced
    }

    pub fn is_corrupt(&self) -> bool {
        self.corrupt
    }

    pub fn workspace_identity(&self) -> &str {
        &self.workspace_identity
    }

    /// 这个服务器能否装载：非项目作用域、未启用闸门时放行；项目服务器必须摘要命中。
    pub fn admits(&self, server: &McpServer) -> bool {
        !self.enforced
            || server.scope != McpScope::Project
            || self.declaration_rejection(server).is_none()
    }

    /// 拒绝原因；放行时 None。
    pub fn rejection(&self, server: &McpServer) -> Option<ProjectMcpRejection> {
        if !self.enforced || server.scope != McpScope::Project {
            return None;
        }
        self.declaration_rejection(server)
    }

    fn declaration_rejection(&self, server: &McpServer) -> Option<ProjectMcpRejection> {
        if self.corrupt {
            return Some(ProjectMcpRejection::TrustStoreCorrupt);
        }
        match self.declarations.get(&server.name) {
            Some(digest) if self.trusted.contains(digest) => None,
            Some(_) if self.stale.contains(&server.name) => {
                Some(ProjectMcpRejection::DeclarationChanged)
            }
            _ => Some(ProjectMcpRejection::PendingTrust),
        }
    }
}

/// 声明摘要 v1（与 Host `computeWorkspaceMcpDeclarationDigest` 逐字节一致）。
pub fn declaration_digest(workspace_identity: &str, server: &McpServer) -> String {
    let mut canonical = Map::new();
    // 键按 UTF-16 码元排序（全 ASCII，等价于字符串升序）。
    canonical.insert("config".to_owned(), canonical_config(server));
    canonical.insert("serverName".to_owned(), json!(server.name));
    canonical.insert("version".to_owned(), json!(1));
    canonical.insert("workspaceIdentity".to_owned(), json!(workspace_identity));
    let text = serde_json::to_string(&Value::Object(canonical)).unwrap_or_default();
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn canonical_config(server: &McpServer) -> Value {
    let mut config = Map::new();
    match &server.transport {
        McpTransportConfig::Stdio {
            command,
            args,
            env,
            cwd,
        } => {
            config.insert("alwaysLoad".to_owned(), json!(server.options.always_load));
            config.insert("args".to_owned(), json!(args));
            config.insert("command".to_owned(), json!(command));
            config.insert(
                "cwd".to_owned(),
                cwd.as_ref().map_or(Value::Null, |cwd| json!(cwd)),
            );
            config.insert("env".to_owned(), string_map(env));
            config.insert("oauth".to_owned(), Value::Null);
            config.insert(
                "protocolVersion".to_owned(),
                json!(protocol_name(server.protocol)),
            );
            config.insert(
                "timeoutMs".to_owned(),
                server
                    .options
                    .timeout_ms
                    .map_or(Value::Null, |value| json!(value)),
            );
            config.insert("type".to_owned(), json!("stdio"));
        }
        McpTransportConfig::Http { url, headers } | McpTransportConfig::Sse { url, headers } => {
            config.insert("alwaysLoad".to_owned(), json!(server.options.always_load));
            config.insert("headers".to_owned(), string_map(headers));
            config.insert("oauth".to_owned(), oauth(server.oauth.as_ref()));
            config.insert(
                "protocolVersion".to_owned(),
                json!(protocol_name(server.protocol)),
            );
            config.insert(
                "timeoutMs".to_owned(),
                server
                    .options
                    .timeout_ms
                    .map_or(Value::Null, |value| json!(value)),
            );
            config.insert(
                "type".to_owned(),
                json!(match server.transport {
                    McpTransportConfig::Sse { .. } => "sse",
                    _ => "http",
                }),
            );
            config.insert("url".to_owned(), json!(url));
        }
    }
    Value::Object(config)
}

fn protocol_name(protocol: McpProtocolVersion) -> &'static str {
    match protocol {
        McpProtocolVersion::Auto => "auto",
        McpProtocolVersion::Legacy => "legacy",
        McpProtocolVersion::Modern => "2026-07-28",
    }
}

fn string_map(map: &BTreeMap<String, String>) -> Value {
    Value::Object(
        map.iter()
            .map(|(key, value)| (key.clone(), json!(value)))
            .collect(),
    )
}

fn oauth(config: Option<&McpOAuthConfig>) -> Value {
    let Some(config) = config else {
        return Value::Null;
    };
    let mut value = Map::new();
    match config {
        McpOAuthConfig::ClientCredentials {
            client_id,
            client_secret,
            client_name,
            scope,
        } => {
            value.insert("clientId".to_owned(), json!(client_id));
            if let Some(name) = client_name {
                value.insert("clientName".to_owned(), json!(name));
            }
            value.insert("clientSecret".to_owned(), json!(client_secret));
            if let Some(scope) = scope {
                value.insert("scope".to_owned(), json!(scope));
            }
            value.insert("type".to_owned(), json!("client_credentials"));
        }
        McpOAuthConfig::AuthorizationCode {
            client_id,
            client_secret,
            client_name,
            scope,
            redirect_path,
        } => {
            if let Some(id) = client_id {
                value.insert("clientId".to_owned(), json!(id));
            }
            if let Some(name) = client_name {
                value.insert("clientName".to_owned(), json!(name));
            }
            if let Some(secret) = client_secret {
                value.insert("clientSecret".to_owned(), json!(secret));
            }
            if let Some(path) = redirect_path {
                value.insert("redirectPath".to_owned(), json!(path));
            }
            if let Some(scope) = scope {
                value.insert("scope".to_owned(), json!(scope));
            }
            value.insert("type".to_owned(), json!("authorization_code"));
        }
    }
    Value::Object(value)
}

#[cfg(test)]
#[path = "trust_tests.rs"]
mod tests;
