//! NIBI license 的本地判定（Ed25519 + 设备/账号绑定 + exp/72h/7d）。
//!
//! 与 Node `packages/services/src/license/nibiLicense.ts` 的判定表逐行对齐：
//!
//! | 情形 | 结果 |
//! |---|---|
//! | 没有 token | `not_activated` |
//! | 验签失败 / iss 不对 | `denied` |
//! | 服务端明确拒绝（快照 last_refusal） | 按 refusal 映射；不等宽限 |
//! | `dev` 缺失或不匹配本机 deviceId | `denied` |
//! | `uid`/`sub` 都匹配不上当前账号 | `denied` |
//! | `exp <= now` | `expired`（硬边界） |
//! | 上次在线检查已过 72h，但未超 7 天宽限 | `grace`（放行） |
//! | 上次在线检查已过 72h + 7 天 | `expired` |
//! | 其余 | `active`（放行） |
//!
//! 本模块只验签与判定，不发 HTTP、不读文件；公钥表与快照由调用方注入。

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const LICENSE_ISSUER: &str = "nibi-license";
pub const CHECK_INTERVAL_MS: u64 = 72 * 3600 * 1000;
pub const OFFLINE_GRACE_MS: u64 = 7 * 86400 * 1000;

#[derive(Debug, Error)]
pub enum LicenseError {
    #[error("license token is malformed")]
    Malformed,
    #[error("license header is not EdDSA")]
    UnsupportedAlgorithm,
    #[error("license key is unknown: {0}")]
    UnknownKey(String),
    #[error("license signature verification failed")]
    BadSignature,
    #[error("license issuer is not {LICENSE_ISSUER}")]
    WrongIssuer,
    #[error("license claims are malformed")]
    MalformedClaims,
}

/// Node `NibiLicenseClaims` 的字段；`plan`/`jti` 只用于展示，判定不依赖。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicenseClaims {
    pub iss: String,
    pub sub: String,
    pub uid: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(default)]
    pub plugins: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iat: Option<u64>,
    pub exp: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jti: Option<String>,
}

/// 上次在线检查留下的快照（Node `nibi:license:state`）。
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct LicenseSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_check_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_refusal: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LicenseStatus {
    Active,
    Grace,
    Expired,
    NotActivated,
    Denied,
}

impl LicenseStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Grace => "grace",
            Self::Expired => "expired",
            Self::NotActivated => "not_activated",
            Self::Denied => "denied",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LicenseDecision {
    pub status: LicenseStatus,
    pub allowed: bool,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claims: Option<LicenseClaims>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_check_at_ms: Option<u64>,
}

/// 公钥解析：按 JWT header 的 `kid` 取 32B Ed25519 公钥；没有 kid 时传 None。
pub type LicenseKeyResolver<'a> = &'a dyn Fn(Option<&str>) -> Option<[u8; 32]>;

pub struct LicenseEvaluation<'a> {
    pub token: Option<&'a str>,
    pub keys: LicenseKeyResolver<'a>,
    pub snapshot: Option<&'a LicenseSnapshot>,
    pub now_ms: u64,
    /// 本机 `nibi:device:id`；提供后强制与 `claims.dev` 比对。
    pub device_id: Option<&'a str>,
    /// 当前登录账号 ID（`oauth:nibi:user_info.id`）；提供后与 `uid`/`sub` 比对。
    pub account_identity: Option<&'a str>,
}

/// 验签并解析 claims；`kid` 由调用方的 resolver 决定用哪把公钥。
pub fn verify_token(
    token: &str,
    keys: LicenseKeyResolver<'_>,
) -> Result<(LicenseClaims, Option<String>), LicenseError> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(LicenseError::Malformed);
    }
    let header_bytes = URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|_| LicenseError::Malformed)?;
    let header: serde_json::Value =
        serde_json::from_slice(&header_bytes).map_err(|_| LicenseError::Malformed)?;
    // Node 接受 `Ed25519` 或 `EdDSA`（也接受缺省 alg）；其他算法一律拒绝。
    if let Some(alg) = header.get("alg").and_then(|value| value.as_str())
        && alg != "EdDSA"
        && alg != "Ed25519"
    {
        return Err(LicenseError::UnsupportedAlgorithm);
    }
    // Node 的验签按 header.kid 查公钥；没有 kid 直接拒绝（不是"用默认钥匙"）。
    let kid = header
        .get("kid")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|kid| !kid.is_empty())
        .ok_or_else(|| LicenseError::UnknownKey(String::new()))?
        .to_owned();
    let key = keys(Some(&kid)).ok_or_else(|| LicenseError::UnknownKey(kid.clone()))?;

    let signature = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| LicenseError::Malformed)?;
    let signing_input = format!("{}.{}", parts[0], parts[1]);
    UnparsedPublicKey::new(&ED25519, key.as_slice())
        .verify(signing_input.as_bytes(), &signature)
        .map_err(|_| LicenseError::BadSignature)?;

    let payload_bytes = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| LicenseError::Malformed)?;
    let claims: LicenseClaims =
        serde_json::from_slice(&payload_bytes).map_err(|_| LicenseError::MalformedClaims)?;
    if claims.iss != LICENSE_ISSUER {
        return Err(LicenseError::WrongIssuer);
    }
    Ok((claims, Some(kid)))
}

/// 判定表；与 Node `evaluateNibiLicense` 同输入同输出。
pub fn evaluate(params: LicenseEvaluation<'_>) -> LicenseDecision {
    let now = params.now_ms;
    let next_check_from = params
        .snapshot
        .and_then(|snapshot| snapshot.last_check_at_ms)
        .map(|last| last.saturating_add(CHECK_INTERVAL_MS));
    let base_next_check = next_check_from;

    let Some(token) = params.token.filter(|token| !token.is_empty()) else {
        return decision(
            LicenseStatus::NotActivated,
            false,
            "这台设备还没有激活会员（可用激活码激活）",
            None,
            base_next_check,
            now,
        );
    };
    let verified = match verify_token(token, params.keys) {
        Ok(verified) => verified,
        Err(_) => {
            return decision(
                LicenseStatus::Denied,
                false,
                "会员凭证无法验证（请重新激活）",
                None,
                base_next_check,
                now,
            );
        }
    };
    let claims = verified.0;

    // 设备绑定：license 必须带 dev；提供本机 deviceId 时强制比对。
    if claims.dev.as_deref().is_none_or(str::is_empty) {
        return decision(
            LicenseStatus::Denied,
            false,
            "会员凭证与这台设备不匹配，请在客户端账户菜单刷新会员状态后重试",
            Some(claims),
            base_next_check,
            now,
        );
    }
    if let Some(device_id) = params.device_id.filter(|value| !value.is_empty())
        && claims.dev.as_deref() != Some(device_id)
    {
        return decision(
            LicenseStatus::Denied,
            false,
            "会员凭证与这台设备不匹配，请在客户端账户菜单刷新会员状态后重试",
            Some(claims),
            base_next_check,
            now,
        );
    }

    // 账号绑定：换账号不能沿用上一个账号的 license。
    if let Some(account) = params.account_identity.filter(|value| !value.is_empty())
        && claims.uid != account
        && claims.sub != account
    {
        return decision(
            LicenseStatus::Denied,
            false,
            "会员凭证与当前登录账号不一致，请重新登录后重试",
            Some(claims),
            base_next_check,
            now,
        );
    }

    // 到期是硬边界，优先于 refusal：过期后服务端拒绝不能把“到期”误报成“状态异常”。
    if claims.exp.saturating_mul(1000) <= now {
        return decision(
            LicenseStatus::Expired,
            false,
            "会员已到期，续费后继续使用",
            Some(claims),
            Some(now),
            now,
        );
    }

    if let Some(refusal) = params
        .snapshot
        .and_then(|snapshot| snapshot.last_refusal.as_deref())
        .filter(|value| !value.is_empty())
    {
        return match refusal {
            "membership_expired" => decision(
                LicenseStatus::Expired,
                false,
                "会员已到期，续费后继续使用",
                Some(claims),
                Some(now),
                now,
            ),
            "no_membership" => decision(
                LicenseStatus::NotActivated,
                false,
                "该账号尚未开通会员",
                Some(claims),
                base_next_check,
                now,
            ),
            _ => decision(
                LicenseStatus::Denied,
                false,
                "会员已失效（服务端已拒绝）",
                Some(claims),
                base_next_check,
                now,
            ),
        };
    }

    if let Some(next_check) = next_check_from {
        if next_check <= now && now.saturating_sub(next_check) > OFFLINE_GRACE_MS {
            return decision(
                LicenseStatus::Expired,
                false,
                "太久没有联网确认会员状态，请联网后重试",
                Some(claims),
                Some(now),
                now,
            );
        }
        if next_check <= now {
            return decision(
                LicenseStatus::Grace,
                true,
                "离线宽限中（联网后将自动确认）",
                Some(claims),
                Some(next_check),
                now,
            );
        }
    }

    decision(
        LicenseStatus::Active,
        true,
        "会员有效",
        Some(claims),
        base_next_check,
        now,
    )
}

fn decision(
    status: LicenseStatus,
    allowed: bool,
    reason: &str,
    claims: Option<LicenseClaims>,
    next_check_at_ms: Option<u64>,
    _now: u64,
) -> LicenseDecision {
    LicenseDecision {
        status,
        allowed,
        reason: reason.to_owned(),
        claims,
        next_check_at_ms,
    }
}

/// 与服务端同口径：`["*"]` 全放行。
pub fn license_covers_plugin(claims: &LicenseClaims, plugin_name: &str) -> bool {
    claims
        .plugins
        .iter()
        .any(|entry| entry == "*" || entry == plugin_name)
}

#[cfg(test)]
#[path = "license_tests.rs"]
mod tests;
