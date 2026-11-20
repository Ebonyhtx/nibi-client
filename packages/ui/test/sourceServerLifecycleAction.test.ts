import { describe, expect, it } from "vitest";
import {
  getRemoteServiceLifecycleDescription,
  getSourceServerReinstallConfirmation,
  resolveSourceServerLifecycleActionAvailability,
  resolveSourceServerReinstallAvailability,
} from "@/lib/sourceServerUpdateAction.js";

describe("resolveSourceServerLifecycleActionAvailability", () => {
  it.each(["online", "offline", "failed"] as const)(
    "enables both actions for %s devices on a supported remote",
    (status) => {
      expect(
        resolveSourceServerLifecycleActionAvailability({
          status,
          deviceBusy: false,
          lastSeenVersion: "4.0.0",
        }),
      ).toEqual({ visible: true, enabled: true, requiresRemoteUpdate: false });
    },
  );

  it("hides both actions while the device needs handling", () => {
    expect(
      resolveSourceServerLifecycleActionAvailability({
        status: "pending",
        deviceBusy: false,
        lastSeenVersion: "4.0.0",
      }),
    ).toEqual({ visible: false });
  });

  it("disables both actions while connecting or while the device has another operation", () => {
    expect(
      resolveSourceServerLifecycleActionAvailability({
        status: "connecting",
        deviceBusy: false,
        lastSeenVersion: "4.0.0",
      }),
    ).toMatchObject({ visible: true, enabled: false, requiresRemoteUpdate: false });
    expect(
      resolveSourceServerLifecycleActionAvailability({
        status: "online",
        deviceBusy: true,
        lastSeenVersion: "4.0.0",
      }),
    ).toMatchObject({ visible: true, enabled: false });
  });

  it("disables both actions and asks for a remote update below the contract version", () => {
    expect(
      resolveSourceServerLifecycleActionAvailability({
        status: "offline",
        deviceBusy: false,
        lastSeenVersion: "3.17.9",
      }),
    ).toEqual({ visible: true, enabled: false, requiresRemoteUpdate: true });
  });

  it("treats an unknown or malformed remote version as unsupported", () => {
    expect(
      resolveSourceServerLifecycleActionAvailability({ status: "offline", deviceBusy: false }),
    ).toMatchObject({ enabled: false, requiresRemoteUpdate: true });
    expect(
      resolveSourceServerLifecycleActionAvailability({
        status: "offline",
        deviceBusy: false,
        lastSeenVersion: "not-a-version",
      }),
    ).toMatchObject({ enabled: false, requiresRemoteUpdate: true });
  });
});

describe("resolveSourceServerReinstallAvailability", () => {
  it("enables reinstall for an installed device on any remote version", () => {
    expect(
      resolveSourceServerReinstallAvailability({
        status: "failed",
        deviceBusy: false,
        installState: "installed",
        lastSeenVersion: "3.17.9",
        localVersion: "4.1.3",
      }),
    ).toEqual({ visible: true, enabled: true });
  });

  it("hides reinstall while the device needs handling or the service is uninstalled", () => {
    expect(
      resolveSourceServerReinstallAvailability({
        status: "pending",
        deviceBusy: false,
        installState: "installed",
        localVersion: "4.1.3",
      }),
    ).toEqual({ visible: false });
    expect(
      resolveSourceServerReinstallAvailability({
        status: "failed",
        deviceBusy: false,
        installState: "uninstalled",
        localVersion: "4.1.3",
      }),
    ).toEqual({ visible: false });
  });

  it("disables reinstall while connecting or while the device has another operation", () => {
    expect(
      resolveSourceServerReinstallAvailability({
        status: "connecting",
        deviceBusy: false,
        installState: "installed",
        localVersion: "4.1.3",
      }),
    ).toEqual({ visible: true, enabled: false });
    expect(
      resolveSourceServerReinstallAvailability({
        status: "failed",
        deviceBusy: true,
        installState: "installed",
        localVersion: "4.1.3",
      }),
    ).toEqual({ visible: true, enabled: false });
  });

  it("hides reinstall when the remote is newer than this computer", () => {
    expect(
      resolveSourceServerReinstallAvailability({
        status: "failed",
        deviceBusy: false,
        installState: "installed",
        lastSeenVersion: "4.2.0",
        localVersion: "4.1.3",
      }),
    ).toEqual({ visible: false });
  });
});

describe("getSourceServerReinstallConfirmation", () => {
  it("uses the reinstall copy and keeps the source and version in the description", () => {
    const confirmation = getSourceServerReinstallConfirmation({
      source: "Build server",
      version: "v4.1.3",
      formatMessage: (descriptor, values) =>
        values ? `${descriptor.id}:${values.source}:${values.version}` : descriptor.id,
    });
    expect(confirmation).toEqual({
      title: "settings.source.reinstallRemoteServiceTitle",
      description: "settings.source.reinstallRemoteServiceDescription:Build server:4.1.3",
      confirmLabel: "settings.source.reinstallRemoteServiceConfirm",
      intent: "source-server-reinstall",
    });
  });
});

describe("getRemoteServiceLifecycleDescription", () => {
  const formatMessage = (id: string) => id;

  it("lists the running tasks that will be interrupted", () => {
    expect(
      getRemoteServiceLifecycleDescription({
        action: "restart",
        runningTasks: {
          available: true,
          tasks: [
            { sessionId: "session-1", workspacePath: "/work/a" },
            { sessionId: "session-2", workspacePath: "/work/b" },
          ],
        },
        startupAutoReconnect: true,
        formatMessage,
      }),
    ).toBe(
      [
        "settings.source.remoteServiceInterruptionDescription",
        "session-1 — /work/a\nsession-2 — /work/b",
        "settings.source.remoteServiceOtherClientsNotice",
      ].join("\n\n"),
    );
  });

  it("distinguishes an empty task list from an unavailable one", () => {
    expect(
      getRemoteServiceLifecycleDescription({
        action: "stop",
        runningTasks: { available: true, tasks: [] },
        startupAutoReconnect: false,
        formatMessage,
      }),
    ).toContain("settings.source.remoteServiceNoRunningTasks");
    expect(
      getRemoteServiceLifecycleDescription({
        action: "stop",
        runningTasks: { available: false },
        startupAutoReconnect: false,
        formatMessage,
      }),
    ).toContain("settings.source.remoteServiceRunningTasksUnavailable");
  });

  it("adds the startup reconnect notice only for stop when the switch is on", () => {
    const stop = getRemoteServiceLifecycleDescription({
      action: "stop",
      runningTasks: { available: true, tasks: [] },
      startupAutoReconnect: true,
      formatMessage,
    });
    expect(stop).toContain("settings.source.stopRemoteServiceStartupReconnectNotice");
    const stopWithout = getRemoteServiceLifecycleDescription({
      action: "stop",
      runningTasks: { available: true, tasks: [] },
      startupAutoReconnect: false,
      formatMessage,
    });
    expect(stopWithout).not.toContain("settings.source.stopRemoteServiceStartupReconnectNotice");
    const restart = getRemoteServiceLifecycleDescription({
      action: "restart",
      runningTasks: { available: true, tasks: [] },
      startupAutoReconnect: true,
      formatMessage,
    });
    expect(restart).not.toContain("settings.source.stopRemoteServiceStartupReconnectNotice");
  });
});
