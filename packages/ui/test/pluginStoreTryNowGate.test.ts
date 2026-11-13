import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NibiPluginInfo } from "@nibi/shared";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";
import type { PluginStoreActions } from "../src/settings/PluginStoreCard.js";
import { runPluginTryPromptFlow } from "../src/settings/pluginTryPromptFlow.js";

// 详情页「立即试用」在插件不可用时必须给出明确提示；点击必须走与「启用」相同的门禁，
// 不能把试用消息预填成待发送草稿（运营者实机 BUG 回归）。
const { buttonProps } = vi.hoisted(() => ({
  buttonProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) => {
    buttonProps.push(props);
    return createElement("button", props as Record<string, unknown>, children);
  },
}));

// 与 pluginStorePaidPlanBadge.test.ts 同款：ControlHintTooltip 依赖 Root 的 TooltipProvider，
// SSR 单测里桩成透传 span，把 title 落到属性上便于断言 hover 文案。
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: string }) =>
    createElement("span", { "data-tooltip-title": title }, children),
}));

function installedItem(overrides: Partial<StorePluginItem> = {}): StorePluginItem {
  const info: NibiPluginInfo = {
    id: "demo@market",
    name: "demo",
    marketplace: "market",
    enabled: true,
    source: "official",
    skillCount: 0,
    skillRootCount: 0,
    commandRootCount: 0,
    declaredMcpServerNames: [],
    mcpServerNames: [],
    rootPath: "/cache/demo",
  };
  return {
    id: info.id,
    name: info.name,
    marketplace: info.marketplace,
    installed: true,
    restorable: false,
    orphaned: false,
    paid: false,
    info,
    ...overrides,
  };
}

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

async function renderDetail(
  item: StorePluginItem,
  options: {
    canUsePaidPlugins?: boolean;
    onUsePrompt?: (item: StorePluginItem, prompt: string) => void;
  } = {},
): Promise<string> {
  const { PluginStoreDetailView } = await import("../src/settings/PluginStoreDetailView.js");
  const { NibiIntlProvider } = await import("@/i18n/IntlProvider.js");
  return renderToStaticMarkup(
    createElement(
      NibiIntlProvider,
      { initialLocale: "en-US" },
      createElement(PluginStoreDetailView, {
        item,
        actions: makeActions(),
        onRetryDescribe: () => {},
        onUsePrompt: options.onUsePrompt ?? (() => {}),
        canUsePaidPlugins: options.canUsePaidPlugins ?? true,
      }),
    ),
  );
}

function tryNowProps() {
  // 同一次渲染可能先渲染过多次详情页；取最后一次捕获的按钮。
  return buttonProps.filter((props) => props["data-testid"] === "plugin-store-try-now").at(-1);
}

describe("PluginStoreDetailView try-now gate", () => {
  afterEach(() => {
    buttonProps.length = 0;
  });

  it("付费插件无会员：按钮标注会员引导提示", async () => {
    const html = await renderDetail(
      installedItem({
        paid: true,
        info: { ...installedItem().info!, enabled: false },
      }),
      { canUsePaidPlugins: false },
    );
    expect(html).toContain('data-try-prompt-blocked="membership"');
    expect(html).toContain("Activate membership to try this plugin.");
  });

  it("免费插件未启用：按钮标注「先启用」提示", async () => {
    const html = await renderDetail(
      installedItem({ info: { ...installedItem().info!, enabled: false } }),
    );
    expect(html).toContain('data-try-prompt-blocked="enable"');
    expect(html).toContain("Trying it will enable it first.");
  });

  it("已启用：不显示阻断提示，行为不变", async () => {
    const html = await renderDetail(installedItem());
    expect(html).not.toContain("data-try-prompt-blocked");
    expect(html).not.toContain("Trying it will enable it first.");
  });

  it("未启用 + 无会员时点击不启动草稿，只给出会员引导", async () => {
    await renderDetail(
      installedItem({
        paid: true,
        info: { ...installedItem().info!, enabled: false },
      }),
      { canUsePaidPlugins: false },
    );
    const requireMembership = vi.fn(async () => true);
    const enable = vi.fn(async () => true);
    const start = vi.fn();
    let flow: Promise<unknown> | undefined;
    // 真实页面把 onUsePrompt 接到同一个门禁编排上；这里复现该接线并断言发送入口没被调用。
    await renderDetail(
      installedItem({
        paid: true,
        info: { ...installedItem().info!, enabled: false },
      }),
      {
        canUsePaidPlugins: false,
        onUsePrompt: (item) => {
          flow = runPluginTryPromptFlow(item, {
            canUsePaidPlugins: false,
            install: vi.fn(),
            requireMembership,
            enable,
            start,
          });
        },
      },
    );
    (tryNowProps()?.onClick as (() => void) | undefined)?.();
    await flow;
    expect(requireMembership).toHaveBeenCalledTimes(1);
    expect(enable).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("已启用时点击照常预填草稿", async () => {
    const start = vi.fn();
    let flow: Promise<unknown> | undefined;
    await renderDetail(installedItem(), {
      onUsePrompt: (item) => {
        flow = runPluginTryPromptFlow(item, {
          canUsePaidPlugins: true,
          install: vi.fn(),
          requireMembership: vi.fn(async () => false),
          enable: vi.fn(async () => true),
          start,
        });
      },
    });
    (tryNowProps()?.onClick as (() => void) | undefined)?.();
    await flow;
    expect(start).toHaveBeenCalledTimes(1);
  });
});
