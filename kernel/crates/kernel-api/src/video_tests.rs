//! 视频的扩展名映射（Node `inferVideoMimeFromPath` 的同一份）。

use super::*;

#[test]
fn every_supported_extension_maps_to_its_mime() {
    for (path, mime) in [
        ("/tmp/demo.mp4", "video/mp4"),
        ("/tmp/demo.m4v", "video/x-m4v"),
        ("/tmp/demo.mov", "video/quicktime"),
        ("/tmp/DEMO.WEBM", "video/webm"),
        ("/tmp/demo.mkv", "video/x-matroska"),
        ("/tmp/demo.avi", "video/x-msvideo"),
    ] {
        assert_eq!(media_type(path), Some(mime), "{path}");
        assert!(has_video_extension(path), "{path}");
    }
}

#[test]
fn other_files_are_not_videos() {
    for path in ["/tmp/a.png", "/tmp/a.mp3", "/tmp/a.pdf", "/tmp/mp4", "/tmp/a.mp4.txt"] {
        assert_eq!(media_type(path), None, "{path}");
        assert!(!has_video_extension(path), "{path}");
    }
}
