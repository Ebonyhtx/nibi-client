//! Windows「系统代理」（Internet 选项 → 局域网设置）的读取：环境变量一个都没给代理时用它。
//!
//! 只设了系统代理（Clash / v2rayN 的常见形态）时，CLI 以前会直连，模型接口与
//! `/api/v1/licenses/check` 被重置（`os error 10054`），表现为「会员状态无法同步」。
//! 出口顺序因此是：显式变量（`NIBI_HTTP_PROXY` / `https_proxy` …）> 系统代理 > 直连。
//!
//! 只读 `HKCU\…\Internet Settings` 的三个值：`ProxyEnable`、`ProxyServer`、`ProxyOverride`。
//! 不写任何东西；读不到时当作没有系统代理（不影响原来的行为）。

/// 系统代理：代理地址（补好 `http://`）与「不走代理」的规则（分号分隔，原样）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SystemProxy {
    pub(crate) url: String,
    pub(crate) overrides: Option<String>,
}

/// 环境变量没有代理时的系统代理。非 Windows 平台没有（macOS 的 SystemConfiguration 不在这里读）。
#[cfg(windows)]
pub(crate) fn system_proxy() -> Option<SystemProxy> {
    if win::dword("ProxyEnable")? == 0 {
        return None;
    }
    let server = win::string("ProxyServer")?;
    let url = proxy_url(&server)?;
    let overrides = win::string("ProxyOverride")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    Some(SystemProxy { url, overrides })
}

#[cfg(not(windows))]
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
