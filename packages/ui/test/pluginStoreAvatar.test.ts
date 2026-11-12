import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PluginStoreAvatar } from "../src/settings/PluginStoreAvatar.js";

describe("PluginStoreAvatar", () => {
  it.each([
    ["documents", "documents.png"],
    ["pdf", "pdf.png"],
    ["presentations", "presentations.png"],
    ["spreadsheets", "spreadsheets.png"],
  ])("uses bundled artwork for the official %s plugin", (name, assetName) => {
    const staleIcon = "https://cdn.example.com/old-document-skills.png";
    const render = (id: string) =>
      renderToStaticMarkup(
        createElement(PluginStoreAvatar, {
          item: { id, name, listing: { icon: staleIcon } },
        }),
      );

    expect(render(`${name}@nibi-official`)).toContain(assetName);
    expect(render(`${name}@nibi-official`)).not.toContain(staleIcon);
    expect(render(`${name}@personal`)).toContain(staleIcon);
  });

  it("uses the bundled creator artwork only for the official plugin, including stale listings", () => {
    const icon = "https://cdn.example.com/old-skill-creator.png";
    const render = (id: string) =>
      renderToStaticMarkup(
        createElement(PluginStoreAvatar, {
          item: { id, name: "plugin-creator", listing: { icon } },
        }),
      );
    expect(render("plugin-creator@nibi-official")).toContain("plugin-creator.png");
    expect(render("plugin-creator@nibi-official")).not.toContain(icon);
    expect(render("plugin-creator@personal")).toContain(icon);
  });

  it("keeps a trusted listing icon ahead of the fallback", () => {
    const html = renderToStaticMarkup(
      createElement(PluginStoreAvatar, {
        item: {
          name: "example-plugin",
          listing: { icon: "https://cdn.example.com/example.png" },
        },
        className: "size-10",
      }),
    );

    expect(html).toContain('src="https://cdn.example.com/example.png"');
    expect(html).not.toContain("lucide-blocks");
  });

  it("rewrites legacy NIBI icon hosts that were cached before the domain migration", () => {
    const html = renderToStaticMarkup(
      createElement(PluginStoreAvatar, {
        item: {
          name: "legacy-plugin",
          listing: { icon: "https://api.nibistudio.top/plugins/icons/legacy.png" },
        },
        className: "size-10",
      }),
    );

    expect(html).toContain('src="https://api.nibistudio.cn/plugins/icons/legacy.png"');
    expect(html).not.toContain("api.nibistudio.top");
  });

  it("renders a deterministic initial avatar instead of an empty container", () => {
    const html = renderToStaticMarkup(
      createElement(PluginStoreAvatar, {
        item: { id: "example-plugin@nibi-official", name: "example-plugin" },
        className: "size-10",
      }),
    );

    // 首字母 + 暖色底；既不是空 div，也不是默认的 Blocks 图标。
    expect(html).toContain(">E<");
    expect(html).not.toContain("lucide-blocks");
    expect(html).toMatch(/background-color:#[0-9A-F]{6}/i);
    expect(html).not.toContain("<img");
  });
});
