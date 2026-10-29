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
    let current = cas_check_with_epoch("c1", Some(7), None, 7, "epoch-1", false);
    assert!(current.is_none());
    let stale = cas_check_with_epoch("c1", Some(6), None, 7, "epoch-1", false).unwrap();
    assert_eq!(stale.status, Status::Stale);
    assert_eq!(stale.reason_code.as_deref(), Some("proto.staleRevision"));
    assert_eq!(stale.revision_at_decision, 7);
    // 缺 baseRevision 的命令在 schema 层就被拒；这里双保险同样按 stale 处理。
    let missing = cas_check_with_epoch("c1", None, None, 7, "epoch-1", false).unwrap();
    assert_eq!(missing.status, Status::Stale);
}

#[test]
fn cas_check_rejects_epoch_mismatch_only_for_row_targeting() {
    // revision 对、epoch 错：compare_epoch=true 才拒。
    let ok = cas_check_with_epoch("c1", Some(7), Some("epoch-1"), 7, "epoch-1", true);
    assert!(ok.is_none());
    let stale_epoch =
        cas_check_with_epoch("c1", Some(7), Some("epoch-0"), 7, "epoch-1", true).unwrap();
    assert_eq!(stale_epoch.status, Status::Stale);
    assert_eq!(
        stale_epoch.reason_code.as_deref(),
        Some("proto.staleLogEpoch")
    );
    // 同样的 epoch 错，在非 row-targeting 命令上不比。
    let ignored = cas_check_with_epoch("c1", Some(7), Some("epoch-0"), 7, "epoch-1", false);
    assert!(ignored.is_none());
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
