// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestWebRemoteControlMobileChatNavigation,
  subscribeWebRemoteControlMobileChatNavigation,
} from "@/lib/webRemoteControlMobileNavigation.js";
import { useAppControlNavigation } from "@/project-sidebar/useAppControlNavigation.js";

function createNavigationPort() {
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  let settled: unknown;
  return {
    port: {
      onOpenSession() {
        return (listener: (event: Record<string, unknown>) => void) => {
          listeners.add(listener);
          return {
            dispose() {
              listeners.delete(listener);
            },
          };
        };
      },
      settleOpenSession(settlement: unknown) {
        settled = settlement;
      },
    },
    emit(event: Record<string, unknown>) {
      for (const listener of [...listeners]) listener(event);
    },
    settled() {
      return settled;
    },
  };
}

afterEach(() => {
  cleanup();
});

describe("web remote mobile chat navigation", () => {
  it("notifies only active subscribers and unsubscribes cleanly", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWebRemoteControlMobileChatNavigation(listener);

    requestWebRemoteControlMobileChatNavigation();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    requestWebRemoteControlMobileChatNavigation();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("useAppControlNavigation onOpened", () => {
  it("selects the task, runs the mobile follow-up, then settles opened", () => {
    const navigation = createNavigationPort();
    const onSelectTask = vi.fn();
    const onOpened = vi.fn();
    renderHook(() =>
      useAppControlNavigation({
        services: { appControlNavigationService: navigation.port },
        onSelectTask,
        onOpened,
      }),
    );

    act(() => {
      navigation.emit({
        requestId: "open-1",
        sessionId: "session-1",
        workspacePath: "/workspace",
      });
    });

    expect(onSelectTask).toHaveBeenCalledWith("/workspace", "session-1", undefined);
    expect(onOpened).toHaveBeenCalledTimes(1);
    expect(navigation.settled()).toEqual({
      requestId: "open-1",
      uiTarget: "window:main",
    });
  });

  it("does not claim opened when task selection throws", () => {
    const navigation = createNavigationPort();
    const onSelectTask = vi.fn(() => {
      throw new Error("workspace not connected");
    });
    const onOpened = vi.fn();
    renderHook(() =>
      useAppControlNavigation({
        services: { appControlNavigationService: navigation.port },
        onSelectTask,
        onOpened,
      }),
    );

    act(() => {
      navigation.emit({
        requestId: "open-2",
        sessionId: "session-2",
        workspacePath: "/missing",
      });
    });

    expect(onOpened).not.toHaveBeenCalled();
    expect(navigation.settled()).toEqual({
      requestId: "open-2",
      reason: "workspace not connected",
    });
  });

  it("settles unavailable for a request without a usable target", () => {
    const navigation = createNavigationPort();
    const onSelectTask = vi.fn();
    renderHook(() =>
      useAppControlNavigation({
        services: { appControlNavigationService: navigation.port },
        onSelectTask,
      }),
    );

    act(() => {
      navigation.emit({ requestId: "open-3", sessionId: "", workspacePath: "" });
    });

    expect(onSelectTask).not.toHaveBeenCalled();
    expect(navigation.settled()).toEqual({
      requestId: "open-3",
      reason: "The open request has no usable session target",
    });
  });
});