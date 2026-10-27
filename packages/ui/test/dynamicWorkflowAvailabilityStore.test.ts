// NIBI 自有动态工作流默认快照：默认提供 alwaysOn，用户选择只在本窗口生效。
import { afterEach, describe, expect, it } from "vitest";
import {
  resetDynamicWorkflowAvailabilityStoreForTests,
  useDynamicWorkflowAvailabilityStore,
} from "@/store/dynamicWorkflowAvailabilityStore.js";

describe("dynamicWorkflowAvailabilityStore", () => {
  afterEach(() => {
    resetDynamicWorkflowAvailabilityStoreForTests();
  });

  it("初值是 loading + 未启用，入口不会先闪一下再收起", () => {
    const state = useDynamicWorkflowAvailabilityStore.getState();
    expect(state.status).toBe("loading");
    expect(state.enabled).toBe(false);
    expect(state.config).toBeNull();
  });

  it("ensureLoaded 发布 NIBI 默认 alwaysOn 快照", async () => {
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded();

    const state = useDynamicWorkflowAvailabilityStore.getState();
    expect(state.status).toBe("ready");
    expect(state.enabled).toBe(true);
    expect(state.config).toMatchObject({ mode: "alwaysOn", offeredMode: "alwaysOn" });
  });

  it("同一个 app 会话只发布一次默认快照", async () => {
    const { ensureLoaded } = useDynamicWorkflowAvailabilityStore.getState();
    await ensureLoaded();
    useDynamicWorkflowAvailabilityStore.getState().setUserMode("disabled");
    await ensureLoaded();

    expect(useDynamicWorkflowAvailabilityStore.getState().enabled).toBe(false);
  });

  it("用户选择覆盖默认提供，并在 refresh/reload 后保持", async () => {
    const store = useDynamicWorkflowAvailabilityStore.getState();
    await store.ensureLoaded();
    useDynamicWorkflowAvailabilityStore.getState().setUserMode("onDemand");
    expect(useDynamicWorkflowAvailabilityStore.getState()).toMatchObject({
      enabled: true,
      config: { mode: "onDemand", offeredMode: "alwaysOn", userMode: "onDemand" },
    });

    await useDynamicWorkflowAvailabilityStore.getState().refresh();
    expect(useDynamicWorkflowAvailabilityStore.getState().config).toMatchObject({
      mode: "onDemand",
    });

    await useDynamicWorkflowAvailabilityStore.getState().reload();
    expect(useDynamicWorkflowAvailabilityStore.getState().config).toMatchObject({
      mode: "onDemand",
    });
  });

  it("清空用户选择后回到默认 alwaysOn", async () => {
    await useDynamicWorkflowAvailabilityStore.getState().ensureLoaded();
    useDynamicWorkflowAvailabilityStore.getState().setUserMode("disabled");
    useDynamicWorkflowAvailabilityStore.getState().setUserMode(undefined);

    expect(useDynamicWorkflowAvailabilityStore.getState()).toMatchObject({
      enabled: true,
      config: { mode: "alwaysOn", source: "default" },
    });
  });
});
