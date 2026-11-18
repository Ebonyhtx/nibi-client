//! App-exclusive 会话控制的 Host 端实现（Node `createProtocolAppControlPort` 的同一条反向请求）。
//!
//! 内核里的 4 个 App 工具经 `Context::peer.request` 发 `appControl/*`，桌面 Host 的
//! `nibiAgentService` 处理并回包。回包是 `{ok:true,result}` 或
//! `{ok:false,error:{code,message}}`；传输层的 JSON-RPC 错误码也在这一层映射成
//! [`AppControlError`]，不让工具层看到两种错误形状。

use async_trait::async_trait;
use nibi_kernel_api::app_control::{
    AppControlError, AppControlErrorCode, AppSessionControlHost, AppTrustedContext,
    ListProjectsInput, ListProjectsResult, MutationResult, OpenSessionInput, OpenSessionResult,
    SetSessionArchivedInput, SetSessionPinnedInput,
};
use nibi_kernel_protocol_core::rpc::codes;
use serde_json::{Map, Value, json};

use crate::context::Context;

pub const LIST_PROJECTS: &str = "appControl/listProjects";
pub const OPEN_SESSION: &str = "appControl/openSession";
pub const SET_SESSION_ARCHIVED: &str = "appControl/setSessionArchived";
pub const SET_SESSION_PINNED: &str = "appControl/setSessionPinned";
pub const CANCEL: &str = "appControl/cancel";
/// 内核直接创建/分叉出会话后的 Host 通知（不是模型工具）；Host 据此补 sessions-index 行。
pub const SESSION_CREATED: &str = "appControl/sessionCreated";

/// 一次 App 控制请求的上限：Host 的目录读取与任务索引写入都很快；卡住时让回合失败，不无限等。
const LIMIT_SECONDS: u64 = 60;
/// 取消只做 best-effort；Host 卡住时也不能拖住已经取消的回合。
const CANCEL_SECONDS: u64 = 5;

pub struct HostAppControl {
    context: std::sync::Arc<Context>,
}

impl nibi_kernel_api::session_control::SessionControlCreatedNotifier for HostAppControl {
    fn session_created(&self, caller_session_id: &str, session_id: &str, workspace_path: &str) {
        self.notify_session_created(caller_session_id, session_id, workspace_path);
    }
}

impl HostAppControl {
    pub fn new(context: std::sync::Arc<Context>) -> Self {
        Self { context }
    }

    /// 创建/分叉出会话后异步通知 Host；通知失败只影响列表补齐，不能影响工具结果。
    pub fn notify_session_created(&self, caller: &str, session: &str, workspace: &str) {
        let context = self.context.clone();
        let params = json!({
            "callerSessionId": caller,
            "callId": format!("session-created-{session}"),
            "workspacePath": workspace,
            "input": { "sessionId": session },
        });
        tokio::spawn(async move {
            let _ = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                context.peer.request(SESSION_CREATED, &params),
            )
            .await;
        });
    }

    /// 请求信封：可信事实与 Host 已解析的输入分开，模型无法伪造 `callerSessionId`。
    fn params(ctx: &AppTrustedContext, input: Value) -> Value {
        let mut params = Map::new();
        params.insert("callerSessionId".to_owned(), json!(ctx.caller_session_id));
        params.insert("callId".to_owned(), json!(ctx.call_id));
        if let Some(turn) = ctx.turn_id.as_ref() {
            params.insert("turnId".to_owned(), json!(turn));
        }
        params.insert("workspacePath".to_owned(), json!(ctx.workspace_path));
        if let Some(identity) = ctx.workspace_identity.as_ref() {
            params.insert("workspaceIdentity".to_owned(), json!(identity));
        }
        params.insert("input".to_owned(), input);
        Value::Object(params)
    }

    async fn request(
        &self,
        method: &str,
        ctx: &AppTrustedContext,
        input: Value,
    ) -> Result<Value, AppControlError> {
        let params = Self::params(ctx, input);
        let answer = match tokio::time::timeout(
            std::time::Duration::from_secs(LIMIT_SECONDS),
            self.context.peer.request(method, &params),
        )
        .await
        {
            Err(_) => {
                return Err(AppControlError::unavailable(format!(
                    "{method} timed out after {LIMIT_SECONDS}s"
                )));
            }
            Ok(Err(error)) => {
                return Err(match error.code {
                    codes::METHOD_NOT_FOUND => AppControlError::unavailable(
                        "The App host does not support session control",
                    ),
                    codes::INVALID_PARAMS => AppControlError::invalid_input(error.message),
                    _ => AppControlError::unavailable(error.message),
                });
            }
            Ok(Ok(answer)) => answer,
        };
        let ok = answer
            .get("ok")
            .and_then(Value::as_bool)
            .ok_or_else(|| AppControlError::invalid_output("App control reply has no ok flag"))?;
        if !ok {
            let error = answer.get("error").cloned().unwrap_or(Value::Null);
            let code = error
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("unavailable");
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("App control request failed");
            return Err(AppControlError::new(
                AppControlErrorCode::from_wire(code),
                message,
            ));
        }
        answer
            .get("result")
            .cloned()
            .ok_or_else(|| AppControlError::invalid_output("App control reply has no result"))
    }

    fn parse<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, AppControlError> {
        serde_json::from_value(value).map_err(|error| {
            AppControlError::invalid_output(format!("App control reply is malformed: {error}"))
        })
    }
}

#[async_trait]
impl AppSessionControlHost for HostAppControl {
    async fn list_projects(
        &self,
        ctx: &AppTrustedContext,
        input: ListProjectsInput,
    ) -> Result<ListProjectsResult, AppControlError> {
        let mut payload = Map::new();
        if let Some(query) = input.query {
            payload.insert("query".to_owned(), json!(query));
        }
        let answer = self
            .request(LIST_PROJECTS, ctx, Value::Object(payload))
            .await?;
        Self::parse(answer)
    }

    async fn open_session(
        &self,
        ctx: &AppTrustedContext,
        input: OpenSessionInput,
    ) -> Result<OpenSessionResult, AppControlError> {
        let answer = self
            .request(OPEN_SESSION, ctx, json!({"sessionId": input.session_id}))
            .await?;
        Self::parse(answer)
    }

    async fn set_session_archived(
        &self,
        ctx: &AppTrustedContext,
        input: SetSessionArchivedInput,
    ) -> Result<MutationResult, AppControlError> {
        let answer = self
            .request(
                SET_SESSION_ARCHIVED,
                ctx,
                json!({
                    "sessionId": input.session_id,
                    "archived": input.archived,
                    "requestId": input.request_id,
                }),
            )
            .await?;
        Self::parse(answer)
    }

    async fn set_session_pinned(
        &self,
        ctx: &AppTrustedContext,
        input: SetSessionPinnedInput,
    ) -> Result<MutationResult, AppControlError> {
        let answer = self
            .request(
                SET_SESSION_PINNED,
                ctx,
                json!({
                    "sessionId": input.session_id,
                    "pinned": input.pinned,
                    "requestId": input.request_id,
                }),
            )
            .await?;
        Self::parse(answer)
    }

    async fn cancel(&self, ctx: &AppTrustedContext) -> Result<(), AppControlError> {
        let params = Self::params(ctx, json!({}));
        // 只投递，不等结果：取消路径不能因为 Host 慢而拖住工具返回。
        let _ = tokio::time::timeout(
            std::time::Duration::from_secs(CANCEL_SECONDS),
            self.context.peer.request(CANCEL, &params),
        )
        .await;
        Ok(())
    }
}

#[cfg(test)]
#[path = "app_control_tests.rs"]
mod tests;
