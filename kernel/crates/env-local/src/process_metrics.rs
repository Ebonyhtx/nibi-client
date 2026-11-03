//! 本机进程指标（141 审计 §9 F3，`process/resourceSample` 的读数端）。
//!
//! 只读**本进程**的累计 CPU 与内存，不做进程表扫描：桌面资源面板要的是 CLI 自己的占用，
//! 整机进程表由桌面的 Host 侧采样（`packages/services/src/process/processResourceSampler.ts`）。
//!
//! - Unix：`getrusage(RUSAGE_SELF)` 给累计 user/system 时间，`/proc/self/statm`（Linux）或
//!   `getrusage` 的 `ru_maxrss`（macOS）给常驻内存。
//! - Windows：`GetProcessTimes` 给累计 CPU，`GetProcessMemoryInfo` 给工作集。
//!
//! 读不到就返回 `None`：上层这一拍跳过，不用 0 冒充（Node 的 `toRoundedUnit` 同一姿态）。

use rust_cli_kernel_api::process_metrics::{ProcessMetrics, ProcessUsage};

/// 本机实现。
pub struct LocalProcessMetrics {
    started: std::time::Instant,
}

impl LocalProcessMetrics {
    pub fn new() -> Self {
        Self {
            started: std::time::Instant::now(),
        }
    }
}

impl Default for LocalProcessMetrics {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessMetrics for LocalProcessMetrics {
    fn platform(&self) -> &'static str {
        std::env::consts::OS
    }

    fn arch(&self) -> &'static str {
        std::env::consts::ARCH
    }

    fn logical_cpu_count(&self) -> u32 {
        std::thread::available_parallelism()
            .map(|count| u32::try_from(count.get()).unwrap_or(u32::MAX))
            .unwrap_or(1)
            .clamp(1, 4_096)
    }

    fn total_memory_bytes(&self) -> Option<u64> {
        total_memory_bytes()
    }

    fn uptime_seconds(&self) -> Option<u64> {
        Some(self.started.elapsed().as_secs())
    }

    fn read(&self) -> Option<ProcessUsage> {
        read()
    }
}

#[cfg(unix)]
#[expect(unsafe_code, reason = "getrusage(2) / sysconf(3) 是 libc 的 FFI，没有安全封装")]
fn read() -> Option<ProcessUsage> {
    // SAFETY: `getrusage` 只写调用方给的 `rusage` 结构；`RUSAGE_SELF` 是常量。
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    // SAFETY: 同上，指针指向本栈上的有效结构。
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
        return None;
    }
    let micros = |value: libc::timeval| -> u64 {
        u64::try_from(value.tv_sec)
            .unwrap_or(0)
            .saturating_mul(1_000_000)
            .saturating_add(u64::try_from(value.tv_usec).unwrap_or(0))
    };
    Some(ProcessUsage {
        user_us: micros(usage.ru_utime),
        system_us: micros(usage.ru_stime),
        rss_bytes: resident_bytes()?,
        // 原生进程没有 V8 堆；字段缺席（Node 那边是 `heapUsed`）。
        heap_used_bytes: None,
    })
}

/// Linux 读 `/proc/self/statm` 的第二列（常驻页数）；其他 Unix 用 `ru_maxrss`（峰值，不是当前值，
/// 但 macOS 没有更便宜的办法，且峰值对「资源面板看有没有涨」足够）。
#[cfg(unix)]
#[expect(unsafe_code, reason = "sysconf(3) 与 getrusage(2) 是 libc 的 FFI，没有安全封装")]
fn resident_bytes() -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
        let pages: u64 = statm.split_whitespace().nth(1)?.parse().ok()?;
        let page_size = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;
        Some(pages.saturating_mul(page_size))
    }
    #[cfg(not(target_os = "linux"))]
    {
        // macOS / BSD：`ru_maxrss` 是字节（macOS）或 KB（BSD）；这里只覆盖 macOS，按字节读。
        let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
        if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } != 0 {
            return None;
        }
        u64::try_from(usage.ru_maxrss).ok()
    }
}

#[cfg(windows)]
#[expect(unsafe_code, reason = "GetProcessTimes / GetProcessMemoryInfo 是 Win32 FFI，没有安全封装")]
fn read() -> Option<ProcessUsage> {
    use windows_sys::Win32::System::ProcessStatus::{
        GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};

    // SAFETY: 这些调用只写调用方给的结构；当前进程的伪句柄恒有效。
    unsafe {
        let handle = GetCurrentProcess();
        let (mut created, mut exited, mut kernel, mut user) = Default::default();
        if GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) == 0 {
            return None;
        }
        let to_us = |filetime: windows_sys::Win32::Foundation::FILETIME| -> u64 {
            // FILETIME 是 100ns 单位。
            (u64::from(filetime.dwHighDateTime) << 32 | u64::from(filetime.dwLowDateTime)) / 10
        };
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = u32::try_from(std::mem::size_of::<PROCESS_MEMORY_COUNTERS>()).ok()?;
        if GetProcessMemoryInfo(handle, &mut counters, counters.cb) == 0 {
            return None;
        }
        Some(ProcessUsage {
            user_us: to_us(user),
            system_us: to_us(kernel),
            rss_bytes: u64::try_from(counters.WorkingSetSize).ok()?,
            heap_used_bytes: None,
        })
    }
}

#[cfg(not(any(unix, windows)))]
fn read() -> Option<ProcessUsage> {
    None
}

#[cfg(target_os = "linux")]
fn total_memory_bytes() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = meminfo
        .lines()
        .find(|line| line.starts_with("MemTotal:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb.saturating_mul(1_024))
}

#[cfg(all(unix, not(target_os = "linux")))]
#[expect(unsafe_code, reason = "sysconf(3) 是 libc 的 FFI，没有安全封装")]
fn total_memory_bytes() -> Option<u64> {
    // SAFETY: `sysconf` 只读系统常量。
    let pages = unsafe { libc::sysconf(libc::_SC_PHYS_PAGES) };
    // SAFETY: 同上。
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if pages <= 0 || page_size <= 0 {
        return None;
    }
    Some((pages as u64).saturating_mul(page_size as u64))
}

#[cfg(windows)]
#[expect(unsafe_code, reason = "GlobalMemoryStatusEx 是 Win32 FFI，没有安全封装")]
fn total_memory_bytes() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    // SAFETY: 只写调用方给的结构；`dwLength` 按 API 要求先填结构大小。
    unsafe {
        let mut status: MEMORYSTATUSEX = std::mem::zeroed();
        status.dwLength = u32::try_from(std::mem::size_of::<MEMORYSTATUSEX>()).ok()?;
        if GlobalMemoryStatusEx(&mut status) == 0 {
            return None;
        }
        Some(status.ullTotalPhys)
    }
}

#[cfg(not(any(unix, windows)))]
fn total_memory_bytes() -> Option<u64> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 本机读数在真实进程上必须可用（CPU 与内存都读得到）。
    #[test]
    fn the_local_reader_reports_this_process() {
        let metrics = LocalProcessMetrics::new();
        let usage = metrics.read().expect("this process is readable");
        assert!(usage.rss_bytes > 0, "rss must be positive");
        assert!(metrics.logical_cpu_count() >= 1);
        assert!(metrics.total_memory_bytes().is_some_and(|bytes| bytes > 0));
        assert!(!metrics.platform().is_empty());
        assert!(!metrics.arch().is_empty());
    }

    /// 累计 CPU 时间只增不减（同一进程连续读两次）。
    #[test]
    fn cpu_time_does_not_go_backwards() {
        let metrics = LocalProcessMetrics::new();
        let first = metrics.read().expect("readable");
        let second = metrics.read().expect("readable");
        assert!(
            second.user_us + second.system_us >= first.user_us + first.system_us,
            "{first:?} then {second:?}"
        );
    }
}
