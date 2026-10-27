// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@nibi/shared";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";

vi.mock("@/hooks/useInterfaceMode.js", () => ({ useIsOfficeMode: () => false }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/settings/PluginStoreCard.js", () => ({
  PluginStoreCard: ({ item }: { item: StorePluginItem }) =>
    createElement("div", { "data-testid": "card" }, item.id),
}));
vi.mock("@/settings/PluginStoreAvatar.js", () => ({ PluginStoreAvatar: () => null }));
vi.mock("@/settings/NibiMembershipDialog.js", () => ({ NibiMembershipDialog: () => null }));
import { PluginStoreListView } from "../src/settings/PluginStoreListView.js";

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(() => root?.unmount());
  root = undefined;
});

function item(name: string, paid?: boolean): StorePluginItem {
  return {
    id: `${name}@${NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID}`,
    name,
    marketplace: NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    paid,
    installed: false,
    restorable: false,
    orphaned: false,
    listing: { category: "productivity", publisherType: "official" },
    summary: {
      id: `${name}@${NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID}`,
      name,
      marketplace: NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID,
      installed: false,
      componentTypes: [],
    },
  } as StorePluginItem;
}

describe("paid plugin grouping", () => {
  it("renders a paid plugin once (members-only group) and keeps the membership entry", async () => {
    const container = document.createElement("div");
    root = createRoot(container);
    await act(() =>
      root?.render(
        createElement(PluginStoreListView, {
          items: [item("math-modeling", true), item("github")],
          marketplaces: [],
          actions: {} as PluginStoreActions,
          loading: false,
          query: "",
          segment: "public",
          onQueryChange: vi.fn(),
          onSegmentChange: vi.fn(),
        }),
      ),
    );
    const cards = [...container.querySelectorAll('[data-testid="card"]')].map(
      (card) => card.textContent,
    );
    expect(cards.filter((text) => text === `math-modeling@${NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID}`)).toHaveLength(1);
    expect(cards.filter((text) => text === `github@${NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID}`)).toHaveLength(1);
    // 会员入口已移到左下角账户菜单：市场顶部不再常驻促销横幅。
    expect(container.querySelector('[data-testid="nibi-membership-banner"]')).toBeNull();
  });
});
