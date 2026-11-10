//! 付费插件发现层门禁（与 Node `paid-plugin-access.ts` 同判定顺序/文案）。
//!
//! 判定顺序（fail-closed）：
//! 1. 服务端 refusal（封禁/撤销/到期）→ 拒绝，不等宽限；
//! 2. 没有 token → `no_license`；
//! 3. 验签失败/iss 不对 → `bad_license`；
//! 4. `claims.dev` 缺失、本机 deviceId 缺失或不等 → `device_mismatch`；
//! 5. 账号不一致（`uid`/`sub` 都对不上当前登录账号）→ 拒绝；
//! 6. `exp <= now` → `expired`；
//! 7. license 未覆盖该插件 → `not_covered`；
//! 8. 其余放行。
//!
//! “是否付费”由调用方按 manifest `paid=true` **或**安装记录 `paid=true` 判定
//! （只看 manifest 拦不住复制件）；本模块只做授权判定，不读文件。
//!
//! 除了发现层，本模块还给 [`PaidPluginRuntime`]：会话建好之后，工具表保持不变，执行
//! 付费能力时按当前 license 复核（到期不删工具、续费不加工具）。

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub use nibi_kernel_api::paid_plugin::PaidPluginGate;

use crate::license::{LicenseClaims, LicenseKeyResolver, license_covers_plugin, verify_token};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaidPluginDenyReason {
    NoLicense,
    BadLicense,
    Expired,
    NotCovered,
    DeviceMismatch,
    Denied,
}

impl PaidPluginDenyReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NoLicense => "no_license",
            Self::BadLicense => "bad_license",
            Self::Expired => "expired",
            Self::NotCovered => "not_covered",
            Self::DeviceMismatch => "device_mismatch",
            Self::Denied => "denied",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaidPluginDecision {
    pub allowed: bool,
    pub reason: Option<PaidPluginDenyReason>,
    pub message: String,
    pub claims: Option<LicenseClaims>,
}

impl PaidPluginDecision {
    fn allow(claims: LicenseClaims) -> Self {
        Self {
            allowed: true,
            reason: None,
            message: String::new(),
            claims: Some(claims),
        }
    }
    fn deny(reason: PaidPluginDenyReason, message: &str, claims: Option<LicenseClaims>) -> Self {
        Self {
            allowed: false,
            reason: Some(reason),
            message: message.to_owned(),
            claims,
        }
    }
}

/// manifest 或安装记录任一为 paid 即需要会员。
pub fn requires_membership(manifest_paid: bool, installed_record_paid: bool) -> bool {
    manifest_paid || installed_record_paid
}

pub struct PaidPluginEvaluation<'a> {
    pub token: &'a str,
    pub plugin_name: &'a str,
    pub device_id: Option<&'a str>,
    /// 当前登录账号（`oauth:nibi:user_info` 的 id）；提供后与 claims 的 `uid`/`sub` 比对。
    pub account_identity: Option<&'a str>,
    pub refusal: Option<&'a str>,
    pub now_ms: u64,
    pub keys: LicenseKeyResolver<'a>,
}

pub fn evaluate(params: PaidPluginEvaluation<'_>) -> PaidPluginDecision {
    if let Some(refusal) = params.refusal.filter(|value| !value.is_empty()) {
        let message = match refusal {
            "no_membership" => "该插件是会员专享插件：当前账号还没有开通 NIBI 会员，请先开通会员",
            "membership_expired" => "该插件需要有效的 NIBI 会员：当前会员已到期，续费后重试",
            "device_mismatch" => "会员凭证与这台设备不匹配，请在客户端账户菜单刷新会员状态后重试",
            "not_entitled" => "当前 NIBI 会员不包含该插件，请查看会员方案或联系支持",
            _ => "会员状态已被服务端暂停或撤销，请重新登录 NIBI 账号或联系支持",
        };
        return PaidPluginDecision::deny(PaidPluginDenyReason::Denied, message, None);
    }

    let token = params.token.trim();
    if token.is_empty() {
        return PaidPluginDecision::deny(
            PaidPluginDenyReason::NoLicense,
            "该插件是会员专享插件：这台设备还没有 NIBI 会员凭证，请登录后开通会员",
            None,
        );
    }
    let claims = match verify_token(token, params.keys) {
        Ok((claims, _kid)) => claims,
        Err(_) => {
            return PaidPluginDecision::deny(
                PaidPluginDenyReason::BadLicense,
                "会员凭证无法验证，请重新登录 NIBI 账号后重试",
                None,
            );
        }
    };

    let device_matches = claims
        .dev
        .as_deref()
        .filter(|value| !value.is_empty())
        .zip(params.device_id.filter(|value| !value.is_empty()))
        .is_some_and(|(claim, local)| claim == local);
    if !device_matches {
        return PaidPluginDecision::deny(
            PaidPluginDenyReason::DeviceMismatch,
            "会员凭证与这台设备不匹配，请在客户端账户菜单刷新会员状态后重试",
            Some(claims),
        );
    }

    if let Some(account) = params.account_identity.filter(|value| !value.is_empty())
        && claims.uid != account
        && claims.sub != account
    {
        return PaidPluginDecision::deny(
            PaidPluginDenyReason::Denied,
            "会员凭证与当前登录账号不一致，请重新登录 NIBI 账号后重试",
            Some(claims),
        );
    }

    if claims.exp.saturating_mul(1000) <= params.now_ms {
        return PaidPluginDecision::deny(
            PaidPluginDenyReason::Expired,
            "该插件需要有效的 NIBI 会员：当前会员已到期，续费后重试",
            Some(claims),
        );
    }

    if !license_covers_plugin(&claims, params.plugin_name) {
        return PaidPluginDecision::deny(
            PaidPluginDenyReason::NotCovered,
            "当前 NIBI 会员不包含该插件，请查看会员方案或联系支持",
            Some(claims),
        );
    }

    PaidPluginDecision::allow(claims)
}

/// 执行期门禁的授权事实（本机凭据文件里与付费插件有关的那几项）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PaidLicenseFacts {
    pub token: String,
    pub device_id: Option<String>,
    pub refusal: Option<String>,
    /// 当前登录账号 id（`oauth:nibi:user_info`）；没有登录态时 None。
    pub account_identity: Option<String>,
}

/// 读授权事实的来源。生产是入口层的 v2 凭据读取；测试用固定值。
pub trait PaidLicenseSource: Send + Sync {
    fn load(&self) -> PaidLicenseFacts;
}

/// 执行期门禁：工具表冻结，执行付费能力时按当前 license 复核。
/// 默认缓存 5 秒：续费/拒绝最多这么晚生效；`exp` 每次都用当前时钟判，不受缓存影响。
const DEFAULT_LICENSE_TTL: Duration = Duration::from_secs(5);

pub struct PaidPluginRuntime {
    paid: RwLock<BTreeSet<String>>,
    source: Arc<dyn PaidLicenseSource>,
    cache: Mutex<Option<(Instant, PaidLicenseFacts)>>,
    ttl: Duration,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    keys: Arc<dyn Fn(Option<&str>) -> Option<[u8; 32]> + Send + Sync>,
}

impl PaidPluginRuntime {
    pub fn new(source: Arc<dyn PaidLicenseSource>) -> Self {
        Self::with_clock(source, Arc::new(unix_now_ms), DEFAULT_LICENSE_TTL)
    }

    /// 测试用：固定时钟与 TTL。
    pub fn with_clock(
        source: Arc<dyn PaidLicenseSource>,
        now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
        ttl: Duration,
    ) -> Self {
        Self {
            paid: RwLock::default(),
            source,
            cache: Mutex::default(),
            ttl,
            now_ms,
            keys: Arc::new(crate::license::public_key),
        }
    }

    /// 测试用：换验签公钥。
    pub fn with_keys(
        mut self,
        keys: Arc<dyn Fn(Option<&str>) -> Option<[u8; 32]> + Send + Sync>,
    ) -> Self {
        self.keys = keys;
        self
    }

    /// 插件加载后登记。只有登记过的插件才会被 `check` 拦住；未登记视为非付费。
    pub fn register_paid(&self, plugin: &str) {
        let plugin = plugin.trim();
        if plugin.is_empty() {
            return;
        }
        self.paid
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(plugin.to_owned());
    }

    pub fn is_paid(&self, plugin: &str) -> bool {
        self.paid
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(plugin)
    }

    /// 按给定时刻检查（测试/批处理用）；生产走 [`PaidPluginGate::check`] 的当前时钟。
    pub fn check_at(&self, plugin: &str, now_ms: u64) -> Result<(), String> {
        if !self.is_paid(plugin) {
            return Ok(());
        }        let facts = self.facts();
        let decision = evaluate(PaidPluginEvaluation {
            token: &facts.token,
            plugin_name: plugin,
            device_id: facts.device_id.as_deref(),
            account_identity: facts.account_identity.as_deref(),
            refusal: facts.refusal.as_deref(),
            now_ms,
            keys: self.keys.as_ref(),
        });
        if decision.allowed {
            Ok(())
        } else {
            Err(decision.message)
        }
    }

    fn facts(&self) -> PaidLicenseFacts {
        let now = Instant::now();
        {
            let cache = self
                .cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some((read_at, facts)) = cache.as_ref()
                && now.duration_since(*read_at) < self.ttl
            {
                return facts.clone();
            }
        }
        // 读失败/解密失败由来源返回空事实：门禁按无 token 拒绝，且缓存 TTL 内不再锤文件。
        let facts = self.source.load();
        *self
            .cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some((now, facts.clone()));
        facts
    }
}

impl PaidPluginGate for PaidPluginRuntime {
    fn is_paid(&self, plugin: &str) -> bool {
        self.paid
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(plugin)
    }

    fn check(&self, plugin: &str) -> Result<(), String> {
        self.check_at(plugin, (self.now_ms)())
    }

    fn register(&self, plugin: &str) {
        self.register_paid(plugin);
    }
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;

    const PUBLIC_KEY: &str = "Op9EiLF_v-qTpLUxIztILaM1hsDpaeP-JZodBwma6fk";
    const ACTIVE: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImtpZC0xIn0.eyJpc3MiOiJuaWJpLWxpY2Vuc2UiLCJzdWIiOiJ1c2VyLTEiLCJ1aWQiOiJ1c2VyLTEiLCJwbGFuIjoicHJvIiwicGx1Z2lucyI6WyJtYXRoLW1vZGVsaW5nIl0sImRldiI6ImRldi0xIiwiZXhwIjoxNzkzMjg4NjAwLCJpYXQiOjE3OTMyODQ5MDAsImp0aSI6Imp0aS0xIn0.9GEubux13C7H41d4n98DcLvIO9nu2yPhSBUpaz0P40rr1VCUVQZ8aoony5q-kYaWfNmz2usdJrn-x0c9Px_hBg";
    const NO_DEV: &str = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImtpZC0xIn0.eyJpc3MiOiJuaWJpLWxpY2Vuc2UiLCJzdWIiOiJ1c2VyLTEiLCJ1aWQiOiJ1c2VyLTEiLCJwbGFuIjoicHJvIiwicGx1Z2lucyI6WyJtYXRoLW1vZGVsaW5nIl0sImV4cCI6MTc5MzI4ODYwMCwiaWF0IjoxNzkzMjg0OTAwLCJqdGkiOiJqdGktMSJ9.MA6vjZXNeFus5As-7py6DAGPgLaRWC-W6Bpi0GPcsPMVRHyIOefDlx9DVvMdlwprk6iL2yupkSsbiMpBCzABAQ";
    const NOW_MS: u64 = 1_793_285_000_000;

    fn key() -> [u8; 32] {
        URL_SAFE_NO_PAD
            .decode(PUBLIC_KEY)
            .unwrap()
            .try_into()
            .unwrap()
    }

    fn eval(
        token: &str,
        plugin: &str,
        device: Option<&str>,
        refusal: Option<&str>,
    ) -> PaidPluginDecision {
        evaluate(PaidPluginEvaluation {
            token,
            plugin_name: plugin,
            device_id: device,
            account_identity: None,
            refusal,
            now_ms: NOW_MS,
            keys: &|_kid| Some(key()),
        })
    }

    #[test]
    fn paid_plugin_is_allowed_for_covered_device_bound_license() {
        let decision = eval(ACTIVE, "math-modeling", Some("dev-1"), None);
        assert!(decision.allowed);
        assert_eq!(decision.reason, None);
    }

    #[test]
    fn unpaid_plugin_does_not_need_membership() {
        assert!(!requires_membership(false, false));
        assert!(requires_membership(true, false));
        assert!(requires_membership(false, true));
    }

    #[test]
    fn missing_token_is_no_license() {
        let decision = eval("", "math-modeling", Some("dev-1"), None);
        assert_eq!(decision.reason, Some(PaidPluginDenyReason::NoLicense));
    }

    #[test]
    fn tampered_token_is_bad_license() {
        let mut token = ACTIVE.to_owned();
        let last = token.pop().unwrap();
        token.push(if last == 'A' { 'B' } else { 'A' });
        let decision = eval(&token, "math-modeling", Some("dev-1"), None);
        assert_eq!(decision.reason, Some(PaidPluginDenyReason::BadLicense));
    }

    #[test]
    fn missing_or_mismatched_device_is_rejected() {
        assert_eq!(
            eval(ACTIVE, "math-modeling", None, None).reason,
            Some(PaidPluginDenyReason::DeviceMismatch)
        );
        assert_eq!(
            eval(ACTIVE, "math-modeling", Some("dev-2"), None).reason,
            Some(PaidPluginDenyReason::DeviceMismatch)
        );
        assert_eq!(
            eval(NO_DEV, "math-modeling", Some("dev-1"), None).reason,
            Some(PaidPluginDenyReason::DeviceMismatch)
        );
    }

    #[test]
    fn expired_token_is_rejected() {
        let decision = evaluate(PaidPluginEvaluation {
            token: ACTIVE,
            plugin_name: "math-modeling",
            device_id: Some("dev-1"),
            account_identity: None,
            refusal: None,
            now_ms: 1_793_288_600_000,
            keys: &|_kid| Some(key()),
        });
        assert_eq!(decision.reason, Some(PaidPluginDenyReason::Expired));
    }

    #[test]
    fn uncovered_plugin_is_rejected() {
        assert_eq!(
            eval(ACTIVE, "other-plugin", Some("dev-1"), None).reason,
            Some(PaidPluginDenyReason::NotCovered)
        );
    }

    #[test]
    fn refusal_is_denied_with_node_message() {
        let decision = eval(
            ACTIVE,
            "math-modeling",
            Some("dev-1"),
            Some("no_membership"),
        );
        assert_eq!(decision.reason, Some(PaidPluginDenyReason::Denied));
        assert!(decision.message.contains("还没有开通 NIBI 会员"));
        let expired = eval(
            ACTIVE,
            "math-modeling",
            Some("dev-1"),
            Some("membership_expired"),
        );
        assert!(expired.message.contains("已到期"));
    }

    struct FixedSource {
        facts: Mutex<PaidLicenseFacts>,
        loads: std::sync::atomic::AtomicUsize,
    }

    impl FixedSource {
        fn new(facts: PaidLicenseFacts) -> Arc<Self> {
            Arc::new(Self {
                facts: Mutex::new(facts),
                loads: std::sync::atomic::AtomicUsize::new(0),
            })
        }

        fn set(&self, facts: PaidLicenseFacts) {
            *self.facts.lock().unwrap() = facts;
        }

        fn loads(&self) -> usize {
            self.loads.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl PaidLicenseSource for FixedSource {
        fn load(&self) -> PaidLicenseFacts {
            self.loads
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.facts.lock().unwrap().clone()
        }
    }

    fn facts(token: &str, account: Option<&str>) -> PaidLicenseFacts {
        PaidLicenseFacts {
            token: token.to_owned(),
            device_id: Some("dev-1".to_owned()),
            refusal: None,
            account_identity: account.map(str::to_owned),
        }
    }

    fn runtime(source: Arc<FixedSource>, ttl: Duration) -> PaidPluginRuntime {
        PaidPluginRuntime::with_clock(source, Arc::new(|| NOW_MS), ttl)
            .with_keys(Arc::new(|_kid| Some(key())))
    }

    #[test]
    fn runtime_allows_paid_plugins_and_ignores_unregistered_ones() {
        let source = FixedSource::new(facts(ACTIVE, Some("user-1")));
        let gate = runtime(source.clone(), Duration::from_secs(5));
        gate.register("math-modeling");
        assert!(gate.check("math-modeling").is_ok());
        // 缓存命中：同一 TTL 内只读一次凭据。
        assert!(gate.check("math-modeling").is_ok());
        assert_eq!(source.loads(), 1);
        // 未登记的不是付费插件，不读凭据。
        assert!(gate.check("other-plugin").is_ok());
        assert_eq!(source.loads(), 1);
    }

    #[test]
    fn runtime_denies_after_expiry_and_after_account_switch() {
        let gate = runtime(
            FixedSource::new(facts(ACTIVE, Some("user-1"))),
            Duration::ZERO,
        );
        gate.register("math-modeling");
        assert!(gate.check_at("math-modeling", NOW_MS).is_ok());
        let expired = gate
            .check_at("math-modeling", 1_793_288_600_000)
            .unwrap_err();
        assert!(expired.contains("到期"), "{expired}");

        let switched = runtime(
            FixedSource::new(facts(ACTIVE, Some("user-2"))),
            Duration::ZERO,
        );
        switched.register("math-modeling");
        let message = switched.check_at("math-modeling", NOW_MS).unwrap_err();
        assert!(message.contains("账号不一致"), "{message}");
    }

    #[test]
    fn runtime_reads_a_renewed_license_after_the_ttl() {
        let source = FixedSource::new(PaidLicenseFacts::default());
        let gate = runtime(source.clone(), Duration::ZERO);
        gate.register("math-modeling");
        assert!(gate.check("math-modeling").is_err());
        // 续费/重新激活后凭据文件换了一份：下一次检查必须重新读，不能一直用缓存拒绝。
        source.set(facts(ACTIVE, Some("user-1")));
        assert!(gate.check("math-modeling").is_ok());
        assert!(source.loads() >= 2);
    }
}
