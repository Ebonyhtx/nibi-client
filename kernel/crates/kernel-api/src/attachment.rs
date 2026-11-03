//! 会话附件（NIBI `AttachmentRef`）：Host 上传的 artifact 或本机路径 → 模型可用的内容。
//!
//! Host 在 `sendText` / `createSession.firstInput` / `editUserQuery` 里给的是引用（不是内容）：
//! - `zcode-artifact://<session>/<artifact>`：chunk 上传的产物（Node 的 `NodeToolArtifactStore` 写入，
//!   内容是 `data:<mime>;base64,…` 文本）；Rust 的 node-store 与它同一套目录与命名，按会话与 id 找回；
//! - 本机绝对路径：desktop 直传，经会话所在机器的文件端口读。
//!
//! 内核只负责"把引用变成字节"（[`Kernel::load_attachment`](crate::session_api::Kernel::load_attachment)）；
//! 哪些类型能进消息、怎么排内容块由协议前端决定（`protocol-zcode`）。

use serde::{Deserialize, Serialize};

/// 附件引用的来源（协议 `AttachmentRef.ref` 的两种形态）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AttachmentSource {
    /// `zcode-artifact://<session>/<artifact>`：会话 artifact 存储里的内容。
    Artifact { uri: String },
    /// 本机（会话所在机器）的路径；相对路径按工作区根解析。
    Path { path: String },
}

/// 读出来的附件内容。`media_type` 来自内容本身（data URL 头）；引用上的 mime 由协议前端自己比对。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoadedAttachment {
    pub bytes: Vec<u8>,
    pub media_type: Option<String>,
}

/// 一次附件上传事务的暂存结果（`v4/attachment/commit` 的返回值）。
///
/// 内容已经**完整**写进会话的 artifact 存储、按引用核验过大小；调用方拿到 `uri` 才能把它放进
/// 会话事实（`AttachmentRef.ref`）。`bytes` 是内容长度，`media_type` 是提交时声明的类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredAttachment {
    pub uri: String,
    pub media_type: String,
    pub bytes: u64,
}

/// 已发送附件的内容与元数据（`v4/attachment/read` / `conversation/attachmentRead` 的读取结果）。
///
/// `bytes` 是**整个**附件（协议层按 offset/limit 切片）；`media_type` 取自内容本身，缺省时用引用上
/// 声明的类型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentPayload {
    pub bytes: Vec<u8>,
    pub media_type: String,
    /// 内容修改时间（毫秒）。只有落在文件系统上的引用才有；artifact 引用没有。
    pub mtime_ms: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sources_round_trip_through_json() {
        let artifact = AttachmentSource::Artifact {
            uri: "zcode-artifact://sess_a/tool-result-1".into(),
        };
        assert_eq!(
            serde_json::to_value(&artifact).unwrap(),
            serde_json::json!({"kind": "artifact", "uri": "zcode-artifact://sess_a/tool-result-1"})
        );
        let path = AttachmentSource::Path {
            path: "/tmp/a.png".into(),
        };
        let back: AttachmentSource = serde_json::from_value(serde_json::to_value(&path).unwrap()).unwrap();
        assert_eq!(back, path);
    }
}
