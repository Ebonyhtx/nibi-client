import { describe, expect, it } from "vitest";
import {
  resolveAppShutdownPolicy,
  selectAppShutdownPolicy,
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
