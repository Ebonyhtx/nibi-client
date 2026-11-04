use std::fs;

use super::*;

fn write(path: &Path, value: serde_json::Value) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
}

#[test]
fn reads_plain_dev_credentials_and_the_last_refusal() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("credentials.json");
    write(
        &path,
        serde_json::json!({
            "nibi:license:token": " token-1 ",
            "nibi:device:id": " dev-1 ",
            "nibi:license:state": "{\"lastRefusal\":\"membership_expired\"}"
        }),
    );
    let credentials = read_license_credentials(&path, |_| None);
    assert_eq!(credentials.token.as_deref(), Some("token-1"));
    assert_eq!(credentials.device_id.as_deref(), Some("dev-1"));
    assert_eq!(credentials.refusal.as_deref(), Some("membership_expired"));
}

#[test]
fn missing_or_blank_values_are_none() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("credentials.json");
    write(
        &path,
        serde_json::json!({
            "nibi:license:token": "   ",
            "nibi:device:id": "",
            "nibi:license:state": "{\"lastRefusal\":\"\"}"
        }),
    );
    let credentials = read_license_credentials(&path, |_| None);
    assert_eq!(credentials, LicenseCredentials::default());
}

#[test]
fn unreadable_or_malformed_files_fail_closed_to_empty() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("missing.json");
    assert_eq!(
        read_license_credentials(&missing, |_| None),
        LicenseCredentials::default()
    );
    let malformed = dir.path().join("malformed.json");
    fs::write(&malformed, "not json").unwrap();
    assert_eq!(
        read_license_credentials(&malformed, |_| None),
        LicenseCredentials::default()
    );
}
