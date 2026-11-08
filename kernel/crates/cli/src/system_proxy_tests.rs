//! 系统代理的解析：`ProxyServer` 的三种写法与 `ProxyOverride` 的转换（纯函数，不读注册表）。

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
