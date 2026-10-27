import type { NibiMembershipStatus } from "@nibi/services";

/**
 * 会员在界面上的“阶段”。与宿主返回的 license status 分开：
 * - `expiring` 是 active + 7 天内到期（UI 提醒续费）；
 * - `expired` 同时覆盖宿主状态与本地时钟已过期的情形（宿主缓存可能滞后）；
 * - `grace` 是离线宽限，仍可继续用付费插件，但提示联网确认。
 */
export type NibiMembershipPhase =
  | "guest"
  | "active"
  | "expiring"
  | "grace"
  | "expired"
  | "not_activated"
  | "denied";

export const NIBI_MEMBERSHIP_EXPIRING_WINDOW_MS = 7 * 86_400_000;

export function resolveNibiMembershipPhase(
  status: NibiMembershipStatus | null | undefined,
  now = Date.now(),
): NibiMembershipPhase {
  if (!status?.loggedIn) return "guest";
  const membership = status.membership;
  if (!membership) return "not_activated";
  if (membership.status === "denied") return "denied";
  if (membership.status === "not_activated") return "not_activated";
  if (membership.status === "expired") return "expired";
  const expiresAt = membership.expiresAt ? Date.parse(membership.expiresAt) : Number.NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= now) return "expired";
  if (membership.status === "grace") return "grace";
  if (Number.isFinite(expiresAt) && expiresAt - now <= NIBI_MEMBERSHIP_EXPIRING_WINDOW_MS) {
    return "expiring";
  }
  return "active";
}

/** 只有真正有效的会员（含离线宽限）才放行会员专享插件；判断只是 UX，宿主机仍是最终门禁。 */
export function nibiMembershipAllowsPaidPlugins(phase: NibiMembershipPhase): boolean {
  return phase === "active" || phase === "expiring" || phase === "grace";
}

/** 左下角入口文案：到期/未开通直接说清楚，不用“状态异常”掩盖。 */
export function nibiMembershipEntryLabelKey(phase: NibiMembershipPhase): string {
  switch (phase) {
    case "active":
      return "sidebar.membership.center";
    case "expiring":
      return "sidebar.membership.expiring";
    case "grace":
      return "sidebar.membership.pending";
    case "expired":
      return "sidebar.membership.renew";
    case "denied":
      return "sidebar.membership.review";
    case "guest":
    case "not_activated":
      return "sidebar.membership.open";
  }
}
