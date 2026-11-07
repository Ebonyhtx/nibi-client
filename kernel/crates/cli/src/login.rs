//! `nibi login` / `nibi logout`（Node `login-command.ts`）：NIBI 账号中心的 Device Flow。
//!
//! 分家后的 CLI 只认 NIBI 账号中心：会员身份、付费插件授权、插件市场购买都靠它。上游的
//! `zai|bigmodel` Coding Plan 登录入口属于另一家生态，`/oauth/cli/init` 在我们的 API 上从来没有过。
//!
//! 登录写的是共享凭据文件（`nibi_session`），会员状态顺手同步一次（收费插件门禁读的是它；
//! 同步失败不让登录失败）。

use std::io::Write as _;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use nibi_kernel_net::{Egress, HttpRequest, header};
use nibi_platform::device_flow::{self, Client, DeviceFlowError, Transport};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::nibi_session::{self as session, Store};

/// 设备码与令牌端点的时限（Node 用 HttpClient 的 `network.timeout`；这里给一个固定上限）。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Node `LICENSE_REQUEST_TIMEOUT_MS`。
const LICENSE_TIMEOUT: Duration = Duration::from_secs(15);
const RESPONSE_LIMIT: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Command {
    Login { no_browser: bool, json: bool },
    Logout { json: bool },
}

const USAGE: &str = "Usage: nibi login [--no-browser]";

/// 第一个参数是 `login` / `logout` 时解析成命令；其他命令返回空。
pub(crate) fn parse(args: &[String]) -> Option<Result<Command, String>> {
    let (first, rest) = args.split_first()?;
    match first.as_str() {
        "logout" => Some(Ok(Command::Logout {
            json: rest.iter().any(|arg| arg == "--json"),
        })),
        "login" => Some(parse_login(rest)),
        _ => None,
    }
}

fn parse_login(args: &[String]) -> Result<Command, String> {
    let (mut no_browser, mut json) = (false, false);
    for arg in args {
        match arg.as_str() {
            "--no-browser" => no_browser = true,
            "--json" => json = true,
            // Node：带了位置参数就报用法（`nibi login [--no-browser]`）。
            _ => return Err(USAGE.to_owned()),
        }
    }
    Ok(Command::Login { no_browser, json })
}

/// 登录需要的本机事实与出口。
pub(crate) struct AccountContext {
    pub store: Store,
    pub egress: Arc<Egress>,
    pub auth_origin: String,
    /// `<origin>/api/v1`（会员同步）。
    pub api_base_url: String,
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

/// 执行命令，返回退出码。成功写标准输出，错误写标准错误（`Error: <message>`）。
pub(crate) async fn run(command: Command, context: &AccountContext) -> u8 {
    let result = match command {
        Command::Login { no_browser, json } => login(context, no_browser, json).await,
        Command::Logout { json } => logout(context, json).await,
    };
    match result {
        Ok(()) => 0,
        Err(error) => {
            let _ = writeln!(std::io::stderr(), "Error: {error}");
            1
        }
    }
}

/// Node `formatJson`：`JSON.stringify(value, null, 2)` 加换行。
fn format_json(value: &Value) -> String {
    format!(
        "{}\n",
        serde_json::to_string_pretty(value).unwrap_or_default()
    )
}

async fn logout(context: &AccountContext, json: bool) -> Result<(), String> {
    let cleared = context.store.clear_account().await;
    let path = context.store.path().display().to_string();
    if json {
        let value = json!({
            "clearedKeys": cleared,
            "credentialsPath": path,
            "status": "signed_out",
        });
        let _ = write!(std::io::stdout(), "{}", format_json(&value));
        return Ok(());
    }
    let _ = writeln!(
        std::io::stdout(),
        "Signed out of NIBI. Credentials: {path}"
    );
    Ok(())
}

/// 登录成功的事实（CLI 与 TUI 共用；`nibi login` 打印，TUI 显示摘要）。
pub(crate) struct SignedIn {
    pub user_info: Value,
    pub membership: Option<Value>,
    pub license_expires_at: Option<String>,
    pub warnings: Vec<String>,
    pub credentials: String,
}

/// 设备码登录的公共段：开始 → 把设备码交给调用方（显示、开浏览器）→ 轮询 → 写凭据 → 同步会员。
pub(crate) async fn device_login(
    context: &AccountContext,
    device: impl FnOnce(&device_flow::DeviceAuthorization),
    cancel: &CancellationToken,
) -> Result<SignedIn, String> {
    let transport = HostTransport {
        egress: context.egress.clone(),
    };
    let now = context.now.clone();
    let client = Client::with_defaults(&transport, &context.auth_origin, move || now());
    let authorization = client.start().await.map_err(text)?;
    device(&authorization);
    let token = client.poll_until_ready(&authorization, cancel).await.map_err(text)?;
    let user = client.user_info(&token.access_token).await.map_err(text)?;
    session::save_session(&context.store, &token, &user)
        .await
        .map_err(|error| format!("登录成功，但写入本地凭据失败：{error}"))?;
    let license = sync_license(context, &token.access_token).await;
    Ok(SignedIn {
        user_info: session::user_info_value(&user),
        membership: license.membership,
        license_expires_at: license.license_expires_at,
        warnings: license.warnings,
        credentials: context.store.path().display().to_string(),
    })
}

async fn login(context: &AccountContext, no_browser: bool, json: bool) -> Result<(), String> {
    let signed_in = device_login(
        context,
        |authorization| {
            let target = authorization
                .verification_uri_complete
                .clone()
                .unwrap_or_else(|| authorization.verification_uri.clone());
            // `--json` 时提示走 stderr，stdout 只留结果（Node 相同）。
            let code = authorization.user_code.clone();
            if no_browser {
                let _ = write_prompt(
                    json,
                    format!(
                        "To sign in to NIBI, open this URL in a browser and enter the code:
{target}
Code: {code}
"
                    ),
                );
            } else {
                let _ = write_prompt(
                    json,
                    format!(
                        "Opening the browser for NIBI sign-in. If it does not open, use this URL:
{target}
Code: {code}
"
                    ),
                );
                if let Err(reason) = open_browser(&target)
                    && !json
                {
                    let _ = writeln!(std::io::stderr(), "Browser open failed: {reason}");
                }
            }
        },
        &CancellationToken::new(),
    )
    .await?;
    let user_info = &signed_in.user_info;
    if json {
        let membership = signed_in.membership.as_ref().map(|membership| {
            json!({
                "expiresAt": membership.get("expiresAt").cloned().unwrap_or(Value::Null),
                "plan": membership.get("plan").cloned().unwrap_or(Value::Null),
                "status": membership
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
            })
        });
        let value = json!({
            "account": session::account_user(user_info),
            "apiBaseUrl": context.api_base_url,
            "credentialsPath": signed_in.credentials,
            "licenseExpiresAt": signed_in.license_expires_at,
            "membership": membership,
            "status": "signed_in",
            "warnings": signed_in.warnings,
        });
        let _ = write!(std::io::stdout(), "{}", format_json(&value));
        return Ok(());
    }
    let mut out = std::io::stdout();
    let _ = writeln!(
        out,
        "Signed in to NIBI{}.",
        session::format_user_label(user_info)
    );
    let _ = writeln!(
        out,
        "{}",
        session::format_membership(
            signed_in.membership.as_ref(),
            signed_in.license_expires_at.as_deref()
        )
    );
    let _ = writeln!(out, "Credentials: {}", signed_in.credentials);
    for warning in &signed_in.warnings {
        let _ = writeln!(out, "Warning: {warning}");
    }
    Ok(())
}

fn write_prompt(to_stderr: bool, text: String) -> std::io::Result<()> {
    if to_stderr {
        let mut stderr = std::io::stderr();
        write!(stderr, "{text}")?;
        stderr.flush()
    } else {
        let mut out = std::io::stdout();
        write!(out, "{text}")?;
        out.flush()
    }
}

fn text(error: DeviceFlowError) -> String {
    error.to_string()
}

struct License {
    membership: Option<Value>,
    license_expires_at: Option<String>,
    warnings: Vec<String>,
}

/// Node `syncNibiLicense`：会员状态同步失败只记一条警告，不让登录失败。
async fn sync_license(context: &AccountContext, access_token: &str) -> License {
    let mut warnings = Vec::new();
    let device_id = match context.store.ensure_device_id().await {
        Ok(id) => id,
        Err(error) => {
            warnings.push(format!("会员状态暂时无法同步（{error}）"));
            return License {
                membership: None,
                license_expires_at: None,
                warnings,
            };
        }
    };
    let (url, headers) = session::license_request(&context.api_base_url, access_token);
    let mut request = HttpRequest::post(url, session::license_body(&device_id).to_string())
        .header(header::CONTENT_TYPE, header::JSON);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    request.timeout = Some(LICENSE_TIMEOUT);
    // 传输层失败（代理抖动、DNS、网络切换）重试一次：登录本身已经成功，会员状态只差这一步。
    // 4xx/5xx 不重试——那是服务端的裁决，重复问没有意义。
    let mut attempt = 0;
    let response = loop {
        attempt += 1;
        match context.egress.send(request.clone()).await {
            Ok(response) => break response,
            Err(error) if attempt < 2 => {
                tracing::debug!(%error, "license check failed, retrying once");
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            Err(error) => {
                warnings.push(format!("会员状态暂时无法同步（{error}）"));
                return License {
                    membership: None,
                    license_expires_at: None,
                    warnings,
                };
            }
        }
    };
    let status = response.status();
    let body = match response.text(RESPONSE_LIMIT).await {
        Ok(text) => serde_json::from_str::<Value>(&text).unwrap_or_else(|_| json!({})),
        Err(_) => json!({}),
    };
    let now = (context.now)();
    let mut writes: Vec<(&'static str, Option<String>)> = Vec::new();
    if status == 200 && body.get("authorized") == Some(&Value::Bool(true)) {
        session::authorized_license(&mut writes, &body, &device_id, now);
        if writes
            .iter()
            .any(|(key, value)| *key == session::LICENSE_TOKEN_KEY && value.is_some())
            && let Err(error) = context.store.save_many(&writes).await
        {
            warnings.push(format!("会员状态暂时无法同步（{error}）"));
        }
        return License {
            membership: body.get("membership").cloned(),
            license_expires_at: body
                .get("license")
                .and_then(|license| license.get("expiresAt"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            warnings,
        };
    }
    if status == 200 && body.get("authorized") == Some(&Value::Bool(false)) {
        session::refused_license(&mut writes, &body, &device_id, now);
        if let Err(error) = context.store.save_many(&writes).await {
            warnings.push(format!("会员状态暂时无法同步（{error}）"));
        }
        return License {
            membership: Some(
                body.get("membership")
                    .cloned()
                    .unwrap_or_else(|| json!({"status": "none"})),
            ),
            license_expires_at: None,
            warnings,
        };
    }
    warnings.push(if status == 401 || status == 403 {
        "账号令牌未被业务服务接受，会员状态未同步（请确认账号中心与 API 项目配置一致）".to_owned()
    } else {
        format!("会员状态同步失败（HTTP {status}）")
    });
    License {
        membership: body.get("membership").cloned(),
        license_expires_at: None,
        warnings,
    }
}

/// 挂在内核网络出口上的传输（与 CLI 其它请求同一套代理/CA/超时配置）。
struct HostTransport {
    egress: Arc<Egress>,
}

impl HostTransport {
    async fn send(&self, request: HttpRequest) -> Result<(u16, Value), String> {
        let response = self
            .egress
            .send(request)
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let body = response
            .text(RESPONSE_LIMIT)
            .await
            .map_err(|error| error.to_string())?;
        // Node `requestJson`：正文不是 JSON 时当空对象。
        let value = if body.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&body).unwrap_or_else(|_| json!({}))
        };
        Ok((status, value))
    }
}

#[async_trait]
impl Transport for HostTransport {
    async fn post_form(
        &self,
        url: &str,
        fields: &[(&str, String)],
    ) -> Result<(u16, Value), String> {
        let body = form_encode(fields);
        let mut request = HttpRequest::post(url, body)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
        request.timeout = Some(REQUEST_TIMEOUT);
        self.send(request).await
    }

    async fn get_bearer(&self, url: &str, token: &str) -> Result<(u16, Value), String> {
        let mut request = HttpRequest::get(url)
            .header(header::ACCEPT, header::JSON)
            .header(header::AUTHORIZATION, format!("Bearer {token}"));
        request.timeout = Some(REQUEST_TIMEOUT);
        self.send(request).await
    }
}

/// `application/x-www-form-urlencoded`（Node `new URLSearchParams(fields).toString()`）。
fn form_encode(fields: &[(&str, String)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in fields {
        serializer.append_pair(name, value);
    }
    serializer.finish()
}

/// 服务地址（`NIBI_AUTH_ORIGIN` 覆盖账号中心；API 根沿用 CLI 的 `NIBI_ENDPOINT_ORIGIN` 规则）。
pub(crate) fn origins(env: &impl Fn(&str) -> Option<String>) -> Result<(String, String), String> {
    let auth = device_flow::auth_origin_from_env(env);
    let api = format!("{}/api/v1", crate::origins::nibi_origin(env)?);
    Ok((auth, api))
}

/// 打开浏览器用的系统命令属于哪一类平台。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Os {
    Mac,
    Windows,
    Other,
}

impl Os {
    fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }
}

/// 打开地址的程序与参数（Node `browserOpenCommand`；Windows 用 `rundll32`）。
///
/// 缺陷修复 R2-15：Windows 原来按 Node 用 `cmd.exe /c start "" <url>`。cmd 会重新解析整行，地址里的 `&`、`|`
/// 被当成命令分隔符：OAuth 地址的参数丢失，后半段还会被当作命令执行。现在用
/// `rundll32 url,OpenURL <url>`，不经过 cmd，地址原样到达。
pub(crate) fn browser_command(os: Os, url: &str) -> (&'static str, Vec<&str>) {
    match os {
        Os::Mac => ("open", vec![url]),
        Os::Windows => ("rundll32", vec!["url,OpenURL", url]),
        Os::Other => ("xdg-open", vec![url]),
    }
}

/// 用系统的打开方式打开授权地址（Node `openUrlInBrowser`）：启动成功即算打开，不等它结束。
pub(crate) fn open_browser(url: &str) -> Result<(), String> {
    let (program, args) = browser_command(Os::current(), url);
    nibi_kernel_proc::command(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(drop)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "login_tests.rs"]
mod tests;
