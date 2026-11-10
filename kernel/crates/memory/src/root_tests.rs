use super::*;

fn dir_name(path: &Path) -> String {
    path.parent()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[test]
fn windows_workspace_uses_the_node_slug_and_lowercased_hash() {
    let root = project_memory_root_for(
        Path::new(r"C:\Users\dev\.nibi\cli"),
        r"C:\Users\Dev\Repo\My Project",
        None,
        true,
    );
    assert_eq!(dir_name(&root), "my-project-f2eeb7a23c10e527");
    assert_eq!(root.file_name().unwrap(), "memory");
}

#[test]
fn an_identity_wins_over_the_workspace_path_and_forces_the_project_slug() {
    let windows = project_memory_root_for(
        Path::new(r"C:\Users\dev\.nibi\cli"),
        r"C:\Users\Dev\Repo\My Project",
        Some("host:abc:/workspace"),
        true,
    );
    assert_eq!(dir_name(&windows), "project-627c64ab112c44c4");
    let posix = project_memory_root_for(
        Path::new("/home/dev/.nibi/cli"),
        "/home/dev/repo",
        Some("host:abc:/workspace"),
        false,
    );
    assert_eq!(dir_name(&posix), "project-627c64ab112c44c4");
}

#[test]
fn posix_paths_keep_their_case_and_collapse_dot_segments() {
    let plain = project_memory_root_for(
        Path::new("/home/dev/.nibi/cli"),
        "/home/dev/repo",
        None,
        false,
    );
    assert_eq!(dir_name(&plain), "repo-ae0d5dd99281cee1");
    let parent = project_memory_root_for(
        Path::new("/home/dev/.nibi/cli"),
        "/home/dev/repo/../repo2",
        None,
        false,
    );
    assert_eq!(dir_name(&parent), "repo2-a78310d0c615a018");
}

#[test]
fn the_root_is_under_the_cli_memories_projects_tree() {
    let root = project_memory_root_for(Path::new("/home/dev/.nibi/cli"), "/work/repo", None, false);
    let projects = root.parent().and_then(Path::parent).unwrap();
    let memories = projects.parent().unwrap();
    assert_eq!(projects.file_name().unwrap(), "projects");
    assert_eq!(memories.file_name().unwrap(), "memories");
    assert_eq!(root.file_name().unwrap(), "memory");
}

#[test]
fn a_slug_falls_back_to_project_and_is_capped_at_48_characters() {
    assert_eq!(sanitize_project_slug(""), "project");
    assert_eq!(sanitize_project_slug("..."), "...");
    assert_eq!(sanitize_project_slug("My  Project"), "my-project");
    assert_eq!(sanitize_project_slug(&"A".repeat(80)).len(), 48);
}
