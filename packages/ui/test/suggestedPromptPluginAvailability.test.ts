import { describe, expect, it } from "vitest";
import {
  collectSuggestedPromptPluginIds,
  draftSuggestedPromptFallback,
  filterSuggestedPromptItemsByPluginAvailability,
  type DraftSuggestedPromptItem,
} from "@/v4/draftSuggestedPromptItems.js";

function item(overrides: Partial<DraftSuggestedPromptItem> & Pick<DraftSuggestedPromptItem, "id">) {
  return {
    id: overrides.id,
    label: { cn: "标签", en: "Label" },
    prompt: { cn: "提示词", en: "Prompt" },
    ...overrides,
  } satisfies DraftSuggestedPromptItem;
}

describe("suggested prompt Plugin availability", () => {
  it("collects both the structured Plugin and inline plugin:// mentions", () => {
    expect(
      collectSuggestedPromptPluginIds(
        item({
          id: "mixed",
          plugin: { stableId: "documents@nibi-official", label: { cn: "文档", en: "Docs" } },
          prompt: {
            cn: "用 [@PDF](plugin://pdf@nibi-official) 生成报告",
            en: "Use [@PDF](plugin://pdf@nibi-official) to build a report",
          },
        }),
      ),
    ).toEqual(["documents@nibi-official", "pdf@nibi-official"]);
  });

  it("drops cards whose Plugin is absent from the installed catalog", () => {
    const available = new Set(["documents@nibi-official"]);
    const items = [
      item({
        id: "installed",
        plugin: { stableId: "documents@nibi-official", label: { cn: "文档", en: "Docs" } },
      }),
      item({
        id: "missing",
        plugin: { stableId: "lark-cli@nibi-official", label: { cn: "飞书", en: "Lark" } },
      }),
      item({
        id: "missing-inline",
        prompt: { cn: "用 [@飞书](plugin://lark-cli@nibi-official)", en: "Use Lark" },
      }),
      item({ id: "plain" }),
    ];

    expect(
      filterSuggestedPromptItemsByPluginAvailability(items, available).map((entry) => entry.id),
    ).toEqual(["installed", "plain"]);
  });

  it("fails open while the catalog is still loading or unavailable", () => {
    const items = [
      item({
        id: "depends-on-plugin",
        plugin: { stableId: "lark-cli@nibi-official", label: { cn: "飞书", en: "Lark" } },
      }),
    ];

    expect(filterSuggestedPromptItemsByPluginAvailability(items, null)).toEqual(items);
  });

  it("keeps the local 404 fallback free of Plugin dependencies", () => {
    for (const entry of draftSuggestedPromptFallback) {
      expect(collectSuggestedPromptPluginIds(entry)).toEqual([]);
      expect(entry.prompt.cn).not.toContain("plugin://");
      expect(entry.prompt.en).not.toContain("plugin://");
    }
  });
});
