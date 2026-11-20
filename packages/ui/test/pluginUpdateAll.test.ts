// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";
import { needsPluginUpdate, updatePluginsSerially } from "@/settings/pluginStoreListing.js";
import { PluginUpdateAllButton, type PluginStoreActions } from "@/settings/PluginStoreCard.js";

function storeItem(id: string, updateStatus: "none" | "update-available"): StorePluginItem {
  const [name = "", marketplace = ""] = id.split("@");
  return {
    id,
    name,
    marketplace,
    installed: true,
    restorable: false,
    orphaned: false,
    paid: false,
    installedMeta: {
      id,
      name,
      marketplace,
      enabled: true,
      scope: "user",
      updateStatus,
    },
  };
}

function makeActions(overrides: Partial<PluginStoreActions> = {}): PluginStoreActions {
  return {
    onOpenDetail: () => {},
    onInstall: () => {},
    onUninstall: () => {},
    onUpdate: () => {},
    activeOperations: [],
    togglingPluginId: null,
    ...overrides,
  };
}

function renderUpdateAll(
  items: StorePluginItem[],
  actions: PluginStoreActions,
  pending = false,
  onUpdateAll: (pluginIds: string[]) => void = () => {},
) {
  return render(
    createElement(
      NibiIntlProvider,
      { initialLocale: "en-US" },
      createElement(PluginUpdateAllButton, { items, actions, pending, onUpdateAll }),
    ),
  );
}

afterEach(() => {
  cleanup();
});

describe("PluginUpdateAllButton", () => {
  it("renders nothing when no installed plugin has a pending update", () => {
    renderUpdateAll(
      [storeItem("alpha@market", "none"), storeItem("beta@market", "none")],
      makeActions(),
    );

    expect(screen.queryByTestId("plugin-settings-update-all")).toBeNull();
  });

  it("shows the updatable count and submits every updatable plugin id", () => {
    const onUpdateAll = vi.fn();
    renderUpdateAll(
      [
        storeItem("alpha@market", "update-available"),
        storeItem("beta@market", "none"),
        storeItem("gamma@market", "update-available"),
      ],
      makeActions(),
      false,
      onUpdateAll,
    );

    const button = screen.getByTestId("plugin-settings-update-all");
    expect(button.textContent).toContain("Update all (2)");
    fireEvent.click(button);
    expect(onUpdateAll).toHaveBeenCalledWith(["alpha@market", "gamma@market"]);
  });

  it("is disabled while a plugin update is already running", () => {
    renderUpdateAll(
      [storeItem("alpha@market", "update-available")],
      makeActions({ activeOperations: [{ id: "plugin:update:another@market" }] }),
    );

    expect((screen.getByTestId("plugin-settings-update-all") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("updatePluginsSerially", () => {
  it("updates every plugin even when one update fails", async () => {
    const calls: string[] = [];
    const update = vi.fn(async (pluginId: string) => {
      calls.push(pluginId);
      return pluginId !== "beta@market";
    });

    const result = await updatePluginsSerially(
      ["alpha@market", "beta@market", "gamma@market"],
      update,
      { isCurrent: () => true, needsUpdate: () => true },
    );

    expect(calls).toEqual(["alpha@market", "beta@market", "gamma@market"]);
    expect(result).toEqual({
      succeeded: ["alpha@market", "gamma@market"],
      failed: ["beta@market"],
      aborted: false,
    });
  });

  it("treats a thrown update as a failed plugin and continues", async () => {
    const update = vi.fn(async (pluginId: string) => {
      if (pluginId === "beta@market") throw new Error("update failed");
      return true;
    });

    const result = await updatePluginsSerially(
      ["alpha@market", "beta@market", "gamma@market"],
      update,
      { isCurrent: () => true, needsUpdate: () => true },
    );

    expect(update).toHaveBeenCalledTimes(3);
    expect(result.failed).toEqual(["beta@market"]);
    expect(result.succeeded).toEqual(["alpha@market", "gamma@market"]);
  });

  it("skips plugins that already updated inline and stops when the scope changes", async () => {
    const update = vi.fn(async () => true);
    let current = true;

    const result = await updatePluginsSerially(["alpha@market", "beta@market"], update, {
      isCurrent: () => current,
      needsUpdate: (pluginId) => pluginId !== "alpha@market",
    });
    expect(result.succeeded).toEqual(["beta@market"]);

    current = false;
    const aborted = await updatePluginsSerially(["gamma@market"], update, {
      isCurrent: () => current,
      needsUpdate: () => true,
    });
    expect(aborted).toEqual({ succeeded: [], failed: [], aborted: true });
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe("needsPluginUpdate", () => {
  it("skips plugins whose update is already running and reads the latest status", () => {
    const state = {
      installedPlugins: [
        { id: "alpha@market", updateStatus: "update-available" as const },
        { id: "beta@market", updateStatus: "none" as const },
      ],
      activeOperations: [] as Array<{ id: string }>,
    };

    expect(needsPluginUpdate(state, "alpha@market")).toBe(true);
    expect(needsPluginUpdate(state, "beta@market")).toBe(false);
    expect(
      needsPluginUpdate(
        { ...state, activeOperations: [{ id: "plugin:update:alpha@market" }] },
        "alpha@market",
      ),
    ).toBe(false);
  });
});
