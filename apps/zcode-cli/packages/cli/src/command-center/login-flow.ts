import { getZCodeCopy } from "@nibi/i18n";
import type { CommandCenterLoginResult } from "./types.js";

export function formatLoginResult(
  locale: string | undefined,
  result: CommandCenterLoginResult,
): string {
  const copy = getZCodeCopy(locale).tui.login;
  const label = result.user.name || result.user.email || result.user.id;
  const membership = result.membership;
  const membershipLine = !membership
    ? copy.membershipUnknown
    : membership.status === "active"
      ? copy.membershipActive(
          membership.plan ?? "member",
          formatDate(membership.expiresAt ?? result.licenseExpiresAt ?? null),
        )
      : membership.status === "expired"
        ? copy.membershipExpired
        : copy.membershipNone;
  return [
    copy.success(label),
    membershipLine,
    ...result.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
}

export function formatLogoutResult(locale: string | undefined): string {
  return getZCodeCopy(locale).tui.login.loggedOut;
}

/** 用户按 Esc 取消登录时 AbortSignal 以 AbortError 拒绝；这不是故障，按"已取消"渲染。 */
export function isLoginCancellation(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
}
