//! `plugins/referenceCatalog`（含 category 变体）与 `plugins/resolveSuggestedReference` 的协议形状：
//! 会话权威的 fail closed、可选字段的投影、推荐插件的五种状态与来源信任。
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use nibi_kernel_api::env::WorkspaceRef;
use nibi_kernel_api::ids::{EnvironmentId, SessionId};
use nibi_kernel_api::listing::{
    MarketplaceListing, PluginDisplay, PluginListing, PluginReference, SuggestedPluginFacts,
};
use nibi_kernel_api::model::ModelSelection;
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::session_api::{Kernel, KernelError};
use nibi_kernel_base::TaskScope;
use nibi_kernel_protocol_core::connection::{self, Options};
use serde_json::{Value, json};

use crate::context::Context;
use crate::server::{Defaults, SESSION_UNAVAILABLE, Server};

struct FakeKernel {
    references: Mutex<Vec<PluginReference>>,
    facts: Mutex<SuggestedPluginFacts>,
    asked: Mutex<Vec<String>>,
}

impl FakeKernel {
    fn new(references: Vec<PluginReference>, facts: SuggestedPluginFacts) -> Arc<Self> {
        Arc::new(Self {
            references: Mutex::new(references),
            facts: Mutex::new(facts),
            asked: Mutex::new(Vec::new()),
        })
    }

    fn asked(&self) -> Vec<String> {
        self.asked
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[async_trait]
impl Kernel for FakeKernel {
    async fn create_session(
        &self,
        _request: nibi_kernel_api::session_api::CreateSession,
    ) -> Result<SessionId, KernelError> {
        Err(KernelError::Unsupported {
            what: "session creation".to_owned(),
        })
    }

    async fn open_session(
        &self,
        _session: &SessionId,
    ) -> Result<Arc<dyn nibi_kernel_api::session_api::SessionHandle>, KernelError> {
        Err(KernelError::Unsupported {
            what: "session".to_owned(),
        })
    }

    async fn list_sessions(
        &self,
        _filter: nibi_kernel_api::store::SessionFilter,
    ) -> Result<Vec<nibi_kernel_api::store::SessionSummary>, KernelError> {
        Err(KernelError::Unsupported {
            what: "sessions".to_owned(),
        })
    }

    async fn plugin_reference_catalog(
        &self,
        session: Option<&SessionId>,
        _workspace: &WorkspaceRef,
    ) -> Result<Vec<PluginReference>, KernelError> {
        self.asked
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(session.map_or_else(|| "workspace".to_owned(), |id| id.as_str().to_owned()));
        Ok(self
            .references
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }

    async fn suggested_plugin_facts(
        &self,
        _workspace: &WorkspaceRef,
        stable_id: &str,
    ) -> Result<SuggestedPluginFacts, KernelError> {
        self.asked
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(stable_id.to_owned());
        Ok(self
            .facts
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }
}

struct FixedClock;

impl nibi_kernel_api::clock::Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        1_760_000_000_000
    }

    fn time_zone(&self) -> String {
        "UTC".to_owned()
    }
}

fn server_for(kernel: Arc<FakeKernel>) -> Arc<Server> {
    let scope = TaskScope::root("plugin-catalog-test", |_| {});
    let (out, _host_in) = tokio::io::duplex(1 << 16);
    let (peer, _writer) = connection::start(out, &scope.spawner(), Options::default());
    let clock: Arc<dyn nibi_kernel_api::clock::Clock> = Arc::new(FixedClock);
    Arc::new(Server::new(
        Arc::new(Context::new(peer, clock)),
        kernel,
        scope.spawner(),
        Defaults {
            selection: ModelSelection {
                provider: "p".into(),
                model: "m".into(),
                reasoning: None,
                connection: None,
            },
            mode: PermissionMode::Default,
            environment: EnvironmentId::new("env"),
        },
        None,
    ))
}

fn workspace() -> Value {
    json!({"workspace": {"workspacePath": "/work", "workspaceIdentity": "local"}})
}

fn reference(id: &str, enabled: bool, conflicts: &[&str], icon: Option<&str>) -> PluginReference {
    PluginReference {
        plugin_id: id.to_owned(),
        name: id.split('@').next().unwrap_or(id).to_owned(),
        marketplace: id.split('@').nth(1).unwrap_or("nibi-official").to_owned(),
        enabled,
        conflicting_plugin_ids: conflicts.iter().map(|id| (*id).to_owned()).collect(),
        skill_qualified_names: vec!["pdf:extract".to_owned()],
        mcp_server_names: Vec::new(),
        subagent_names: Vec::new(),
        display: PluginDisplay {
            icon: icon.map(str::to_owned),
            display_name: Some("PDF".to_owned()),
            description: Some("PDF tools".to_owned()),
            ..PluginDisplay::default()
        },
        root_path: "/plugins/pdf".to_owned(),
        category: None,
    }
}

fn listing(name: &str) -> MarketplaceListing {
    MarketplaceListing {
        plugin_id: format!("{name}@nibi-official"),
        plugin_name: name.to_owned(),
        marketplace: "nibi-official".to_owned(),
        listing: PluginListing {
            display_name: Some("Spreadsheets".to_owned()),
            icon: Some("https://cdn.example/sheets.png".to_owned()),
            ..PluginListing::default()
        },
    }
}

fn reference_params() -> Value {
    workspace()
}

fn suggested_params(stable_id: &str) -> Value {
    let mut params = workspace();
    params["stableId"] = json!(stable_id);
    params["operationId"] = json!("op-1");
    params["clientMode"] = json!("desktop");
    params["deliveryKind"] = json!("local");
    params
}

#[tokio::test]
async fn the_workspace_catalog_projects_identity_and_skips_root_path() {
    let kernel = FakeKernel::new(
        vec![reference("pdf@nibi-official", true, &[], Some("icon.png"))],
        SuggestedPluginFacts::default(),
    );
    let server = server_for(kernel.clone());
    let result = crate::plugin_catalog::reference(&server, &reference_params(), false)
        .await
        .unwrap();
    assert_eq!(result["authority"], "workspace");
    let entry = &result["plugins"][0];
    assert_eq!(entry["pluginId"], "pdf@nibi-official");
    assert_eq!(entry["enabled"], true);
    assert_eq!(entry["skillQualifiedNames"][0], "pdf:extract");
    assert_eq!(entry["icon"], "icon.png");
    assert_eq!(entry["displayName"], "PDF");
    assert_eq!(entry["description"], "PDF tools");
    // 身份目录不带 rootPath；旧入口也不带 category。
    assert!(entry.get("rootPath").is_none());
    assert!(entry.get("category").is_none());
    assert_eq!(kernel.asked(), ["workspace"]);
}

#[tokio::test]
async fn the_category_variant_always_projects_a_category() {
    let mut entry = reference("pdf@nibi-official", true, &[], None);
    entry.category = Some("documents".to_owned());
    let kernel = FakeKernel::new(
        vec![entry, reference("kit@my-market", true, &[], None)],
        SuggestedPluginFacts::default(),
    );
    let server = server_for(kernel);
    let result = crate::plugin_catalog::reference(&server, &reference_params(), true)
        .await
        .unwrap();
    assert_eq!(result["plugins"][0]["category"], "documents");
    // 没有分类的条目回 "other"（Node `display?.category ?? "other"`）。
    assert_eq!(result["plugins"][1]["category"], "other");
}

#[tokio::test]
async fn an_unknown_session_fails_closed() {
    let kernel = FakeKernel::new(Vec::new(), SuggestedPluginFacts::default());
    let server = server_for(kernel.clone());
    let mut params = reference_params();
    params["sessionId"] = json!("missing-session");
    let error = crate::plugin_catalog::reference(&server, &params, false)
        .await
        .unwrap_err();
    assert_eq!(error.code, SESSION_UNAVAILABLE);
    // 未知会话不回落到工作区权威，也不问内核。
    assert!(kernel.asked().is_empty());
}

#[tokio::test]
async fn a_discovered_suggested_plugin_reports_ready_disabled_or_conflict() {
    let cases = [
        (
            "ready",
            reference("pdf@nibi-official", true, &[], Some("icon.png")),
            "icon.png",
        ),
        (
            "disabled",
            reference("pdf@nibi-official", false, &[], None),
            "https://cdn.example/sheets.png",
        ),
        (
            "conflict",
            reference("pdf@nibi-official", true, &["pdf@my-market"], None),
            "https://cdn.example/sheets.png",
        ),
    ];
    for (expected, entry, expected_icon) in cases {
        let kernel = FakeKernel::new(
            Vec::new(),
            SuggestedPluginFacts {
                entry: Some(entry),
                listing: Some(listing("pdf")),
            },
        );
        let server = server_for(kernel);
        let result =
            crate::plugin_catalog::suggested(&server, &suggested_params("pdf@nibi-official"))
                .await
                .unwrap();
        assert_eq!(result["status"], expected, "{expected}");
        assert_eq!(result["pluginName"], "pdf");
        assert_eq!(result["marketplace"], "nibi-official");
        assert_eq!(result["sourceTrust"], "official");
        // 已安装的条目只回 icon，不回整份 listing。
        assert!(result.get("listing").is_none());
        let diagnostics = result["diagnostics"].as_array().unwrap();
        if expected == "conflict" {
            assert_eq!(
                diagnostics[0]["code"],
                "plugin_suggested_reference_conflict"
            );
            assert_eq!(diagnostics[0]["severity"], "error");
        } else {
            assert!(diagnostics.is_empty());
        }
        // 身份条目的 icon 优先；entry 没图标时回落到目录 listing 的 icon（停用条目同样回）。
        assert_eq!(result["icon"], expected_icon);
    }
}

#[tokio::test]
async fn a_listed_but_missing_plugin_returns_the_store_listing() {
    let kernel = FakeKernel::new(
        Vec::new(),
        SuggestedPluginFacts {
            entry: None,
            listing: Some(listing("spreadsheets")),
        },
    );
    let server = server_for(kernel);
    let result =
        crate::plugin_catalog::suggested(&server, &suggested_params("spreadsheets@nibi-official"))
            .await
            .unwrap();
    assert_eq!(result["status"], "missing");
    assert_eq!(result["pluginName"], "spreadsheets");
    assert_eq!(result["listing"]["displayName"], "Spreadsheets");
    assert_eq!(result["icon"], "https://cdn.example/sheets.png");
}

#[tokio::test]
async fn an_unlisted_plugin_and_an_untrusted_source_are_unavailable() {
    let kernel = FakeKernel::new(Vec::new(), SuggestedPluginFacts::default());
    let server = server_for(kernel.clone());
    let unlisted =
        crate::plugin_catalog::suggested(&server, &suggested_params("ghost@nibi-official"))
            .await
            .unwrap();
    assert_eq!(unlisted["status"], "unavailable");
    assert_eq!(
        unlisted["diagnostics"][0]["code"],
        "plugin_suggested_reference_not_listed"
    );
    // 不是官方市场的来源：不查内核、直接拒绝。
    let untrusted = crate::plugin_catalog::suggested(&server, &suggested_params("pdf@my-market"))
        .await
        .unwrap();
    assert_eq!(untrusted["status"], "unavailable");
    assert_eq!(
        untrusted["diagnostics"][0]["code"],
        "plugin_suggested_reference_untrusted_source"
    );
    // 奇怪的 ID（缺 marketplace、路径字符）同样按不可信来源处理。
    for stable_id in ["pdf", "@/x", "../escape@nibi-official", "pdf@"] {
        let result = crate::plugin_catalog::suggested(&server, &suggested_params(stable_id))
            .await
            .unwrap();
        assert_eq!(result["status"], "unavailable", "{stable_id}");
    }
    assert_eq!(kernel.asked().len(), 1);
}

#[tokio::test]
async fn params_are_strict() {
    let kernel = FakeKernel::new(Vec::new(), SuggestedPluginFacts::default());
    let server = server_for(kernel);
    let mut params = reference_params();
    params["extra"] = json!(true);
    assert!(
        crate::plugin_catalog::reference(&server, &params, false)
            .await
            .is_err()
    );
    let mut params = suggested_params("pdf@nibi-official");
    params["operationId"] = json!(7);
    assert!(
        crate::plugin_catalog::suggested(&server, &params)
            .await
            .is_err()
    );
}
