//! 发给模型的视频：扩展名 → mime 与字节上限（Node `core/runtime/helpers/attachment-video.ts` 与
//! `read-video.ts` 的同一份映射）。Read 工具与协议前端的附件都用这里，映射只有一份。
//!
//! 不做转码、不抽帧：CLI 不引 ffmpeg，视频原样内联成 base64（Node 相同）。

/// 视频原样内联的上限（字节，base64 之前）。Node `VIDEO_INPUT_MAX_BYTES = 30 MiB`。
pub const MAX_VIDEO_BYTES: usize = 30 * 1024 * 1024;

/// Node `VIDEO_INPUT_MIME_BY_EXTENSION`：扩展名（小写，带点）→ mime。
const VIDEO_EXTENSIONS: [(&str, &str); 6] = [
    (".mp4", "video/mp4"),
    (".m4v", "video/x-m4v"),
    (".mov", "video/quicktime"),
    (".webm", "video/webm"),
    (".mkv", "video/x-matroska"),
    (".avi", "video/x-msvideo"),
];

/// 按扩展名认视频 mime（不分大小写）；不是受支持的扩展名时为 None（Node `inferVideoMimeFromPath`）。
pub fn media_type(path: &str) -> Option<&'static str> {
    let lower = path.to_ascii_lowercase();
    VIDEO_EXTENSIONS
        .iter()
        .find(|(extension, _)| lower.ends_with(extension))
        .map(|(_, mime)| *mime)
}

/// 扩展名是不是受支持的视频（Read 的分支判断）。
pub fn has_video_extension(path: &str) -> bool {
    media_type(path).is_some()
}

#[cfg(test)]
#[path = "video_tests.rs"]
mod tests;
