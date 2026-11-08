//! 登录与退出（docs/specs/rust-cli/tui.md §7.2）：账号服务用替身（不连真实服务）。浏览器授权的地址进
//! transcript；esc 发取消、回到选项；授权完成后提示结果并切到新模型；手工 key 只显示 `•`、不进输入历史。
use std::sync::{Arc, Mutex};

use crossterm::event::{KeyCode, KeyModifiers};
use futures_util::FutureExt;
use futures_util::future::BoxFuture;
use nibi_kernel_api::testing::text_response;
use nibi_kernel_tui::services::{CancellationToken, DeviceCode, NibiAccount, RedactedString};
use nibi_kernel_tui::{Account, Authorize, Configured, Family, LoginFailure, Services};
use tokio::sync::oneshot;

use super::support::{GatedModel, Setup, with_ui};

const URL: &str = "https://chat.example.com/oauth?flow=1";
const DEVICE_URL: &str = "https://nibi.example.com/device";
const USER_CODE: &str = "ABCD-1234";
const CREDENTIALS: &str = "/Users/dev/.nibi/v2/credentials.json";
const CONFIG: &str = "/Users/dev/.nibi/v2/provider_config.json";

/// 账号服务的替身：浏览器授权等测试放行（`complete`）或取消；记下收到的 key。
#[derive(Default)]
struct FakeAccount {
    release: Mutex<Option<oneshot::Sender<()>>>,
    keys: Mutex<Vec<String>>,
}

impl FakeAccount {
    fn complete(&self) {
        let sender = self.release.lock().unwrap().take().unwrap();
        sender.send(()).unwrap();
    }
}

fn configured(family: Family, oauth: bool) -> Configured {
    Configured {
        family,
        user: oauth.then(|| "Dev".to_owned()),
        model: "fixture/other-model".to_owned(),
        credentials: oauth.then(|| CREDENTIALS.to_owned()),
        config: CONFIG.to_owned(),
        browser_failed: None,
        oauth,
    }
}

impl Account for FakeAccount {
    fn login(
        &self,
        family: Family,
        authorize: oneshot::Sender<Authorize>,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Configured, LoginFailure>> {
        let (sender, receiver) = oneshot::channel();
        *self.release.lock().unwrap() = Some(sender);
        let _ = authorize.send(Authorize {
            url: URL.to_owned(),
            browser_failed: None,
        });
        async move {
            tokio::select! {
                () = cancel.cancelled() => Err(LoginFailure::Cancelled),
                _ = receiver => Ok(configured(family, true)),
            }
        }
        .boxed()
    }

    fn login_nibi(
        &self,
        device: oneshot::Sender<DeviceCode>,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<NibiAccount, LoginFailure>> {
        let (sender, receiver) = oneshot::channel();
        *self.release.lock().unwrap() = Some(sender);
        let _ = device.send(DeviceCode {
            user_code: USER_CODE.to_owned(),
            verification_uri: DEVICE_URL.to_owned(),
            verification_uri_complete: Some(format!("{DEVICE_URL}?code={USER_CODE}")),
        });
        async move {
            tokio::select! {
                () = cancel.cancelled() => Err(LoginFailure::Cancelled),
                _ = receiver => Ok(NibiAccount {
                    user: "Dev".to_owned(),
                    membership: "Membership: Pro (expires 2026-12-01)".to_owned(),
                    warning: None,
                }),
            }
        }
        .boxed()
    }

    fn configure_api_key(
        &self,
        family: Family,
        key: RedactedString,
    ) -> BoxFuture<'static, Result<Configured, String>> {
        self.keys.lock().unwrap().push(key.expose().to_owned());
        async move { Ok(configured(family, false)) }.boxed()
    }

    fn logout(&self) -> BoxFuture<'static, Result<String, String>> {
        async { Ok(CREDENTIALS.to_owned()) }.boxed()
    }
}

fn setup(account: &Arc<FakeAccount>) -> Setup {
    Setup {
        width: 100,
        height: 30,
        services: Services {
            account: Some(account.clone()),
            ..Services::default()
        },
        ..Setup::default()
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn esc_cancels_the_nibi_login_and_returns_to_the_choice() {
    let model = GatedModel::scripted(vec![text_response(&["ok"])]);
    let account = Arc::new(FakeAccount::default());
    with_ui(model, setup(&account), |mut ui| async move {
        ui.submit("/login");
        let screen = ui.wait_for("Sign in").await;
        // 只有一种方式：NIBI 账号（上游套餐登录已删，模型 Provider 走 `/provider`）。
        assert!(screen.contains("NIBI Account"), "{screen}");
        assert!(!screen.contains("Coding Plan"), "{screen}");
        ui.key(KeyCode::Enter);
        let screen = ui.wait_for("Waiting for NIBI sign-in").await;
        assert!(
            screen.contains("Esc cancels and returns to setup choices."),
            "{screen}"
        );
        let screen = ui.wait_for(USER_CODE).await;
        assert!(
            screen.contains(&format!("{DEVICE_URL}?code={USER_CODE}")),
            "{screen}"
        );
        ui.key(KeyCode::Esc);
        let screen = ui.wait_for("Login cancelled.").await;
        assert!(screen.contains("NIBI Account"), "{screen}");
        assert!(!screen.contains("Signed in"), "{screen}");
        ui.key(KeyCode::Esc);
        ui.wait_for("Ask before changes").await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_finished_login_shows_the_membership() {
    let model = GatedModel::scripted(vec![text_response(&["ok"])]);
    let account = Arc::new(FakeAccount::default());
    let control = account.clone();
    with_ui(model, setup(&account), |mut ui| async move {
        // 显式点名 `nibi`：(与不带参数那条第 1 项是同一个流程。)
        ui.submit("/login nibi");
        ui.wait_for("Waiting for NIBI sign-in").await;
        ui.wait_for(USER_CODE).await;
        control.complete();
        let screen = ui.wait_for("Signed in to NIBI as Dev.").await;
        assert!(
            screen.contains("Membership: Pro (expires 2026-12-01)"),
            "{screen}"
        );
        // 其它参数只提示用法：模型 Provider 走 `/provider`，不再是登录入口。
        ui.submit("/login nope");
        ui.wait_for("Usage: /login [nibi]").await;
    })
    .await;
}

/// `/login` 的第一项是 NIBI 账号：显示设备码与地址，完成后提示会员摘要。
#[tokio::test(flavor = "multi_thread")]
async fn the_default_login_is_the_nibi_device_flow() {
    let model = GatedModel::scripted(vec![text_response(&["ok"])]);
    let account = Arc::new(FakeAccount::default());
    let control = account.clone();
    with_ui(model, setup(&account), |mut ui| async move {
        ui.submit("/login");
        ui.wait_for("Sign in").await;
        ui.key(KeyCode::Enter);
        ui.wait_for("Waiting for NIBI sign-in").await;
        let screen = ui.wait_for(USER_CODE).await;
        assert!(screen.contains(&format!("{DEVICE_URL}?code={USER_CODE}")), "{screen}");
        control.complete();
        let screen = ui.wait_for("Signed in to NIBI as Dev.").await;
        assert!(screen.contains("Membership: Pro"), "{screen}");
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn logout_reports_the_credentials_file() {
    let model = GatedModel::scripted(vec![text_response(&["ok"])]);
    let account = Arc::new(FakeAccount::default());
    with_ui(model, setup(&account), |mut ui| async move {
        ui.submit("/logout now");
        ui.wait_for("Usage: /logout").await;
        ui.submit("/logout");
        ui.wait_for(&format!("Logged out. Credentials: {CREDENTIALS}"))
        .await;
    })
    .await;
}

#[tokio::test(flavor = "multi_thread")]
async fn without_an_account_service_login_is_unavailable() {
    let model = GatedModel::scripted(vec![text_response(&["ok"])]);
    with_ui(model, Setup::default(), |mut ui| async move {
        // 上游套餐登录已经删掉：其它参数一律只提示用法。
        ui.submit("/login zai-coding-plan");
        ui.wait_for("Usage: /login [nibi]").await;
        ui.submit("/login nibi");
        ui.wait_for("NIBI sign-in is not available in this client.")
            .await;
        ui.submit("/logout");
        ui.wait_for("Logout is not available in this client.").await;
    })
    .await;
}
