//! Elicitation 动作的名字（ext.md §3.13.6）。

use super::ElicitationAction;

#[test]
fn actions_use_the_wire_names() {
    assert_eq!(ElicitationAction::Accept.as_str(), "accept");
    assert_eq!(ElicitationAction::Decline.as_str(), "decline");
    assert_eq!(ElicitationAction::Cancel.as_str(), "cancel");
    assert_eq!(
        serde_json::to_string(&ElicitationAction::Decline).unwrap(),
        "\"decline\""
    );
}
