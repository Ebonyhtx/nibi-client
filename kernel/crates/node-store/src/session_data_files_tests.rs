//! `v4/storage/sessionData/*` 的文件面：口径（空会话、有消息、有附件）、记忆目录与删除幂等。
#![allow(
    clippy::disallowed_methods,
    reason = "测试直接写会话的 artifacts / model-io / 记忆目录"
)]

use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::session_data::SessionDataDirectory;
use nibi_kernel_api::store::SessionStore;

use super::*;
use crate::tests::{TestStore, batch, meta, user};

fn sid(id: &str) -> SessionId {
    SessionId::new(id)
}

fn write(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
}

#[tokio::test]
async fn measures_every_session_file_root_and_the_memory_folder() {
    let t = TestStore::new();
    let cli = t.store.paths().cli_root().as_path().to_path_buf();
    // 空会话：0 字节。
    assert_eq!(measure_session(&cli, &sid("sess_empty")).await.unwrap(), 0);
    // 有消息的会话：数据库行不计入体积（库文件不收缩），只统计真实文件。
    let id = sid("sess_a");
    t.store.create(meta("sess_a", "/work/app", "")).await.unwrap();
    t.store
        .commit(
            &id,
            batch(None, vec![user("msg_1", &"x".repeat(1_000))]),
        )
        .await
        .unwrap();
    write(&cli.join("artifacts/sess_a/media-1.bin"), b"12345");
    write(&cli.join("exec/sess_a/out.txt"), b"123456");
    write(&cli.join("agents/sess_a/a.json"), b"1234567");
    write(&cli.join("sessions/sess_a/s.json"), b"12345678");
    write(&cli.join("debug/model-io-sess_a.jsonl"), b"123456789");
    write(&cli.join("rollout/model-io-sess_a.jsonl"), b"1234567890");
    assert_eq!(measure_session(&cli, &id).await.unwrap(), 45);

    let directory = SessionDataDirectory {
        workspace_path: "/work/app".to_owned(),
        workspace_identity: None,
    };
    let memory = nibi_kernel_memory::project_memory_root(&cli, "/work/app", None);
    write(&memory.join("MEMORY.md"), b"0123456789");
    write(&memory.parent().unwrap().join("other.txt"), b"abc");
    assert_eq!(measure_memory(&cli, &directory).await.unwrap(), 13);

    // 删除返回删除前的字节数；再删是幂等的 0。
    assert_eq!(remove_session(&cli, &id).await.unwrap(), 45);
    assert_eq!(remove_session(&cli, &id).await.unwrap(), 0);
    assert!(!cli.join("artifacts/sess_a").exists());
    assert!(!cli.join("rollout/model-io-sess_a.jsonl").exists());
    assert_eq!(remove_memory(&cli, &directory).await.unwrap(), 13);
    assert_eq!(remove_memory(&cli, &directory).await.unwrap(), 0);
    assert!(!memory.parent().unwrap().exists());
}

#[tokio::test]
async fn an_unsafe_session_id_is_refused_instead_of_building_a_path() {
    let t = TestStore::new();
    let cli = t.store.paths().cli_root().as_path().to_path_buf();
    let error = measure_session(&cli, &sid("../../escape"))
        .await
        .unwrap_err();
    assert_eq!(error.code, "session-data.invalid-session-id");
    let error = remove_session(&cli, &sid("a/b")).await.unwrap_err();
    assert_eq!(error.code, "session-data.invalid-session-id");
}
