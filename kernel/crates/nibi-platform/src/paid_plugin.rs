//! 付费插件发现层门禁（与 Node `paid-plugin-access.ts` 同判定顺序/文案）。
//!
//! 判定顺序（fail-closed）：
//! 1. 服务端 refusal（封禁/撤销/到期）→ 拒绝，不等宽限；
//! 2. 没有 token → `no_license`；
//! 3. 验签失败/iss 不对 → `bad_license`；
//! 4. `claims.dev` 缺失、本机 deviceId 缺失或不等 → `device_mismatch`；
//! 5. `exp <= now` → `expired`；
//! 6. license 未覆盖该插件 → `not_covered`；
//! 7. 其余放行。
//!
//! “是否付费”由调用方按 manifest `paid=true` **或**安装记录 `paid=true` 判定
//! （只看 manifest 拦不住复制件）；本模块只做授权判定，不读文件。

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
}
