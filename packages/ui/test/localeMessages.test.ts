// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { LOCALE_MESSAGES } from "@/i18n/localeMessages.js";
import { NibiIntlProvider, useNibiIntl } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import koKR from "@/i18n/locales/ko-KR.js";
import jaJP from "@/i18n/locales/ja-JP.js";
import ruRU from "@/i18n/locales/ru-RU.js";
import zhCN from "@/i18n/locales/zh-CN.js";

function MessageProbe({ ids }: { ids: readonly string[] }) {
  const { intl, locale } = useNibiIntl();
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "locale" }, locale),
    createElement(
      "span",
      { "data-testid": "messages" },
      ids.map((id) => intl.formatMessage({ id })).join("|"),
    ),
  );
}

afterEach(() => {
  cleanup();
});

describe("五语言消息表", () => {
  it("en-US 与 zh-CN 完整；ja/ko/ru 只显式翻译上游交集并用英文补齐", () => {
    expect(Object.keys(LOCALE_MESSAGES["en-US"])).toHaveLength(Object.keys(enUS).length);
    expect(Object.keys(LOCALE_MESSAGES["zh-CN"])).toHaveLength(Object.keys(zhCN).length);
    for (const [locale, table] of [
      ["ja-JP", jaJP],
      ["ko-KR", koKR],
      ["ru-RU", ruRU],
    ] as const) {
      const effective = LOCALE_MESSAGES[locale];
      // 合并表必须覆盖全部英文 key：缺失时不会露出原始 id 或中文。
      expect(Object.keys(effective)).toHaveLength(Object.keys(enUS).length);
      expect(Object.keys(effective).sort()).toEqual(Object.keys(enUS).sort());
      expect(Object.keys(table).length).toBeGreaterThan(0);
      expect(Object.keys(table).length).toBeLessThan(Object.keys(enUS).length);
    }
  });

  it("显式翻译命中上游 key，NIBI 专属 key 回退英文而不是中文", () => {
    expect(LOCALE_MESSAGES["ja-JP"]["app.login"]).toBe("接続");
    expect(LOCALE_MESSAGES["ko-KR"]["app.login"]).not.toBe(enUS["app.login"]);
    expect(LOCALE_MESSAGES["ru-RU"]["app.login"]).not.toBe(enUS["app.login"]);

    // titleBar.menu.help.nibiEndpoint 是 NIBI 专属 key，上游 ja/ko/ru 没有。
    for (const locale of ["ja-JP", "ko-KR", "ru-RU"] as const) {
      expect(LOCALE_MESSAGES[locale]["titleBar.menu.help.nibiEndpoint"]).toBe(
        enUS["titleBar.menu.help.nibiEndpoint"],
      );
      expect(LOCALE_MESSAGES[locale]["titleBar.menu.help.nibiEndpoint"]).not.toBe(
        zhCN["titleBar.menu.help.nibiEndpoint"],
      );
    }
  });

  it("任何语言的表里都不存在「值就是 key」的原始 id", () => {
    for (const locale of ["zh-CN", "en-US", "ja-JP", "ko-KR", "ru-RU"] as const) {
      const rawIds = Object.entries(LOCALE_MESSAGES[locale])
        .filter(([key, value]) => value === key)
        .map(([key]) => key);
      expect(rawIds).toEqual([]);
    }
  });

  it("Provider 在 ja-JP 下渲染日语、NIBI-only key 显示英文，并同步 html lang", () => {
    render(
      createElement(
        NibiIntlProvider,
        { initialLocale: "ja-JP" },
        createElement(MessageProbe, {
          ids: ["app.login", "titleBar.menu.help.nibiEndpoint"],
        }),
      ),
    );
    expect(screen.getByTestId("locale").textContent).toBe("ja-JP");
    expect(screen.getByTestId("messages").textContent).toBe(
      "接続|Service endpoint (test builds only)",
    );
    expect(document.documentElement.lang).toBe("ja-JP");
  });
});
