import { describe, expect, it } from "vitest";
import {
  hasBlockedPluginCode,
  resolvePluginBlockedLabelId,
} from "../src/settings/pluginStoreListing.js";

describe("plugin gate status labels", () => {
  it("distinguishes a security block from a user-disabled plugin", () => {
    expect(resolvePluginBlockedLabelId({ blockedReason: { code: "plugin_revoked", message: "" } })).toBe(
      "settings.plugins.detail.blocked",
    );
    expect(resolvePluginBlockedLabelId({ codeBlockedReason: { code: "plugin_native_module_blocked", message: "" } })).toBe(
      "settings.plugins.detail.blocked",
    );
    expect(resolvePluginBlockedLabelId({})).toBeUndefined();
  });

  it("treats only codeBlockedReason as 'declarative features still work'", () => {
    expect(hasBlockedPluginCode({ blockedReason: { code: "plugin_revoked", message: "" } })).toBe(true);
    expect(
      hasBlockedPluginCode({ codeBlockedReason: { code: "plugin_native_module_blocked", message: "" } }),
    ).toBe(true);
    expect(hasBlockedPluginCode({})).toBe(false);
  });
});
