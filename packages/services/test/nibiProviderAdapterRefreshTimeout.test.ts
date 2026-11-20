import { NIBI_PROVIDER_ID } from "@nibi/shared";
import { describe, expect, it, vi } from "vitest";
import {
  NibiProviderAdapter,
  OAUTH_REFRESH_TIMEOUT_MS,
} from "../src/oauth/providers/nibiProviderAdapter.js";
import { createNibiProviderRuntimeConfig } from "../src/oauth/providers/nibiProviderConfig.js";
import { createNodeApiClient } from "../src/providers/api/nodeApiClient.js";

describe("NibiProviderAdapter refresh timeout", () => {
  it("启动恢复的 refresh 请求 4s 后被 abort，不再无限等待弱网响应", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("The operation was aborted.", "AbortError")),
              { once: true },
            );
          }),
      );
      const adapter = new NibiProviderAdapter(
        createNibiProviderRuntimeConfig({}),
        createNodeApiClient({ fetchImpl: fetchImpl as typeof fetch }),
      );

      const pending = adapter.refreshToken(
        { accessToken: "expired", refreshToken: "refresh-1" },
        {
          providerId: NIBI_PROVIDER_ID,
          state: "",
          redirectUri: "nibi://oauth/callback",
          now: () => 0,
        },
      );
      const assertion = expect(pending).rejects.toMatchObject({
        name: "ApiError",
        message: expect.stringContaining(`Request timed out after ${OAUTH_REFRESH_TIMEOUT_MS}ms`),
      });

      await vi.advanceTimersByTimeAsync(OAUTH_REFRESH_TIMEOUT_MS);
      await assertion;
      expect(OAUTH_REFRESH_TIMEOUT_MS).toBe(4_000);
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
