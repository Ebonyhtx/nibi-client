// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";
import { SettingsSearch } from "../src/settings-search/SettingsSearch.js";

vi.mock("@/i18n/IntlProvider.js", () => {
  const intl = {
    formatMessage: ({ id }: { id: string }) => (zhCN as Record<string, string>)[id] ?? id,
  };
  return { useNibiIntl: () => ({ intl }) };
});

afterEach(cleanup);

describe("SettingsSearch", () => {
  const sections = createSettingsPageConfig({ isMacDesktop: true }).settingsSections;

  it("回车跳转首个匹配项并带上深链锚点", () => {
    const onNavigate = vi.fn();
    render(
      createElement(SettingsSearch, {
        settingsSections: sections,
        isDesktop: true,
        isMacDesktop: true,
        onNavigate,
      }),
    );

    const input = screen.getByTestId("settings-search-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "字体平滑" } });
    expect(screen.getAllByTestId("settings-search-result").length).toBeGreaterThan(0);

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        sectionId: "appearance",
        targetId: "appearance.fontSmoothing",
      }),
    );
    expect(input.value).toBe("");
  });

  it("Escape 清空查询", () => {
    render(
      createElement(SettingsSearch, {
        settingsSections: sections,
        isDesktop: true,
        isMacDesktop: true,
        onNavigate: vi.fn(),
      }),
    );

    const input = screen.getByTestId("settings-search-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "项目" } });
    expect(input.value).toBe("项目");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });

  it("无匹配时显示空态", () => {
    render(
      createElement(SettingsSearch, {
        settingsSections: sections,
        isDesktop: true,
        isMacDesktop: true,
        onNavigate: vi.fn(),
      }),
    );

    fireEvent.change(screen.getByTestId("settings-search-input"), {
      target: { value: "绝对不存在的设置项" },
    });

    expect(screen.getByTestId("settings-search-no-results").textContent).toBe("没有匹配的设置");
  });
});