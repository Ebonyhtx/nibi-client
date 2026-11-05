//! 旧方法 `session/read`（docs/specs/rust-cli/app-protocol.md §5.1）：任务索引同步建搜索文本
//! （`contentProfile: index`）。快照形状见 [`crate::legacy_snapshot`]；index 只带正文，去掉工具与
//! 思考的大载荷。

use rust_cli_kernel_api::ids::SessionId;
use rust_cli_protocol_core::rpc::RpcError;
use serde_json::Value;

use crate::legacy_snapshot::{self, Profile};
use crate::server::{Server, kernel_error};

pub async fn read(server: &Server, params: &Value) -> Result<Value, RpcError> {
    let session = SessionId::new(params["sessionId"].as_str().unwrap_or_default());
    let view = match server.bridge.get(&session) {
        Some(live) => live.handle.view().await,
        None => server.kernel.session_snapshot(&session).await,
    }
    .map_err(|error| kernel_error(&error))?;
    let times = server
        .kernel
        .session_message_times(&session)
        .await
        .unwrap_or_default();
    // Index 只出正文，没有图片 part，不用读 artifact。
    Ok(legacy_snapshot::snapshot(
        &view,
        Profile::Index,
        &times,
        &legacy_snapshot::Media::new(),
    ))
}
