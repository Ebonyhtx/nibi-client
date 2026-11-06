// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyTheme, loadThemePreference } from "@/useTheme.js";
import { NIBI_PREFS_KEY, NIBI_PREFS_VERSION } from "@/lib/nibiStorage.js";

beforeEach(() => {
  localStorage.clear();
  document.head.innerHTML = "";
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-nibi-browser-theme-surface");
  document.documentElement.removeAttribute("style");
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("applyTheme", () => {
  it.each([
    ["nibi-dark", "dark", "#161616"],
    ["nibi-light", "light", "#f8f8f8"],
  ] as const)("把 %s 同步到已 opt-in 的浏览器主题表面", (theme, resolvedTheme, background) => {
    document.documentElement.setAttribute("data-nibi-browser-theme-surface", "light");
    document.documentElement.style.setProperty("--color-background", background);
    document.head.innerHTML = `
        <meta name="theme-color" content="#ffffff" />
        <meta name="color-scheme" content="light" />
      `;

    applyTheme(theme);

    expect(document.documentElement.getAttribute("data-nibi-browser-theme-surface")).toBe(
      resolvedTheme,
    );
    expect(document.documentElement.style.colorScheme).toBe(resolvedTheme);
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      background,
    );
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
      resolvedTheme,
    );
  });

  it("system 模式用浏览器偏好同步同一份 resolved theme", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    document.documentElement.setAttribute("data-nibi-browser-theme-surface", "light");
    document.documentElement.style.setProperty("--color-background", "#161616");

    applyTheme("system");

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("theme-nibi-dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-nibi-browser-theme-surface")).toBe("dark");
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute("content")).toBe(
      "#161616",
    );
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
      "dark",
    );
  });

  it("未 opt-in 的 Electron 页面只切换既有主题 class", () => {
    applyTheme("nibi-dark");

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("theme-nibi-dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("");
    expect(document.querySelector('meta[name="theme-color"]')).toBeNull();
    expect(document.querySelector('meta[name="color-scheme"]')).toBeNull();
  });

  it("轻量 DOM shim 未提供浏览器表面能力时仍保留既有 class 切换", () => {
    const toggle = vi.fn();
    vi.stubGlobal("document", {
      documentElement: {
        classList: { toggle },
      },
    });

    expect(() => applyTheme("nibi-dark")).not.toThrow();
    expect(toggle).toHaveBeenCalledTimes(3);
  });
});

describe("loadThemePreference", () => {
  it("把 light/dark 归一化为 nibi-* 并回写", () => {
    localStorage.setItem(NIBI_PREFS_KEY, JSON.stringify({ version: NIBI_PREFS_VERSION, theme: "dark" }));

    expect(loadThemePreference()).toBe("nibi-dark");
    expect(localStorage.getItem(NIBI_PREFS_KEY)).toContain('"theme":"nibi-dark"');
  });

  it("偏好只落在 nibi:prefs，且带版本号", () => {
    localStorage.setItem(
      NIBI_PREFS_KEY,
      JSON.stringify({ version: NIBI_PREFS_VERSION, theme: "nibi-dark" }),
    );

    expect(loadThemePreference()).toBe("nibi-dark");
    expect(JSON.parse(localStorage.getItem(NIBI_PREFS_KEY)!)).toMatchObject({
      version: NIBI_PREFS_VERSION,
      theme: "nibi-dark",
    });
  });
});
