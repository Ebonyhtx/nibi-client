//! Android 上的平台信任锚状态（NIBI-GO Phase C · 票据 T8）。
//!
//! 桌面与 CLI 直接用系统信任库。Android 进程内 cdylib 没有 JVM / Context 时，
//! `rustls-platform-verifier` 的 Android 后端无法读取系统信任库，reqwest 会把整条 egress
//! 构造当作失败（NIBI-GO 真机实测：`rustls-platform-verifier could not load extra certs`），
//! app-server 随之退出。
//!
//! 在宿主把 JVM 与 Context 交给内核之前，Android 退回**只用内置的 Mozilla 根证书**
//! （`Anchors::Merge` 的附加锚部分仍照常生效）：公开 HTTPS 正常，用户安装的 CA /
//! 企业代理证书暂不生效。宿主交接入口是 S2 的活（新 C ABI + JNI 薄层），本文件预留置位函数。

#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicBool, Ordering};

#[cfg(target_os = "android")]
static PLATFORM_TRUST: AtomicBool = AtomicBool::new(false);

/// 宿主交接过 JVM / Context 之后置位（S2 接入，当前没有调用方）。
#[cfg(target_os = "android")]
#[allow(dead_code)]
pub(crate) fn mark_platform_trust_ready() {
    PLATFORM_TRUST.store(true, Ordering::Release);
}

/// 是否可以使用平台根证书。
#[cfg(target_os = "android")]
pub(crate) fn platform_trust_available() -> bool {
    PLATFORM_TRUST.load(Ordering::Acquire)
}

/// 非 Android 平台始终走平台校验器（与改动前逐字一致）。
#[cfg(not(target_os = "android"))]
pub(crate) fn platform_trust_available() -> bool {
    true
}

#[cfg(test)]
mod tests {
    #[test]
    fn host_platforms_keep_using_the_platform_verifier() {
        #[cfg(not(target_os = "android"))]
        assert!(super::platform_trust_available());
    }
}
