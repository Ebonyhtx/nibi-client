// @vitest-environment jsdom
import { createElement } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyOAuthLoginFailed, useOAuth } from "@/hooks/useOAuth.js";

const mocks = vi.hoisted(() => ({
  oauthService: {
    getProviders: vi.fn(async () => []),
    getActiveProvider: vi.fn(async () => null),
    startOAuthWithPolling: vi.fn(async () => ({
      authorizeUrl: "https://auth.example/authorize",
      state: "state-1",
      provider: "nibi",
    })),
    cancelPending: vi.fn(async () => {}),
  },
  registerOAuthState: vi.fn(),
  openExternal: vi.fn(),
  reportTelemetryEvent: vi.fn(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ oauthService: mocks.oauthService }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    registerOAuthState: mocks.registerOAuthState,
    openExternal: mocks.openExternal,
    reportTelemetryEvent: mocks.reportTelemetryEvent,
  }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
  }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: () => vi.fn(),
}));
vi.mock("@/lib/appTelemetry.js", () => ({
  reportAppTelemetryEvent: vi.fn(async () => {}),
}));
vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("useOAuth login failure broadcast", () => {
  it("a waiting instance exits waiting with the failure message", async () => {
    let latest!: ReturnType<typeof useOAuth>;
    function Probe() {
      latest = useOAuth();
      return null;
    }
    render(createElement(Probe));
    await act(async () => {
      await latest.startLogin("nibi");
    });
    expect(latest.status).toBe("waiting");

    act(() => {
      notifyOAuthLoginFailed("login.oauth.loginFailure");
    });
    expect(latest.status).toBe("error");
    expect(latest.error).toBe("login.oauth.loginFailure");
    expect(latest.pendingProvider).toBeNull();
  });

  it("an idle instance is not overwritten by the broadcast", async () => {
    let latest!: ReturnType<typeof useOAuth>;
    function Probe() {
      latest = useOAuth();
      return null;
    }
    render(createElement(Probe));
    await act(async () => {
      await latest.refreshProviders();
    });
    expect(latest.status).toBe("idle");

    act(() => {
      notifyOAuthLoginFailed("login.oauth.loginFailure");
    });
    expect(latest.status).toBe("idle");
    expect(latest.error).toBeNull();
    void screen;
  });

  it("the broadcast uses the standard login failure copy when no message is given", async () => {
    let latest!: ReturnType<typeof useOAuth>;
    function Probe() {
      latest = useOAuth();
      return null;
    }
    render(createElement(Probe));
    await act(async () => {
      await latest.startLogin("nibi");
    });
    act(() => {
      notifyOAuthLoginFailed();
    });
    expect(latest.status).toBe("error");
    expect(latest.error).toBe("login.oauth.loginFailure");
  });
});
