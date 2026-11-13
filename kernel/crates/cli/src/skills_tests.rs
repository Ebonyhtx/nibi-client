#![allow(
    clippy::disallowed_methods,
    clippy::unwrap_used,
    reason = "tests create temporary SKILL.md fixtures (README §4)"
)]

use std::path::Path;
use std::sync::Arc;

use nibi_kernel_api::env::{EnvPath, WorkspaceRef};
use nibi_kernel_api::ids::EnvironmentId;
use nibi_kernel_env_local::LocalEnvironment;
use nibi_kernel_ext::{SkillCatalog, SkillSource};

use super::*;

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| (*arg).to_owned()).collect()
}

#[test]
fn the_subcommands_and_flags_are_parsed() {
    assert_eq!(
        parse(&args(&["skills", "list", "--json", "--cwd", "sub"])),
        Some(Ok(Command::List {
            json: true,
            cwd: Some("sub".to_owned()),
        }))
    );
    assert_eq!(
        parse(&args(&["skills", "inspect", "review"])),
        Some(Ok(Command::Inspect {
            name: "review".to_owned(),
            json: false,
            cwd: None,
        }))
    );
    assert_eq!(
        parse(&args(&["skills", "inspect"])),
        Some(Err(
            "missing skill name\nUsage:\n  nibi skills list [--json] [--cwd <path>]\n  nibi skills inspect <name> [--json] [--cwd <path>]\n"
                .to_owned()
        ))
    );
    assert_eq!(
        parse(&args(&["skills", "--nope"])),
        Some(Err(
            "unknown option '--nope'\nUsage:\n  nibi skills list [--json] [--cwd <path>]\n  nibi skills inspect <name> [--json] [--cwd <path>]\n"
                .to_owned()
        ))
    );
    assert_eq!(
        parse(&args(&["skills", "list", "--cwd"])),
        Some(Err(
            "option '--cwd <path>' argument missing\nUsage:\n  nibi skills list [--json] [--cwd <path>]\n  nibi skills inspect <name> [--json] [--cwd <path>]\n"
                .to_owned()
        ))
    );
    assert_eq!(
        parse(&args(&["skills", "list", "--help"])),
        Some(Ok(Command::Help))
    );
    assert_eq!(parse(&args(&["commands"])), None);
}

fn write_skill(root: &Path, name: &str, description: &str) {
    let dir = root.join(".nibi").join("skills").join(name);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        format!(
            "---\nname: {name}\ndescription: {description}\nallowed-tools: Read, Bash(git *)\n---\n\n# {name}\n"
        ),
    )
    .unwrap();
}

async fn catalog(home: &Path, cwd: &Path) -> (SkillCatalog, WorkspaceRef) {
    let env = Arc::new(LocalEnvironment::new(Some(home.to_path_buf())));
    let catalog = SkillCatalog::new(env.clone(), env);
    let workspace = WorkspaceRef {
        environment: EnvironmentId::new(crate::LOCAL_ENVIRONMENT),
        root: EnvPath::new(cwd.to_string_lossy()),
    };
    (catalog, workspace)
}

#[tokio::test]
async fn user_skills_win_over_project_skills_with_the_same_name() {
    let home = tempfile::tempdir().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    write_skill(home.path(), "shared", "from the user directory");
    write_skill(cwd.path(), "shared", "from the project");
    write_skill(cwd.path(), "project-only", "only in the project");
    let (catalog, workspace) = catalog(home.path(), cwd.path()).await;
    let skills = catalog.skills(&workspace).await;
    let shared = skills.iter().find(|skill| skill.name == "shared").unwrap();
    assert_eq!(shared.source, SkillSource::User);
    assert_eq!(shared.description, "from the user directory");
    assert!(skills.iter().any(|skill| skill.name == "project-only"));
    assert_eq!(shared.allowed_tools, ["Read", "Bash(git *)"]);
}

#[tokio::test]
async fn disabled_paths_are_not_listed() {
    let home = tempfile::tempdir().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    write_skill(cwd.path(), "review", "review code");
    let dir = cwd.path().join(".nibi").join("skills").join("review");
    let file = skill_file(&dir.to_string_lossy());
    let (catalog, workspace) = catalog(home.path(), cwd.path()).await;
    catalog.set_disabled_paths(vec![file]);
    let skills = catalog.skills(&workspace).await;
    assert!(
        skills.iter().all(|skill| skill.name != "review"),
        "{:?}",
        skills.iter().map(|s| &s.name).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn list_json_has_the_contract_fields() {
    let home = tempfile::tempdir().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    write_skill(cwd.path(), "review", "review code");
    let (catalog, workspace) = catalog(home.path(), cwd.path()).await;
    let skills = catalog.skills(&workspace).await;
    let value: Value = serde_json::from_str(&list_text(&skills, true)).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    let skill = &value["skills"][0];
    assert_eq!(skill["name"], "review");
    assert_eq!(skill["source"], "project");
    assert_eq!(skill["description"], "review code");
    assert_eq!(skill["enabled"], true);
    assert!(skill["path"].as_str().unwrap().ends_with("SKILL.md"));
}

#[tokio::test]
async fn inspect_json_carries_the_frontmatter_and_parsed_metadata() {
    let home = tempfile::tempdir().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    write_skill(cwd.path(), "review", "review code");
    let (catalog, workspace) = catalog(home.path(), cwd.path()).await;
    let skills = catalog.skills(&workspace).await;
    let skill = skills.iter().find(|skill| skill.name == "review").unwrap();
    let file = skill_file(&skill.dir);
    let raw = std::fs::read_to_string(&file).unwrap();
    let value: Value = serde_json::from_str(&inspect_text(skill, Some(&raw), true)).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["skill"]["name"], "review");
    assert!(
        value["skill"]["frontmatter"]
            .as_str()
            .unwrap()
            .contains("description:")
    );
    assert_eq!(value["skill"]["allowedTools"][0], "Read");
    assert_eq!(value["skill"]["metadata"]["allowedTools"][0], "Read");
    assert_eq!(value["skill"]["metadata"]["userInvocable"], true);
}

#[test]
fn sources_map_to_the_documented_strings() {
    assert_eq!(source(&SkillSource::User), ("user", None));
    assert_eq!(source(&SkillSource::Project), ("project", None));
    assert_eq!(source(&SkillSource::Builtin), ("builtin", None));
    assert_eq!(source(&SkillSource::Bundled), ("bundled", None));
    assert_eq!(
        source(&SkillSource::Plugin {
            plugin: "demo".to_owned()
        }),
        ("plugin", Some("demo"))
    );
}

#[test]
fn cwd_resolution_expands_home_and_relative_paths() {
    let root = tempfile::tempdir().unwrap();
    let home = tempfile::tempdir().unwrap();
    assert_eq!(workspace_root(root.path(), home.path(), None), root.path());
    assert_eq!(
        workspace_root(root.path(), home.path(), Some("sub")),
        root.path().join("sub")
    );
    assert_eq!(
        workspace_root(root.path(), home.path(), Some("~")),
        home.path()
    );
}
