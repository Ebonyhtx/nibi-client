//! `nibi login` / `nibi logout` 的真实进程（Node `login-command.ts`）：NIBI Device Flow 的提示与输出、
//! 写出的 v2 凭据与会员状态。账号中心与业务接口都是本地假服务，不连任何真实服务；数据目录、home 与密钥
//! 都是临时的。
#![allow(
    clippy::disallowed_methods,
    reason = "测试搭本地 HTTP 夹具、读临时目录里的文件"
)]
#![allow(
    clippy::unwrap_used,
    reason = "集成测试：辅助函数不在 #[test] 里，clippy 的测试豁免覆盖不到"
)]

mod system_env;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::Path;
use std::process::{Output, Stdio};
use system_env::KeepSystem as _;

use serde_json::{Value, json};

/// 在临时 home 里运行 `nibi <args>`。
fn nibi(home: &Path, args: &[&str], server: Option<&str>) -> Output {
    let mut command = nibi_kernel_proc::std_command(env!("CARGO_BIN_EXE_nibi-rs"));
    command
        .args(args)
        .env_clear()
        .keep_system()
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("NIBI_DATA_BASE_DIR", home)
        .env("NIBI_CREDENTIAL_SECRET", "test-secret")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(url) = server {
        command.env("NIBI_AUTH_ORIGIN", url).env("NIBI_BASE_URL", url);
    }
    command.spawn().unwrap().wait_with_output().unwrap()
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn credentials_path(home: &Path) -> std::path::PathBuf {
    home.join(".nibi").join("v2").join("credentials.json")
}

fn credentials(home: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(credentials_path(home)).unwrap()).unwrap()
}

/// 用与 CLI 相同的 secret 解开一个键。
fn decrypted(home: &Path, key: &str) -> Option<String> {
    let raw = credentials(home);
    let value = raw.get(key)?.as_str()?;
    nibi_platform::credentials::CredentialCipher::from_env(&credentials_path(home), |name| {
        (name == "NIBI_CREDENTIAL_SECRET").then(|| "test-secret".to_owned())
    })
    .decrypt(value)
    .ok()
}

/// 按路径回复的假账号中心 + 业务接口。
fn serve(listener: TcpListener) {
    let origin = format!("http://{}", listener.local_addr().unwrap());
    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let path = line.split(' ').nth(1).unwrap_or_default().to_owned();
        let mut length = 0;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            if header.trim().is_empty() {
                break;
            }
            if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        let reply = match path.as_str() {
            "/oauth/v2/device_authorization" => json!({
                "device_code": "dc-1",
                "user_code": "UC-1",
                "verification_uri": format!("{origin}/device"),
                "verification_uri_complete": format!("{origin}/device?uc=UC-1"),
                "expires_in": 300,
                "interval": 1,
            }),
            "/oauth/v2/token" => json!({
                "access_token": "at",
                "refresh_token": "rt",
                "token_type": "Bearer",
                "expires_in": 3600,
            }),
            "/oidc/v1/userinfo" => json!({
                "sub": "user-1",
                "email": "u@example.test",
                "name": "Nibi",
                "picture": "https://img",
            }),
            "/api/v1/licenses/check" => json!({
                "authorized": true,
                "membership": {
                    "status": "active",
                    "plan": "pro",
                    "expiresAt": "2027-01-02T03:04:05.000Z",
                },
                "license": {
                    "token": "lic-token",
                    "expiresAt": "2027-01-02T03:04:05.000Z",
                },
            }),
            _ => json!({"error": "not found"}),
        }
        .to_string();
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
            reply.len()
        );
    }
}

fn start_server() -> String {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || serve(listener));
    origin
}

#[test]
fn device_login_writes_the_nibi_session_and_license() {
    let origin = start_server();
    let home = tempfile::tempdir().unwrap();
    let output = nibi(home.path(), &["login", "--no-browser"], Some(&origin));
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert_eq!(
        text(&output.stdout),
        format!(
            "To sign in to NIBI, open this URL in a browser and enter the code:\n\
             {origin}/device?uc=UC-1\n\
             Code: UC-1\n\
             Signed in to NIBI as Nibi <u@example.test>.\n\
             Membership: pro (active until 2027-01-02)\n\
             Credentials: {}\n",
            credentials_path(home.path()).display()
        )
    );
    // 会话键与 license 都在，值是 v2（每安装钥匙）。
    assert_eq!(
        decrypted(home.path(), "oauth:nibi:access_token").as_deref(),
        Some("at")
    );
    assert_eq!(
        decrypted(home.path(), "oauth:nibi:refresh_token").as_deref(),
        Some("rt")
    );
    assert_eq!(
        decrypted(home.path(), "oauth:active_provider").as_deref(),
        Some("nibi")
    );
    assert_eq!(
        decrypted(home.path(), "nibi:license:token").as_deref(),
        Some("lic-token")
    );
    let user: Value =
        serde_json::from_str(&decrypted(home.path(), "oauth:nibi:user_info").unwrap()).unwrap();
    assert_eq!(user["id"], "user-1");
    assert_eq!(user["avatarUrl"], "https://img");
    let device = decrypted(home.path(), "nibi:device:id").unwrap();
    assert!((8..=128).contains(&device.len()));
    let raw = std::fs::read_to_string(credentials_path(home.path())).unwrap();
    assert!(!raw.contains("\"at\""));
    for key in ["oauth:nibi:access_token", "nibi:license:token"] {
        assert!(
            credentials(home.path())[key]
                .as_str()
                .unwrap()
                .starts_with("enc:v2:"),
            "{key} is not v2"
        );
    }
}

/// `--json`：提示写到 stderr，stdout 只有一段 `JSON.stringify(…, null, 2)` 加换行。
#[test]
fn json_output_follows_node() {
    let origin = start_server();
    let home = tempfile::tempdir().unwrap();
    let output = nibi(home.path(), &["login", "--no-browser", "--json"], Some(&origin));
    assert!(output.status.success(), "{}", text(&output.stderr));
    assert_eq!(
        text(&output.stderr),
        format!(
            "To sign in to NIBI, open this URL in a browser and enter the code:\n\
             {origin}/device?uc=UC-1\n\
             Code: UC-1\n"
        )
    );
    let expected = json!({
        "account": {
            "user_id": "user-1",
            "email": "u@example.test",
            "name": "Nibi",
            "avatar": "https://img",
        },
        "apiBaseUrl": format!("{origin}/api/v1"),
        "credentialsPath": credentials_path(home.path()).display().to_string(),
        "licenseExpiresAt": "2027-01-02T03:04:05.000Z",
        "membership": {
            "expiresAt": "2027-01-02T03:04:05.000Z",
            "plan": "pro",
            "status": "active",
        },
        "status": "signed_in",
        "warnings": [],
    });
    assert_eq!(
        text(&output.stdout),
        format!("{}\n", serde_json::to_string_pretty(&expected).unwrap())
    );
}

#[test]
fn logout_clears_the_nibi_account() {
    let origin = start_server();
    let home = tempfile::tempdir().unwrap();
    assert!(
        nibi(home.path(), &["login", "--no-browser"], Some(&origin))
            .status
            .success()
    );
    let output = nibi(home.path(), &["logout", "--json"], None);
    assert!(output.status.success(), "{}", text(&output.stderr));
    let expected = json!({
        "clearedKeys": [
            "oauth:nibi:access_token",
            "oauth:nibi:refresh_token",
            "oauth:nibi:user_info",
            "nibi:license:token",
            "nibi:license:state",
            "oauth:active_provider",
        ],
        "credentialsPath": credentials_path(home.path()).display().to_string(),
        "status": "signed_out",
    });
    assert_eq!(
        text(&output.stdout),
        format!("{}\n", serde_json::to_string_pretty(&expected).unwrap())
    );
    let raw = credentials(home.path());
    assert!(raw.get("oauth:nibi:access_token").is_none());
    assert!(raw.get("nibi:license:token").is_none());
}

/// Node 只认 `nibi login [--no-browser]`：带了位置参数就是用法错误。
#[test]
fn usage_errors_follow_node() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        vec!["login", "--unknown"],
        vec!["login", "zai"],
        vec!["login", "bigmodel"],
    ] {
        let output = nibi(home.path(), &args, None);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(
            text(&output.stderr).starts_with("Error: Usage: nibi login [--no-browser]"),
            "{args:?}: {}",
            text(&output.stderr)
        );
    }
}
