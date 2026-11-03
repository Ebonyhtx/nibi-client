//! 网络捕获（141 审计 §9 F3）：`process/networkCapture` 的开关与 `process/networkRequests` 的批次。
//!
//! Node 侧是 `createNodeNetworkCapture`（`packages/shared/src/node/networkCapture.ts`）：订阅 undici 与
//! `http` 的请求创建事件，攒够 250 ms 或 100 条就发一批。Rust 这边所有出站请求都经
//! [`Egress::send`](rust_cli_net::Egress::send)，所以在那一处挂钩就够——不必像 Node 那样订阅两套
//! 客户端事件。
//!
//! 三条与 Node 相同的规则：
//!
//! - **只在开了捕获时记录**：没开时不持有任何状态，也不做 URL 清洗。
//! - **URL 脱敏后上报**：去掉凭据与 fragment，查询值一律换成 `[redacted]`，只留路径与键名。
//! - **观测失败不影响业务**：攒批、发送都在尽力而为的一侧，`CONNECT` 这类隧道请求不记。
//!
//! 与 Node 的一处差异：Node 用 `diagnostics_channel` 抓**所有**进程内请求，包括不走自己 HTTP 客户端的；
//! Rust 只有经 `Egress` 的请求会被记录——那本来就是本工程唯一允许的出站路径（出口规则单点），
//! 所以覆盖面相同。

use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};

/// 一批最多这么多条（Node `records.length >= 100`）。
pub const CAPTURE_BATCH_LIMIT: usize = 100;
/// 攒批窗口（Node `setTimeout(flush, 250)`）。
pub const CAPTURE_FLUSH_MS: u64 = 250;
/// URL 上限（Node `slice(0, 2_048)`）。
const URL_MAX: usize = 2_048;

/// 一条请求记录（Host `networkRequestRecordSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRequestRecord {
    pub timestamp: u64,
    /// 固定 `cli`（这条路径只有 CLI 自己的请求）。
    pub process_type: String,
    pub pid: u32,
    /// 方法名，最多 32 字符。
    pub method: String,
    pub url: String,
}

/// 一批记录（Host `networkCaptureBatchSchema`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCaptureBatch {
    pub capture_id: String,
    pub records: Vec<NetworkRequestRecord>,
    /// 这一批期间因上限丢掉的条数。
    pub dropped: u64,
}

/// 捕获开关与攒批的状态。
#[derive(Default)]
pub struct CaptureState {
    capture_id: Option<String>,
    records: Vec<NetworkRequestRecord>,
    dropped: u64,
}

impl CaptureState {
    /// 开或关捕获（`process/networkCapture` 的 `{captureId}`）。换 id 或关掉都会丢掉未发的记录
    /// （Node `setCaptureId` 同样清空）。
    pub fn set_capture_id(&mut self, capture_id: Option<String>) {
        if self.capture_id == capture_id {
            return;
        }
        self.capture_id = capture_id;
        self.records.clear();
        self.dropped = 0;
    }

    pub fn capture_id(&self) -> Option<&str> {
        self.capture_id.as_deref()
    }

    /// 记一条；没开捕获或 URL 不可上报时什么都不做。返回是否到达攒批上限（调用方据此立即冲一批）。
    pub fn record(&mut self, timestamp: u64, pid: u32, method: &str, url: &str) -> bool {
        if self.capture_id.is_none() || method.eq_ignore_ascii_case("CONNECT") {
            return false;
        }
        if self.records.len() >= CAPTURE_BATCH_LIMIT {
            self.dropped += 1;
            return false;
        }
        let Some(url) = sanitize_url(url) else {
            return false;
        };
        let mut method = method.to_owned();
        method.truncate(32);
        self.records.push(NetworkRequestRecord {
            timestamp,
            process_type: "cli".to_owned(),
            pid,
            method,
            url,
        });
        self.records.len() >= CAPTURE_BATCH_LIMIT
    }

    /// 取走攒下的记录。没开捕获或没有记录时为 `None`（不发空批）。
    pub fn take_batch(&mut self) -> Option<NetworkCaptureBatch> {
        let capture_id = self.capture_id.clone()?;
        if self.records.is_empty() {
            return None;
        }
        let records = std::mem::take(&mut self.records);
        let dropped = std::mem::take(&mut self.dropped);
        Some(NetworkCaptureBatch {
            capture_id,
            records,
            dropped,
        })
    }
}

/// URL 脱敏（Node `sanitizeNetworkCaptureUrl`）：只留 http/https/ws/wss，去凭据与 fragment，
/// 查询值换成 `[redacted]`，截到 2048。
pub fn sanitize_url(value: &str) -> Option<String> {
    let mut url = url::Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
        return None;
    }
    let _ = url.set_username("");
    let _ = url.set_password(None);
    url.set_fragment(None);
    let keys: Vec<String> = url
        .query_pairs()
        .map(|(key, _)| key.into_owned())
        .collect();
    if !keys.is_empty() {
        let mut query = url.query_pairs_mut();
        query.clear();
        for key in &keys {
            query.append_pair(key, "[redacted]");
        }
    }
    let mut out: String = url.into();
    if out.len() > URL_MAX {
        out.truncate(URL_MAX);
    }
    Some(out)
}

/// 挂在进程上的捕获状态（一把锁）。
#[derive(Default)]
pub struct NetworkCapture {
    state: Mutex<CaptureState>,
}

impl NetworkCapture {
    pub fn with<R>(&self, f: impl FnOnce(&mut CaptureState) -> R) -> R {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        f(&mut state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_is_off_until_a_capture_id_is_set() {
        let mut state = CaptureState::default();
        assert!(!state.record(1, 2, "GET", "https://example.com/a?b=1"));
        assert!(state.take_batch().is_none());
        state.set_capture_id(Some("cap-1".to_owned()));
        assert!(!state.record(1, 2, "GET", "https://example.com/a?b=1"));
        let batch = state.take_batch().expect("a batch");
        assert_eq!(batch.capture_id, "cap-1");
        assert_eq!(batch.records.len(), 1);
        assert_eq!(batch.records[0].process_type, "cli");
        assert_eq!(batch.records[0].pid, 2);
        assert_eq!(batch.records[0].method, "GET");
        assert_eq!(batch.records[0].url, "https://example.com/a?b=%5Bredacted%5D");
    }

    #[test]
    fn the_batch_limit_drops_the_overflow() {
        let mut state = CaptureState::default();
        state.set_capture_id(Some("cap-1".to_owned()));
        // 前 99 条正常收；第 100 条（索引 99）到上限，返回值告诉调用方该冲批了。
        for index in 0..CAPTURE_BATCH_LIMIT - 1 {
            assert!(!state.record(index as u64, 1, "GET", "https://example.com/"));
        }
        assert!(state.record(99, 1, "GET", "https://example.com/"));
        // 再来的就是溢出：丢掉并计数。
        assert!(!state.record(100, 1, "GET", "https://example.com/"));
        let batch = state.take_batch().unwrap();
        assert_eq!(batch.records.len(), CAPTURE_BATCH_LIMIT);
        assert_eq!(batch.dropped, 1);
    }

    #[test]
    fn changing_the_capture_id_clears_the_buffer() {
        let mut state = CaptureState::default();
        state.set_capture_id(Some("one".to_owned()));
        state.record(1, 1, "GET", "https://example.com/");
        state.set_capture_id(Some("two".to_owned()));
        assert!(state.take_batch().is_none());
        state.set_capture_id(None);
        assert!(state.capture_id().is_none());
    }

    #[test]
    fn sanitizing_strips_credentials_fragment_and_query_values() {
        assert_eq!(
            sanitize_url("https://user:pass@example.com/a/b?x=1&y=2#frag").unwrap(),
            "https://example.com/a/b?x=%5Bredacted%5D&y=%5Bredacted%5D"
        );
        // 非 http(s) 不记（Node 同一判据）。
        assert!(sanitize_url("ftp://example.com/a").is_none());
        assert!(sanitize_url("file:///etc/passwd").is_none());
        assert!(sanitize_url("not a url").is_none());
        // ws / wss 放行（WebSocket 工具）。
        assert!(sanitize_url("wss://example.com/socket").is_some());
    }

    #[test]
    fn connect_requests_are_not_recorded() {
        let mut state = CaptureState::default();
        state.set_capture_id(Some("cap".to_owned()));
        assert!(!state.record(1, 1, "CONNECT", "https://example.com/"));
        assert!(state.take_batch().is_none());
    }
}
