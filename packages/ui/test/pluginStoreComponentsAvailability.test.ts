import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NibiPluginDescribeDeclaration, NibiPluginInfo } from "@nibi/shared";
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

function makeDeclaration(): NibiPluginDescribeDeclaration {
  return {
    permissions: {
      requested: ["filesystem.read", "network"],
      required: ["filesystem.read", "network", "process", "code"],
    },
    capabilities: {
      requested: [{ id: "nibi.sessions.read", scope: "workspace" }],
      granted: [],
    },
    hasCodeRuntime: true,
    trust: "community",
  };
}

async function renderDetail(
  detailItem: StorePluginItem,
  describeEntry?: { status: "loading" | "error" | "loaded"; data?: unknown },
  declaration?: NibiPluginDescribeDeclaration,
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
        declaration,
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

  it("未安装：详情高级区展示插件包声明的权限、能力与代码运行", async () => {
    const html = await renderDetail(item(), undefined, makeDeclaration());
    expect(html).toContain('data-testid="plugin-store-advanced"');
    expect(html).toContain('data-testid="plugin-store-declaration-note"');
    expect(html).toContain("Declared by this plugin package; nothing runs before install.");
    expect(html).toContain('data-testid="plugin-store-declaration-code-runtime"');
    expect(html).toContain("Includes executable code that runs after installation.");
    // 权限/能力沿用既有标签，不在声明区另造一套名字。
    expect(html).toContain("Read files in your workspace");
    expect(html).toContain("Read sessions in this workspace");
  });

  it("未安装且声明缺省：整块不渲染，不留占位文案", async () => {
    const html = await renderDetail(item());
    expect(html).not.toContain('data-testid="plugin-store-declaration-note"');
    expect(html).not.toContain('data-testid="plugin-store-declaration-code-runtime"');
    expect(html).not.toContain("Declared by this plugin package");
    expect(html).not.toContain('data-testid="plugin-store-advanced"');
  });
});
