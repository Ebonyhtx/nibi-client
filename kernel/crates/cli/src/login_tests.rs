//! `nibi login` / `nibi logout` 的参数、会话写入与输出形状（Node `login-command.ts`）。

use nibi_platform::device_flow::{TokenSet, UserProfile};
use serde_json::{Value, json};

use super::*;

fn args(text: &str) -> Vec<String> {
    text.split_whitespace().map(str::to_owned).collect()
}

#[test]
fn login_arguments_follow_node() {
    assert_eq!(parse(&args("-p hi")), None);
    assert_eq!(
        parse(&args("logout")),
        Some(Ok(Command::Logout { json: false }))
    );
    assert_eq!(
        parse(&args("logout --json")),
        Some(Ok(Command::Logout { json: true }))
    );
    assert_eq!(
        parse(&args("login")),
        Some(Ok(Command::Login {
            no_browser: false,
            json: false,
        }))
    );
    assert_eq!(
        parse(&args("login --no-browser")),
        Some(Ok(Command::Login {
            no_browser: true,
            json: false,
        }))
    );
    // `--json`：位置不限。
    assert_eq!(
        parse(&args("login --json --no-browser")),
        Some(Ok(Command::Login {
            no_browser: true,
            json: true,
        }))
    );
    // Node 只认 `nibi login [--no-browser]`：带了位置参数就是用法错误。
    for bad in ["login zai", "login bigmodel", "login a b"] {
        assert_eq!(parse(&args(bad)), Some(Err(USAGE.to_owned())), "{bad}");
    }
    assert_eq!(USAGE, "Usage: nibi login [--no-browser]");
}

/// 缺陷 R2-15：Windows 原来用 `cmd /c start "" <url>`，地址没有经过 cmd 的转义：地址里的 `&` 被
/// cmd 当成命令分隔符，后面的参数丢失（还会被当作命令执行）。改用 `rundll32 url,OpenURL <url>`，
/// 不经过 cmd。
#[test]
fn the_browser_command_keeps_the_whole_url() {
    let url = "https://example.com/oauth?client_id=a&state=b|c";
    let windows = browser_command(Os::Windows, url);
    assert_eq!(windows, ("rundll32", vec!["url,OpenURL", url]));
    assert_eq!(browser_command(Os::Mac, url), ("open", vec![url]));
    assert_eq!(browser_command(Os::Other, url), ("xdg-open", vec![url]));
}

#[test]
fn the_service_origins_follow_the_nibi_environment_rules() {
    let read = |pairs: Vec<(&'static str, &'static str)>| {
        move |key: &str| {
            pairs
                .iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| (*value).to_owned())
        }
    };
    let (auth, api) = origins(&read(vec![])).unwrap();
    assert_eq!(auth, "https://auth.nibistudio.cn");
    assert_eq!(api, "https://api.nibistudio.cn/api/v1");
    let (auth, api) = origins(&read(vec![
        ("NIBI_AUTH_ORIGIN", "https://auth.test/"),
        ("NIBI_BASE_URL", "https://api.test/"),
    ]))
    .unwrap();
    assert_eq!(auth, "https://auth.test");
    assert_eq!(api, "https://api.test/api/v1");
}

fn temporary_store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().join("credentials.json"), |_| None);
    (dir, store)
}

fn token() -> TokenSet {
    TokenSet {
        access_token: "at".to_owned(),
        token_type: Some("Bearer".to_owned()),
        scope: None,
        id_token: None,
        refresh_token: Some("rt".to_owned()),
        expires_at_ms: Some(1_000),
    }
}

fn user() -> UserProfile {
    UserProfile {
        id: "user-1".to_owned(),
        name: Some("Nibi".to_owned()),
        email: Some("u@example.test".to_owned()),
        preferred_username: Some("nibi".to_owned()),
        avatar_url: Some("https://img".to_owned()),
        raw_profile: json!({"sub": "user-1"}),
    }
}

#[tokio::test]
async fn the_session_round_trips_and_is_written_as_v2() {
    let (_dir, store) = temporary_store();
    session::save_session(&store, &token(), &user()).await.unwrap();

    assert_eq!(store.load(session::ACCESS_TOKEN_KEY).as_deref(), Some("at"));
    assert_eq!(store.load(session::REFRESH_TOKEN_KEY).as_deref(), Some("rt"));
    let stored_user: Value =
        serde_json::from_str(&store.load(session::USER_INFO_KEY).unwrap()).unwrap();
    assert_eq!(stored_user["id"], "user-1");
    // active provider 指向 NIBI，值全部是 `enc:v2:`（每安装钥匙）。
    assert_eq!(store.load(session::ACTIVE_PROVIDER_KEY).as_deref(), Some("nibi"));
    let raw = std::fs::read_to_string(store.path()).unwrap();
    let raw: Value = serde_json::from_str(&raw).unwrap();
    for key in [
        session::ACCESS_TOKEN_KEY,
        session::REFRESH_TOKEN_KEY,
        session::USER_INFO_KEY,
    ] {
        let value = raw[key].as_str().unwrap();
        assert!(value.starts_with("enc:v2:"), "{key} is not v2: {value}");
    }
    // 用户资料的键序与 Node 相同。
    assert_eq!(
        session::user_info_value(&user()).to_string(),
        r#"{"avatarUrl":"https://img","email":"u@example.test","id":"user-1","name":"Nibi","preferredUsername":"nibi","rawProfile":{"sub":"user-1"}}"#
    );
}

#[tokio::test]
async fn logout_clears_the_account_keys_but_not_another_provider() {
    let (_dir, store) = temporary_store();
    session::save_session(&store, &token(), &user()).await.unwrap();
    store
        .save_many(&[("oauth:zai:access_token", Some("zai".to_owned()))])
        .await
        .unwrap();
    let cleared = store.clear_account().await;
    assert_eq!(
        cleared,
        session::CLEARED_KEYS
            .iter()
            .map(|key| (*key).to_owned())
            .chain([session::ACTIVE_PROVIDER_KEY.to_owned()])
            .collect::<Vec<_>>()
    );
    assert!(store.load(session::ACCESS_TOKEN_KEY).is_none());
    // 别的 provider 的登录态不属于这次登出。
    assert_eq!(store.load("oauth:zai:access_token").as_deref(), Some("zai"));
}

#[tokio::test]
async fn values_the_cipher_cannot_read_are_preserved_verbatim() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("credentials.json");
    // 别的安装写的 v2 值（钥匙不在本机）与损坏的 v1 值：既解不开也不该被改写。
    std::fs::write(
        &file,
        json!({
            "oauth:zai:access_token": "enc:v2:AAAA.BBBB.CCCC",
            "oauth:bigmodel:refresh_token": "enc:v1:broken",
        })
        .to_string(),
    )
    .unwrap();
    let store = Store::open(&file, |_| None);
    assert!(store.load("oauth:zai:access_token").is_none());
    store
        .save_many(&[(session::ACCESS_TOKEN_KEY, Some("new".to_owned()))])
        .await
        .unwrap();
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(raw["oauth:zai:access_token"], "enc:v2:AAAA.BBBB.CCCC");
    assert_eq!(raw["oauth:bigmodel:refresh_token"], "enc:v1:broken");
}

#[tokio::test]
async fn a_corrupt_credentials_file_is_not_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("credentials.json");
    std::fs::write(&file, "{not json").unwrap();
    let store = Store::open(&file, |_| None);
    assert!(store
        .save_many(&[(session::ACCESS_TOKEN_KEY, Some("at".to_owned()))])
        .await
        .is_err());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "{not json");
}

#[test]
fn license_facts_and_membership_text_match_node() {
    assert_eq!(session::license_body("dev-1")["deviceId"], "dev-1");
    assert_eq!(session::license_body("dev-1")["deviceName"], "NIBI CLI");
    assert_eq!(session::node_platform("windows"), "win32");
    assert_eq!(session::node_platform("macos"), "darwin");
    assert_eq!(
        session::format_membership(None, None),
        "Membership: unknown (will retry on the next login or desktop launch)"
    );
    assert_eq!(
        session::format_membership(Some(&json!({"status": "expired"})), None),
        "Membership: expired (member-only plugins stay locked)"
    );
    assert_eq!(
        session::format_membership(
            Some(&json!({"status": "active", "plan": "pro", "expiresAt": "2027-01-02T03:04:05.000Z"})),
            None
        ),
        "Membership: pro (active until 2027-01-02)"
    );
    assert_eq!(session::format_date("not-a-date"), "not-a-date");
    assert_eq!(
        session::format_user_label(&json!({"id": "u", "name": "Nibi", "email": "n@example.test"})),
        " as Nibi <n@example.test>"
    );
}
