import { describe, expect, it } from "vitest";
import type { ZCodePluginReferenceCatalogEntry } from "@nibi/shared";
import {
  buildWorkspacePluginMention,
  isWorkspacePluginReferenceable,
} from "../src/workspace-plugin-preview/index.js";

function entry(
  overrides: Partial<ZCodePluginReferenceCatalogEntry> = {},
): ZCodePluginReferenceCatalogEntry {
  return {
    pluginId: "pdf@nibi-official",
    name: "pdf",
    marketplace: "nibi-official",
    icon: "https://cdn.example.com/pdf.png",
    enabled: true,
    conflictingPluginIds: [],
    skillQualifiedNames: ["pdf:read"],
    mcpServerNames: [],
    subagentNames: [],
    ...overrides,
  };
}

describe("workspace plugin preview", () => {
  it("只允许已启用且无冲突的 workspace catalog 插件被引用", () => {
    expect(isWorkspacePluginReferenceable(entry())).toBe(true);
    expect(isWorkspacePluginReferenceable(entry({ enabled: false }))).toBe(false);
    expect(
      isWorkspacePluginReferenceable(entry({ conflictingPluginIds: ["pdf@personal-marketplace"] })),
    ).toBe(false);
  });

  it("构造与 Composer @ Picker 相同的 canonical 插件引用", () => {
    expect(buildWorkspacePluginMention(entry())).toEqual({
      id: "plugin:pdf@nibi-official",
      category: "plugins",
      label: "pdf",
      value: "pdf@nibi-official",
      markdown: "[@pdf](plugin://pdf@nibi-official)",
      data: {
        pluginId: "pdf@nibi-official",
        icon: "https://cdn.example.com/pdf.png",
      },
    });
  });
});
