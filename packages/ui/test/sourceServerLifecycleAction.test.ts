import { describe, expect, it } from "vitest";
import {
  getRemoteServiceLifecycleDescription,
  resolveSourceServerLifecycleActionAvailability,
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
