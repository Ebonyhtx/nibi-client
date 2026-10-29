use serde_json::json;

use super::*;

/// 随 crate 带的 schema 全部能编译（zod 用了不认识的关键字时这里失败，重新生成后要补校验器）。
#[test]
fn the_shipped_schema_compiles() {
    let inbound = Inbound::parse(INBOUND).unwrap();
    for method in [
        "v4/command",
        "v4/conversation/subscribe",
        "runtime/capabilities",
        "session/read",
    ] {
        assert!(inbound.methods.contains_key(method), "{method}");
    }
    // NIBI 分家：命令契约搬去 nibi_commands（34 个），这里只保证方法/回复段还在，
    // 且已删除的 offPeak 方法不再出现。
    assert!(
        !inbound
            .methods
            .contains_key("workspace/updateOffPeakToolPolicy")
    );
}

#[test]
fn method_params_follow_the_app_schema() {
    let inbound = Inbound::get();
    assert!(
        inbound
            .method("session/read", &json!({"sessionId": "sess_x"}))
            .is_ok()
    );
    let error = inbound
        .method("session/read", &json!({"sessionId": "sess_x", "extra": 1}))
        .unwrap_err();
    assert_eq!(error.code, -32602);
    // 省略 params 按 {} 校验。
    assert!(inbound.method("runtime/capabilities", &Value::Null).is_ok());
    assert!(inbound.method("not/registered", &json!(1)).is_ok());
}

#[test]
fn commands_check_the_payload_and_the_cross_field_rules() {
    let inbound = Inbound::get();
    let envelope = |kind: &str, payload: Value| {
        json!({"commandId": "c1", "clientId": "k", "sessionId": "s", "type": kind,
            "payload": payload, "issuedAt": 1})
    };
    assert!(
        inbound
            .command(&envelope("sendText", json!({"text": "hi"})))
            .is_ok()
    );
    assert!(
        inbound
            .command(&envelope("sendText", json!({"text": 1})))
            .is_err()
    );
    assert!(
        inbound
            .command(&envelope(
                "sendText",
                json!({"text": "hi", "modelExecution": {"kind": "standard"}})
            ))
            .is_err()
    );
    // CAS 命令要 baseRevision。
    assert!(
        inbound
            .command(&envelope("setFollowupMode", json!({"mode": "queue"})))
            .is_err()
    );
    let mut cas = envelope("setFollowupMode", json!({"mode": "queue"}));
    cas["baseRevision"] = json!(0);
    assert!(inbound.command(&cas).is_ok());
    assert!(
        inbound
            .command(&envelope("noSuchCommand", json!({})))
            .is_err()
    );
}

#[test]
fn reverse_request_replies_follow_the_app_schema() {
    let inbound = Inbound::get();
    let method = "interaction/requestProviderRuntimeHeaders";
    assert!(
        inbound
            .reply(
                method,
                &json!({"headersApplied": true, "requestAuth": {"apiKey": "k"}})
            )
            .is_ok()
    );
    assert!(
        inbound
            .reply(method, &json!({"headersApplied": true}))
            .is_err()
    );
    assert!(
        inbound
            .reply(
                method,
                &json!({"headersApplied": false, "errorMessage": "no"})
            )
            .is_ok()
    );
}
