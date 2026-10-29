use super::*;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;

// kid-1 公钥（Node crypto 生成；tokens 见 scripts/kernel-baseline 的金标准生成器）
const PUBLIC_KEY: &str = "Op9EiLF_v-qTpLUxIztILaM1hsDpaeP-JZodBwma6fk";
const ACTIVE: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImtpZC0xIn0.eyJpc3MiOiJuaWJpLWxpY2Vuc2UiLCJzdWIiOiJ1c2VyLTEiLCJ1aWQiOiJ1c2VyLTEiLCJwbGFuIjoicHJvIiwicGx1Z2lucyI6WyJtYXRoLW1vZGVsaW5nIl0sImRldiI6ImRldi0xIiwiZXhwIjoxNzkzMjg4NjAwLCJpYXQiOjE3OTMyODQ5MDAsImp0aSI6Imp0aS0xIn0.9GEubux13C7H41d4n98DcLvIO9nu2yPhSBUpaz0P40rr1VCUVQZ8aoony5q-kYaWfNmz2usdJrn-x0c9Px_hBg";
const NO_DEV: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImtpZC0xIn0.eyJpc3MiOiJuaWJpLWxpY2Vuc2UiLCJzdWIiOiJ1c2VyLTEiLCJ1aWQiOiJ1c2VyLTEiLCJwbGFuIjoicHJvIiwicGx1Z2lucyI6WyJtYXRoLW1vZGVsaW5nIl0sImV4cCI6MTc5MzI4ODYwMCwiaWF0IjoxNzkzMjg0OTAwLCJqdGkiOiJqdGktMSJ9.MA6vjZXNeFus5As-7py6DAGPgLaRWC-W6Bpi0GPcsPMVRHyIOefDlx9DVvMdlwprk6iL2yupkSsbiMpBCzABAQ";
const NO_KID: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJuaWJpLWxpY2Vuc2UiLCJzdWIiOiJ1c2VyLTEiLCJ1aWQiOiJ1c2VyLTEiLCJwbGFuIjoicHJvIiwicGx1Z2lucyI6WyJtYXRoLW1vZGVsaW5nIl0sImRldiI6ImRldi0xIiwiZXhwIjoxNzkzMjg4NjAwLCJpYXQiOjE3OTMyODQ5MDAsImp0aSI6Imp0aS0xIn0.p1auyZl-0NE_pQpfzSJYNnGTDvDLJWyHc7rs8N7oZGs2cqsSpaJR1QsIlpFEMguutcCq0I6TvjRLgJmHxe_9CQ";
// 第二把钥匙：只用于 iss/alg 负例，避免和主用例抢 kid-1。
const EXTRA_PUBLIC_KEY: &str = "siTMzfYVgJMHc63rS0weCyaM4xOtMsmByiExBaBZNNE";
const BAD_ISSUER: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImtpZC0xIn0.eyJpc3MiOiJ6Y29kZSIsInN1YiI6InVzZXItMSIsInVpZCI6InVzZXItMSIsInBsYW4iOiJwcm8iLCJwbHVnaW5zIjpbIm1hdGgtbW9kZWxpbmciXSwiZGV2IjoiZGV2LTEiLCJleHAiOjE3OTMyODg2MDAsImlhdCI6MTc5MzI4NDkwMCwianRpIjoianRpLTEifQ.3h2R0x3wGU3A_dcqF7qxfjb9I3WrQO6pgaC1V9JaM7jtVFaKwl1EkIqf38GiZAnYMHtlrQfLxa4o0WqbNAN5Dw";
const ALG_ED25519: &str = "eyJhbGciOiJFZDI1NTE5IiwidHlwIjoiSldUIiwia2lkIjoia2lkLTEifQ.eyJpc3MiOiJuaWJpLWxpY2Vuc2UiLCJzdWIiOiJ1c2VyLTEiLCJ1aWQiOiJ1c2VyLTEiLCJwbGFuIjoicHJvIiwicGx1Z2lucyI6WyJtYXRoLW1vZGVsaW5nIl0sImRldiI6ImRldi0xIiwiZXhwIjoxNzkzMjg4NjAwLCJpYXQiOjE3OTMyODQ5MDAsImp0aSI6Imp0aS0xIn0.Y3gsw6lKGMQsxu7kCvHsitYkwe2tMlVr9Hwc5DzOLUucggfMvcrFeFZrgR5vka7yTh9U4tHd0uBuZT3p-lkqAA";
const NOW_MS: u64 = 1_793_285_000_000;

fn decode_key(value: &str) -> [u8; 32] {
    URL_SAFE_NO_PAD.decode(value).unwrap().try_into().unwrap()
}
fn key() -> [u8; 32] {
    decode_key(PUBLIC_KEY)
}
fn extra_key() -> [u8; 32] {
    decode_key(EXTRA_PUBLIC_KEY)
}

fn eval(token: Option<&str>, device: Option<&str>, account: Option<&str>) -> LicenseDecision {
    evaluate(LicenseEvaluation {
        token,
        keys: &|_kid| Some(key()),
        snapshot: None,
        now_ms: NOW_MS,
        device_id: device,
        account_identity: account,
    })
}

#[test]
fn active_token_is_allowed() {
    let decision = eval(Some(ACTIVE), Some("dev-1"), Some("user-1"));
    assert_eq!(decision.status, LicenseStatus::Active);
    assert!(decision.allowed);
    assert_eq!(
        decision.claims.as_ref().unwrap().plugins,
        vec!["math-modeling"]
    );
}

#[test]
fn kid_header_selects_key_or_denies() {
    let decision = evaluate(LicenseEvaluation {
        token: Some(ACTIVE),
        keys: &|kid| (kid == Some("kid-1")).then(key),
        snapshot: None,
        now_ms: NOW_MS,
        device_id: Some("dev-1"),
        account_identity: Some("user-1"),
    });
    assert_eq!(decision.status, LicenseStatus::Active);

    let denied = evaluate(LicenseEvaluation {
        token: Some(ACTIVE),
        keys: &|kid| (kid == Some("other")).then(key),
        snapshot: None,
        now_ms: NOW_MS,
        device_id: Some("dev-1"),
        account_identity: Some("user-1"),
    });
    assert_eq!(denied.status, LicenseStatus::Denied);
}

#[test]
fn missing_kid_is_rejected() {
    assert!(matches!(
        verify_token(NO_KID, &|_kid| Some(key())).unwrap_err(),
        LicenseError::UnknownKey(_)
    ));
}

#[test]
fn accepts_ed25519_alg_spelling_like_node() {
    let (claims, kid) = verify_token(ALG_ED25519, &|_kid| Some(extra_key())).unwrap();
    assert_eq!(claims.iss, LICENSE_ISSUER);
    assert_eq!(kid.as_deref(), Some("kid-1"));
}

#[test]
fn wrong_issuer_is_rejected() {
    assert!(matches!(
        verify_token(BAD_ISSUER, &|_kid| Some(extra_key())).unwrap_err(),
        LicenseError::WrongIssuer
    ));
}

#[test]
fn missing_token_is_not_activated() {
    assert_eq!(
        eval(None, Some("dev-1"), Some("user-1")).status,
        LicenseStatus::NotActivated
    );
}

#[test]
fn missing_dev_is_denied() {
    assert_eq!(
        eval(Some(NO_DEV), Some("dev-1"), Some("user-1")).status,
        LicenseStatus::Denied
    );
}

#[test]
fn wrong_device_is_denied() {
    assert_eq!(
        eval(Some(ACTIVE), Some("dev-2"), Some("user-1")).status,
        LicenseStatus::Denied
    );
}

#[test]
fn wrong_account_is_denied() {
    assert_eq!(
        eval(Some(ACTIVE), Some("dev-1"), Some("user-2")).status,
        LicenseStatus::Denied
    );
}

#[test]
fn matching_account_is_enough() {
    assert_eq!(
        eval(Some(ACTIVE), Some("dev-1"), Some("user-1")).status,
        LicenseStatus::Active
    );
}

#[test]
fn tampered_token_is_denied() {
    let mut tampered = ACTIVE.to_owned();
    let last = tampered.pop().unwrap();
    tampered.push(if last == 'A' { 'B' } else { 'A' });
    assert_eq!(
        eval(Some(&tampered), Some("dev-1"), Some("user-1")).status,
        LicenseStatus::Denied
    );
}

#[test]
fn exp_is_a_hard_boundary() {
    let decision = evaluate(LicenseEvaluation {
        token: Some(ACTIVE),
        keys: &|_kid| Some(key()),
        snapshot: None,
        now_ms: 1_793_288_600_000,
        device_id: Some("dev-1"),
        account_identity: Some("user-1"),
    });
    assert_eq!(decision.status, LicenseStatus::Expired);
    assert!(!decision.allowed);
}

#[test]
fn grace_then_expired_after_seven_days() {
    let last_check = NOW_MS - CHECK_INTERVAL_MS - 3_600_000;
    let grace = evaluate(LicenseEvaluation {
        token: Some(ACTIVE),
        keys: &|_kid| Some(key()),
        snapshot: Some(&LicenseSnapshot {
            last_check_at_ms: Some(last_check),
            last_refusal: None,
        }),
        now_ms: NOW_MS,
        device_id: Some("dev-1"),
        account_identity: Some("user-1"),
    });
    assert_eq!(grace.status, LicenseStatus::Grace);
    assert!(grace.allowed);

    let too_old = NOW_MS - CHECK_INTERVAL_MS - OFFLINE_GRACE_MS - 1;
    let expired = evaluate(LicenseEvaluation {
        token: Some(ACTIVE),
        keys: &|_kid| Some(key()),
        snapshot: Some(&LicenseSnapshot {
            last_check_at_ms: Some(too_old),
            last_refusal: None,
        }),
        now_ms: NOW_MS,
        device_id: Some("dev-1"),
        account_identity: Some("user-1"),
    });
    assert_eq!(expired.status, LicenseStatus::Expired);
}

#[test]
fn refusal_overrides_grace_but_not_exp() {
    let snapshot = LicenseSnapshot {
        last_check_at_ms: Some(NOW_MS),
        last_refusal: Some("no_membership".to_owned()),
    };
    let decision = evaluate(LicenseEvaluation {
        token: Some(ACTIVE),
        keys: &|_kid| Some(key()),
        snapshot: Some(&snapshot),
        now_ms: NOW_MS,
        device_id: Some("dev-1"),
        account_identity: Some("user-1"),
    });
    assert_eq!(decision.status, LicenseStatus::NotActivated);

    let expired_snapshot = LicenseSnapshot {
        last_check_at_ms: Some(NOW_MS),
        last_refusal: Some("membership_expired".to_owned()),
    };
    let decision = evaluate(LicenseEvaluation {
        token: Some(ACTIVE),
        keys: &|_kid| Some(key()),
        snapshot: Some(&expired_snapshot),
        now_ms: NOW_MS,
        device_id: Some("dev-1"),
        account_identity: Some("user-1"),
    });
    assert_eq!(decision.status, LicenseStatus::Expired);
}

#[test]
fn covers_plugin_uses_star_and_exact_match() {
    let claims = verify_token(ACTIVE, &|_kid| Some(key())).unwrap().0;
    assert!(license_covers_plugin(&claims, "math-modeling"));
    assert!(!license_covers_plugin(&claims, "other"));
    let mut wildcard = claims;
    wildcard.plugins = vec!["*".to_owned()];
    assert!(license_covers_plugin(&wildcard, "anything"));
}

#[test]
fn resolver_that_returns_none_is_denied() {
    let decision = evaluate(LicenseEvaluation {
        token: Some(ACTIVE),
        keys: &|_kid| None,
        snapshot: None,
        now_ms: NOW_MS,
        device_id: Some("dev-1"),
        account_identity: Some("user-1"),
    });
    assert_eq!(decision.status, LicenseStatus::Denied);
}
