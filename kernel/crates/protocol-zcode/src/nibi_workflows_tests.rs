//! 中枢参数校验的单元测试：写面（save/updateMeta/delete/move）与读面共用的严格入参
//! ——`.strict()` 未知键、`nonEmptyString` 的 trim 转换、meta/args 的形状。方法级的端到端
//! 行为在 `check-dwf-engine.mjs` 的 112 字段双内核对拍里，这里只钉纯函数。

use serde_json::json;

use super::*;

fn invalid_message<T>(result: Result<T, RpcError>) -> String {
    match result {
        Ok(_) => panic!("expected an invalid-params error"),
        Err(error) => {
            assert_eq!(error.code, -32602, "validation failures are -32602");
            error.message
        }
    }
}

#[test]
fn non_empty_strings_trim_like_the_node_transform() {
    // `nonEmptyString` 是 `z.string().trim().min(1)`：trim 是转换的一部分——Node 的
    // parseParams 把 `" foo "` 解析成 `"foo"`，写面拿名字拼文件名，不照做就写出第二个名字。
    assert_eq!(required_non_empty(&json!(" foo "), "x").unwrap(), "foo");
    assert_eq!(
        required_non_empty(&json!("  spaced  "), "x").unwrap(),
        "spaced"
    );
    invalid_message(required_non_empty(&json!("   "), "x"));
    invalid_message(required_non_empty(&json!(""), "x"));
    invalid_message(required_non_empty(&json!(null), "x"));
    invalid_message(required_non_empty(&json!(7), "x"));
}

#[test]
fn optional_non_empty_rejects_null_and_blank() {
    // zod `.optional()` 只放行缺席与合法值：显式 null、空串、空白串都不在契约里。
    let params = json!({}).as_object().unwrap().clone();
    assert_eq!(optional_non_empty_string_of(&params, "name", "x").unwrap(), None);
    let params = json!({ "name": " n " }).as_object().unwrap().clone();
    assert_eq!(
        optional_non_empty_string_of(&params, "name", "x").unwrap(),
        Some("n".to_owned())
    );
    for bad in [json!(null), json!(""), json!("  "), json!(true)] {
        let params = json!({ "name": bad }).as_object().unwrap().clone();
        invalid_message(optional_non_empty_string_of(&params, "name", "x"));
    }
}

#[test]
fn top_level_unknown_keys_are_rejected_like_strict_zod() {
    let params = json!({ "workspace": {}, "limit": 5, "bogus": 1 })
        .as_object()
        .unwrap()
        .clone();
    let message = invalid_message(
        strict_keys(&params, &["workspace", "limit"]),
    );
    assert!(message.contains("bogus"), "the message names the key: {message}");
    // 已知键集合内的调用照常通过。
    strict_keys(&params, &["workspace", "limit", "bogus"]).unwrap();
}

#[test]
fn workspace_ref_validates_both_required_keys_and_unknown_ones() {
    // workspace_path_of 读的是顶层 params 的 `workspace` 键。
    let ok = json!({ "workspace": { "workspacePath": " D:/proj ", "workspaceKey": "k" } })
        .as_object()
        .unwrap()
        .clone();
    assert_eq!(workspace_path_of(&ok).unwrap(), "D:/proj");
    // workspaceIdentity / remoteSessionId 是 optional 的非空字符串。
    let with_optional =
        json!({ "workspace": { "workspacePath": "p", "workspaceKey": "k", "workspaceIdentity": "i" } })
            .as_object()
            .unwrap()
            .clone();
    workspace_path_of(&with_optional).unwrap();
    for missing in ["workspacePath", "workspaceKey"] {
        let mut broken = ok.clone();
        broken["workspace"].as_object_mut().unwrap().remove(missing);
        invalid_message(workspace_path_of(&broken));
    }
    let unknown =
        json!({ "workspace": { "workspacePath": "p", "workspaceKey": "k", "nope": 1 } })
            .as_object()
            .unwrap()
            .clone();
    invalid_message(workspace_path_of(&unknown));
    let not_object = json!({ "workspace": "p" }).as_object().unwrap().clone();
    invalid_message(workspace_path_of(&not_object));
    let absent = json!({}).as_object().unwrap().clone();
    invalid_message(workspace_path_of(&absent));
}

#[test]
fn meta_takes_description_when_to_use_and_args() {
    let params = json!({
        "meta": {
            "description": "  Saves the day  ",
            "whenToUse": "when needed",
            "args": {
                "pr": { "type": "string", "required": true, "default": "main", "description": "branch" },
                "n": { "type": "number" },
            },
        },
    })
    .as_object()
    .unwrap()
    .clone();
    let meta = meta_of(&params).unwrap();
    assert_eq!(meta["description"], "Saves the day");
    assert_eq!(meta["whenToUse"], "when needed");
    assert_eq!(meta["args"]["pr"]["type"], "string");
    // `default` 刻意 unknown：任何 JSON 值都原样通过。
    assert_eq!(meta["args"]["pr"]["default"], "main");
    assert_eq!(meta["args"]["n"]["type"], "number");
    // 只有 description 也成立。
    let minimal = json!({ "meta": { "description": "d" } })
        .as_object()
        .unwrap()
        .clone();
    meta_of(&minimal).unwrap();
}

#[test]
fn meta_rejects_unknown_keys_and_missing_description() {
    let unknown = json!({ "meta": { "description": "d", "bogus": 1 } })
        .as_object()
        .unwrap()
        .clone();
    let message = invalid_message(meta_of(&unknown));
    assert!(message.contains("bogus"), "{message}");
    let missing = json!({ "meta": { "whenToUse": "w" } })
        .as_object()
        .unwrap()
        .clone();
    invalid_message(meta_of(&missing));
    let empty = json!({ "meta": { "description": "  " } })
        .as_object()
        .unwrap()
        .clone();
    invalid_message(meta_of(&empty));
    let not_object = json!({ "meta": "d" }).as_object().unwrap().clone();
    invalid_message(meta_of(&not_object));
    let absent = json!({}).as_object().unwrap().clone();
    invalid_message(meta_of(&absent));
}

#[test]
fn meta_args_declarations_strictly_shape_each_entry() {
    let bad_type = json!({ "meta": { "description": "d", "args": { "a": { "type": "list" } } } })
        .as_object()
        .unwrap()
        .clone();
    invalid_message(meta_of(&bad_type));
    let missing_type = json!({ "meta": { "description": "d", "args": { "a": { "required": true } } } })
        .as_object()
        .unwrap()
        .clone();
    invalid_message(meta_of(&missing_type));
    let unknown_key =
        json!({ "meta": { "description": "d", "args": { "a": { "type": "string", "nope": 1 } } } })
            .as_object()
            .unwrap()
            .clone();
    invalid_message(meta_of(&unknown_key));
    let bad_description =
        json!({ "meta": { "description": "d", "args": { "a": { "type": "string", "description": 3 } } } })
            .as_object()
            .unwrap()
            .clone();
    invalid_message(meta_of(&bad_description));
    let bad_required =
        json!({ "meta": { "description": "d", "args": { "a": { "type": "string", "required": "yes" } } } })
            .as_object()
            .unwrap()
            .clone();
    invalid_message(meta_of(&bad_required));
    // args 本身不是对象也炸。
    let not_object = json!({ "meta": { "description": "d", "args": [] } })
        .as_object()
        .unwrap()
        .clone();
    invalid_message(meta_of(&not_object));
}

#[test]
fn scope_defaults_to_project_and_takes_both_values() {
    let absent = json!({}).as_object().unwrap().clone();
    assert_eq!(scope_of(&absent).unwrap(), "project");
    for scope in ["project", "global"] {
        let params = json!({ "scope": scope }).as_object().unwrap().clone();
        assert_eq!(scope_of(&params).unwrap(), scope);
    }
    for bad in [json!("both"), json!(null), json!(1)] {
        let params = json!({ "scope": bad }).as_object().unwrap().clone();
        invalid_message(scope_of(&params));
    }
}
