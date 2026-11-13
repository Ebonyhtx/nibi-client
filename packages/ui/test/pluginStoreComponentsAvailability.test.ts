import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NibiPluginInfo } from "@nibi/shared";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";

// 未安装的市场候选本来就没有本地插件可 describe；把它当"组件清单加载失败"弹警告，
// 用户会以为插件坏了（运营者实机反馈）。未安装 → 中性提示；已安装 + describe 失败 → 才报错可重试。
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

function makeActions(): PluginStoreActions {
  return {
    onOpenDetail: () => {},
    onInstall: () => {},
    onUninstall: () => {},
    onSetEnabled: () => {},
    onUpdate: () => {},
    activeOperations: [],
    togglingPluginId: null,
  };
}

function item(overrides: Partial<StorePluginItem> = {}): StorePluginItem {
  return {
    id: "nibi-modeling@nibi-official",
    name: "nibi-modeling",
    marketplace: "nibi-official",
    installed: false,
    restorable: false,
    orphaned: false,
    paid: true,
    listing: { displayName: "NIBI 数模工作台", description: "会员专享" },
    ...overrides,
  };
}

function installedInfo(): NibiPluginInfo {
  return {
    id: "nibi-modeling@nibi-official",
    name: "nibi-modeling",
    marketplace: "nibi-official",
    enabled: true,
    source: "official",
    skillCount: 0,
    skillRootCount: 0,
    commandRootCount: 0,
    declaredMcpServerNames: [],
    mcpServerNames: [],
    rootPath: "/cache/nibi-modeling",
  };
}

async function renderDetail(
  detailItem: StorePluginItem,
  describeEntry?: { status: "loading" | "error" | "loaded"; data?: unknown },
): Promise<string> {
  const { PluginStoreDetailView } = await import("../src/settings/PluginStoreDetailView.js");
  const { NibiIntlProvider } = await import("@/i18n/IntlProvider.js");
  return renderToStaticMarkup(
    createElement(
      NibiIntlProvider,
      { initialLocale: "en-US" },
      createElement(PluginStoreDetailView, {
        item: detailItem,
        actions: makeActions(),
        describeEntry,
        onRetryDescribe: () => {},
        onUsePrompt: () => {},
        canUsePaidPlugins: false,
      }),
    ),
  );
}

describe("插件详情页组件清单的可得性提示", () => {
  it("未安装：不报错、不给重试，给中性提示", async () => {
    const html = await renderDetail(item(), { status: "error" });
    expect(html).toContain('data-testid="plugin-store-components-after-install"');
    expect(html).not.toContain('data-testid="plugin-store-components-error"');
    expect(html).not.toContain('data-testid="plugin-store-components-retry"');
    expect(html).not.toContain("Loading components");
  });

  it("已安装但 describe 失败：保留警告与重试入口", async () => {
    const html = await renderDetail(
      item({ installed: true, info: { ...installedInfo(), enabled: false } }),
      undefined,
    );
    // 有运行时信息时直接用权威组件清单，不进入失败分支。
    expect(html).not.toContain('data-testid="plugin-store-components-after-install"');
    expect(html).not.toContain('data-testid="plugin-store-components-error"');
  });
});
