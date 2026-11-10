//! 工作区 MCP 信任记录 `workspace-mcp-trust-v1.json` 的只读解析（A5/A6）。
//!
//! Host（`packages/desktop/src/main/mcpWorkspaceTrust/index.ts`）是唯一写入者；内核只读同一份
//! 用户域文件（`<storage.dir>/security/workspace-mcp-trust-v1.json`）。格式与校验对应 Node
//! `packages/shared/src/workspace-mcp-trust-store-file.ts` 的 strict schema：多余的键、缺字段、
//! 未知版本或重复的 `(workspaceIdentity, serverName, declarationDigest)` 都让整份记录作废
//! （fail closed）。读取不加锁、不改名损坏文件，也不写入。

use nibi_kernel_paths::StoragePath;
use serde_json::{Value, json};

/// 一条信任记录（字段与 Node schema 一一对应）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpTrustRecord {
    pub workspace_identity: String,
    pub server_name: String,
    pub declaration_digest: String,
    pub granted_at: String,
}

/// 读取结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpTrustLoad {
    /// 文件不存在：没有授权（尚未审核）。
    Missing,
    Records(Vec<McpTrustRecord>),
    /// 读不出或不合法：全部视为未信任。
    Corrupt,
}

impl McpTrustLoad {
    /// 某个工作区、某个服务器的已信任摘要。
    pub fn trusted_digests(&self, identity: &str) -> Vec<String> {
        match self {
            Self::Records(records) => records
                .iter()
                .filter(|record| record.workspace_identity == identity)
                .map(|record| record.declaration_digest.clone())
                .collect(),
            Self::Missing | Self::Corrupt => Vec::new(),
        }
    }

    /// 这个服务器有记录、但摘要都不是当前那个：用于诊断“声明已变化”。
    pub fn records_server(&self, identity: &str, server: &str) -> bool {
        match self {
            Self::Records(records) => records.iter().any(|record| {
                record.workspace_identity == identity && record.server_name == server
            }),
            Self::Missing | Self::Corrupt => false,
        }
    }
}

fn non_empty(text: &str) -> bool {
    !text.trim().is_empty()
}

fn sha256_hex(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// zod `z.string().datetime()`：`YYYY-MM-DDTHH:MM:SS[.小数]Z`。
fn datetime(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    };
    let fixed = bytes.len() >= 20
        && digits(0..4)
        && bytes[4] == b'-'
        && digits(5..7)
        && bytes[7] == b'-'
        && digits(8..10)
        && bytes[10] == b'T'
        && digits(11..13)
        && bytes[13] == b':'
        && digits(14..16)
        && bytes[16] == b':'
        && digits(17..19);
    let rest = &text.get(19..).unwrap_or("");
    fixed
        && match rest.strip_suffix('Z') {
            Some("") => true,
            Some(fraction) => fraction
                .strip_prefix('.')
                .is_some_and(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit())),
            None => false,
        }
}

const KEYS: [&str; 4] = [
    "workspaceIdentity",
    "serverName",
    "declarationDigest",
    "grantedAt",
];

impl McpTrustRecord {
    fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        if object.len() != KEYS.len() || object.keys().any(|key| !KEYS.contains(&key.as_str())) {
            return None;
        }
        let text = |key: &str| object.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Self {
            workspace_identity: text("workspaceIdentity").filter(|t| non_empty(t))?,
            server_name: text("serverName").filter(|t| non_empty(t))?,
            declaration_digest: text("declarationDigest").filter(|t| sha256_hex(t))?,
            granted_at: text("grantedAt").filter(|t| datetime(t))?,
        })
    }

    fn key(&self) -> (&str, &str, &str) {
        (
            &self.workspace_identity,
            &self.server_name,
            &self.declaration_digest,
        )
    }
}

/// Node `workspaceMcpTrustStoreFileSchema`：整份解析；任何不合法都返回 None。
fn parse_store(bytes: &[u8]) -> Option<Vec<McpTrustRecord>> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let object = value.as_object()?;
    if object.len() != 2 || object.get("schemaVersion") != Some(&json!(1)) {
        return None;
    }
    let records: Vec<McpTrustRecord> = object
        .get("records")?
        .as_array()?
        .iter()
        .map(McpTrustRecord::parse)
        .collect::<Option<_>>()?;
    let mut keys: Vec<_> = records.iter().map(McpTrustRecord::key).collect();
    keys.sort_unstable();
    let unique = keys.windows(2).all(|pair| pair[0] != pair[1]);
    unique.then_some(records)
}

/// 只读信任记录文件。
#[derive(Debug, Clone)]
pub struct McpTrustStore {
    file: StoragePath,
}

impl McpTrustStore {
    /// `file` 来自 `StoragePaths::mcp_trust_store`。
    pub fn new(file: StoragePath) -> Self {
        Self { file }
    }

    pub fn path(&self) -> &StoragePath {
        &self.file
    }

    /// 读当前记录（不加锁：Host 的写入是原子 rename，读到的总是完整的一版）。
    pub async fn load(&self) -> McpTrustLoad {
        match nibi_kernel_fs::read_optional(self.file.as_path()).await {
            Ok(None) => McpTrustLoad::Missing,
            Ok(Some(bytes)) => {
                parse_store(&bytes).map_or(McpTrustLoad::Corrupt, McpTrustLoad::Records)
            }
            Err(_) => McpTrustLoad::Corrupt,
        }
    }
}

#[cfg(test)]
#[path = "mcp_trust_tests.rs"]
mod tests;
