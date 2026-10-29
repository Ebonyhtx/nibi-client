use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::permission::PermissionMode;
use serde_json::json;

use super::*;

fn selection(provider: &str, model: &str, reasoning: Option<&str>) -> ModelSelection {
    ModelSelection {
        provider: provider.to_owned(),
        model: model.to_owned(),
        reasoning: reasoning.map(str::to_owned),
        connection: None,
    }
}

#[test]
fn cas_check_only_fires_on_revision_mismatch() {
    let current = cas_check("c1", Some(7), 7);
    assert!(current.is_none());
    let stale = cas_check("c1", Some(6), 7).unwrap();
    assert_eq!(stale.status, Status::Stale);
    assert_eq!(stale.reason_code.as_deref(), Some("proto.staleRevision"));
    assert_eq!(stale.revision_at_decision, 7);
    // 缺 baseRevision 的命令在 schema 层就被拒；这里双保险同样按 stale 处理。
    let missing = cas_check("c1", None, 7).unwrap();
    assert_eq!(missing.status, Status::Stale);
}

#[test]
fn model_config_selection_maps_the_flat_nibi_payload() {
    let chosen = model_config_selection(&json!({
        "provider": "zai-standard-api",
        "model": "glm-5.3-flash",
        "thought": "max"
    }))
    .unwrap();
    assert_eq!(
        chosen,
        selection("zai-standard-api", "glm-5.3-flash", Some("max"))
    );

    // schema 要求 thought 必带；处理器对缺省保持宽容（reasoning=None，同上游 selection()），
    // 类型错了仍然 None。
    assert_eq!(
        model_config_selection(&json!({"provider": "p", "model": "m"})),
        Some(selection("p", "m", None))
    );
    assert!(
        model_config_selection(&json!({"provider": 1, "model": "m", "thought": "max"})).is_none()
    );
}

#[test]
fn collaboration_mode_reuses_the_send_text_mapping() {
    assert_eq!(
        mode(&json!("plan"), None),
        Some((PermissionMode::Default, true))
    );
    assert_eq!(
        mode(&json!("yolo"), None),
        Some((PermissionMode::BypassPermissions, false))
    );
    assert_eq!(mode(&json!("stealth"), None), None);
}
