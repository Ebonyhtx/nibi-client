import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sortPluginStoreEntries } from "@nibi/shared";
import { groupItemsByCategory, type StorePluginItem } from "../src/settings/pluginStoreListing.js";

function item(name: string, category?: string): StorePluginItem {
  return {
    id: `${name}@official`,
    name,
    marketplace: "official",
    installed: false,
    restorable: false,
    orphaned: false,
    listing: { category },
  };
}

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

describe("公开分类排序", () => {
  it("详情页也将旧指南分类显示为实用工具", async () => {
    const { PluginStoreDetailView } = await import("../src/settings/PluginStoreDetailView.js");
    const html = renderToStaticMarkup(
      createElement(PluginStoreDetailView, {
        item: item("zcode-guide", "guides"),
        actions: {
          onOpenDetail() {},
          onInstall() {},
          onUninstall() {},
          onSetEnabled() {},
          onUpdate() {},
          activeOperations: [],
          togglingPluginId: null,
        },
        onRetryDescribe() {},
        onUsePrompt() {},
      }),
    );
    expect(html).toContain("settings.plugins.store.category.utilities");
  });
  it("旧指南类目并入实用工具且不改变插件身份，legal 无插件时不显示", () => {
    const entries = [item("zcode-guide", "guides"), item("skill-creator", "utilities")];
    const groups = groupItemsByCategory(entries, "zh-CN", {
      categoryOrder: ["legal", "guides", "utilities"],
    });
    expect(groups.map((group) => group.category)).toEqual(["utilities"]);
    expect(groups[0]?.items.map((entry) => entry.id).sort()).toEqual(
      entries.map((entry) => entry.id).sort(),
    );
    expect(entries[0]?.listing?.category).toBe("guides");
  });

  it("未来法律插件可按服务端分类及插件顺序展示", () => {
    const groups = groupItemsByCategory(
      [item("contract", "legal"), item("research", "legal"), item("util", "utilities")],
      "en-US",
      {
        categoryOrder: ["legal", "utilities"],
        pluginOrder: { legal: ["research@official", "contract@official"] },
      },
    );
    expect(groups.map((group) => group.category)).toEqual(["legal", "utilities"]);
    expect(groups[0]?.items.map((entry) => entry.name)).toEqual(["research", "contract"]);
  });
  it("未知分类碰巧与对象原型属性同名时仍可使用默认排序", () => {
    const entries = [item("b", "constructor"), item("a", "constructor")];
    expect(
      groupItemsByCategory(entries, "en-US", { pluginOrder: {} })[0]?.items.map(
        (entry) => entry.name,
      ),
    ).toEqual(["a", "b"]);
  });
  const items = [
    item("z", "productivity"),
    item("a", "productivity"),
    item("b", "developer-tools"),
    item("c"),
    item("d", "unknown"),
  ];

  it("分类及分类内插件独立排序，未配置项保留默认，显式 other 可置顶", () => {
    const before = structuredClone(items);
    const groups = groupItemsByCategory(items, "en-US", {
      categoryOrder: ["missing", "other", "developer-tools", "other"],
      pluginOrder: { productivity: ["missing@official", "z@official", "z@official"] },
    });
    expect(groups.map((group) => group.category)).toEqual([
      "other",
      "developer-tools",
      "productivity",
      "unknown",
    ]);
    expect(groups[2]?.items.map((entry) => entry.name)).toEqual(["z", "a"]);
    expect(items).toEqual(before);
  });

  it.each(["zh-CN", "en-US"])("无配置保持原排序 %s", (locale) => {
    const groups = groupItemsByCategory(items, locale);
    expect(groups.map((group) => group.category)).toEqual([
      "productivity",
      "developer-tools",
      "unknown",
      "other",
    ]);
    expect(groups[0]?.items.map((entry) => entry.name)).toEqual(["a", "z"]);
  });

  it("ID 必须完整匹配，不能跨分类搬动或加入插件", () => {
    const groups = groupItemsByCategory(items, "en-US", {
      pluginOrder: { productivity: ["z", "z@personal", "b@official"] },
    });
    expect(groups[0]?.items.map((entry) => entry.name)).toEqual(["a", "z"]);
    expect(groups.flatMap((group) => group.items)).toHaveLength(items.length);
  });
});

/** 构造带安装态/启用态的商店条目；不传 installed 即未安装。 */
function storeEntry(
  name: string,
  options: { category?: string; installed?: boolean; enabled?: boolean } = {},
): StorePluginItem {
  const marketplace = "official";
  const id = `${name}@${marketplace}`;
  return {
    id,
    name,
    marketplace,
    installed: options.installed ?? false,
    restorable: false,
    orphaned: false,
    listing: { category: options.category },
    ...(options.installed
      ? {
          installedMeta: {
            id,
            name,
            marketplace,
            enabled: options.enabled ?? true,
            scope: "user" as const,
          },
        }
      : {}),
  };
}

const names = (group: { items: StorePluginItem[] } | undefined) =>
  group?.items.map((entry) => entry.name) ?? [];

describe("已安装优先（分类内稳定键）", () => {
  it("已安装排在未安装前，分类分组与组间顺序不变", () => {
    const groups = groupItemsByCategory(
      [
        storeEntry("a", { category: "productivity" }),
        storeEntry("c", { category: "productivity", installed: true }),
        storeEntry("b", { category: "developer-tools" }),
        storeEntry("d", { category: "developer-tools", installed: true }),
      ],
      "en-US",
    );
    expect(groups.map((group) => group.category)).toEqual(["productivity", "developer-tools"]);
    expect(names(groups[0])).toEqual(["c", "a"]);
    expect(names(groups[1])).toEqual(["d", "b"]);
    // 安装态只改变顺序：每个条目仍只出现一次，没有被 strip 复制或移除。
    expect(groups.flatMap((group) => group.items)).toHaveLength(4);
  });

  it("只有后置分类装了插件时也不会把该分类整体提前", () => {
    const groups = groupItemsByCategory(
      [
        storeEntry("a", { category: "productivity" }),
        storeEntry("b", { category: "developer-tools" }),
        storeEntry("c", { category: "developer-tools", installed: true }),
      ],
      "en-US",
    );
    expect(groups.map((group) => group.category)).toEqual(["productivity", "developer-tools"]);
    expect(names(groups[0])).toEqual(["a"]);
    expect(names(groups[1])).toEqual(["c", "b"]);
  });

  it("已安装组内保留既有配置顺序，未安装组的相对顺序也不变", () => {
    const groups = groupItemsByCategory(
      ["c", "a", "d", "b"].map((name) =>
        storeEntry(name, { installed: name === "a" || name === "b" }),
      ),
      "en-US",
      { pluginOrder: { productivity: ["c@official", "a@official", "d@official", "b@official"] } },
    );
    // 原顺序 c→a→d→b；安装态只做稳定分组：已安装 a→b，未安装 c→d。
    expect(names(groups[0])).toEqual(["a", "b", "c", "d"]);
  });

  it("已安装且已启用优先于已安装但停用，未安装不会越过两者", () => {
    const groups = groupItemsByCategory(
      [
        storeEntry("a"),
        storeEntry("z", { installed: true, enabled: false }),
        storeEntry("y", { installed: true, enabled: true }),
      ],
      "en-US",
    );
    expect(names(groups[0])).toEqual(["y", "z", "a"]);
  });

  it("已安装优先于文档插件默认顺序（文档插件未安装时不再置顶）", () => {
    const groups = groupItemsByCategory(
      [storeEntry("pdf", { installed: false }), storeEntry("zeta", { installed: true })],
      "en-US",
    );
    expect(names(groups[0])).toEqual(["zeta", "pdf"]);
  });

  it("全部未安装时顺序与空已安装列表一致，且不产生空分组/空条", () => {
    const entries = [
      storeEntry("b", { category: "utilities" }),
      storeEntry("a", { category: "utilities" }),
    ];
    const groups = groupItemsByCategory(entries, "en-US");
    expect(groups.map((group) => group.category)).toEqual(["utilities"]);
    expect(names(groups[0])).toEqual(["a", "b"]);
    expect(groups.every((group) => group.items.length > 0)).toBe(true);
    expect(groups.flatMap((group) => group.items)).toHaveLength(entries.length);
  });

  it("Picker/市场预览不传安装态时保持原有排序", () => {
    const entries = [
      { id: "z@official", category: "productivity", displayName: "Z" },
      { id: "a@official", category: "productivity", displayName: "A" },
    ];
    expect(
      sortPluginStoreEntries(entries, (entry) => entry, "en-US", {
        pluginOrder: { productivity: ["z@official", "a@official"] },
      }).map((entry) => entry.id),
    ).toEqual(["z@official", "a@official"]);
  });
});
