//! 系统代理（Windows「Internet 选项 → 局域网设置」/ macOS 网络代理）的读取：环境变量一个都没给代理时用它。
//!
//! 只设了系统代理（Clash / v2rayN / Surge 的常见形态）时，CLI 以前会直连，模型接口与
//! `/api/v1/licenses/check` 被重置，表现为「会员状态无法同步」。出口顺序因此是：
//! 显式变量（`NIBI_HTTP_PROXY` / `https_proxy` …）> 系统代理 > 直连。
//!
//! - Windows：读 `HKCU\…\Internet Settings` 的 `ProxyEnable`、`ProxyServer`、`ProxyOverride`；
//! - macOS：读 `scutil --proxy`（与「系统设置 → 网络 → 代理」同一份），`ExceptionsList` 转 no_proxy；
//! - 其它平台：没有（Linux 的代理由环境变量表达，`network.rs` 的显式变量已经读过）。
//!
//! 只读，不写任何东西；读不到时当作没有系统代理（不影响原来的行为）。PAC（`ProxyAutoConfigEnable`）
//! 需要 JS 引擎才能求值，检测到也没有固定代理时按「未配置」处理（与 Node 的 `pac-unsupported` 同义）。

/// 系统代理：代理地址（补好 `http://`）与「不走代理」的规则（已转成 no_proxy 的逗号分隔写法）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SystemProxy {
    pub(crate) url: String,
    pub(crate) no_proxy: Option<String>,
}

/// 环境变量没有代理时的系统代理。
#[cfg(windows)]
pub(crate) fn system_proxy() -> Option<SystemProxy> {
    if win::dword("ProxyEnable")? == 0 {
        return None;
    }
    let server = win::string("ProxyServer")?;
    let url = proxy_url(&server)?;
    let no_proxy = win::string("ProxyOverride")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .and_then(|value| no_proxy_from_override(&value));
    Some(SystemProxy { url, no_proxy })
}

/// 环境变量没有代理时的系统代理：`scutil --proxy` 里的固定代理。
#[cfg(target_os = "macos")]
pub(crate) fn system_proxy() -> Option<SystemProxy> {
    let output = run("scutil", &["--proxy"])?;
    let parsed = parse_scutil(&output);
    let url = parsed.url?;
    Some(SystemProxy {
        url,
        no_proxy: Some(no_proxy_from_exceptions(&parsed.exceptions)),
    })
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn system_proxy() -> Option<SystemProxy> {
    None
}

/// `ProxyServer` 的三种写法：`host:port`、`http=host:port;https=host:port`（按协议分开）、
/// 以及混合写法。优先 `https`，其次 `http`，最后裸地址；没有可用的返回 None。
pub(crate) fn proxy_url(server: &str) -> Option<String> {
    let (mut https, mut http, mut plain) = (None, None, None);
    for part in server.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match part.split_once('=') {
            Some((scheme, host)) => {
                let host = host.trim();
                if host.is_empty() {
                    continue;
                }
                match scheme.trim().to_ascii_lowercase().as_str() {
                    "https" => https = Some(host.to_owned()),
                    "http" => http = Some(host.to_owned()),
                    _ => {}
                }
            }
            None => plain = Some(part.to_owned()),
        }
    }
    let host = https.or(http).or(plain)?;
    Some(if host.contains("://") {
        host
    } else {
        format!("http://{host}")
    })
}

/// `ProxyOverride` 的写法（`*.example.com;10.*;<local>`）转成标准 `no_proxy` 的逗号分隔形式；
/// `<local>`（本机与内网短名）换成明确的本机地址，避免请求本机的 MCP 服务时绕进代理。
#[cfg(any(windows, test))]
pub(crate) fn no_proxy_from_override(override_list: &str) -> Option<String> {
    let mut rules: Vec<String> = Vec::new();
    let mut local = false;
    for token in override_list.split(';') {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        if token.eq_ignore_ascii_case("<local>") {
            local = true;
            continue;
        }
        rules.push(token.to_owned());
    }
    if local {
        let locals = ["localhost", "127.0.0.1", "::1"].map(str::to_owned);
        rules.splice(0..0, locals);
    }
    if rules.is_empty() {
        None
    } else {
        Some(rules.join(","))
    }
}

/// `scutil --proxy` 的输出里我们认的几项：固定代理地址与忽略列表（其它字段不看）。
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ScutilProxy {
    pub(crate) url: Option<String>,
    pub(crate) exceptions: Vec<String>,
}

/// 解析 `scutil --proxy`：优先 HTTPS，其次 HTTP（与 Node 的 `parseMacProxyOutput` 同序）。
///
/// 输出的形状是「`键 : 值`」的行，`ExceptionsList` 是嵌套的 `<array> { 0 : … }`：
///
/// ```text
/// <dictionary> {
///   ExceptionsList : <array> {
///     0 : *.local
///     1 : 169.254/16
///   }
///   HTTPSEnable : 1
///   HTTPSPort : 7897
///   HTTPSProxy : 127.0.0.1
/// }
/// ```
#[cfg(any(target_os = "macos", test))]
pub(crate) fn parse_scutil(output: &str) -> ScutilProxy {
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut exceptions: Vec<String> = Vec::new();
    let mut in_exceptions = false;
    for line in output.lines() {
        let line = line.trim();
        if in_exceptions {
            if line.starts_with('}') {
                in_exceptions = false;
            } else if let Some((_, value)) = line.split_once(':') {
                let value = value.trim();
                if !value.is_empty() {
                    exceptions.push(value.to_owned());
                }
            }
            continue;
        }
        if line.starts_with("ExceptionsList") {
            // `ExceptionsList : <array> {` 开始；写成一行 `{ }` 时没有条目。
            in_exceptions = line.ends_with('{');
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let (key, value) = (key.trim(), value.trim());
        if key.is_empty() || value.is_empty() {
            continue;
        }
        fields.push((key.to_owned(), value.to_owned()));
    }
    let get = |name: &str| {
        fields
            .iter()
            .find(|(key, _)| key.as_str() == name)
            .map(|(_, value)| value.as_str())
    };
    let enabled = |name: &str| get(name) == Some("1");
    let fixed = |enable: &str, host: &str, port: &str, default: &str| -> Option<String> {
        if !enabled(enable) {
            return None;
        }
        let host = get(host)?;
        if host.is_empty() {
            return None;
        }
        if host.contains("://") {
            return Some(host.to_owned());
        }
        let port = get(port).filter(|value| !value.is_empty()).unwrap_or(default);
        Some(format!("http://{host}:{port}"))
    };
    ScutilProxy {
        url: fixed("HTTPSEnable", "HTTPSProxy", "HTTPSPort", "443")
            .or_else(|| fixed("HTTPEnable", "HTTPProxy", "HTTPPort", "80")),
        exceptions,
    }
}

/// `ExceptionsList`（`*.local`、`*.corp`、`host`）转成标准 `no_proxy` 的逗号分隔写法。
///
/// 本机三项永远在（MCP 服务与本地端口不能绕进代理）；`*.x` 去星号写成 `.x`（标准匹配器的
/// `.x` 同时匹配 `x` 与 `*.x`）。`169.254/16` 这类 CIDR 我们的匹配器不支持，跳过。
#[cfg(any(target_os = "macos", test))]
pub(crate) fn no_proxy_from_exceptions(exceptions: &[String]) -> String {
    let mut rules = ["localhost", "127.0.0.1", "::1"]
        .map(str::to_owned)
        .to_vec();
    for entry in exceptions {
        let entry = entry.trim();
        if entry.is_empty() || entry.contains('/') {
            continue;
        }
        let rule = entry.strip_prefix('*').unwrap_or(entry).trim();
        if rule.is_empty() || rule == "." {
            continue;
        }
        if !rules.iter().any(|existing| existing == rule) {
            rules.push(rule.to_owned());
        }
    }
    rules.join(",")
}

/// 跑一个本机命令并读 stdout（2 秒上限，与 Node 的 `execFileSync` 相同：scutil 卡住时不能拖住启动）。
#[cfg(target_os = "macos")]
fn run(program: &str, args: &[&str]) -> Option<String> {
    use std::io::Read;
    use std::process::Stdio;
    use std::time::{Duration, Instant};

    let mut child = nibi_kernel_proc::std_command(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut output = String::new();
                child.stdout.take()?.read_to_string(&mut output).ok()?;
                return Some(output);
            }
            Ok(Some(_)) => return None,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(windows)]
#[expect(
    unsafe_code,
    reason = "RegGetValueW 是 Win32 注册表 API，读 HKCU 的 Internet Settings，没有安全封装"
)]
mod win {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW,
    };

    const KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// `HKCU\Internet Settings` 下的一个字符串值。
    pub(super) fn string(name: &str) -> Option<String> {
        let (subkey, value) = (wide(KEY), wide(name));
        let mut size: u32 = 0;
        let probe = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut size,
            )
        };
        if probe != ERROR_SUCCESS || size == 0 {
            return None;
        }
        // 注册表字符串的字节数（含结尾的 NUL），换算成 u16 的个数。
        let mut buffer = vec![0u16; (size as usize).div_ceil(2)];
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let end = buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len());
        Some(String::from_utf16_lossy(&buffer[..end]))
    }

    /// `HKCU\Internet Settings` 下的一个 DWORD 值。
    pub(super) fn dword(name: &str) -> Option<u32> {
        let (subkey, value) = (wide(KEY), wide(name));
        let mut data: u32 = 0;
        let mut size = u32::try_from(std::mem::size_of::<u32>()).ok()?;
        let status = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                subkey.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                std::ptr::from_mut(&mut data).cast(),
                &mut size,
            )
        };
        (status == ERROR_SUCCESS).then_some(data)
    }
}

#[cfg(test)]
#[path = "system_proxy_tests.rs"]
mod tests;
