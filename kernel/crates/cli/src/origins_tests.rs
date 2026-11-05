//! 账号服务地址的解析与 Node 相同（`resolveRuntimeZCodeEndpointOrigin`、`resolveBigModelApiOrigin`）。

use super::*;

fn origins(pairs: &[(&str, &str)]) -> Result<AccountOrigins, String> {
    account_origins(
        |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        },
        "0.1.0",
    )
}

#[test]
fn production_defaults() {
    let origins = origins(&[]).unwrap();
    // Node `DEFAULT_NIBI_ENDPOINT_ORIGIN`：NIBI 自己的服务，不是上游。
    assert_eq!(origins.zcode_api, "https://api.nibistudio.top/api/v1");
    assert_eq!(origins.zai_api, "https://api.z.ai");
    assert_eq!(origins.bigmodel_api, "https://bigmodel.cn");
    assert_eq!(origins.client_version, "0.1.0");
}

#[test]
fn environment_overrides_follow_node() {
    let test = origins(&[("NIBI_ENV", "TEST")]).unwrap();
    // Node `TEST_NIBI_ENDPOINT_ORIGIN`（上游的技术端点）与 Node 一致。
    assert_eq!(test.zcode_api, "https://zcode.z.ai/api/v1");
    assert_eq!(test.bigmodel_api, "https://bigmodel.cn");
    // Z.ai 业务地址按 App 的 resolveZaiBusinessBaseUrl（工作线 F47）。
    assert_eq!(test.zai_api, "https://api.z.ai");
    let zai = origins(&[
        (
            "ZAI_PRODUCTION_BUSINESS_BASE_URL",
            "https://zai.example.com/x",
        ),
        ("ZAI_TEST_BUSINESS_BASE_URL", "https://zai-test.example.com"),
    ])
    .unwrap();
    assert_eq!(zai.zai_api, "https://zai.example.com");
    let zai = origins(&[
        ("NIBI_ENV", "test"),
        ("ZAI_BUSINESS_BASE_URL", "http://127.0.0.1:9000/"),
        ("ZAI_TEST_BUSINESS_BASE_URL", "https://zai-test.example.com"),
    ])
    .unwrap();
    assert_eq!(zai.zai_api, "http://127.0.0.1:9000");
    assert!(origins(&[("ZAI_BUSINESS_BASE_URL", "not a url")]).is_err());
    // 通用覆盖优先于分环境覆盖；只取 origin。
    let overridden = origins(&[
        ("NIBI_PRODUCTION_BASE_URL", "https://prod.example.com"),
        ("NIBI_ENDPOINT_ORIGIN", "http://127.0.0.1:8080/path"),
        (
            "BIGMODEL_PRODUCTION_API_BASE_URL",
            "https://big.example.com/x",
        ),
    ])
    .unwrap();
    assert_eq!(overridden.zcode_api, "http://127.0.0.1:8080/api/v1");
    assert_eq!(overridden.bigmodel_api, "https://big.example.com");
    // 测试环境不看生产环境的变量。
    let scoped = origins(&[
        ("NIBI_ENV", "test"),
        ("NIBI_PRODUCTION_BASE_URL", "https://prod.example.com"),
        ("BIGMODEL_TEST_API_BASE_URL", "https://dev.example.com"),
    ])
    .unwrap();
    assert_eq!(scoped.zcode_api, "https://zcode.z.ai/api/v1");
    assert_eq!(scoped.bigmodel_api, "https://dev.example.com");
    assert!(origins(&[("NIBI_BASE_URL", "ftp://example.com")]).is_err());
}

/// 端点变量按 Node 的优先级取第一个；测试档不看生产变量。
#[test]
fn the_endpoint_variables_follow_node_precedence() {
    let both = origins(&[
        ("NIBI_ENDPOINT_ORIGIN", "https://origin.example.com"),
        ("NIBI_BASE_URL", "https://base.example.com"),
    ])
    .unwrap();
    assert_eq!(both.zcode_api, "https://base.example.com/api/v1");
    let scoped = origins(&[
        ("NIBI_ENV", "test"),
        ("NIBI_TEST_BASE_URL", "https://test.example.com/x"),
    ])
    .unwrap();
    assert_eq!(scoped.zcode_api, "https://test.example.com/api/v1");
    let production_ignored = origins(&[
        ("NIBI_ENV", "test"),
        ("NIBI_PRODUCTION_BASE_URL", "https://prod.example.com"),
    ])
    .unwrap();
    assert_eq!(
        production_ignored.zcode_api,
        "https://zcode.z.ai/api/v1"
    );
    assert!(origins(&[("NIBI_BASE_URL", "ftp://example.com")]).is_err());
}

/// 团队套餐的管理页照 App（修复线 F58）：z.ai 写死（App 没有测试环境的变体）；BigModel 只看 `NIBI_ENV`
/// （App `buildBigModelCodingPlanTeamManageUrl({ NIBI_ENV })`），不跟随 `BIGMODEL_*` 的覆盖。以前 BigModel 的链接
/// 从账号地址拼，设了覆盖变量时跟着变。
#[test]
fn team_manage_pages_follow_the_app() {
    let production = origins(&[("BIGMODEL_API_BASE_URL", "https://big.example.com")]).unwrap();
    assert_eq!(
        production.bigmodel_team_plans,
        "https://bigmodel.cn/coding-plan/team/plans"
    );
    let test = origins(&[
        ("NIBI_ENV", "test"),
        ("BIGMODEL_TEST_API_BASE_URL", "https://dev.example.com"),
    ])
    .unwrap();
    assert_eq!(
        test.bigmodel_team_plans,
        "https://bigmodel.cn/coding-plan/team/plans"
    );
}
