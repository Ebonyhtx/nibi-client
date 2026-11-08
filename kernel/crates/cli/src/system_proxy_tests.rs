//! 系统代理的解析：`ProxyServer` 的三种写法、`ProxyOverride` 与 macOS `scutil` 的转换
//! （纯函数，不读注册表、不跑 scutil）。

use super::*;

#[test]
fn a_plain_host_and_port_becomes_a_http_url() {
    assert_eq!(
        proxy_url("127.0.0.1:7897"),
        Some("http://127.0.0.1:7897".to_owned())
    );
    assert_eq!(
        proxy_url(" http://proxy.example.com:8080 "),
        Some("http://proxy.example.com:8080".to_owned())
    );
}

#[test]
fn per_scheme_servers_prefer_https_then_http() {
    assert_eq!(
        proxy_url("http=127.0.0.1:7890;https=127.0.0.1:7897"),
        Some("http://127.0.0.1:7897".to_owned())
    );
    assert_eq!(
        proxy_url("ftp=1.2.3.4:21;http=127.0.0.1:7890"),
        Some("http://127.0.0.1:7890".to_owned())
    );
    // 只有不认识的协议时没有可用代理。
    assert_eq!(proxy_url("ftp=1.2.3.4:21"), None);
    assert_eq!(proxy_url("  "), None);
}

/// 本机真读一次 HKCU（CI 的 Linux 上没有这个平台分支）：只验证读到的值能解析。
#[cfg(windows)]
#[test]
fn the_live_registry_values_parse() {
    if let Some(found) = super::system_proxy() {
        assert!(
            found.url.contains("://"),
            "proxy url must carry a scheme: {}",
            found.url
        );
        eprintln!("live system proxy: {}", found.url);
    }
}

#[test]
fn overrides_become_no_proxy_rules() {
    assert_eq!(
        no_proxy_from_override("*.example.com;10.*"),
        Some("*.example.com,10.*".to_owned())
    );
    // `<local>` 展开成本机地址，别让本机的 MCP 服务绕进代理。
    assert_eq!(
        no_proxy_from_override("<local>;*.corp"),
        Some("localhost,127.0.0.1,::1,*.corp".to_owned())
    );
    assert_eq!(no_proxy_from_override(" ; "), None);
}

/// `scutil --proxy` 的固定代理：优先 HTTPS，端口缺省按协议补 443 / 80。
#[test]
fn scutil_prefers_https_then_http() {
    let both = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  HTTPProxy : 127.0.0.1\n  \
                HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 10.0.0.2\n}\n";
    assert_eq!(
        parse_scutil(both).url,
        Some("http://10.0.0.2:7897".to_owned())
    );
    let http_only = "<dictionary> {\n  HTTPEnable : 1\n  HTTPProxy : 192.168.1.9\n}\n";
    assert_eq!(
        parse_scutil(http_only).url,
        Some("http://192.168.1.9:80".to_owned())
    );
    // HTTPS 开着但没有主机：退回 HTTP（Node 的 `&& httpsHost` 同一判据）。
    let empty_https = "<dictionary> {\n  HTTPEnable : 1\n  HTTPPort : 7890\n  \
                        HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n}\n";
    assert_eq!(
        parse_scutil(empty_https).url,
        Some("http://127.0.0.1:7890".to_owned())
    );
}

/// 关掉的代理、只有 PAC 的配置都当作没有固定代理。
#[test]
fn a_disabled_or_pac_only_proxy_has_no_url() {
    let disabled = "<dictionary> {\n  HTTPEnable : 0\n  HTTPSEnable : 0\n  \
                    HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7897\n}\n";
    assert_eq!(parse_scutil(disabled).url, None);
    let pac = "<dictionary> {\n  ProxyAutoConfigEnable : 1\n  \
               ProxyAutoConfigURLString : http://wpad/wpad.dat\n}\n";
    assert_eq!(parse_scutil(pac).url, None);
    assert_eq!(parse_scutil("").url, None);
}

/// `ExceptionsList` 转成标准 no_proxy：本机三项固定在最前，`*.x` 去星号，CIDR 跳过。
#[test]
fn scutil_exceptions_become_no_proxy_rules() {
    let output = "<dictionary> {\n  ExceptionsList : <array> {\n    0 : *.local\n    1 : 169.254/16\n   \
                  2 : *.corp\n    3 : localhost\n  }\n  HTTPSEnable : 1\n  \
                  HTTPSProxy : 127.0.0.1\n  HTTPSPort : 7897\n}\n";
    let parsed = parse_scutil(output);
    assert_eq!(parsed.exceptions, ["*.local", "169.254/16", "*.corp", "localhost"]);
    assert_eq!(
        no_proxy_from_exceptions(&parsed.exceptions),
        "localhost,127.0.0.1,::1,.local,.corp"
    );
    // 没有忽略列表时也有本机三项（MCP 服务在本机）。
    assert_eq!(
        no_proxy_from_exceptions(&[]),
        "localhost,127.0.0.1,::1".to_owned()
    );
}

/// 本机真跑一次 `scutil --proxy`（CI 的非 macOS 机器上没有这个平台分支）：只验证读到的值能解析。
#[cfg(target_os = "macos")]
#[test]
fn the_live_scutil_proxy_parses() {
    if let Some(found) = super::system_proxy() {
        assert!(
            found.url.contains("://"),
            "proxy url must carry a scheme: {}",
            found.url
        );
        assert!(found.no_proxy.is_some());
        eprintln!("live system proxy: {}", found.url);
    }
}
