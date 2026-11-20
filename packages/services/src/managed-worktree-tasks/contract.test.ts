import { describe, expect, it, vi } from "vitest";
import {
  createRemovalGateForExample,
  removeManagedWorktreeWithLease,
} from "./contract.example.js";

describe("managed worktree tasks contract", () => {
  it("removes once the lease is free and releases it afterwards", async () => {
    const gate = createRemovalGateForExample();
    const remove = vi.fn(async () => undefined);

    await expect(
      removeManagedWorktreeWithLease({ gate, worktreeRoot: "/work/wt", remove }),
    ).resolves.toBe(true);
    expect(remove).toHaveBeenCalledOnce();
    expect(gate.acquire("/work/wt")).toBe(true);
    gate.release("/work/wt");
  });

  it("refuses a second concurrent removal and keeps the lease", async () => {
    const gate = createRemovalGateForExample();
    const remove = vi.fn(async () => undefined);

    await removeManagedWorktreeWithLease({ gate, worktreeRoot: "/work/wt", remove });
    expect(gate.isRemoving("/work/wt")).toBe(false);

    gate.acquire("/work/wt");
    await expect(
      removeManagedWorktreeWithLease({ gate, worktreeRoot: "/work/wt", remove }),
    ).resolves.toBe(false);
    expect(remove).toHaveBeenCalledOnce();
    expect(gate.isRemoving("/work/wt/sub")).toBe(true);
    gate.release("/work/wt");
  });
});
