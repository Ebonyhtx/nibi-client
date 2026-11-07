//! TUI 的账号服务（docs/specs/rust-cli/tui.md §7.2）：NIBI 账号的 Device Flow（与 `nibi login` 共用
//! [`crate::login::device_login`]）、provider 模板的登录与退出，加上打开浏览器。TUI 不起进程，打开浏览器在这里做。
use std::sync::Arc;

use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use nibi_kernel_base::secret::RedactedString;
use nibi_kernel_platform::{Family, LoginError, Platform};
use nibi_kernel_tui::services::CancellationToken;
use nibi_kernel_tui::{Account, Authorize, Configured, DeviceCode, LoginFailure, NibiAccount};
use tokio::sync::oneshot;

pub(crate) struct PlatformAccount {
    pub(crate) platform: Arc<Platform>,
    /// NIBI 账号的凭据上下文（与 `nibi login` 同一份共享凭据文件）。
    pub(crate) nibi: Arc<crate::login::AccountContext>,
}

/// 用户的显示名（资料里的 `name`，没有时 `email`，再没有时 `id`）。
fn user_label(user: &serde_json::Value) -> String {
    let text = |key: &str| {
        user.get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    };
    text("name")
        .or_else(|| text("email"))
        .or_else(|| text("id"))
        .unwrap_or("NIBI")
        .to_owned()
}

fn failure(error: LoginError) -> LoginFailure {
    match error {
        LoginError::Cancelled => LoginFailure::Cancelled,
        other => LoginFailure::Failed(other.to_string()),
    }
}

impl Account for PlatformAccount {
    fn login_nibi(
        &self,
        device: oneshot::Sender<DeviceCode>,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<NibiAccount, LoginFailure>> {
        let context = self.nibi.clone();
        async move {
            let signed_in = crate::login::device_login(
                &context,
                |authorization| {
                    let code = DeviceCode {
                        user_code: authorization.user_code.clone(),
                        verification_uri: authorization.verification_uri.clone(),
                        verification_uri_complete: authorization.verification_uri_complete.clone(),
                    };
                    // 打开浏览器由实现负责（TUI 起不了进程）；界面已经不等时发不出去不影响登录。
                    let _ = crate::login::open_browser(code.target());
                    let _ = device.send(code);
                },
                &cancel,
            )
            .await
            .map_err(|reason| {
                if cancel.is_cancelled() {
                    LoginFailure::Cancelled
                } else {
                    LoginFailure::Failed(reason)
                }
            })?;
            Ok(NibiAccount {
                user: user_label(&signed_in.user_info),
                membership: crate::nibi_session::format_membership(
                    signed_in.membership.as_ref(),
                    signed_in.license_expires_at.as_deref(),
                ),
            })
        }
        .boxed()
    }

    fn login(
        &self,
        family: Family,
        authorize: oneshot::Sender<Authorize>,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Configured, LoginFailure>> {
        let platform = self.platform.clone();
        async move {
            let pending = platform.begin_login(family).await.map_err(failure)?;
            let url = pending.authorize_url().to_owned();
            let browser_failed = crate::login::open_browser(&url).err();
            // 界面可能已经不等地址了（退出中）：发不出去不影响登录。
            let _ = authorize.send(Authorize {
                url,
                browser_failed: browser_failed.clone(),
            });
            let outcome = pending.complete_until(&cancel).await.map_err(failure)?;
            Ok(Configured {
                family: outcome.family,
                user: outcome.user_label().map(str::to_owned),
                model: outcome.model,
                credentials: Some(outcome.credentials.as_path().display().to_string()),
                config: outcome.config.as_path().display().to_string(),
                browser_failed,
                oauth: true,
            })
        }
        .boxed()
    }

    fn configure_api_key(
        &self,
        family: Family,
        key: RedactedString,
    ) -> BoxFuture<'static, Result<Configured, String>> {
        let platform = self.platform.clone();
        async move {
            let outcome = platform
                .configure_api_key(family, &key)
                .await
                .map_err(|error| error.to_string())?;
            Ok(Configured {
                family: outcome.family,
                user: None,
                model: outcome.model,
                credentials: None,
                config: outcome.config.as_path().display().to_string(),
                browser_failed: None,
                oauth: false,
            })
        }
        .boxed()
    }

    fn logout(&self) -> BoxFuture<'static, Result<String, String>> {
        let platform = self.platform.clone();
        let nibi = self.nibi.clone();
        async move {
            // provider 模板的凭据与 NIBI 账号的键一起清（`nibi logout` 清的是后者的那几个键）。
            platform
                .logout()
                .await
                .map_err(|error| error.to_string())?;
            nibi.store.clear_account().await;
            Ok(nibi.store.path().display().to_string())
        }
        .boxed()
    }
}
