// @vitest-environment jsdom
// NIBI 自有动态工作流：设置里的选择变化后，本窗口 Root 先让 Host 重发策略，
// 再把选择应用到本地默认快照；首次读到的值只是基线，不发信号。
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DynamicWorkflowMode } from "@nibi/shared";
import { useDynamicWorkflowUserModeSync } from "@/hooks/useDynamicWorkflowAvailability.js";
import {
  resetDynamicWorkflowAvailabilityStoreForTests,
  useDynamicWorkflowAvailabilityStore,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function setup() {
  const events: string[] = [];
  const zcodeAgentService = {
    syncDynamicWorkflowUserMode: vi.fn(async (params: { mode?: DynamicWorkflowMode }) => {
      events.push(`sync:${params.mode ?? "follow"}`);
    }),
  };
  const hook = renderHook(
    (props: { settingsLoaded: boolean; userMode: DynamicWorkflowMode | undefined }) => {
      useDynamicWorkflowUserModeSync({ ...props, zcodeAgentService });
    },
    { initialProps: { settingsLoaded: false, userMode: undefined } },
  );
  return { events, hook, zcodeAgentService };
}

describe("useDynamicWorkflowUserModeSync", () => {
  afterEach(() => {
    cleanup();
    resetDynamicWorkflowAvailabilityStoreForTests();
  });

  it("设置未加载与首次读到的值都不发信号，但首次值会应用为基线", () => {
    const { events, hook } = setup();
    hook.rerender({ settingsLoaded: true, userMode: "onDemand" });
    expect(events).toEqual([]);
    expect(useDynamicWorkflowAvailabilityStore.getState().config).toMatchObject({
      mode: "onDemand",
      offeredMode: "alwaysOn",
    });
  });

  it("选择变化：先让 Host 重发策略，再应用本地快照", async () => {
    const { events, hook } = setup();
    hook.rerender({ settingsLoaded: true, userMode: undefined });
    hook.rerender({ settingsLoaded: true, userMode: "disabled" });
    await waitFor(() => expect(events).toEqual(["sync:disabled"]));
    expect(useDynamicWorkflowAvailabilityStore.getState()).toMatchObject({
      status: "ready",
      enabled: false,
      config: { mode: "disabled", offeredMode: "alwaysOn" },
    });

    hook.rerender({ settingsLoaded: true, userMode: undefined });
    await waitFor(() => expect(events).toEqual(["sync:disabled", "sync:follow"]));
    expect(useDynamicWorkflowAvailabilityStore.getState().enabled).toBe(true);
  });

  it("连续两次变化串行发送", async () => {
    const { events, hook } = setup();
    hook.rerender({ settingsLoaded: true, userMode: undefined });
    hook.rerender({ settingsLoaded: true, userMode: "disabled" });
    hook.rerender({ settingsLoaded: true, userMode: "onDemand" });
    await waitFor(() => expect(events).toEqual(["sync:disabled", "sync:onDemand"]));
    expect(useDynamicWorkflowAvailabilityStore.getState().config).toMatchObject({
      mode: "onDemand",
    });
  });

  it("Host 同步失败仍应用本地选择", async () => {
    const { hook, zcodeAgentService } = setup();
    zcodeAgentService.syncDynamicWorkflowUserMode.mockRejectedValueOnce(new Error("host gone"));
    hook.rerender({ settingsLoaded: true, userMode: undefined });
    hook.rerender({ settingsLoaded: true, userMode: "disabled" });
    await waitFor(() =>
      expect(useDynamicWorkflowAvailabilityStore.getState().config).toMatchObject({
        mode: "disabled",
      }),
    );
  });
});
