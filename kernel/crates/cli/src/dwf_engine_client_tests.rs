//! `NIBI_DWF_ENGINE_CMD` 的解析（桌面是 Electron Helper + `nibi.cjs`，开发是 node/tsx）。

use super::SidecarCommand;

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
