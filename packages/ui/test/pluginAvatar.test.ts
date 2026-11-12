import { describe, expect, it } from "vitest";
import {
  PLUGIN_AVATAR_TONES,
  pluginAvatarInitial,
  pluginAvatarSeed,
  pluginAvatarTone,
} from "../src/lib/pluginAvatar.js";

describe("plugin avatar fallback", () => {
  it("maps a seed to a stable warm tone across calls and cache refreshes", () => {
    const first = pluginAvatarTone("github@nibi-official");
    expect(pluginAvatarTone("github@nibi-official")).toBe(first);
    expect(PLUGIN_AVATAR_TONES).toContainEqual(first);

    // 不同插件允许碰撞，但不能全部落在同一桶。
    const tones = new Set(
      ["github", "zotero", "obsidian", "blender", "typst-workbench"].map((name) =>
        JSON.stringify(pluginAvatarTone(name)),
      ),
    );
    expect(tones.size).toBeGreaterThan(1);
  });

  it("prefers the full plugin id over the display name", () => {
    expect(pluginAvatarSeed({ id: "github@nibi-official", name: "GitHub" })).toBe(
      "github@nibi-official",
    );
    expect(pluginAvatarSeed({ name: "  GitHub  " })).toBe("github");
    expect(pluginAvatarSeed({})).toBe("");
  });

  it("uses the first letter or the first non-ASCII character", () => {
    expect(pluginAvatarInitial("github")).toBe("G");
    expect(pluginAvatarInitial(" zotero")).toBe("Z");
    expect(pluginAvatarInitial("阿里云 CLI")).toBe("阿");
    expect(pluginAvatarInitial("@scope/plugin")).toBe("S");
    expect(pluginAvatarInitial("123-plugin")).toBe("1");
    expect(pluginAvatarInitial("   ")).toBe("?");
  });
});
