//! 插件来源与启用判定（ext.md §4.3、§4.4）。

use std::collections::BTreeMap;

use nibi_kernel_api::env::EnvPath;
use nibi_kernel_api::testing::MemoryEnvironment;

use super::*;
use crate::test_support::{facts, workspace};

const OFFICIAL: &str = "nibi-official";
const CACHE: &str = "/Users/dev/.nibi/cli/plugins/cache";

fn manifest(dir: &str, body: &str) -> (String, String) {
    (format!("{dir}/.nibi-plugin/plugin.json"), body.to_owned())
}

fn env(files: &[(String, String)]) -> MemoryEnvironment {
    files
        .iter()
        .fold(MemoryEnvironment::new(facts()), |env, (path, text)| {
            env.with_file(path, text)
        })
}

fn candidate(dir: &str, marketplace: &str, origin: PluginOrigin) -> PluginCandidate {
    PluginCandidate {
        dir: EnvPath::new(dir),
        marketplace: marketplace.to_owned(),
        origin,
        paid: false,
    }
}

fn official(name: &str) -> PluginCandidate {
    candidate(
        &format!("{CACHE}/{OFFICIAL}/{name}/1.0.0"),
        OFFICIAL,
        PluginOrigin::Official,
    )
}

fn official_manifest(name: &str, extra: &str) -> (String, String) {
    manifest(
        &format!("{CACHE}/{OFFICIAL}/{name}/1.0.0"),
        &format!(r#"{{"name": "{name}"{extra}}}"#),
    )
}

fn enabled(pairs: &[(&str, bool)]) -> BTreeMap<String, bool> {
    pairs
        .iter()
        .map(|(id, on)| ((*id).to_owned(), *on))
        .collect()
}

fn names(loaded: &Loaded) -> Vec<&str> {
    loaded
        .plugins
        .0
        .iter()
        .map(|plugin| plugin.name.as_str())
        .collect()
}

fn reasons(loaded: &Loaded) -> Vec<(Option<&str>, &SkipReason)> {
    loaded
        .skipped
        .iter()
        .map(|skipped| (skipped.id.as_deref(), &skipped.reason))
        .collect()
}

#[tokio::test]
async fn enablement_follows_enabled_plugins_and_the_defaults() {
    let files = [
        manifest("/Users/dev/cfg", r#"{"name": " cfg-kit "}"#),
        (
            "/Users/dev/cfg/skills/hello/SKILL.md".to_owned(),
            "Hello\n".to_owned(),
        ),
        manifest("/Users/dev/off", r#"{"name": "off"}"#),
        manifest("/Users/dev/market-kit", r#"{"name": "market-kit"}"#),
        manifest("/Users/dev/on-kit", r#"{"name": "on-kit"}"#),
        official_manifest("skill-creator", ""),
        official_manifest("restore-legacy-sessions", ""),
        official_manifest("zcode-guide", ""),
    ];
    let sources = PluginSources {
        candidates: vec![
            candidate("/Users/dev/cfg", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/off", "inline", PluginOrigin::ConfigDir),
            official("skill-creator"),
            official("restore-legacy-sessions"),
            official("zcode-guide"),
            candidate("/Users/dev/market-kit", "market", PluginOrigin::Installed),
            candidate("/Users/dev/on-kit", "market", PluginOrigin::Installed),
        ],
        enabled_plugins: enabled(&[("off@inline", false), ("on-kit@market", true)]),
        suppressed_builtins: vec![format!("zcode-guide@{OFFICIAL}")],
        paid_installed_ids: Vec::new(),
        paid_license: None,
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    // 配置目录缺省启用；官方插件只有缺省名单里的启用；已安装插件要 `enabledPlugins` 打开。
    assert_eq!(names(&loaded), ["cfg-kit", "skill-creator", "on-kit"]);
    assert_eq!(
        loaded.plugins.0[0].skill_dirs,
        ["/Users/dev/cfg/skills".to_owned()]
    );
    assert_eq!(
        reasons(&loaded),
        [
            (Some("off@inline"), &SkipReason::Disabled),
            (
                Some("restore-legacy-sessions@nibi-official"),
                &SkipReason::Disabled
            ),
            (
                Some("zcode-guide@nibi-official"),
                &SkipReason::Suppressed
            ),
            (Some("market-kit@market"), &SkipReason::Disabled),
        ]
    );
}

#[tokio::test]
async fn paid_plugins_are_pruned_without_a_license() {
    let files = [
        manifest(
            "/Users/dev/paid",
            r#"{"name": "paid-kit", "skills": "./skills"}"#,
        ),
        (
            "/Users/dev/paid/skills/secret/SKILL.md".to_owned(),
            "---\ndescription: Secret\n---\nBody\n".to_owned(),
        ),
    ];
    let sources = PluginSources {
        candidates: vec![PluginCandidate {
            dir: EnvPath::new("/Users/dev/paid"),
            marketplace: "inline".to_owned(),
            origin: PluginOrigin::ConfigDir,
            paid: true,
        }],
        enabled_plugins: enabled(&[("paid-kit@inline", true)]),
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    assert!(names(&loaded).is_empty(), "{:?}", names(&loaded));
    assert!(matches!(
        loaded.skipped[0].reason,
        SkipReason::MembershipRequired(_)
    ));
}

#[tokio::test]
async fn installed_paid_records_prune_the_official_cache_copy_too() {
    // 官方缓存与 installed_plugins.json 同 id 时，官方候选先到；付费判据必须看安装记录，
    // 否则把 paid 记录复制到官方缓存旁就能绕过门禁。
    let files = [official_manifest(
        "paid-kit",
        r#", "skills": "./skills""#,
    )];
    let sources = PluginSources {
        candidates: vec![official("paid-kit")],
        enabled_plugins: enabled(&[("paid-kit@nibi-official", true)]),
        paid_installed_ids: vec![format!("paid-kit@{OFFICIAL}")],
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    assert!(names(&loaded).is_empty(), "{:?}", names(&loaded));
    assert!(matches!(
        loaded.skipped[0].reason,
        SkipReason::MembershipRequired(_)
    ));
}

#[tokio::test]
async fn sources_other_than_the_command_line_need_a_valid_manifest() {
    let files = [
        (
            "/Users/dev/bare/skills/x/SKILL.md".to_owned(),
            "B\n".to_owned(),
        ),
        manifest("/Users/dev/bad", r#"{"name": "Bad Name"}"#),
        (
            "/Users/dev/codex/.codex-plugin/plugin.json".to_owned(),
            r#"{"name": "codex-kit"}"#.to_owned(),
        ),
        (
            "/Users/dev/session/skills/y/SKILL.md".to_owned(),
            "S\n".to_owned(),
        ),
    ];
    let sources = PluginSources {
        candidates: vec![
            candidate("/Users/dev/bare", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/bad", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/codex", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/missing", "inline", PluginOrigin::ConfigDir),
        ],
        ..PluginSources::default()
    };
    let session = [EnvPath::new("/Users/dev/session")];
    let loaded = load_all(&env(&files), &workspace(), &session, &sources).await;
    // `--plugin-dir` 没有 manifest 时取目录名；其余来源按 Node 必须有合法的 manifest。
    assert_eq!(names(&loaded), ["session", "codex-kit"]);
    let reasons: Vec<&SkipReason> = loaded.skipped.iter().map(|s| &s.reason).collect();
    assert!(matches!(
        reasons.as_slice(),
        [
            SkipReason::ManifestMissing,
            SkipReason::ManifestInvalid(_),
            SkipReason::RootMissing
        ]
    ));
}

#[tokio::test]
async fn session_plugins_and_first_comers_win_name_conflicts() {
    let files = [
        manifest("/Users/dev/session-dup", r#"{"name": "dup"}"#),
        manifest("/Users/dev/cfg-dup", r#"{"name": "dup"}"#),
        manifest("/Users/dev/twin-a", r#"{"name": "twin"}"#),
        manifest("/Users/dev/twin-b", r#"{"name": "twin"}"#),
        manifest("/Users/dev/twin-market", r#"{"name": "twin"}"#),
    ];
    let sources = PluginSources {
        candidates: vec![
            candidate("/Users/dev/cfg-dup", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/twin-a", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/twin-b", "inline", PluginOrigin::ConfigDir),
            candidate("/Users/dev/twin-market", "market", PluginOrigin::Installed),
        ],
        enabled_plugins: enabled(&[("twin@market", true)]),
        ..PluginSources::default()
    };
    let session = [EnvPath::new("/Users/dev/session-dup")];
    let loaded = load_all(&env(&files), &workspace(), &session, &sources).await;
    assert_eq!(names(&loaded), ["dup", "twin"]);
    assert_eq!(loaded.plugins.0[1].dir, "/Users/dev/twin-a");
    assert_eq!(
        reasons(&loaded),
        [
            (Some("dup@inline"), &SkipReason::ShadowedBySession),
            (Some("twin@inline"), &SkipReason::DuplicateId),
            (Some("twin@market"), &SkipReason::DuplicateName),
        ]
    );
}

#[tokio::test]
async fn bundled_plugins_that_need_the_node_runtime_are_skipped() {
    let host_mcp = r#", "mcpServers": {"documents": {"type": "stdio", "command": "/opt/zcode/zcode", "args": ["__zcode-plugin-host", "/x/dist/mcp/server.js"]}}"#;
    let files = [
        official_manifest("browser-use", r#", "skills": "skills""#),
        official_manifest("computer-use", ""),
        official_manifest("documents", host_mcp),
        official_manifest("image-search", ""),
        (
            format!("{CACHE}/{OFFICIAL}/image-search/1.0.0/.mcp.json"),
            r#"{"mcpServers": {"image_search": {"type": "http", "url": "${NIBI_BASE_URL}/mcp", "auth": {"type": "zcode_official", "provider": "jwt_token"}}}}"#.to_owned(),
        ),
        official_manifest("visualize", ""),
        official_manifest("android-emulator", host_mcp),
        official_manifest("skill-creator", ""),
        manifest(
            "/Users/dev/third",
            &format!(r#"{{"name": "third"{host_mcp}}}"#),
        ),
    ];
    let sources = PluginSources {
        candidates: vec![
            official("browser-use"),
            official("computer-use"),
            official("documents"),
            official("image-search"),
            official("visualize"),
            official("android-emulator"),
            official("skill-creator"),
            candidate("/Users/dev/third", "market", PluginOrigin::Installed),
        ],
        enabled_plugins: enabled(&[
            ("computer-use@nibi-official", true),
            ("third@market", true),
        ]),
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    // 只判定官方市场的插件：第三方插件里同样的参数照常加载。
    assert_eq!(names(&loaded), ["skill-creator", "third"]);
    assert_eq!(
        reasons(&loaded),
        [
            (
                Some("browser-use@nibi-official"),
                &SkipReason::NodeRuntime(NodeDependency::NodeRepl)
            ),
            (
                Some("computer-use@nibi-official"),
                &SkipReason::NodeRuntime(NodeDependency::NodeRepl)
            ),
            (
                Some("documents@nibi-official"),
                &SkipReason::NodeRuntime(NodeDependency::PluginHost)
            ),
            (
                Some("image-search@nibi-official"),
                &SkipReason::NodeRuntime(NodeDependency::OfficialAuth)
            ),
            (
                Some("visualize@nibi-official"),
                &SkipReason::NodeRuntime(NodeDependency::ViewHost)
            ),
            // 未启用的插件只记“未启用”，不判定 Node 依赖。
            (
                Some("android-emulator@nibi-official"),
                &SkipReason::Disabled
            ),
        ]
    );
}

#[tokio::test]
async fn a_hosted_node_repl_admits_computer_use_and_the_shared_host() {
    let files = [
        official_manifest("node-repl-host", ""),
        official_manifest("browser-use", r#", "skills": "skills""#),
        official_manifest("computer-use", r#", "skills": "skills""#),
        (
            format!("{CACHE}/{OFFICIAL}/computer-use/1.0.0/skills/computer-use/SKILL.md"),
            "---\ndescription: Computer Use\n---\nBody\n".to_owned(),
        ),
    ];
    let sources = PluginSources {
        candidates: vec![
            official("node-repl-host"),
            official("browser-use"),
            official("computer-use"),
        ],
        enabled_plugins: enabled(&[("computer-use@nibi-official", true)]),
        host_node_repl: true,
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    // browser-use 还缺 Host 的 broker socket，继续跳过；宿主与 CUA 放行。
    assert_eq!(names(&loaded), ["node-repl-host", "computer-use"]);
    assert_eq!(
        reasons(&loaded),
        [(
            Some("browser-use@nibi-official"),
            &SkipReason::NodeRuntime(NodeDependency::NodeRepl)
        )]
    );
    assert_eq!(
        loaded.plugins.0[1].skill_dirs,
        [format!("{CACHE}/{OFFICIAL}/computer-use/1.0.0/skills")]
    );
}

#[tokio::test]
async fn a_hosted_browser_broker_admits_browser_use_too() {
    let files = [
        official_manifest("node-repl-host", ""),
        official_manifest("browser-use", ""),
        official_manifest("computer-use", ""),
    ];
    let sources = PluginSources {
        candidates: vec![
            official("node-repl-host"),
            official("browser-use"),
            official("computer-use"),
        ],
        enabled_plugins: enabled(&[("computer-use@nibi-official", true)]),
        host_node_repl: true,
        host_browser_broker: true,
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    assert_eq!(
        names(&loaded),
        ["node-repl-host", "browser-use", "computer-use"]
    );
    assert!(loaded.skipped.is_empty());
}

/// 加载一次的产出里就带着 Composer `@` 面板的身份目录：已加载条目的身份/能力/展示，以及停用条目
/// 声明出来的组件名（Node `buildPluginReferenceCatalog` 的口径）。
#[tokio::test]
async fn the_reference_catalog_is_built_from_the_same_load() {
    use nibi_kernel_api::listing::{MarketplaceListing, PluginListing};

    let files = [
        manifest("/Users/dev/cfg", r#"{"name": "kit", "description": "Kit tools"}"#),
        (
            "/Users/dev/cfg/skills/hello/SKILL.md".to_owned(),
            "Hello\n".to_owned(),
        ),
        (
            "/Users/dev/cfg/agents/team/lead.md".to_owned(),
            "Lead\n".to_owned(),
        ),
        (
            "/Users/dev/cfg/.mcp.json".to_owned(),
            r#"{"mcpServers": {"web": {"type": "http", "url": "https://mcp.example.com"}}}"#
                .to_owned(),
        ),
        official_manifest("restore-legacy-sessions", ""),
        (
            format!("{CACHE}/{OFFICIAL}/restore-legacy-sessions/1.0.0/skills/undo/SKILL.md"),
            "Undo\n".to_owned(),
        ),
    ];
    let sources = PluginSources {
        candidates: vec![
            candidate("/Users/dev/cfg", "inline", PluginOrigin::ConfigDir),
            official("restore-legacy-sessions"),
        ],
        listings: vec![MarketplaceListing {
            plugin_id: "kit@inline".to_owned(),
            plugin_name: "kit".to_owned(),
            marketplace: "inline".to_owned(),
            listing: PluginListing {
                display_name: Some("Kit".to_owned()),
                icon: Some("https://cdn.example/kit.png".to_owned()),
                category: Some("developer-tools".to_owned()),
                ..PluginListing::default()
            },
        }],
        ..PluginSources::default()
    };
    let loaded = load_all(&env(&files), &workspace(), &[], &sources).await;
    let catalog = &loaded.catalog.references;
    assert_eq!(catalog.len(), 2);

    let kit = &catalog[0];
    assert_eq!(kit.plugin_id, "kit@inline");
    assert_eq!(kit.marketplace, "inline");
    assert!(kit.enabled);
    assert!(kit.conflicting_plugin_ids.is_empty());
    assert_eq!(kit.skill_qualified_names, ["kit:hello"]);
    assert_eq!(kit.subagent_names, ["kit:team:lead"]);
    assert_eq!(kit.mcp_server_names, ["plugin:kit:web"]);
    assert_eq!(kit.display.description.as_deref(), Some("Kit tools"));
    assert_eq!(kit.display.display_name.as_deref(), Some("Kit"));
    assert_eq!(kit.display.icon.as_deref(), Some("https://cdn.example/kit.png"));
    assert_eq!(kit.category.as_deref(), Some("developer-tools"));

    // 停用（缺省不启用）的官方插件仍在目录里：能力名来自 manifest 目录的声明，MCP 名称为空。
    let disabled = &catalog[1];
    assert_eq!(disabled.plugin_id, "restore-legacy-sessions@nibi-official");
    assert!(!disabled.enabled);
    assert_eq!(disabled.skill_qualified_names, ["restore-legacy-sessions:undo"]);
    assert!(disabled.mcp_server_names.is_empty());
}
