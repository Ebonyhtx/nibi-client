// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

import { ManagedWorktreeHandoffNotice } from "@/managed-worktrees/ManagedWorktreeHandoffNotice.js";
import {
  ManagedWorktreeHandoffRegistry,
  MANAGED_WORKTREE_HANDOFF_MAX_MS,
  managedWorktreeHandoffRegistry,
  markManagedWorktreeHandoff,
  shouldShowManagedWorktreeHandoff,
  type ManagedWorktreeHandoffSubscriptionStatus,
} from "@/managed-worktrees/managedWorktreeHandoff.js";
import { TID_WORKTREE_HANDOFF } from "@/managed-worktrees/testIds.js";
import { useManagedWorktreeHandoff } from "@/managed-worktrees/useManagedWorktreeHandoff.js";

afterEach(() => {
  cleanup();
  managedWorktreeHandoffRegistry.clear();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("ManagedWorktreeHandoffRegistry", () => {
  it("tracks a session until it is settled", () => {
    const registry = new ManagedWorktreeHandoffRegistry();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);

    expect(registry.isPending("session-1")).toBe(false);
    registry.mark("session-1");
    expect(registry.isPending("session-1")).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    registry.settle("session-1");
    expect(registry.isPending("session-1")).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    registry.mark("session-1");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("expires the notice after the display bound", () => {
    vi.useFakeTimers();
    const registry = new ManagedWorktreeHandoffRegistry(1_000);
    registry.mark("session-1");
    expect(registry.isPending("session-1")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(registry.isPending("session-1")).toBe(false);
  });

  it("refreshes the display bound instead of stacking a second entry", () => {
    vi.useFakeTimers();
    const registry = new ManagedWorktreeHandoffRegistry(1_000);
    registry.mark("session-1");
    act(() => {
      vi.advanceTimersByTime(600);
    });
    registry.mark("session-1");
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(registry.isPending("session-1")).toBe(true);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(registry.isPending("session-1")).toBe(false);
  });

  it("clears every entry and timer", () => {
    vi.useFakeTimers();
    const registry = new ManagedWorktreeHandoffRegistry();
    registry.mark("session-1");
    registry.mark("session-2");
    registry.clear();
    expect(registry.isPending("session-1")).toBe(false);
    expect(registry.isPending("session-2")).toBe(false);
    expect(MANAGED_WORKTREE_HANDOFF_MAX_MS).toBeGreaterThan(0);
  });
});

describe("shouldShowManagedWorktreeHandoff", () => {
  const base = {
    pending: true,
    sessionId: "session-1",
    snapshotReady: false,
    subscriptionStatus: "connecting" as ManagedWorktreeHandoffSubscriptionStatus,
  };

  it("shows only while the first snapshot is still missing", () => {
    expect(shouldShowManagedWorktreeHandoff(base)).toBe(true);
    expect(shouldShowManagedWorktreeHandoff({ ...base, subscriptionStatus: "live" })).toBe(true);
    expect(shouldShowManagedWorktreeHandoff({ ...base, snapshotReady: true })).toBe(false);
  });

  it("hides on subscription failure, release, missing session or missing handoff", () => {
    expect(shouldShowManagedWorktreeHandoff({ ...base, subscriptionStatus: "error" })).toBe(false);
    expect(shouldShowManagedWorktreeHandoff({ ...base, subscriptionStatus: "closed" })).toBe(false);
    expect(shouldShowManagedWorktreeHandoff({ ...base, sessionId: null })).toBe(false);
    expect(shouldShowManagedWorktreeHandoff({ ...base, pending: false })).toBe(false);
  });
});

describe("useManagedWorktreeHandoff", () => {
  function renderHandoff() {
    return renderHook(
      (props: {
        sessionId: string | null;
        snapshotReady: boolean;
        subscriptionStatus: ManagedWorktreeHandoffSubscriptionStatus | null;
      }) => useManagedWorktreeHandoff(props),
      {
        initialProps: {
          sessionId: "session-1",
          snapshotReady: false,
          subscriptionStatus: "connecting" as ManagedWorktreeHandoffSubscriptionStatus,
        },
      },
    );
  }

  it("appears after the settlement mark and disappears on the first snapshot", () => {
    const { result, rerender } = renderHandoff();
    expect(result.current).toBe(false);

    act(() => markManagedWorktreeHandoff("session-1"));
    expect(result.current).toBe(true);

    rerender({ sessionId: "session-1", snapshotReady: true, subscriptionStatus: "live" });
    expect(result.current).toBe(false);
    expect(managedWorktreeHandoffRegistry.isPending("session-1")).toBe(false);
  });

  it("disappears and clears the mark when the subscription fails", () => {
    const { result, rerender } = renderHandoff();
    act(() => markManagedWorktreeHandoff("session-1"));
    expect(result.current).toBe(true);

    rerender({ sessionId: "session-1", snapshotReady: false, subscriptionStatus: "error" });
    expect(result.current).toBe(false);
    expect(managedWorktreeHandoffRegistry.isPending("session-1")).toBe(false);
  });

  it("does not leak a mark from another session into the open pane", () => {
    const { result } = renderHandoff();
    act(() => markManagedWorktreeHandoff("session-2"));
    expect(result.current).toBe(false);
    expect(managedWorktreeHandoffRegistry.isPending("session-2")).toBe(true);
  });

  it("keeps the mark while the conversation lease is not ready", () => {
    const { result, rerender } = renderHook(
      () =>
        useManagedWorktreeHandoff({
          sessionId: "session-1",
          snapshotReady: false,
          subscriptionStatus: null,
        }),
      { initialProps: {} },
    );
    act(() => markManagedWorktreeHandoff("session-1"));
    expect(result.current).toBe(true);

    // 无 lease 时 projection 是 CLOSED_STATE，但那不是会话已释放，不能误清。
    rerender({});
    expect(result.current).toBe(true);
    expect(managedWorktreeHandoffRegistry.isPending("session-1")).toBe(true);
  });
});

describe("ManagedWorktreeHandoffNotice", () => {
  it("renders a non-blocking status line with the existing creation string", () => {
    render(createElement(ManagedWorktreeHandoffNotice));
    const notice = screen.getByTestId(TID_WORKTREE_HANDOFF);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("git.managedWorktree.creation.startingSession");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
