import { describe, expect, it } from "vitest";
import type { NibiMembershipStatus } from "@nibi/services";
import {
  nibiMembershipAllowsPaidPlugins,
  nibiMembershipEntryLabelKey,
  resolveNibiMembershipPhase,
} from "../src/settings/nibiMembershipState.js";

const NOW = Date.parse("2026-10-27T00:00:00.000Z");
const DAY = 86_400_000;

function status(
  membership: NibiMembershipStatus["membership"],
  loggedIn = true,
): NibiMembershipStatus {
  return { loggedIn, membership };
}

function active(expiresAt: string | null): NibiMembershipStatus["membership"] {
  return { status: "active", plan: "pro", expiresAt };
}

describe("会员界面阶段", () => {
  it("未登录 / 无会员记录 / 未开通", () => {
    expect(resolveNibiMembershipPhase(null, NOW)).toBe("guest");
    expect(resolveNibiMembershipPhase(status(null), NOW)).toBe("not_activated");
    expect(
      resolveNibiMembershipPhase(
        status({ status: "not_activated", plan: null, expiresAt: null }),
        NOW,
      ),
    ).toBe("not_activated");
  });

  it("有效期充足 → active；7 天内 → expiring；本地时钟已过 → expired", () => {
    expect(resolveNibiMembershipPhase(status(active(new Date(NOW + 30 * DAY).toISOString())), NOW))
      .toBe("active");
    expect(resolveNibiMembershipPhase(status(active(new Date(NOW + 3 * DAY).toISOString())), NOW))
      .toBe("expiring");
    expect(resolveNibiMembershipPhase(status(active(new Date(NOW - 1000).toISOString())), NOW))
      .toBe("expired");
  });

  it("宿主说 grace 仍可续用，但界面提示待确认", () => {
    const phase = resolveNibiMembershipPhase(
      status({ status: "grace", plan: "pro", expiresAt: new Date(NOW + DAY).toISOString() }),
      NOW,
    );
    expect(phase).toBe("grace");
    expect(nibiMembershipAllowsPaidPlugins(phase)).toBe(true);
  });

  it("expired / denied / not_activated 都放行不了付费插件", () => {
    for (const [membership, phase] of [
      [{ status: "expired", plan: "pro", expiresAt: null }, "expired"],
      [{ status: "denied", plan: null, expiresAt: null }, "denied"],
      [{ status: "not_activated", plan: null, expiresAt: null }, "not_activated"],
    ] as const) {
      const resolved = resolveNibiMembershipPhase(status(membership), NOW);
      expect(resolved).toBe(phase);
      expect(nibiMembershipAllowsPaidPlugins(resolved)).toBe(false);
    }
  });

  it("入口文案按阶段区分，到期不再叫“状态异常”", () => {
    expect(nibiMembershipEntryLabelKey("expired")).toBe("sidebar.membership.renew");
    expect(nibiMembershipEntryLabelKey("denied")).toBe("sidebar.membership.review");
    expect(nibiMembershipEntryLabelKey("active")).toBe("sidebar.membership.center");
    expect(nibiMembershipEntryLabelKey("not_activated")).toBe("sidebar.membership.open");
  });
});
