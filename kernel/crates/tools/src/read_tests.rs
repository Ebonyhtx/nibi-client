use super::*;

#[test]
fn lines_are_numbered_with_a_tab_and_lose_carriage_returns() {
    assert_eq!(number_lines("a\r\nb", 1), "1\ta\n2\tb");
    assert_eq!(number_lines("x", 0), "0\tx");
}

#[test]
fn binary_and_device_paths_are_recognized() {
    assert!(is_binary("/w/app.EXE"));
    assert!(!is_binary("/w/shot.png"));
    assert!(!is_binary("/w/doc.pdf"));
    assert!(!is_binary("/w/main.rs"));
    assert!(is_device("/dev/zero"));
    assert!(is_device("/proc/42/environ"));
    assert!(!is_device("/proc/42/task/1/environ"));
}

#[test]
fn token_estimates_follow_the_extension() {
    assert_eq!(estimate_tokens(&"x".repeat(100), ".json"), 50);
    assert_eq!(estimate_tokens(&"x".repeat(100), ".rs"), 25);
    assert!(check_tokens(&"x".repeat(100_004), ".rs").is_err());
    assert!(check_tokens(&"x".repeat(100_000), ".rs").is_ok());
}

/// 文件头的判断（修复线 F58，kernel-api `image::media_type`，TUI 的粘贴也用它）：GIF 要 `GIF87a` / `GIF89a`，
/// 不足 4 字节的不认。以前 `GIF8` 开头就算 GIF。
#[test]
fn image_headers_need_the_full_signature() {
    assert_eq!(image_type(b"GIF89a.."), Some("image/gif"));
    assert_eq!(image_type(b"GIF8xa.."), None);
    assert_eq!(image_type(&[0xff, 0xd8, 0xff]), None);
    assert_eq!(image_type(b"\x89PNG"), Some("image/png"));
}

use std::sync::Arc;

use async_trait::async_trait;
use nibi_kernel_api::env::{EnvFacts, EnvPath};
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::message::{ImageSource, ToolResultContent};
use nibi_kernel_api::orchestration::PermissionGate;
use nibi_kernel_api::permission::{PermissionDecision, PermissionRule};
use nibi_kernel_api::testing::{MemoryEnvironment, ScriptedInteractions};
use nibi_kernel_api::tool::{Tool, ToolUseContext};
use serde_json::{Value, json};

use crate::test_more::Ctx;
use crate::ReadTool;

/// 全部放行（与 `read_pdf_tests` 的同一个替身）。
struct AllowAll;

#[async_trait]
impl PermissionGate for AllowAll {
    async fn decide(&self, _: &dyn Tool, _: &Value, _: &ToolUseContext) -> PermissionDecision {
        PermissionDecision::Passthrough
    }
    async fn remember(&self, _: &SessionId, _: &[PermissionRule]) {}
}

/// 视频（Node `read-video.ts`）：按扩展名认 mime，原样内联成 `Video` 块，不转码；display 是 video 行。
#[tokio::test]
async fn videos_are_inlined_as_video_blocks() {
    let env = Arc::new(MemoryEnvironment::new(EnvFacts {
        cwd: EnvPath::new("/Users/dev/work"),
        platform: "darwin".to_owned(),
        os_version: String::new(),
        shell: "zsh".to_owned(),
        is_git_repo: false,
        additional_directories: Vec::new(),
        home: Some(EnvPath::new("/Users/dev")),
    }));
    env.set_bytes("/Users/dev/work/clip.MP4", b"fake-mp4-bytes");
    let mut ctx = Ctx::new(Arc::new(ScriptedInteractions::default()));
    ctx.set_env(env);
    let context = ctx.build();
    let (progress, _) = tokio::sync::mpsc::channel(1);
    let tool = ReadTool::new(crate::FileTools::new(Arc::default(), Arc::new(AllowAll)));
    let output = tool
        .call(
            json!({"file_path": "/Users/dev/work/clip.MP4"}),
            context,
            progress,
        )
        .await
        .unwrap();
    assert_eq!(output.display["type"], "video");
    assert_eq!(output.display["file"]["type"], "video/mp4");
    match &output.content[0] {
        ToolResultContent::Video {
            source:
                ImageSource::Base64 {
                    media_type, data, ..
                },
        } => {
            assert_eq!(media_type, "video/mp4");
            assert_eq!(data, &crate::base64::encode(b"fake-mp4-bytes"));
        }
        other => panic!("expected a video block, got {other:?}"),
    }
}
