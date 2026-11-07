//! `nibi provider` 的参数解析：子命令、选项与错误文本。

use nibi_kernel_api::provider::WireProtocol;

use super::*;

fn args(text: &str) -> Vec<String> {
    text.split_whitespace().map(str::to_owned).collect()
}

#[test]
fn other_commands_are_not_ours() {
    assert_eq!(parse(&args("login")), None);
    assert_eq!(parse(&args("provider")), Some(Err(USAGE.to_owned())));
}

#[test]
fn read_only_subcommands() {
    assert_eq!(
        parse(&args("provider list")),
        Some(Ok(Command::List { json: false }))
    );
    assert_eq!(
        parse(&args("provider list --json")),
        Some(Ok(Command::List { json: true }))
    );
    assert_eq!(
        parse(&args("provider show personal:gateway")),
        Some(Ok(Command::Show {
            id: "personal:gateway".to_owned(),
            json: false
        }))
    );
    assert_eq!(
        parse(&args("provider path")),
        Some(Ok(Command::Path { json: false }))
    );
    assert!(parse(&args("provider list extra")).unwrap().is_err());
}

#[test]
fn add_takes_flags_in_any_order() {
    let parsed = parse(&args(
        "provider add --base-url https://relay.example.com/v1 --name Relay --protocol chat --model a --model b,c",
    ));
    let Some(Ok(Command::Add { options, json })) = parsed else {
        panic!("expected add");
    };
    assert!(!json);
    assert_eq!(options.name, "Relay");
    assert_eq!(options.base_url, "https://relay.example.com/v1");
    assert_eq!(options.protocol, Some(WireProtocol::OpenAiChatCompletions));
    assert_eq!(options.models, vec!["a", "b", "c"]);
    assert!(options.template.is_none());
    assert!(!options.key_stdin);
}

#[test]
fn add_accepts_a_preset_and_stdin_key() {
    let parsed = parse(&args(
        "provider add --name DeepSeek --template deepseek --api-key-stdin --json",
    ));
    let Some(Ok(Command::Add { options, json })) = parsed else {
        panic!("expected add");
    };
    assert!(json);
    assert_eq!(options.template.as_deref(), Some("deepseek"));
    assert!(options.key_stdin);
    assert!(options.models.is_empty());
}

#[test]
fn add_rejects_incomplete_choices() {
    // 没有模板时必须给全 base URL、协议与模型。
    assert!(parse(&args("provider add --name Relay")).unwrap().is_err());
    // 不认识的协议。
    assert!(
        parse(&args(
            "provider add --name R --base-url https://x.test --protocol grpc --model m"
        ))
        .unwrap()
        .is_err()
    );
    // 不认识的旗标。
    assert!(
        parse(&args(
            "provider add --name R --base-url https://x.test --model m --key sk-1"
        ))
        .unwrap()
        .is_err()
    );
}

#[test]
fn key_and_remove_need_an_id() {
    assert!(parse(&args("provider key")).unwrap().is_err());
    assert_eq!(
        parse(&args("provider key personal:x --api-key-stdin")),
        Some(Ok(Command::Key {
            id: "personal:x".to_owned(),
            key_stdin: true,
            json: false
        }))
    );
    assert_eq!(
        parse(&args("provider remove personal:x")),
        Some(Ok(Command::Remove {
            id: "personal:x".to_owned(),
            json: false
        }))
    );
    assert!(
        parse(&args("provider remove personal:x --force"))
            .unwrap()
            .is_err()
    );
}

#[test]
fn protocols_have_short_names() {
    assert_eq!(
        parse_protocol("anthropic"),
        Some(WireProtocol::AnthropicMessages)
    );
    assert_eq!(
        parse_protocol("openai-chat-completions"),
        Some(WireProtocol::OpenAiChatCompletions)
    );
    assert_eq!(
        parse_protocol("responses"),
        Some(WireProtocol::OpenAiResponses)
    );
    assert_eq!(parse_protocol("grpc"), None);
}
