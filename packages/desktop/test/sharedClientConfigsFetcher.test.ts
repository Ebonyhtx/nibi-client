import { describe, expect, it, vi } from "vitest";
import {
  createSharedClientConfigsFetcher,
  SHARED_CLIENT_CONFIGS_REQUEST_TIMEOUT_MS,
} from "../src/main/sharedClientConfigsFetcher.js";

describe("sharedClientConfigsFetcher", () => {
  it("并发消费复用同一个 in-flight 请求", async () => {
    let resolveRequest!: (value: unknown) => void;
    const fetchConfig = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const shared = createSharedClientConfigsFetcher({ fetchConfig });

    const first = shared.fetchConfig();
    const second = shared.fetchConfig();
    expect(fetchConfig).toHaveBeenCalledOnce();

    resolveRequest({ code: 0, data: { configs: {} } });
    await expect(first).resolves.toEqual({ code: 0, data: { configs: {} } });
    await expect(second).resolves.toEqual({ code: 0, data: { configs: {} } });
    expect(fetchConfig).toHaveBeenCalledOnce();
  });

  it("成功响应在短 TTL 内复用，过期后重新请求", async () => {
    vi.useFakeTimers();
    try {
      const fetchConfig = vi
        .fn<(_signal: AbortSignal) => Promise<unknown>>()
        .mockResolvedValueOnce({ code: 0, version: 1 })
        .mockResolvedValueOnce({ code: 0, version: 2 });
      const shared = createSharedClientConfigsFetcher({ fetchConfig, cacheTtlMs: 30_000 });

      await expect(shared.fetchConfig()).resolves.toEqual({ code: 0, version: 1 });
      await expect(shared.fetchConfig()).resolves.toEqual({ code: 0, version: 1 });
      expect(fetchConfig).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(shared.fetchConfig()).resolves.toEqual({ code: 0, version: 2 });
      expect(fetchConfig).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("失败不写缓存，后续消费会重新请求", async () => {
    const fetchConfig = vi
      .fn<(_signal: AbortSignal) => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ code: 0 });
    const shared = createSharedClientConfigsFetcher({ fetchConfig });

    await expect(shared.fetchConfig()).rejects.toThrow("offline");
    await expect(shared.fetchConfig()).resolves.toEqual({ code: 0 });
    expect(fetchConfig).toHaveBeenCalledTimes(2);
  });

  it("底层请求超过 3s 会 abort，且不会把超时当成可缓存结果", async () => {
    vi.useFakeTimers();
    try {
      const fetchConfig = vi.fn(
        (signal: AbortSignal) =>
          new Promise<unknown>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted.", "AbortError")),
              { once: true },
            );
          }),
      );
      const shared = createSharedClientConfigsFetcher({ fetchConfig });

      const assertion = expect(shared.fetchConfig()).rejects.toThrow(
        `timed out after ${SHARED_CLIENT_CONFIGS_REQUEST_TIMEOUT_MS}ms`,
      );
      await vi.advanceTimersByTimeAsync(SHARED_CLIENT_CONFIGS_REQUEST_TIMEOUT_MS);
      await assertion;
      expect(fetchConfig).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
