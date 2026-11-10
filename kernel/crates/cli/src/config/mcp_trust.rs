//! 入口读取 Host 写入的工作区 MCP 信任记录（A5/A6），组装成 ext 的 [`ProjectMcpTrust`]。
//!
//! Host 是唯一写入者（`packages/desktop/src/main/mcpWorkspaceTrust/index.ts`）；这里只读
//! `<storage.dir>/security/workspace-mcp-trust-v1.json`，不创建、不修复、不写入。存储缺失表示
//! 没有授权；损坏/不可读时 `corrupt = true`，ext 会拒绝全部项目服务器。

use nibi_kernel_ext::mcp::{McpServer, ProjectMcpTrust, ProjectMcpTrustRecord};
use nibi_kernel_paths::StoragePaths;
use nibi_kernel_platform::{McpTrustLoad, McpTrustStore};
use serde_json::Map;

/// 用户级配置的 `storage.dir`（与 hooks 信任记录同一存储根）。
fn storage_dir(user: Option<&Map<String, serde_json::Value>>) -> Option<&str> {
    user?.get("storage")?.get("dir")?.as_str()
}

/// 读 Host 记录并构造当前工作区的信任快照。`workspace_identity` 与 Host 一致：工作区根路径
/// （远程 identity 由入口按需传入；不匹配时 fail closed）。
pub(crate) async fn load(
    paths: &StoragePaths,
    user: Option<&Map<String, serde_json::Value>>,
    workspace_identity: &str,
    servers: &[McpServer],
) -> ProjectMcpTrust {
    let store = McpTrustStore::new(paths.mcp_trust_store(storage_dir(user)));
    match store.load().await {
        McpTrustLoad::Missing => {
            ProjectMcpTrust::from_records(workspace_identity, servers, Vec::new(), false)
        }
        McpTrustLoad::Records(records) => ProjectMcpTrust::from_records(
            workspace_identity,
            servers,
            records
                .into_iter()
                .map(|record| ProjectMcpTrustRecord {
                    workspace_identity: record.workspace_identity,
                    server_name: record.server_name,
                    declaration_digest: record.declaration_digest,
                })
                .collect(),
            false,
        ),
        McpTrustLoad::Corrupt => {
            tracing::warn!(
                event = "mcp.project_trust.store_corrupt",
                path = %store.path().as_path().display(),
                "workspace MCP trust store is corrupt; all project servers are denied"
            );
            ProjectMcpTrust::from_records(workspace_identity, servers, Vec::new(), true)
        }
    }
}
