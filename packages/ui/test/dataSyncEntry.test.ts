// @vitest-environment jsdom
import { createElement, type MouseEvent, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openDataSync: vi.fn(),
  setPendingSettingsSectionIntent: vi.fn(),
}));

vi.mock("@/hooks/useOpenDataSyncSettings.js", () => ({
  useOpenDataSyncSettings: () => mocks.openDataSync,
}));
vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: mocks.setPendingSettingsSectionIntent,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/ui/button.js", () => ({
  Button: ({
    children,
    onClick,
    ...props
  }: {
    children: ReactNode;
    onClick?: () => void;
    [key: string]: unknown;
  }) => createElement("button", { type: "button", onClick, ...props }, children),
}));
vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: ReactNode;
    onSelect?: (event: MouseEvent) => void;
  }) => createElement("button", { type: "button", onClick: onSelect }, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

import {
  DataSyncEntryButton,
  DataSyncEntryDropdownButton,
  DataSyncEntryMenuItems,
} from "@/settings/DataSyncEntry.js";
import { openDataSyncSettings, shouldShowDataSyncEntry } from "@/lib/dataSyncEntry.js";

beforeEach(() => {
  mocks.openDataSync.mockClear();
  mocks.setPendingSettingsSectionIntent.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("data sync entries", () => {
  it("opens the data sync page with the requested category from an icon entry", () => {
    render(
      createElement(DataSyncEntryButton, {
        category: "plugins",
        labelId: "settings.plugins.remoteSync.open",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "settings.plugins.remoteSync.open" }));
    expect(mocks.openDataSync).toHaveBeenCalledWith("plugins");
  });

  it("lists the three sync categories in the remote menu and preselects each one", () => {
    render(createElement(DataSyncEntryMenuItems));

    for (const key of ["remote.syncSkills", "remote.syncMcp", "remote.syncPlugins"]) {
      fireEvent.click(screen.getByRole("button", { name: key }));
    }
    expect(mocks.openDataSync.mock.calls).toEqual([["skills"], ["mcp"], ["plugins"]]);
  });

  it("uses the data sync page title for the remote dropdown trigger", () => {
    render(createElement(DataSyncEntryDropdownButton));

    expect(screen.getByRole("button", { name: "settings.dataSync.title" })).toBeTruthy();
  });

  it("dispatches a dataSync section intent with the category", () => {
    openDataSyncSettings("skills");
    openDataSyncSettings();

    expect(mocks.setPendingSettingsSectionIntent.mock.calls).toEqual([
      ["dataSync", { dataSyncCategory: "skills" }],
      ["dataSync", {}],
    ]);
  });

  it("shows entries only for a connected desktop remote session with local source services", () => {
    const target = { kind: "ssh", host: "dev", username: "user" };
    expect(shouldShowDataSyncEntry({ remoteSessionId: "s", remoteTarget: target })).toBe(true);
    expect(
      shouldShowDataSyncEntry({ remoteSessionId: "s", remoteTarget: { kind: "server" } as never }),
    ).toBe(true);
    expect(shouldShowDataSyncEntry({ remoteSessionId: null, remoteTarget: target })).toBe(false);
    expect(
      shouldShowDataSyncEntry({
        remoteSessionId: "s",
        remoteTarget: target,
        hasLocalSourceService: false,
      }),
    ).toBe(false);
    expect(
      shouldShowDataSyncEntry({
        remoteSessionId: "s",
        remoteTarget: target,
        clientMode: "web-remote-replayable",
      }),
    ).toBe(false);
  });
});
