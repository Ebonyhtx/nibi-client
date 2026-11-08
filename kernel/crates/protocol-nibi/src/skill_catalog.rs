//! `skills/referenceCatalog`（Host `zcodeSkillsReferenceCatalogParamsSchema`）：Composer 的 `@` 技能引用面板。
//!
//! 与 Node `apps/zcode-cli/.../nibi-protocol/skill-reference-catalog.ts` 同口径：
//! - 带 `sessionId` → 该会话创建时冻结的发现结果（`authority: "session"`）；未知会话 fail closed，
//!   不回落到当前工作区（否则新加的 skill 会漏进旧对话）；
//! - 不带 → 每次现扫当前工作区（`authority: "workspace"`），手改目录后不用重启；
//! - 内置（bundled）skill 不进面板；条目的 `id` 是 `glm:<scope>:<path>`（Host 的 UI 按 `glm:` 前缀过滤）。

use nibi_kernel_api::ids::SessionId;
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{Value, json};

use crate::mcp_rpc::{object, strict_keys, workspace_param};
use crate::server::Server;

/// `skills/referenceCatalog` 的处理器。
pub(crate) async fn skills(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &["workspace", "sessionId"],
        "skills/referenceCatalog params",
    )?;
    let (workspace_path, _) = workspace_param(params.get("workspace"))?;
    let workspace = server.workspace(&workspace_path);
    let session = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(SessionId::new);
    if let Some(session) = &session
        && server.bridge.get(session).is_none()
    {
        return Err(crate::server::session_unavailable(session));
    }
    let entries = server
        .kernel
        .skill_reference_catalog(session.as_ref(), &workspace)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    Ok(json!({
        "authority": if session.is_some() { "session" } else { "workspace" },
        "skills": entries,
    }))
}
