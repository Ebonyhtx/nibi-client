// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDataSyncDevices } from "@/data-sync/index.js";

const state = vi.hoisted(() => ({
  platform: null as { requestSourceSettingsAttachment: (id: string) => Promise<unknown> } | null,
  inputs: new Map<string, unknown>(),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => state.platform,
}));
vi.mock("@/hooks/useSourceServerStatuses.js", () => ({
  useRemoteDevicePresentationInputs: () => state.inputs,
}));

beforeEach(() => {
  state.platform = { requestSourceSettingsAttachment: vi.fn() };
  state.inputs = new Map();
});

afterEach(() => {
  cleanup();
});

describe("useDataSyncDevices", () => {
  it("lists only online source devices when the platform can request an attachment", () => {
    state.inputs.set("source-a", {
      state: "online",
      target: { kind: "ssh", host: "dev-a" },
    });
    state.inputs.set("source-b", {
      state: "offline",
      target: { kind: "wsl", distro: "Ubuntu" },
    });
    const { result } = renderHook(() => useDataSyncDevices());
    expect(result.current.remoteUserAvailable).toBe(true);
    expect(result.current.devices).toEqual([{ sourceServerId: "source-a", name: "dev-a" }]);
  });

  it("has no devices on platforms without source-settings attachments", () => {
    state.platform = null;
    state.inputs.set("source-a", {
      state: "online",
      target: { kind: "ssh", host: "dev-a" },
    });
    const { result } = renderHook(() => useDataSyncDevices());
    expect(result.current.remoteUserAvailable).toBe(false);
    expect(result.current.devices).toEqual([]);
  });
});
