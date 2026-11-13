// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@nibi/rpc";
import type {
  SourceServerConnectionStateSnapshot,
  SourceServerManagementSnapshot,
} from "@nibi/shared";
import { SourceServerManagementPanel } from "@/settings/SourceServerManagementPanel.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, number | string>) =>
        values?.source
          ? `${id}:${values.source}`
          : values?.query !== undefined
            ? `${id}:${values.query}`
            : id === "settings.source.error.credentials-required"
              ? "credentials-required-message"
              : id,
    },
  }),
}));

const showToast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast.js", () => ({ toast: showToast }));
const confirmDialog = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => confirmDialog }));
const platform = vi.hoisted(() => ({
  listSSHConfigAliases: vi.fn(async () => []),
  selectFile: vi.fn(),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => platform,
  useOptionalPlatform: () => platform,
}));

function snapshot(options: {
  state?: SourceServerConnectionStateSnapshot["state"];
  lastSeenVersion?: string;
  secondDevice?: boolean;
}): SourceServerManagementSnapshot {
  const profiles = [
    {
      profileId: "profile-a",
      sourceServerId: "source-a",
      displayName: "Alpha",
      transport: "ssh" as const,
      target: { kind: "ssh" as const, host: "alpha.example.com", username: "dev" },
      createdAt: 1,
      lifecycleState: "active" as const,
    },
  ];
  const servers = [
    {
      sourceServerId: "source-a",
      displayName: "Alpha",
      preferredProfileId: "profile-a",
      installState: "installed" as const,
      lastSeenVersion: options.lastSeenVersion ?? "4.0.0",
      declaredWorkspaces: [],
    },
  ];
  const states = [
    {
      profileId: "profile-a",
      sourceServerId: "source-a",
      state: options.state ?? ("online" as const),
      updatedAt: 1,
    },
  ];
  if (options.secondDevice) {
    profiles.push({
      profileId: "profile-b",
      sourceServerId: "source-b",
      displayName: "Beta",
      transport: "docker" as const,
      target: { kind: "docker" as const, container: "beta" },
      createdAt: 2,
      lifecycleState: "active" as const,
    });
    servers.push({
      sourceServerId: "source-b",
      displayName: "Beta",
      preferredProfileId: "profile-b",
      installState: "installed" as const,
      lastSeenVersion: "4.0.0",
      declaredWorkspaces: [],
    });
    states.push({
      profileId: "profile-b",
      sourceServerId: "source-b",
      state: "offline" as const,
      updatedAt: 2,
    });
  }
  return {
    generation: 1,
    profiles,
    servers,
    workspaceHistory: [],
    states,
    failedPathCount: 0,
    abandonedPathCount: 0,
    migrationCounts: [],
  };
}

function managementFor(
  value: SourceServerManagementSnapshot,
  overrides: Record<string, unknown> = {},
): never {
  return {
    getSnapshot: async () => value,
    onDidChangeState: new Emitter().event,
    getSourceRunningTasks: vi.fn(async () => ({ available: true, tasks: [] })),
    stopSource: vi.fn(async () => value),
    restartSource: vi.fn(async () => value),
    ...overrides,
  } as never;
}

async function openDeviceMenu(serverName = "Alpha"): Promise<HTMLElement> {
  const card = (await screen.findByText(serverName)).closest(
    "[data-source-server-card]",
  ) as HTMLElement;
  fireEvent.pointerDown(within(card).getByRole("button", { name: "common.more" }));
  return card;
}

beforeEach(() => confirmDialog.mockReset().mockResolvedValue(true));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("remote service lifecycle menu", () => {
  it("reads running tasks, confirms, stops the remote service, and reports success", async () => {
    const value = snapshot({});
    const getSourceRunningTasks = vi.fn(async () => ({
      available: true as const,
      tasks: [{ sessionId: "session-1", workspacePath: "/work/app" }],
    }));
    const stopSource = vi.fn(async () => value);
    const management = managementFor(value, { getSourceRunningTasks, stopSource });
    render(
      createElement(SourceServerManagementPanel, {
        management,
        settings: { remoteStartupAutoReconnectEnabled: false },
      }),
    );
    await openDeviceMenu();

    fireEvent.click(screen.getByText("settings.source.stopRemoteService"));

    await waitFor(() => expect(stopSource).toHaveBeenCalledWith("source-a"));
    expect(getSourceRunningTasks).toHaveBeenCalledWith("source-a");
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "settings.source.stopRemoteServiceTitle",
        confirmLabel: "settings.source.stopRemoteService",
        confirmVariant: "destructive",
        intent: "source-server-stop",
        scrollableDescription: true,
        description: expect.stringContaining("session-1 — /work/app"),
      }),
    );
    expect(confirmDialog.mock.calls[0]![0].description).toContain(
      "settings.source.remoteServiceInterruptionDescription",
    );
    expect(confirmDialog.mock.calls[0]![0].description).toContain(
      "settings.source.remoteServiceOtherClientsNotice",
    );
    expect(confirmDialog.mock.calls[0]![0].description).not.toContain(
      "settings.source.stopRemoteServiceStartupReconnectNotice",
    );
    expect(showToast).toHaveBeenCalledWith("sourceServer.stopCompletedToast:Alpha");
  });

  it("disables both actions and shows the update hint below the contract version", async () => {
    const value = snapshot({ lastSeenVersion: "3.17.9" });
    render(createElement(SourceServerManagementPanel, { management: managementFor(value) }));
    await openDeviceMenu();

    const stop = screen.getByText("settings.source.stopRemoteService").closest('[role="menuitem"]');
    const restart = screen
      .getByText("settings.source.restartRemoteService")
      .closest('[role="menuitem"]');
    expect(stop?.getAttribute("aria-disabled")).toBe("true");
    expect(restart?.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getAllByText("settings.source.remoteServiceUpdateRequired")).toHaveLength(2);
  });

  it("hides both actions while the device needs handling", async () => {
    const value = snapshot({ state: "needs-upgrade" });
    render(createElement(SourceServerManagementPanel, { management: managementFor(value) }));
    await openDeviceMenu();

    expect(screen.queryByText("settings.source.stopRemoteService")).toBeNull();
    expect(screen.queryByText("settings.source.restartRemoteService")).toBeNull();
  });

  it("shows the unavailable task list instead of claiming no tasks", async () => {
    const value = snapshot({});
    const management = managementFor(value, {
      getSourceRunningTasks: vi.fn(async () => ({ available: false })),
      restartSource: vi.fn(async () => value),
    });
    render(createElement(SourceServerManagementPanel, { management }));
    await openDeviceMenu();
    fireEvent.click(screen.getByText("settings.source.restartRemoteService"));

    await waitFor(() =>
      expect(
        (management as { restartSource: ReturnType<typeof vi.fn> }).restartSource,
      ).toHaveBeenCalledWith("source-a"),
    );
    expect(confirmDialog.mock.calls[0]![0].description).toContain(
      "settings.source.remoteServiceRunningTasksUnavailable",
    );
  });

  it("does not confirm when credentials cannot be obtained silently", async () => {
    const value = snapshot({});
    const getSourceRunningTasks = vi.fn(async () => {
      throw Object.assign(new Error("interactive credentials required"), {
        code: "credentials-required",
      });
    });
    render(
      createElement(SourceServerManagementPanel, {
        management: managementFor(value, { getSourceRunningTasks }),
      }),
    );
    await openDeviceMenu();
    fireEvent.click(screen.getByText("settings.source.stopRemoteService"));

    await waitFor(() => expect(screen.getByText("credentials-required-message")).toBeTruthy());
    expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("keeps devices compact, searchable, and shows the online status", async () => {
    const value = snapshot({ secondDevice: true });
    render(createElement(SourceServerManagementPanel, { management: managementFor(value) }));

    const toggles = () => [
      ...document.querySelectorAll<HTMLButtonElement>("[data-source-server-toggle]"),
    ];
    await waitFor(() => expect(toggles()).toHaveLength(2));
    // 在线设备排在前；两行默认折叠，只显示紧凑摘要。
    expect(toggles()[0]!.textContent).toContain("Alpha");
    expect(toggles().every((toggle) => toggle.getAttribute("aria-expanded") === "false")).toBe(
      true,
    );
    expect(document.querySelector('[data-remote-connection-status="online"]')).toBeTruthy();

    fireEvent.click(toggles()[0]!);
    expect(toggles()[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector("[data-device-details]")).toBeTruthy();

    fireEvent.change(screen.getByRole("searchbox", { name: "settings.source.searchPlaceholder" }), {
      target: { value: "beta" },
    });
    await waitFor(() => expect(toggles()).toHaveLength(1));
    expect(toggles()[0]!.textContent).toContain("Beta");
    expect(screen.queryByText("Alpha")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "settings.source.searchPlaceholder" }), {
      target: { value: "no-such-device" },
    });
    expect(await screen.findByText("settings.source.searchEmpty:no-such-device")).toBeTruthy();
  });
});
