// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_NAV_CLASSNAME,
  SETTINGS_NAV_LIST_CLASSNAME,
  SETTINGS_PAGE_LAYOUT_CLASSNAME,
} from "@/SettingsPage.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";

afterEach(cleanup);

describe("settings compact-web layout", () => {
  it("uses the two-row grid and horizontal nav classes only under compact-web", () => {
    expect(SETTINGS_PAGE_LAYOUT_CLASSNAME).toContain("compact-web:grid-cols-1");
    expect(SETTINGS_PAGE_LAYOUT_CLASSNAME).toContain(
      "compact-web:grid-rows-[auto_minmax(0,1fr)]",
    );
    expect(SETTINGS_PAGE_LAYOUT_CLASSNAME).toContain("lg:grid-cols-[268px_minmax(0,1fr)]");

    expect(SETTINGS_NAV_CLASSNAME).toContain("compact-web:overflow-x-auto");
    expect(SETTINGS_NAV_CLASSNAME).toContain("compact-web:overflow-y-hidden");
    expect(SETTINGS_NAV_CLASSNAME).toContain("overflow-y-auto");

    expect(SETTINGS_NAV_LIST_CLASSNAME).toContain("compact-web:flex");
    expect(SETTINGS_NAV_LIST_CLASSNAME).toContain("compact-web:space-y-0");
  });

  it("keeps row content on the original grid outside compact-web and wraps inline under it", () => {
    const { container } = render(
      createElement(SettingsRow, {
        label: "Label",
        description: "Description",
        control: createElement("button", { type: "button" }, "Action"),
      }),
    );
    const row = container.firstElementChild?.firstElementChild as HTMLElement;
    expect(row.className).toContain("grid-cols-[minmax(0,1fr)_192px]");
    expect(row.className).toContain("compact-web:flex");
    expect(row.className).toContain("compact-web:flex-wrap");
    expect(row.children[0]?.className).toContain("compact-web:flex-[999_1_10rem]");
    expect(row.children[1]?.className).toContain("compact-web:w-auto");
  });

  it("keeps resource header actions on one line under compact-web", () => {
    render(
      createElement(
        NibiIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          TooltipProvider,
          null,
          createElement(SettingsResourceHeaderActions, { onRefresh: vi.fn() }),
        ),
      ),
    );
    const actions = document.querySelector<HTMLElement>(
      '[class*="compact-web:shrink-0"]',
    ) as HTMLElement;
    expect(actions.className).toContain("compact-web:flex-nowrap");
    expect(actions.className).toContain("flex-wrap");
  });

function readStylesCss(): string {
  // 从 cwd 向上找，兼容「仓库根」与「packages/ui」两种测试启动目录；
  // 不用 import.meta.url：jsdom 环境下它不是 file: scheme。
  let directory = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of [
      resolve(directory, "src/styles.css"),
      resolve(directory, "packages/ui/src/styles.css"),
    ]) {
      if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`styles.css not found from ${process.cwd()}`);
}

  it("defines compact-web as a sub-640px variant that excludes desktop platforms", () => {
    const css = readStylesCss();
    const variant = /@custom-variant compact-web \{[\s\S]*?\n\}/u.exec(css)?.[0] ?? "";
    expect(variant).toContain("@media (width < 40rem)");
    expect(variant).toContain(
      ":root:not(.platform-mac-desktop, .platform-windows-desktop, .platform-linux-desktop)",
    );
  });
});