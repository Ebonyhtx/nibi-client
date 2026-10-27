import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RootStartupLoading, ZCodeStartupLogoBadge } from "@/root/RootStartupLoading.js";

// 品牌图标已换成真实 app icon（PNG），不再用内联 SVG：
// 内联几何图形在不同尺寸下边缘会糊，这一点在面板顶栏/空状态上已经踩过。
describe("RootStartupLoading", () => {
  it("静态品牌图标用打包图片且不渲染呼吸动画", () => {
    const html = renderToStaticMarkup(createElement(ZCodeStartupLogoBadge, { animated: false }));
    expect(html).toContain("<img");
    expect(html).toContain("nibi-app-icon");
    expect(html).toContain("rounded-3xl");
    expect(html).not.toContain("animate-[");
    expect(html).not.toContain("<animate");
  });

  it("启动阻塞态给整块容器加呼吸动画，而不是露出 loading 文案", () => {
    const html = renderToStaticMarkup(createElement(RootStartupLoading, { label: "加载中..." }));

    expect(html).toContain('data-testid="root-startup-loading"');
    expect(html).toContain('aria-label="加载中..."');
    expect(html).toContain("<img");
    expect(html).toContain("nibi-app-icon");
    expect(html).toContain("animate-[nibi-startup-breathe");
    expect(html).not.toContain(">加载中...<");
  });
});
