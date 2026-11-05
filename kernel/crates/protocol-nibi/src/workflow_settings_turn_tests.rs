//! 控制轮规范句与元数据的形状（与 Node `buildSettingsMessageText` / `buildLaunchMessageText` /
//! `WorkflowSettingsAmendMeta` 逐句对齐）。

use serde_json::json;

use super::{SettingsTurnText, build_settings_message_text, launch_turn, settings_turn};
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::session_api::Command;
use nibi_kernel_api::workflow::{WorkflowLaunchTurn, WorkflowRunStarted, WorkflowSettingsTurn};

fn amend(model: serde_json::Value, bound: serde_json::Value, predecessor: bool) -> serde_json::Value {
    let mut out = json!({"ceiling": 16});
    if predecessor {
        out["predecessorRunId"] = json!("dwfrun-old");
    }
    if !model.is_null() {
        out["subagentModel"] = model;
    }
    if !bound.is_null() {
        out["maxConcurrency"] = bound;
    }
    out
}

fn text(name: Option<&str>, previous: &str, run_id: &str, superseded: bool, amend: serde_json::Value) -> String {
    build_settings_message_text(SettingsTurnText {
        name,
        previous,
        run_id,
        superseded,
        amend: &amend,
    })
}

#[test]
fn in_place_retune_names_the_bound_and_says_nothing_stopped() {
    let said = text(
        Some("amend"),
        "dwfrun-old",
        "dwfrun-old",
        false,
        amend(json!(null), json!({"to": 2}), false),
    );
    assert_eq!(
        said,
        "Changed the settings of workflow run dwfrun-old (\"amend\") from the GUI: \
         at most 2 of its subagents run at once. \
         Run dwfrun-old keeps running under the new limit; nothing was stopped and no new run was started. \
         Progress and results arrive as background notifications; do not amend, resume or restart it."
    );
}

#[test]
fn in_place_release_back_to_default() {
    let said = text(
        None,
        "dwfrun-old",
        "dwfrun-old",
        false,
        amend(json!(null), json!({"from": 4, "to": serde_json::Value::Null}), false),
    );
    assert!(
        said.contains("the limit on subagents at once is back to the default")
            && said.contains("Run dwfrun-old keeps running with no limit; nothing was stopped"),
        "{said}"
    );
}

#[test]
fn successor_model_change_supersedes_a_live_predecessor() {
    let said = text(
        Some("amend"),
        "dwfrun-old",
        "dwfrun-new",
        true,
        amend(json!({"to": "drive-fake/fake-model-b$enabled"}), json!(null), true),
    );
    assert_eq!(
        said,
        "Changed the settings of workflow run dwfrun-old (\"amend\") from the GUI: \
         its subagents now run on drive-fake/fake-model-b$enabled. \
         The same script continues as run dwfrun-new, which supersedes run dwfrun-old and imports everything run dwfrun-old finished as cache. \
         Progress and results arrive as background notifications; do not amend, resume or restart it."
    );
}

#[test]
fn successor_without_a_live_predecessor_takes_over() {
    let said = text(
        None,
        "dwfrun-old",
        "dwfrun-new",
        false,
        amend(json!({"from": "a/b", "to": serde_json::Value::Null}), json!(null), true),
    );
    assert!(
        said.contains("takes over from run dwfrun-old")
            && said.contains("its subagents are back on the session model"),
        "{said}"
    );
}

#[test]
fn meta_carries_run_id_tool_call_and_name() {
    let session = SessionId::new("sess-1");
    let started = WorkflowRunStarted {
        run_id: "dwfrun-new".to_owned(),
        tool_call_id: "settings-1".to_owned(),
        superseded_run_id: Some("dwfrun-old".to_owned()),
        settings_turn: Some(WorkflowSettingsTurn {
            name: Some("amend".to_owned()),
            amend: amend(
                json!({"to": "drive-fake/fake-model-b$enabled"}),
                json!(null),
                true,
            ),
        }),
        launch_turn: None,
    };
    let (session, command) = settings_turn(&session, "dwfrun-old", &started)
        .expect("the turn material is present");
    assert_eq!(session.as_str(), "sess-1");
    let Command::WorkflowLaunch { text, launch } = command else {
        panic!("expected a WorkflowLaunch command");
    };
    assert!(text.contains("supersedes run dwfrun-old"), "{text}");
    assert_eq!(launch["runId"], "dwfrun-new");
    assert_eq!(launch["toolCallId"], "settings-1");
    assert_eq!(launch["name"], "amend");
    assert_eq!(launch["amend"]["predecessorRunId"], "dwfrun-old");
    assert_eq!(launch["amend"]["ceiling"], 16);
}

#[test]
fn in_place_meta_has_no_predecessor() {
    let session = SessionId::new("sess-1");
    let started = WorkflowRunStarted {
        run_id: "dwfrun-old".to_owned(),
        tool_call_id: "settings-2".to_owned(),
        superseded_run_id: None,
        settings_turn: Some(WorkflowSettingsTurn {
            name: None,
            amend: amend(json!(null), json!({"to": 2}), false),
        }),
        launch_turn: None,
    };
    let (_, command) = settings_turn(&session, "dwfrun-old", &started)
        .expect("the turn material is present");
    let Command::WorkflowLaunch { launch, .. } = command else {
        panic!("expected a WorkflowLaunch command");
    };
    assert!(launch["name"].is_null());
    assert!(launch["amend"]["predecessorRunId"].is_null());
    assert_eq!(launch["amend"]["maxConcurrency"]["to"], 2);
}

#[test]
fn no_material_no_turn() {
    let session = SessionId::new("sess-1");
    let started = WorkflowRunStarted {
        run_id: "dwfrun-new".to_owned(),
        tool_call_id: "call-1".to_owned(),
        superseded_run_id: None,
        settings_turn: None,
        launch_turn: None,
    };
    assert!(settings_turn(&session, "dwfrun-old", &started).is_none());
}

fn launch_started(script: Option<&str>, description: Option<&str>, args: Option<serde_json::Value>) -> WorkflowRunStarted {
    WorkflowRunStarted {
        run_id: "dwfrun-1".to_owned(),
        tool_call_id: "launch-1".to_owned(),
        superseded_run_id: None,
        settings_turn: None,
        launch_turn: Some(WorkflowLaunchTurn {
            name: "amend".to_owned(),
            scope: "project".to_owned(),
            path: Some("D:/repo/.nibi/workflows/amend.dwf.ts".to_owned()),
            description: description.map(str::to_owned),
            args,
            script: script.map(str::to_owned),
        }),
    }
}

#[test]
fn launch_turn_text_and_meta_shape() {
    let (session, command) = launch_turn(
        &SessionId::new("sess-1"),
        &launch_started(Some("const worker = agent();"), Some("amend probe"), None),
    )
    .expect("the launch turn is present");
    assert_eq!(session.as_str(), "sess-1");
    let Command::WorkflowLaunch { text, launch } = command else {
        panic!("expected a WorkflowLaunch command");
    };
    assert_eq!(
        text,
        concat!(
            "Started the saved workflow \"amend\" (project) from the workflows hub as run dwfrun-1.",
            "\n\nProgress and results arrive as background notifications; do not start it again.",
        )
    );
    assert_eq!(launch["runId"], "dwfrun-1");
    assert_eq!(launch["toolCallId"], "launch-1");
    assert_eq!(launch["name"], "amend");
    assert_eq!(launch["scope"], "project");
    assert_eq!(launch["path"], "D:/repo/.nibi/workflows/amend.dwf.ts");
    assert_eq!(launch["description"], "amend probe");
    assert_eq!(launch["script"], "const worker = agent();");
    assert!(launch["args"].is_null());
}

#[test]
fn launch_turn_args_block_and_omission_marker() {
    let (_, command) = launch_turn(
        &SessionId::new("sess-1"),
        &launch_started(None, None, Some(json!({"topic": "math"}))),
    )
    .expect("the launch turn is present");
    let Command::WorkflowLaunch { text, launch } = command else {
        panic!("expected a WorkflowLaunch command");
    };
    assert!(text.contains("Arguments:"), "{text}");
    assert!(text.contains("\"topic\": \"math\""), "{text}");
    assert_eq!(launch["args"]["topic"], "math");
    // 超界的实参袋整体换成标记（真实实参只走模型面的规范句）。
    let (_, command) = launch_turn(
        &SessionId::new("sess-1"),
        &launch_started(None, None, Some(json!({"big": "x".repeat(5_000)}))),
    )
    .expect("the launch turn is present");
    let Command::WorkflowLaunch { launch, .. } = command else {
        panic!("expected a WorkflowLaunch command");
    };
    assert!(launch["args"]["…"].as_str().unwrap().contains("arguments omitted"), "{launch}");
}

#[test]
fn launch_turn_script_over_bound_is_absent() {
    let (_, command) = launch_turn(
        &SessionId::new("sess-1"),
        &launch_started(Some(&"x".repeat(256_001)), None, None),
    )
    .expect("the launch turn is present");
    let Command::WorkflowLaunch { launch, .. } = command else {
        panic!("expected a WorkflowLaunch command");
    };
    assert!(launch["script"].is_null(), "the oversized script must be dropped");
}

#[test]
fn no_launch_material_no_turn() {
    let started = WorkflowRunStarted {
        run_id: "dwfrun-1".to_owned(),
        tool_call_id: "launch-1".to_owned(),
        superseded_run_id: None,
        settings_turn: None,
        launch_turn: None,
    };
    assert!(launch_turn(&SessionId::new("sess-1"), &started).is_none());
}
