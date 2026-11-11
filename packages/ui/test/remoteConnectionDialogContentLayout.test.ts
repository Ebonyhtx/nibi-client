// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/DirectoryBrowser.js", () => ({
  DirectoryBrowser: () => createElement("div", { "data-testid": "directory-browser" }),
}));

vi.mock("@/RemoteConnectionFields.js", () => ({
  RemoteConnectionFields: () => createElement("div", { "data-testid": "remote-connection-fields" }),
}));

vi.mock("@/settings/DataSyncEntry.js", () => ({
  DataSyncEntryDropdownButton: () =>
    createElement("button", { type: "button", "data-testid": "data-sync-entry" }, "data-sync"),
}));

import {
  getRecentRemoteWorkspaceHistory,
  RemoteConnectionDirectoryStep,
} from "@/RemoteConnectionDialogContent.js";
import { buildAvailableKinds } from "@/hooks/useRemoteConnectionForm.js";

describe("RemoteConnectionDialogContent layout", () => {
  it("shows the most recently opened directories first", () => {
    expect(
      getRecentRemoteWorkspaceHistory([
        {
          workspacePath: "/old",
          profileId: "p",
          sourceServerId: "s",
          lastOpenedAt: 1,
        },
        {
          workspacePath: "/new",
          profileId: "p",
          sourceServerId: "s",
          lastOpenedAt: 3,
        },
        {
          workspacePath: "/middle",
          profileId: "p",
          sourceServerId: "s",
          lastOpenedAt: 2,
        },
      ]).map((entry) => entry.workspacePath),
    ).toEqual(["/new", "/middle", "/old"]);
  });

  it("filters hidden directories out of the recent list", () => {
    expect(
      getRecentRemoteWorkspaceHistory([
        {
          workspacePath: "/home/dev/.nibi",
          profileId: "p",
          sourceServerId: "s",
          lastOpenedAt: 9,
        },
        {
          workspacePath: "/home/dev/work",
          profileId: "p",
          sourceServerId: "s",
          lastOpenedAt: 1,
        },
      ]).map((entry) => entry.workspacePath),
    ).toEqual(["/home/dev/work"]);
  });

  it("filters the Source conversation backing path out of recent directories", () => {
    expect(
      getRecentRemoteWorkspaceHistory(
        [
          {
            workspacePath: "/remote/.nibi/workspace/default",
            sourceServerId: "source-1",
            profileId: "p",
            lastOpenedAt: 3,
          },
          {
            workspacePath: "/remote/project",
            sourceServerId: "source-1",
            profileId: "p",
            lastOpenedAt: 2,
          },
        ],
        {
          "source-1": {
            workspacePath: "/remote/.nibi/workspace/default",
            lastResolvedAt: 4,
          },
        },
      ).map((entry) => entry.workspacePath),
    ).toEqual(["/remote/project"]);
  });

  it("renders full quick-open paths", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteConnectionDirectoryStep, {
        services: {} as never,
        selecting: false,
        quickOpenPaths: ["/home/dev/work/api"],
        deviceName: "dev",
        onRenameDevice: vi.fn(),
        onSelect: vi.fn(),
        onBack: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(html).toContain("/home/dev/work/api");
    expect(html).toContain("remote.recentDirectories");
  });

  it("shows Server between SSH and Windows-only kinds in local development", () => {
    expect(
      buildAvailableKinds({
        isWindowsDesktop: true,
        isLocalDevelopmentRuntime: true,
      }),
    ).toEqual(["ssh", "server", "wsl", "docker"]);
  });

  it("hides Server from production-mode packaged runtimes", () => {
    expect(
      buildAvailableKinds({
        isWindowsDesktop: true,
        isLocalDevelopmentRuntime: false,
      }),
    ).toEqual(["ssh", "wsl", "docker"]);
    expect(
      buildAvailableKinds({
        isWindowsDesktop: false,
        isLocalDevelopmentRuntime: false,
      }),
    ).toEqual(["ssh", "docker"]);
  });

  it("shows progress feedback while finalizing a selected remote directory", () => {
    const html = renderToStaticMarkup(
      createElement(RemoteConnectionDirectoryStep, {
        services: {} as never,
        selecting: true,
        onSelect: vi.fn(),
        onBack: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(html).toContain("common.loading");
    expect(html).toContain("animate-spin");
  });

  it("shows the unified data sync entry only after a remote target is connected", () => {
    const connected = renderToStaticMarkup(
      createElement(RemoteConnectionDirectoryStep, {
        services: {} as never,
        remoteTarget: {
          kind: "ssh",
          host: "localhost",
          port: 2223,
          username: "root",
        },
        onSelect: vi.fn(),
        onBack: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    const disconnected = renderToStaticMarkup(
      createElement(RemoteConnectionDirectoryStep, {
        services: {} as never,
        onSelect: vi.fn(),
        onBack: vi.fn(),
        onCancel: vi.fn(),
      }),
    );

    expect(connected).toContain('data-testid="data-sync-entry"');
    expect(disconnected).not.toContain('data-testid="data-sync-entry"');
  });
});
