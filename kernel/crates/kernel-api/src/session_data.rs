//! 会话数据的测量与彻底删除（上游 `v4/storage/sessionData/measure` / `purge`，
//! `packages/shared/src/zcode-protocol-v4/session-data/contract.ts`）。
//!
//! 协议层只负责方法名与入参形状；测量/删除的语义在运行时（`nibi-kernel-runtime`）与存储
//! （`nibi-kernel-node-store`）：按会话根展开附属后代、运行中/被引用保留、先删文件再删行。
//! 载荷与上游 schema 同形，因此这里的类型也用 camelCase 序列化。
//!
//! 口径（上游 `session-data/CONTRACT.md`）：
//! - CLI 不感知项目：载荷只有会话根 ID 与目录（`workspacePath` + 可选 `workspaceIdentity`）。
//! - 大小只统计真正从磁盘删除的文件；数据库行删除不计入（库文件不收缩）。
//! - purge 幂等：已不存在的会话按 0 字节删除成功。

use serde::{Deserialize, Serialize};

use crate::ids::SessionId;

/// 一个目录（只用于项目记忆）：`workspacePath` 必填，`workspaceIdentity` 是远程工作区身份。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDataDirectory {
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_identity: Option<String>,
}

/// `v4/storage/sessionData/measure|purge` 的入参。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDataParams {
    pub session_ids: Vec<SessionId>,
    pub directories: Vec<SessionDataDirectory>,
}

/// 一个会话（根）的可清理字节数；包含它的附属后代。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDataBytes {
    pub session_id: SessionId,
    pub bytes: u64,
}

/// 一个目录的项目记忆字节数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDataMemoryBytes {
    pub workspace_path: String,
    pub bytes: u64,
}

/// measure 的结果（上游 `v4SessionDataMeasureResultSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDataMeasure {
    pub sessions: Vec<SessionDataBytes>,
    pub memory: Vec<SessionDataMemoryBytes>,
}

/// 保留的原因（上游 `kept[].reason`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionDataKeptReason {
    Running,
    Referenced,
}

/// 被保留的会话根。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDataKept {
    pub session_id: SessionId,
    pub reason: SessionDataKeptReason,
}

/// 删除失败的会话或目录。`sessionId` 与 `workspacePath` 至少有一个（上游 schema 也允许两者都缺席，
/// 只为让错误码能单独交付；本工程实际总带一个）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDataFailure {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    pub code: String,
}

/// purge 的结果（上游 `v4SessionDataPurgeResultSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDataPurge {
    pub deleted: Vec<SessionDataBytes>,
    pub kept: Vec<SessionDataKept>,
    pub failed: Vec<SessionDataFailure>,
    pub memory: Vec<SessionDataMemoryBytes>,
}

/// 文件/记忆操作里的失败码（上游取 Node 的 `error.code`，没有时 `"unknown"`）。
///
/// 单独成类型而不是塞进 [`crate::store::StoreError`]：测量/删除的失败要按会话或目录逐项返回，
/// 不能把整个方法变成一次内部错误；同时错误码要能原样交给 Host（`failed[].code`）。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{code}")]
pub struct SessionDataError {
    pub code: String,
}

impl SessionDataError {
    pub fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }

    /// 给不支持这份读写的实现用（内存存储、TUI 的存储）。
    pub fn unsupported() -> Self {
        Self::new("unsupported")
    }
}
