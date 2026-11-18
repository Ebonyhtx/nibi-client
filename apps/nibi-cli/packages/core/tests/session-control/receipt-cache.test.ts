import { describe, expect, it, vi } from "vitest";
import type { CliSessionRef } from "@nibi/session-control/contracts";
import { SessionControlReceiptCache } from "../../src/tool/session-control/receipt-cache.js";

const root: CliSessionRef = { kind: "cli", workspacePath: "/workspace", sessionId: "sess_root" };
const otherRoot: CliSessionRef = { ...root, sessionId: "sess_other" };

function input(overrides: Partial<Parameters<SessionControlReceiptCache["remember"]>[0]> = {}) {
  return {
    callerId: "caller",
    rootSession: root,
    requestId: "request-1",
    action: "sendToSession",
    payload: { requestId: "request-1", prompt: "go" },
    run: async () => ({ status: "applied", requestId: "request-1" }),
    ...overrides,
  };
}

describe("SessionControlReceiptCache", () => {
  it("replays the same fingerprint without running twice", async () => {
    const cache = new SessionControlReceiptCache();
    const run = vi.fn(async () => ({ ok: true }));
    const first = cache.remember(input({ run }));
    const replay = cache.remember(input({ run }));
    await expect(first).resolves.toEqual({ ok: true });
    await expect(replay).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(1);
    expect(cache.rootCount).toBe(1);
  });

  it("rejects a different fingerprint under the same request identity", async () => {
    const cache = new SessionControlReceiptCache();
    await cache.remember(input());
    expect(() =>
      cache.remember(input({ payload: { requestId: "request-1", prompt: "different" } })),
    ).toThrow(expect.objectContaining({ code: "conflict" }));
  });

  it("isolates receipts by caller and root session", async () => {
    const cache = new SessionControlReceiptCache();
    const run = vi.fn(async () => ({ ok: true }));
    await cache.remember(input({ run }));
    await cache.remember(input({ callerId: "other-caller", run }));
    await cache.remember(input({ rootSession: otherRoot, run }));
    expect(run).toHaveBeenCalledTimes(3);
    expect(cache.size).toBe(3);
    expect(cache.rootCount).toBe(3);
  });

  it("rejects a new request at the request capacity without evicting receipts", async () => {
    const cache = new SessionControlReceiptCache({ maxRequests: 1 });
    await cache.remember(input());
    expect(() => cache.remember(input({ requestId: "request-2" }))).toThrow(
      expect.objectContaining({ code: "unavailable" }),
    );
    // 已有回执仍可重放。
    await expect(cache.remember(input())).resolves.toEqual({
      status: "applied",
      requestId: "request-1",
    });
  });

  it("rejects a new root at the root capacity", async () => {
    const cache = new SessionControlReceiptCache({ maxRoots: 1 });
    await cache.remember(input());
    expect(() => cache.remember(input({ rootSession: otherRoot }))).toThrow(
      expect.objectContaining({ code: "unavailable" }),
    );
  });

  it("registers the in-flight promise before running the owner", async () => {
    const cache = new SessionControlReceiptCache();
    let release!: () => void;
    const run = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("done");
        }),
    );
    const first = cache.remember(input({ run }));
    const concurrent = cache.remember(input({ run }));
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toBe("done");
    await expect(concurrent).resolves.toBe("done");
  });
});
