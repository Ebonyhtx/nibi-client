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

  it("maps the marketplace source diagnostics that reach the store UI", () => {
    expect(
      resolvePluginErrorMessage(
        intl,
        "Marketplace source path does not exist: D:\\fixtures\\missing-marketplace",
        null,
      ),
    ).toBe("settings.plugins.error.sourcePathMissing");
    expect(
      resolvePluginErrorMessage(
        intl,
        "Unsupported or missing plugin source: ./plugins/e2e-plugin-lifecycle",
        null,
      ),
    ).toBe("settings.plugins.error.sourceUnsupported");
    expect(
      resolvePluginErrorMessage(intl, "Unsupported marketplace source: ftp://example.com", null),
    ).toBe("settings.plugins.error.sourceUnsupported");
    expect(
      resolvePluginErrorMessage(intl, "Marketplace file must be a .json file: /tmp/a.txt", null),
    ).toBe("settings.plugins.error.sourceNotJson");
    expect(
      resolvePluginErrorMessage(
        intl,
        "Marketplace source path is not a file or directory: /tmp/a",
        null,
      ),
    ).toBe("settings.plugins.error.sourceNotFileOrDir");
  });

  it("passes the offending source through as the detail", () => {
    const calls: Array<{ id: string; values?: Record<string, string> }> = [];
    const recording = {
      formatMessage: (
        descriptor: { id: string },
        values?: Record<string, string>,
      ): string => {
        calls.push({ id: descriptor.id, values });
        return descriptor.id;
      },
    } as unknown as Parameters<typeof resolvePluginErrorMessage>[0];
    resolvePluginErrorMessage(
      recording,
      "Marketplace source path does not exist: /tmp/missing",
      null,
    );
    expect(calls).toEqual([
      {
        id: "settings.plugins.error.sourcePathMissing",
        values: { detail: "/tmp/missing" },
      },
    ]);
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
