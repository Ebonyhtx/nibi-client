//! `v4/telemetry/local-ttft` 的线上形状：`instanceId` 与时间戳是驼峰，可选字段缺席不写。
//! Host 的 schema 是 strict，多写一个键整条事实会被丢弃。

use serde_json::json;

use super::*;

fn facts() -> LocalTtftFacts {
    LocalTtftFacts {
        version: 1,
        observation_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301".to_owned(),
        instance_id: "cli-1".to_owned(),
        command_id: "c1".to_owned(),
        session_id: Some("s1".to_owned()),
        turn_id: None,
        product_turn_id: None,
        query_id: None,
        request_id: None,
        logical_call_id: None,
        cli_version: None,
        provider: None,
        model: None,
        revision: Some(2),
        send_mode: Some("idle".to_owned()),
        received_at: 1_000,
        admitted_at: Some(1_010),
        execution_at: None,
        request_at: None,
        output_at: None,
        output_kind: None,
        terminal: None,
        excluded: None,
        truncated: None,
        clock_invalid: None,
    }
}

#[test]
fn the_shape_is_camel_case_and_skips_absent_fields() {
    let value = serde_json::to_value(facts()).expect("serializable");
    assert_eq!(value["observationId"], "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
    assert_eq!(value["instanceId"], "cli-1");
    assert_eq!(value["commandId"], "c1");
    assert_eq!(value["receivedAt"], 1_000);
    assert_eq!(value["admittedAt"], 1_010);
    assert_eq!(value["revision"], 2);
    for absent in [
        "turnId",
        "productTurnId",
        "queryId",
        "requestId",
        "logicalCallId",
        "provider",
        "model",
        "executionAt",
        "requestAt",
        "outputAt",
        "outputKind",
        "terminal",
        "excluded",
        "truncated",
        "clockInvalid",
    ] {
        assert!(value.get(absent).is_none(), "{absent} must stay absent");
    }
}

#[test]
fn facts_round_trip() {
    let fact = facts();
    let back: LocalTtftFacts = serde_json::from_value(json!(fact.clone())).expect("round trip");
    assert_eq!(back, fact);
}

#[test]
fn the_observation_context_rejects_unknown_keys() {
    let context: LocalTtftContext =
        serde_json::from_value(json!({"version": 1, "observationId": "obs"})).expect("parsed");
    assert_eq!(context.observation_id, "obs");
    assert!(
        serde_json::from_value::<LocalTtftContext>(
            json!({"version": 1, "observationId": "obs", "extra": true})
        )
        .is_err()
    );
}
