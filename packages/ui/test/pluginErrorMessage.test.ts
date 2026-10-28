// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { resolvePluginErrorMessage } from "@/settings/pluginErrorMessage.js";

const intl = {
  formatMessage: ({ id }: { id: string }) => id,
} as unknown as Parameters<typeof resolvePluginErrorMessage>[0];

describe("plugin error localization", () => {
  it("maps the paid-membership diagnostic code to localized copy", () => {
    expect(
      resolvePluginErrorMessage(intl, "该插件是会员专享插件：当前账号还没有开通 NIBI 会员", "plugin_membership_required"),
    ).toBe("settings.plugins.error.membershipRequired");
  });

  it("keeps the raw message for codes without a mapping", () => {
    expect(resolvePluginErrorMessage(intl, "installation failed", "plugin_not_found")).toBe(
      "installation failed",
    );
    expect(resolvePluginErrorMessage(intl, "installation failed", null)).toBe("installation failed");
  });

  it("returns null when there is no error", () => {
    expect(resolvePluginErrorMessage(intl, null, "plugin_membership_required")).toBeNull();
    expect(resolvePluginErrorMessage(intl, undefined, undefined)).toBeNull();
  });
});
