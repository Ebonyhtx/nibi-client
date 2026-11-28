// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { AppearanceSectionContent } from "@/settingsCodePreview.js";
import type { Theme } from "@/useTheme.js";

vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code }: { code: string }) => createElement("pre", null, code),
}));

vi.mock("@/settings/CompanionSettingsRows.js", () => ({
  CompanionSettingsRows: () => null,
}));

function renderAppearance(theme: Theme, setTheme = vi.fn()) {
  render(
    createElement(
      NibiIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(AppearanceSectionContent, {
        codePreviewSettings: {
          lightTheme: "github-light",
          darkTheme: "github-dark",
          showLineNumbers: true,
          wrapLongLines: false,
          fontSizePx: 13,
        },
        setCodePreviewSettings: vi.fn(),
        theme,
        setTheme,
        uiFontSizePx: 14,
        setUiFontSizePx: vi.fn(),
        motionEnabled: true,
        setMotionEnabled: vi.fn(),
      }),
    ),
  );
  return { setTheme };
}

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppearanceSectionContent theme gallery", () => {
  it("renders all five Folio Desk theme cards and highlights the active one", () => {
    renderAppearance("nibi-mist");

    const radiogroup = screen.getByRole("radiogroup");
    expect(radiogroup).toBeTruthy();

    for (const mode of ["system", "nibi-light", "nibi-mist", "nibi-dark", "nibi-obsidian"]) {
      const card = screen.getByTestId(`appearance-theme-card-${mode}`);
      expect(card.getAttribute("role")).toBe("radio");
      expect(card.getAttribute("aria-checked")).toBe(mode === "nibi-mist" ? "true" : "false");
    }

    const activeBadge = screen.getByTestId("appearance-theme-active-badge");
    expect(activeBadge.textContent?.trim().length).toBeGreaterThan(0);
  });

  it("normalizes legacy theme values and switches themes on card click", () => {
    const setTheme = vi.fn();
    renderAppearance("dark", setTheme);

    expect(
      screen.getByTestId("appearance-theme-card-nibi-dark").getAttribute("aria-checked"),
    ).toBe("true");

    fireEvent.click(screen.getByTestId("appearance-theme-card-nibi-obsidian"));
    expect(setTheme).toHaveBeenCalledTimes(1);
    expect(setTheme).toHaveBeenCalledWith("nibi-obsidian");
  });
});
