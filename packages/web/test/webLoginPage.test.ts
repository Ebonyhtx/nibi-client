// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NIBI_PROVIDER_ID } from "@nibi/shared";
import { WebLoginPage } from "../src/auth/WebLoginPage.js";

describe("手机远控登录页", () => {
  it.each(["zh-CN", "en-US"] as const)("%s 页头显示品牌与本地化登录标题", (lang) => {
    document.documentElement.lang = lang;
    const html = renderToStaticMarkup(createElement(WebLoginPage, { onLogin: () => {} }));
    expect(html).toContain("NIBI");
    expect(html).toContain(
      lang === "zh-CN" ? "登录后继续使用 Web 远程控制" : "Sign In To Continue",
    );
  });

  it.each(["zh-CN", "en-US"] as const)("%s 只显示 NIBI 账号入口", (lang) => {
    document.documentElement.lang = lang;
    const providers: string[] = [];
    const html = renderToStaticMarkup(
      createElement(WebLoginPage, { onLogin: (provider: string) => providers.push(provider) }),
    );
    expect(html).toContain(lang === "zh-CN" ? "使用 NIBI 账号登录" : "Sign in with NIBI");
    expect(html).not.toContain("Z.ai");
    expect(html).not.toContain("BigModel");
    expect(NIBI_PROVIDER_ID).toBe("nibi");
    expect(providers).toEqual([]);
  });
});
