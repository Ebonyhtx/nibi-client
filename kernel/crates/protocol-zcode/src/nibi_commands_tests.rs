use serde_json::json;

use super::*;

fn envelope(kind: &str, payload: Value) -> Value {
    json!({
        "commandId": "0197c8d2-7f2a-7c3e-9f0b-3f7d1e2a4b5c",
        "clientId": "desktop",
        "sessionId": "sess_contract_test",
        "type": kind,
        "payload": payload,
        "issuedAt": 1
    })
}

fn contract() -> &'static NibiCommands {
    NibiCommands::get()
}

#[test]
fn all_34_commands_compile_with_the_nibi_cas_sets() {
    let contract = contract();
    assert_eq!(contract.commands.len(), 34);
    assert_eq!(
        contract
            .commands
            .keys()
            .filter(|kind| contract.requires_revision.contains(*kind))
            .count(),
        15
    );
    assert_eq!(
        contract
            .commands
            .keys()
            .filter(|kind| contract.requires_epoch.contains(*kind))
            .count(),
        5
    );
    for kind in [
        "forkAssistant",
        "applyFileRewind",
        "editUserQuery",
        "retryTurn",
        "setAssistantFeedback",
    ] {
        assert!(
            contract.requires_revision.contains(kind) && contract.requires_epoch.contains(kind),
            "{kind}"
        );
    }
    for kind in [
        "sendQueuedNow",
        "editQueueItem",
        "reorderQueueItem",
        "deleteQueueItem",
        "setAutoDrain",
        "switchModelConfig",
        "switchCollaborationMode",
        "setFollowupMode",
        "pauseGoal",
        "resumeGoal",
    ] {
        assert!(
            contract.requires_revision.contains(kind) && !contract.requires_epoch.contains(kind),
            "{kind}"
        );
    }
    // 上游多出的命令不在 NIBI 协议面里。
    assert!(!contract.commands.contains_key("setHighspeedMetrics"));
    assert!(
        contract
            .validate(&envelope("setHighspeedMetrics", json!({})))
            .unwrap_err()
            .contains("unknown command type")
    );
}

#[test]
fn create_session_accepts_every_nibi_field() {
    let contract = contract();
    let payload = json!({
        "sessionId": "sess_new",
        "workspaceId": "w1",
        "additionalDirectories": ["/tmp/extra"],
        "permissionScope": "session",
        "config": {
            "modelSelection": {"providerId": "provider", "modelId": "model"},
            "provider": "provider",
            "model": "model",
            "thought": "max",
            "followupMode": "queue",
            "mode": "yolo",
            "planEnabled": false
        },
        "mcpServers": [
            {"name": "srv", "command": "cmd", "args": [], "env": [{"name": "K", "value": "V"}]}
        ],
        "dynamicWorkflowEnabled": true,
        "dynamicWorkflowMode": "onDemand",
        "firstInput": {
            "text": "hello",
            "attachments": [
                {"ref": "att1", "fileName": "a.png", "mime": "image/png", "bytes": 12}
            ],
            "modelSelection": {"providerId": "provider", "modelId": "model"},
            "mode": "build",
            "planEnabled": false
        }
    });
    contract
        .validate(&envelope("createSession", payload.clone()))
        .unwrap();
    let unsupported = NibiCommands::unsupported_create_session_fields(&payload);
    assert_eq!(
        unsupported.len(),
        CREATE_SESSION_FIELDS_NOT_YET_CONSUMED.len()
    );
    // 已消费的不再上报（config.provider/model/thought 2026-10-30 起作选择回落；
    // firstInput.mode/planEnabled 由 input_meta 捕获）。
    assert!(!unsupported.contains(&"config.provider"));
    assert!(!unsupported.contains(&"config.model"));
    assert!(!unsupported.contains(&"config.thought"));
    assert!(!unsupported.contains(&"firstInput.mode"));
    assert!(!unsupported.contains(&"firstInput.planEnabled"));
    // 仍未消费的继续点名。
    assert!(unsupported.contains(&"mcpServers"));
    assert!(unsupported.contains(&"additionalDirectories"));
    assert!(!unsupported.contains(&"permissionScope"));
    assert!(unsupported.contains(&"dynamicWorkflowEnabled"));
    assert!(unsupported.contains(&"dynamicWorkflowMode"));
    assert!(unsupported.contains(&"firstInput.attachments"));
}

#[test]
fn create_session_rejects_removed_off_peak_field() {
    let error = contract()
        .validate(&envelope(
            "createSession",
            json!({"workspaceId": "w1", "offPeakToolEnabled": true}),
        ))
        .unwrap_err();
    assert!(error.contains("removed NIBI fields"), "{error}");
}

#[test]
fn cas_commands_require_revision_and_row_targeting_requires_epoch() {
    let contract = contract();
    let target = json!({"rowId": 3, "entityId": "row_entity_1"});
    let missing = contract
        .validate(&envelope("forkAssistant", json!({"target": target})))
        .unwrap_err();
    assert!(missing.contains("CAS commands require"), "{missing}");

    let mut revision_only = envelope("forkAssistant", json!({"target": &target}));
    revision_only["baseRevision"] = json!(7);
    let error = contract.validate(&revision_only).unwrap_err();
    assert!(error.contains("CAS commands require"), "{error}");

    let mut both = envelope("forkAssistant", json!({"target": target}));
    both["baseRevision"] = json!(7);
    both["baseLogEpoch"] = json!("epoch-2");
    contract.validate(&both).unwrap();

    // 非 row-targeting 的 CAS 命令不需要 epoch。
    let mut followup = envelope("setFollowupMode", json!({"mode": "queue"}));
    followup["baseRevision"] = json!(0);
    contract.validate(&followup).unwrap();
}

#[test]
fn model_execution_requires_model_selection() {
    let contract = contract();
    let execution = json!({"selectionScope": "execution"});
    for kind in ["sendText", "editUserQuery", "sendQueuedNow"] {
        let payload = if kind == "sendText" {
            json!({"text": "hi", "modelExecution": execution})
        } else if kind == "editUserQuery" {
            json!({"target": {"rowId": 1, "entityId": "row_entity_1"}, "newText": "hi", "modelExecution": execution})
        } else {
            json!({"queueItemId": "q1", "modelExecution": execution})
        };
        let mut envelope = envelope(kind, payload);
        if contract.requires_revision.contains(kind) {
            envelope["baseRevision"] = json!(0);
        }
        if contract.requires_epoch.contains(kind) {
            envelope["baseLogEpoch"] = json!("epoch-1");
        }
        let error = contract.validate(&envelope).unwrap_err();
        assert!(
            error.contains("modelExecution requires modelSelection"),
            "{kind}: {error}"
        );
    }
}

#[test]
fn send_text_rejects_removed_off_peak_and_highspeed_fields() {
    let contract = contract();
    for field in ["offPeakTaskId", "offPeakRunType", "highspeedMeta"] {
        let error = contract
            .validate(&envelope("sendText", json!({"text": "hi", field: "x"})))
            .unwrap_err();
        assert!(error.contains("removed NIBI fields"), "{field}: {error}");
    }
}

#[test]
fn envelope_fields_are_validated() {
    let contract = contract();
    let mut missing_client = envelope("stop", json!({}));
    missing_client["clientId"] = json!("");
    assert!(contract.validate(&missing_client).is_err());

    let mut null_session = envelope("stop", json!({}));
    null_session["sessionId"] = Value::Null;
    // createSession 允许 null；其他命令的 sessionId 规则由 handler 判，契约只查类型。
    contract.validate(&null_session).unwrap();

    let mut bad_revision = envelope("setFollowupMode", json!({"mode": "queue"}));
    bad_revision["baseRevision"] = json!("7");
    assert!(contract.validate(&bad_revision).is_err());

    let mut bad_epoch = envelope(
        "forkAssistant",
        json!({"target": {"rowId": 1, "entityId": "e"}}),
    );
    bad_epoch["baseRevision"] = json!(1);
    bad_epoch["baseLogEpoch"] = json!("  ");
    assert!(contract.validate(&bad_epoch).is_err());
}
