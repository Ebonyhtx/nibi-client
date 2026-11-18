import { describe, expect, it, vi } from "vitest";
import type { HostQuitBlocker } from "@nibi/shared";
import {
  buildAppQuitConfirmationDetail,
  confirmAppQuitWithDialog,
  getCreatingWorktreeCount,
  resolveAppShutdownPolicy,
  selectAppShutdownPolicy,
  shouldConfirmAppQuitForCounts,
} from "../src/main/appShutdownPolicy.js";

describe("app shutdown policy", () => {
  it.each(["win32", "darwin", "linux"] as const)(
    "uses the strict shutdown budget on %s for normal quits",
    (platform) => {
      expect(resolveAppShutdownPolicy("normal", platform)).toEqual({
        forceKillDelayMs: 7_500,
        waitTimeoutMs: 9_000,
      });
    },
  );

  it("uses the same strict budget for update install", () => {
    expect(resolveAppShutdownPolicy("update-install", "win32")).toEqual({
      forceKillDelayMs: 7_500,
      waitTimeoutMs: 9_000,
    });
  });

  it("keeps force kill earlier than the total barrier", () => {
    const policy = resolveAppShutdownPolicy("normal", "win32");
    // Host 内部进程树兜底最长为 3.5s；强制结束必须晚于它，总屏障再留出 1.5s
    // 给 kill 后的 exit 事件与并行 owner 收口。
    expect(policy.forceKillDelayMs).toBeGreaterThan(3_500);
    expect(policy.waitTimeoutMs).toBeGreaterThan(policy.forceKillDelayMs);
  });

  it("upgrades a running normal shutdown when update install arrives", () => {
    expect(selectAppShutdownPolicy("normal", "update-install", "win32")).toEqual({
      kind: "update-install",
      policy: { forceKillDelayMs: 7_500, waitTimeoutMs: 9_000 },
      upgraded: true,
    });
  });

  it("does not let a later before-quit downgrade update install", () => {
    expect(selectAppShutdownPolicy("update-install", "normal", "win32")).toEqual({
      kind: "update-install",
      policy: { forceKillDelayMs: 7_500, waitTimeoutMs: 9_000 },
      upgraded: false,
    });
  });
});

describe("getCreatingWorktreeCount", () => {
  const hostA = {};
  const hostB = {};

  it("aggregates every Host by default and ignores empty entries", () => {
    const map = new Map<object, HostQuitBlocker[]>([
      [hostA, [{ kind: "worktree-creating", count: 2 }]],
      [hostB, [{ kind: "worktree-creating", count: 1 }]],
    ]);

    expect(getCreatingWorktreeCount(map)).toBe(3);
    expect(getCreatingWorktreeCount(new Map())).toBe(0);
  });

  it("only counts the Hosts passed by the caller so other windows cannot block a close", () => {
    const map = new Map<object, HostQuitBlocker[]>([
      [hostA, [{ kind: "worktree-creating", count: 2 }]],
      [hostB, []],
    ]);

    expect(getCreatingWorktreeCount(map, [hostA])).toBe(2);
    expect(getCreatingWorktreeCount(map, [hostB])).toBe(0);
    expect(getCreatingWorktreeCount(map, [undefined])).toBe(0);
  });
});

describe("shouldConfirmAppQuitForCounts", () => {
  it("confirms in development when a worktree is being created", () => {
    expect(
      shouldConfirmAppQuitForCounts({
        isProduction: false,
        runningAgentSessionCount: 0,
        creatingWorktreeCount: 1,
      }),
    ).toBe(true);
  });

  it("keeps the production-only gate for running sessions", () => {
    expect(
      shouldConfirmAppQuitForCounts({
        isProduction: false,
        runningAgentSessionCount: 3,
        creatingWorktreeCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldConfirmAppQuitForCounts({
        isProduction: true,
        runningAgentSessionCount: 3,
        creatingWorktreeCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldConfirmAppQuitForCounts({
        isProduction: true,
        runningAgentSessionCount: 0,
        creatingWorktreeCount: 0,
      }),
    ).toBe(false);
  });
});

describe("buildAppQuitConfirmationDetail", () => {
  it("adds the worktree line only when the count is positive", () => {
    expect(
      buildAppQuitConfirmationDetail({
        isZh: true,
        runningAgentSessionCount: 2,
        creatingWorktreeCount: 1,
      }),
    ).toBe(
      ["正在进行的会话：2 个，退出后会被中断。", "正在新 worktree 中启动的任务：1 个，关闭后会丢失。"].join(
        "\n",
      ),
    );
    expect(
      buildAppQuitConfirmationDetail({
        isZh: false,
        runningAgentSessionCount: 0,
        creatingWorktreeCount: 2,
      }),
    ).toBe("Tasks starting in new worktrees: 2. They will be lost after quitting.");
    expect(
      buildAppQuitConfirmationDetail({
        isZh: true,
        runningAgentSessionCount: 0,
        creatingWorktreeCount: 0,
      }),
    ).toBe("");
  });
});

describe("confirmAppQuitWithDialog", () => {
  it("shows the worktree detail and maps the dialog result", () => {
    const showMessageBoxSync = vi.fn(() => 1);
    expect(
      confirmAppQuitWithDialog({
        isZh: true,
        runningAgentSessionCount: 0,
        creatingWorktreeCount: 1,
        showMessageBoxSync,
      }),
    ).toBe(false);
    expect(showMessageBoxSync).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "退出确认",
        detail: "正在新 worktree 中启动的任务：1 个，关闭后会丢失。",
      }),
    );

    showMessageBoxSync.mockReturnValue(0);
    expect(
      confirmAppQuitWithDialog({
        isZh: false,
        runningAgentSessionCount: 1,
        creatingWorktreeCount: 0,
        showMessageBoxSync,
      }),
    ).toBe(true);
  });
});