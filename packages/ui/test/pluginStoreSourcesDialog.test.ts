// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { AddMarketplaceSourceDialog } from "@/settings/AddMarketplaceSourceDialog.js";
import {
  PluginStoreSourceRefreshFailure,
  PluginStoreSourcesDialog,
} from "@/settings/PluginStoreSourcesDialog.js";

afterEach(() => {
  cleanup();
});

describe("PluginStoreSourcesDialog", () => {
  it("shows the persisted marketplace refresh failure beside its source", () => {
    const html = renderToStaticMarkup(
      createElement(
        NibiIntlProvider,
        { initialLocale: "en-US" },
        createElement(PluginStoreSourceRefreshFailure, {
          failure: {
            code: "plugin_archive_fetch_failed",
            failedAt: "2026-08-06T03:55:00.000Z",
            message: "Archive download timed out",
          },
        }),
      ),
    );

    expect(html).toContain("Archive download timed out");
    expect(html).toContain("Refresh failed");
  });

  // claude-plugins-official 的刷新失败不提示（任何原因）；其它来源仍显示失败行。
  it("hides the refresh failure of claude-plugins-official but keeps it for other sources", () => {
    const failure = {
      code: "plugin_marketplace_invalid",
      failedAt: "2026-08-06T03:55:00.000Z",
      message: "git clone failed",
    };
    render(
      createElement(
        NibiIntlProvider,
        { initialLocale: "en-US" },
        createElement(PluginStoreSourcesDialog, {
          open: true,
          onOpenChange: () => {},
          marketplaces: [
            {
              id: "claude-plugins-official",
              name: "claude-plugins-official",
              source: {},
              pluginCount: 0,
              refreshFailure: failure,
            },
            {
              id: "nibi-labs",
              name: "nibi-labs",
              source: {},
              pluginCount: 0,
              refreshFailure: failure,
            },
          ],
          onUpdateMarketplace: () => {},
          onRemoveMarketplace: () => {},
          activeOperations: [],
        }),
      ),
    );

    const failures = screen.getAllByTestId("plugin-store-source-refresh-failure");
    expect(failures).toHaveLength(1);
    expect(
      failures[0]!
        .closest("[data-testid='plugin-store-source-row']")
        ?.getAttribute("data-marketplace-id"),
    ).toBe("nibi-labs");
  });

  it("renders an add failure inside the add marketplace dialog", () => {
    render(
      createElement(
        NibiIntlProvider,
        { initialLocale: "en-US" },
        createElement(AddMarketplaceSourceDialog, {
          open: true,
          onOpenChange: () => {},
          onAddMarketplace: async () => false,
          activeOperations: [],
          error: "Invalid marketplace source",
        }),
      ),
    );

    expect(screen.getByTestId("plugin-store-add-source-dialog")).toBeTruthy();
    expect(screen.getByTestId("plugin-store-add-source-error").textContent).toContain(
      "Invalid marketplace source",
    );
  });

  it("shows the unofficial marketplace warning and requires acknowledgement to submit", async () => {
    const onAddMarketplace = vi.fn(async () => true);
    render(
      createElement(
        NibiIntlProvider,
        { initialLocale: "en-US" },
        createElement(AddMarketplaceSourceDialog, {
          open: true,
          onOpenChange: () => {},
          onAddMarketplace,
          activeOperations: [],
        }),
      ),
    );

    expect(screen.getByTestId("plugin-store-add-source-risk-warning").textContent).toContain(
      "Unofficial plugin marketplaces may contain malicious plugins",
    );
    const submit = screen.getByTestId("plugin-store-add-source-submit") as HTMLButtonElement;
    const input = screen.getByTestId("plugin-store-add-source-input") as HTMLInputElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "https://example.com/marketplace.git" } });
    expect(submit.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("plugin-store-add-source-risk-acknowledgement"));
    expect(submit.disabled).toBe(false);

    fireEvent.click(submit);
    await waitFor(() =>
      expect(onAddMarketplace).toHaveBeenCalledWith("https://example.com/marketplace.git"),
    );
  });

  it("resets the acknowledgement when the dialog closes", () => {
    const onAddMarketplace = vi.fn(async () => true);
    const element = (open: boolean) =>
      createElement(
        NibiIntlProvider,
        { initialLocale: "en-US" },
        createElement(AddMarketplaceSourceDialog, {
          open,
          onOpenChange: () => {},
          onAddMarketplace,
          activeOperations: [],
        }),
      );
    const { rerender } = render(element(true));

    fireEvent.change(screen.getByTestId("plugin-store-add-source-input"), {
      target: { value: "https://example.com/marketplace.git" },
    });
    fireEvent.click(screen.getByTestId("plugin-store-add-source-risk-acknowledgement"));
    expect(
      (screen.getByTestId("plugin-store-add-source-submit") as HTMLButtonElement).disabled,
    ).toBe(false);

    rerender(element(false));
    rerender(element(true));
    expect(
      (screen.getByTestId("plugin-store-add-source-submit") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      screen
        .getByTestId("plugin-store-add-source-risk-acknowledgement")
        .getAttribute("aria-checked"),
    ).toBe("false");
  });

  it("renders official sources first and custom sources by lastUpdated", () => {
    render(
      createElement(
        NibiIntlProvider,
        { initialLocale: "en-US" },
        createElement(PluginStoreSourcesDialog, {
          open: true,
          onOpenChange: () => {},
          marketplaces: [
            {
              id: "never-refreshed",
              name: "Never Refreshed",
              source: {},
              pluginCount: 0,
            },
            {
              id: "nibi-plugins-test",
              name: "nibi-plugins-test",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-08-20T12:00:00Z",
            },
            {
              id: "claude-plugins-official",
              name: "claude-plugins-official",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-01-01T00:00:00Z",
            },
            {
              id: "nibi-official",
              name: "nibi-official",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-08-20T23:00:00Z",
            },
            {
              id: "nibi-labs",
              name: "nibi-labs",
              source: {},
              pluginCount: 0,
              lastUpdated: "2026-08-20T12:00:00Z",
            },
          ],
          onUpdateMarketplace: () => {},
          onRemoveMarketplace: () => {},
          activeOperations: [],
        }),
      ),
    );

    expect(
      screen
        .getAllByTestId("plugin-store-source-row")
        .map((row) => row.getAttribute("data-marketplace-id")),
    ).toEqual([
      "nibi-official",
      "claude-plugins-official",
      "nibi-labs",
      "nibi-plugins-test",
      "never-refreshed",
    ]);
  });
});
