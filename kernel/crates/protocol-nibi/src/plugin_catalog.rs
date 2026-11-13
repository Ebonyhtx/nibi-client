//! Composer 的 `@` 插件引用面板与推荐插件的安装前解析（Host `nibiPluginsReferenceCatalogParamsSchema`、
//! `nibiPluginsResolveSuggestedReferenceParamsSchema`）。
//!
//! 与 Node `apps/nibi-cli/.../nibi-protocol/plugin-reference-catalog.ts` 同口径：
//! - 带 `sessionId` → 该会话创建时冻结的身份目录（`authority: "session"`）；未知会话 fail closed，
//!   不回落到当前工作区（否则新装的插件会漏进旧对话）；
//! - 不带 → 每次按当前配置现扫工作区（`authority: "workspace"`），手改配置后不用重启；
//! - 条目只投影身份与展示字段：`rootPath` 不出协议，`category` 只有 `WithCategory` 变体返回。
//!
//! 推荐插件的解析只认官方市场（`nibi-official`）的稳定 ID；目录里没有的条目按 `missing` 返回，让 UI 走
//! 安装确认。刷新官方目录是 Host 的插件管理职责（`plugins/updateMarketplace` 由 Host 直答），本内核只读
//! 它落盘的快照——所以这里不重新发明一条网络刷新路径，也不伪造 `refreshing` 进度通知。

use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::listing::PluginReference;
use nibi_kernel_protocol_core::rpc::RpcError;
use serde_json::{Map, Value, json};

use crate::mcp_rpc::{object, strict_keys, workspace_param};
use crate::server::Server;

/// 推荐插件只认这个官方市场（Node `NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID`）。
const OFFICIAL_MARKETPLACE: &str = nibi_kernel_base::names::OFFICIAL_MARKETPLACE;

/// `plugins/referenceCatalog` 与 `plugins/referenceCatalogWithCategory` 的处理器。
pub(crate) async fn reference(
    server: &Server,
    params: &Value,
    include_category: bool,
) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &["workspace", "sessionId"],
        "plugins/referenceCatalog params",
    )?;
    let (workspace_path, _) = workspace_param(params.get("workspace"))?;
    let workspace = server.workspace(&workspace_path);
    let session = session_param(params)?;
    if let Some(session) = &session
        && server.bridge.get(session).is_none()
    {
        return Err(crate::server::session_unavailable(session));
    }
    let entries = server
        .kernel
        .plugin_reference_catalog(session.as_ref(), &workspace)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;
    Ok(json!({
        "authority": if session.is_some() { "session" } else { "workspace" },
        "plugins": entries
            .iter()
            .map(|entry| entry_json(entry, include_category))
            .collect::<Vec<_>>(),
    }))
}

/// `plugins/resolveSuggestedReference` 的处理器。
pub(crate) async fn suggested(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let params = object(params)?;
    strict_keys(
        params,
        &[
            "workspace",
            "stableId",
            "operationId",
            "clientMode",
            "deliveryKind",
        ],
        "plugins/resolveSuggestedReference params",
    )?;
    let (workspace_path, _) = workspace_param(params.get("workspace"))?;
    let workspace = server.workspace(&workspace_path);
    for key in ["operationId", "clientMode", "deliveryKind"] {
        if params.get(key).and_then(Value::as_str).is_none() {
            return Err(RpcError::invalid_params(&format!("{key} must be a string")));
        }
    }
    let stable_id = params
        .get("stableId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_owned();
    // 推荐插件的来源必须是我们自己的官方市场：其它 marketplace（用户手工添加的源、上游市场）里的
    // 同名插件不能被推荐 Prompt 静默装上。
    let (plugin_name, marketplace) = match stable_id.rsplit_once('@') {
        Some((name, marketplace))
            if !name.is_empty()
                && valid_segment(name)
                && valid_segment(marketplace)
                && marketplace == OFFICIAL_MARKETPLACE =>
        {
            (name, marketplace)
        }
        _ => {
            return Ok(unavailable(
                &stable_id,
                "plugin_suggested_reference_untrusted_source",
                "推荐插件不是受信任的官方 nibi-official 来源",
            ));
        }
    };
    let facts = server
        .kernel
        .suggested_plugin_facts(&workspace, &stable_id)
        .await
        .map_err(|error| crate::server::kernel_error(&error))?;

    // 已发现（含停用/冲突）：状态由身份目录决定，展示用的 icon 来自商店 listing。
    if let Some(entry) = &facts.entry {
        let (status, diagnostics) = if !entry.conflicting_plugin_ids.is_empty() {
            (
                "conflict",
                vec![diagnostic(
                    "plugin_suggested_reference_conflict",
                    "推荐插件存在同名冲突，不能自动安装或引用",
                    &stable_id,
                )],
            )
        } else if entry.enabled {
            ("ready", Vec::new())
        } else {
            ("disabled", Vec::new())
        };
        let mut result = json!({
            "stableId": stable_id,
            "status": status,
            "marketplace": marketplace,
            "pluginName": plugin_name,
            "sourceTrust": "official",
            "diagnostics": diagnostics,
        });
        if let Some(icon) = entry.display.icon.clone().or_else(|| {
            facts
                .listing
                .as_ref()
                .and_then(|listing| listing.listing.icon.clone())
        }) {
            result["icon"] = json!(icon);
        }
        return Ok(result);
    }

    // 官方目录里有、本机还没装：回 `missing` + listing，UI 据此走安装确认。
    if let Some(listing) = facts.listing.filter(|listing| {
        listing.plugin_name == plugin_name && listing.marketplace == OFFICIAL_MARKETPLACE
    }) {
        let mut result = json!({
            "stableId": stable_id,
            "status": "missing",
            "marketplace": OFFICIAL_MARKETPLACE,
            "pluginName": listing.plugin_name,
            "sourceTrust": "official",
            "listing": listing.listing,
            "diagnostics": [],
        });
        if let Some(icon) = listing.listing.icon.clone() {
            result["icon"] = json!(icon);
        }
        return Ok(result);
    }

    Ok(unavailable(
        &stable_id,
        "plugin_suggested_reference_not_listed",
        "官方目录中未找到该插件",
    ))
}

/// `pluginId` 的两段都只允许标识符字符（Node 用来挡住 `@`/路径注入的正则）。
fn valid_segment(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn session_param(params: &Map<String, Value>) -> Result<Option<SessionId>, RpcError> {
    match params.get("sessionId") {
        None => Ok(None),
        Some(Value::String(text)) if !text.trim().is_empty() => {
            Ok(Some(SessionId::new(text.trim())))
        }
        Some(_) => Err(RpcError::invalid_params(
            "sessionId must be a non-empty string",
        )),
    }
}

fn diagnostic(code: &str, message: &str, plugin_id: &str) -> Value {
    json!({
        "code": code,
        "message": message,
        "severity": "error",
        "pluginId": plugin_id,
    })
}

fn unavailable(stable_id: &str, code: &str, message: &str) -> Value {
    json!({
        "stableId": stable_id,
        "status": "unavailable",
        "diagnostics": [diagnostic(code, message, stable_id)],
    })
}

/// 一条目录条目（身份 + 展示）。空的可选字段不下发（Host 的 strict schema 按缺失处理）。
fn entry_json(entry: &PluginReference, include_category: bool) -> Value {
    let mut object = Map::new();
    if include_category {
        object.insert(
            "category".to_owned(),
            json!(entry.category.as_deref().unwrap_or("other")),
        );
    }
    object.insert("pluginId".to_owned(), json!(entry.plugin_id));
    object.insert("name".to_owned(), json!(entry.name));
    object.insert("marketplace".to_owned(), json!(entry.marketplace));
    object.insert("enabled".to_owned(), json!(entry.enabled));
    object.insert(
        "conflictingPluginIds".to_owned(),
        json!(entry.conflicting_plugin_ids),
    );
    object.insert(
        "skillQualifiedNames".to_owned(),
        json!(entry.skill_qualified_names),
    );
    object.insert("mcpServerNames".to_owned(), json!(entry.mcp_server_names));
    object.insert("subagentNames".to_owned(), json!(entry.subagent_names));
    let display = &entry.display;
    if let Some(icon) = &display.icon {
        object.insert("icon".to_owned(), json!(icon));
    }
    if let Some(display_name) = &display.display_name {
        object.insert("displayName".to_owned(), json!(display_name));
    }
    if !display.display_name_i18n.is_empty() {
        object.insert(
            "displayNameI18n".to_owned(),
            json!(display.display_name_i18n),
        );
    }
    if let Some(description) = &display.description {
        object.insert("description".to_owned(), json!(description));
    }
    if !display.description_i18n.is_empty() {
        object.insert(
            "descriptionI18n".to_owned(),
            json!(display.description_i18n),
        );
    }
    Value::Object(object)
}

/// 商店条目在测试与文档里用得到（避免测试自己拼 JSON）。
#[cfg(test)]
#[path = "plugin_catalog_tests.rs"]
mod tests;
