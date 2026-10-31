//! `NIBI_DWF_ENGINE_CMD` 的解析（桌面是 Electron Helper + `nibi.cjs`，开发是 node/tsx）与
//! 脚本点名模型的目录解析（launch.md「`subagent_model` resolves by specificity」）。

use super::{SidecarCommand, resolve_model_reference};
use rust_cli_kernel_api::model::ModelSelection;
use rust_cli_kernel_api::provider::{CatalogModel, ModelCatalog, WireProtocol};

fn catalog(entries: &[(&str, &str, &[&str])], default: Option<(&str, &str)>) -> ModelCatalog {
    ModelCatalog {
        revision: 1,
        models: entries
            .iter()
            .map(|(provider, model, levels)| CatalogModel {
                provider: (*provider).to_owned(),
                provider_name: (*provider).to_owned(),
                model: (*model).to_owned(),
                protocol: WireProtocol::OpenAiChatCompletions,
                reasoning_levels: levels.iter().map(|level| (*level).to_owned()).collect(),
                context_window: 200_000,
                max_output_tokens: 128_000,
                capabilities: Default::default(),
                connection: None,
            })
            .collect(),
        default: default.map(|(provider, model)| ModelSelection {
            provider: provider.to_owned(),
            model: model.to_owned(),
            reasoning: None,
            connection: None,
        }),
    }
}

#[test]
fn the_reference_resolves_by_specificity() {
    let table = catalog(
        &[("drive-fake", "fake-model", &["disabled", "enabled"]), ("drive-fake", "fake-model-b", &["disabled", "enabled"])],
        Some(("drive-fake", "fake-model")),
    );
    // 全称精确命中（档位原样，注册表拼写胜出大小写）。
    assert_eq!(
        resolve_model_reference(&table, "drive-fake/fake-model-b$enabled").unwrap(),
        "drive-fake/fake-model-b$enabled"
    );
    // 裸名落在目录默认选择的 provider 下；缺席档位取默认档（最后一个）。
    assert_eq!(
        resolve_model_reference(&table, "FAKE-MODEL-B").unwrap(),
        "drive-fake/fake-model-b$enabled"
    );
    // 没有档位的模型不带 $。
    let plain = catalog(&[("drive-fake", "fake-model", &[])], Some(("drive-fake", "fake-model")));
    assert_eq!(resolve_model_reference(&plain, "fake-model").unwrap(), "drive-fake/fake-model");
}

#[test]
fn the_reference_refuses_to_cross_providers_and_bad_levels() {
    let table = catalog(
        &[
            ("drive-fake", "fake-model", &["disabled", "enabled"]),
            ("other", "fake-model-b", &[]),
        ],
        Some(("drive-fake", "fake-model")),
    );
    // 裸名只在别的 provider 下有：不替用户跨账单。
    let error = resolve_model_reference(&table, "fake-model-b").unwrap_err();
    assert!(error.contains("other providers") && error.contains("other/fake-model-b"), "{error}");
    // 全称可以。
    assert_eq!(
        resolve_model_reference(&table, "other/fake-model-b").unwrap(),
        "other/fake-model-b"
    );
    // 档位不存在：报合法档位。
    let error = resolve_model_reference(&table, "drive-fake/fake-model$high").unwrap_err();
    assert!(error.contains("`high`") && error.contains("disabled, enabled"), "{error}");
    // 找不到：候选清单里有全称。
    let error = resolve_model_reference(&table, "no-such-model").unwrap_err();
    assert!(error.contains("drive-fake/fake-model"), "{error}");
}

#[test]
fn ambiguous_bare_names_fail_without_a_default_anchor() {
    let table = catalog(
        &[("drive-fake", "fake-model", &[]), ("other", "fake-model", &[])],
        None,
    );
    let error = resolve_model_reference(&table, "fake-model").unwrap_err();
    assert!(error.contains("ambiguous"), "{error}");
}

#[test]
fn the_launch_command_parses_the_json_shape() {
    let command = SidecarCommand::parse(
        r#"{"command":"C:/Program Files/NIBI/NIBI Helper.exe","args":["C:/NIBI/nibi.cjs","__nibi-dwf-engine"],"env":{"ELECTRON_RUN_AS_NODE":"1"}}"#,
    )
    .unwrap();
    assert_eq!(command.command, "C:/Program Files/NIBI/NIBI Helper.exe");
    assert_eq!(
        command.args,
        ["C:/NIBI/nibi.cjs", "__nibi-dwf-engine"]
    );
    assert_eq!(
        command.env,
        [("ELECTRON_RUN_AS_NODE".to_owned(), "1".to_owned())]
    );

    let minimal = SidecarCommand::parse(r#"{"command":"node"}"#).unwrap();
    assert!(minimal.args.is_empty() && minimal.env.is_empty());
}

#[test]
fn an_invalid_launch_command_is_a_named_error() {
    assert!(
        SidecarCommand::parse("not json")
            .unwrap_err()
            .contains("expected")
    );
    assert!(
        SidecarCommand::parse(r#"{"args":[]}"#)
            .unwrap_err()
            .contains("command")
    );
}
