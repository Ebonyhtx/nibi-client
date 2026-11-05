//! 会话附件的解析：artifact URI / data URL / base64（`Kernel::load_attachment` 的内核侧）。

use super::*;

#[test]
fn data_urls_decode_to_bytes_and_media_type() {
    // 1x1 PNG 的字节。
    let png: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let encoded = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(png)
    };
    let text = format!("data:image/png;base64,{encoded}").into_bytes();
    let loaded = decode(text).unwrap();
    assert_eq!(loaded.bytes, png);
    assert_eq!(loaded.media_type.as_deref(), Some("image/png"));
}

#[test]
fn plain_bytes_and_unknown_shapes_keep_their_content() {
    let raw = vec![0xff, 0xd8, 0xff, 0x00];
    let loaded = decode(raw.clone()).unwrap();
    assert_eq!(loaded.bytes, raw);
    assert!(loaded.media_type.is_none());
    // 不是 data URL 的文本原样返回（mime 由引用决定）。
    let loaded = decode(b"hello".to_vec()).unwrap();
    assert_eq!(loaded.bytes, b"hello");
    assert!(loaded.media_type.is_none());
    // data URL 但 base64 坏了：明确失败，不返回半截内容。
    assert!(decode(b"data:image/png;base64,!!!!".to_vec()).is_err());
}

#[test]
fn artifact_uris_parse_and_decode_percent_escapes() {
    assert_eq!(
        parse_artifact_uri("nibi-artifact://sess_a/tool-result-1"),
        Some(("sess_a".to_owned(), "tool-result-1".to_owned()))
    );
    // encodeURIComponent 的转义（会话 id 可能含空格等）。
    assert_eq!(
        parse_artifact_uri("nibi-artifact://sess%20a/tool-result-1"),
        Some(("sess a".to_owned(), "tool-result-1".to_owned()))
    );
    assert_eq!(parse_artifact_uri("https://example.invalid/x"), None);
    assert_eq!(parse_artifact_uri("nibi-artifact://only-owner"), None);
    assert_eq!(parse_artifact_uri("nibi-artifact://a/b/c"), None);
}

#[test]
fn oversized_attachments_are_rejected() {
    let big = vec![0u8; MAX_ATTACHMENT_BYTES + 1];
    assert!(capped(big).is_err());
    assert!(capped(vec![0u8; 16]).is_ok());
}
