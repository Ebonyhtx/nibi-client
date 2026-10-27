// @vitest-environment jsdom

import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { isMarketingBannerRenderable } from "@/components/marketing-touch/marketingTouchController.js";
import type { MarketingTouchController } from "@/components/marketing-touch/marketingTouchController.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

// 领 token banner 的真实渲染树依赖 iframe/cloud-hero/intl，已由 marketingBanner.test.ts 覆盖；
// 这里只验槽位仲裁，故把 MarketingBanner 换成轻量桩，保留真实的 useMarketingBannerVisible 与 Context。
vi.mock("@/components/marketing-touch/MarketingTouchProvider.js", async (importActual) => {
  const actual =
    await importActual<typeof import("@/components/marketing-touch/MarketingTouchProvider.js")>();
  return {
    ...actual,
    MarketingBanner: () =>
      createElement("div", { "data-testid": "marketing-banner-stub" }, "banner"),
  };
});

// 在 mock 之后再引入被测组件与 Context，确保拿到打了桩的 MarketingBanner。
import { SidebarBottomActivity } from "@/sidebar-activity/SidebarBottomActivity.js";
import { MarketingTouchContext } from "@/components/marketing-touch/MarketingTouchProvider.js";

// 构造一个仅够 useMarketingBannerVisible 读取的假控制器：只需要 store.subscribe / getState().banner。
function fakeController(banner: unknown): MarketingTouchController {
  const store = createStore(() => ({ banner }));
  return { store } as unknown as MarketingTouchController;
}

// 可渲染的 banner 候选：满足 isMarketingBannerRenderable 谓词的最小结构。
const renderableBanner = {
  delivery: { resource_position: "banner" },
  image: "data:image/png;base64,a",
} as unknown;

function renderActivity(controller: MarketingTouchController) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        MarketingTouchContext.Provider,
        { value: controller },
        createElement(SidebarBottomActivity),
      ),
    ),
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("isMarketingBannerRenderable", () => {
  it("popup 位置的投放不算左下角 banner", () => {
    expect(
      isMarketingBannerRenderable({
        delivery: { resource_position: "popup" },
        image: "x",
      } as never),
    ).toBe(false);
  });
  it("banner 位置但无图无 hero 时不可见", () => {
    expect(
      isMarketingBannerRenderable({ delivery: { resource_position: "banner" } } as never),
    ).toBe(false);
  });
  it("banner 位置且有 bannerHero 时可见", () => {
    expect(
      isMarketingBannerRenderable({
        delivery: { resource_position: "banner" },
        bannerHero: { type: "video" },
      } as never),
    ).toBe(true);
  });
});

describe("SidebarBottomActivity 共享槽位仲裁", () => {
  it("banner 可见 → 渲染领 token banner", () => {
    const { container } = renderActivity(fakeController(renderableBanner));
    expect(container.querySelector('[data-testid="marketing-banner-stub"]')).not.toBeNull();
  });

  it("banner 不可见 → 槽位不产生多余内容", () => {
    const { container } = renderActivity(fakeController(null));
    expect(container.querySelector('[data-testid="marketing-banner-stub"]')).toBeNull();
  });

  it("banner 关闭后 → 槽位清空", () => {
    const controller = fakeController(renderableBanner);
    const { container } = renderActivity(controller);
    expect(container.querySelector('[data-testid="marketing-banner-stub"]')).not.toBeNull();

    act(() => {
      controller.store.setState({ banner: null } as never);
    });

    expect(container.querySelector('[data-testid="marketing-banner-stub"]')).toBeNull();
  });
});
