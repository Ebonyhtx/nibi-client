import { describe, expect, it } from "vitest";
import { resolvePluginOriginLabelId } from "../src/settings/pluginStoreListing.js";

describe("plugin origin detail label", () => {
  it("maps the four trust origins to their own labels", () => {
    expect(resolvePluginOriginLabelId("builtin")).toBe("settings.plugins.detail.origin.builtin");
    expect(resolvePluginOriginLabelId("official")).toBe("settings.plugins.detail.origin.official");
    expect(resolvePluginOriginLabelId("community")).toBe(
      "settings.plugins.detail.origin.community",
    );
    expect(resolvePluginOriginLabelId("local")).toBe("settings.plugins.detail.origin.local");
  });

  it("shows one generic label for every supported external adapter", () => {
    for (const adapter of ["claude", "codex", "zcode", "dsh"]) {
      expect(resolvePluginOriginLabelId(`external:${adapter}`)).toBe(
        "settings.plugins.detail.origin.external",
      );
    }
  });

  it("does not render missing or unknown origins", () => {
    expect(resolvePluginOriginLabelId(undefined)).toBeUndefined();
    expect(resolvePluginOriginLabelId("")).toBeUndefined();
    expect(resolvePluginOriginLabelId("external:unknown")).toBeUndefined();
    expect(resolvePluginOriginLabelId("legacy-cache")).toBeUndefined();
  });
});
