import { describe, expect, it, vi } from "vitest";
import { createStandaloneProviderRuntimeHeadersPort } from "../src/app/standalone-account-provider-runtime.js";

/**
 * 上游的 Coding Plan / Team Plan 账号型 Provider 已整体移除（NIBI 4.0 不再有套餐业务）。
 *
 * 这组用例钉住的是「移除是有意的」而不是「刷新逻辑坏了」：端口仍然存在、方法仍是
 * 幂等 no-op，刷新请求给出可读的移除错误。这样后续维护者不会把缺失的凭据投影
 * 当成待修 bug 又接回上游套餐链路。
 */
describe("Standalone Account Provider 套餐鉴权已移除", () => {
  function fixture() {
    const store = {
      load: vi.fn(async () => null),
      loadMany: vi.fn(async () => ({})),
      save: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    return { store, port: createStandaloneProviderRuntimeHeadersPort(store, {}) };
  }

  it("不声明需要在模型请求前刷新凭据", () => {
    const { port } = fixture();
    expect(port.shouldRefreshBeforeModelRequest()).toBe(false);
  });

  it("刷新请求给出明确的移除错误，而不是伪造 token", async () => {
    const { port } = fixture();
    await expect(
      port.refreshBeforeModelRequest({
        providerId: "account:bigmodel-individual-coding-plan",
        modelId: "glm",
      } as never),
    ).rejects.toThrow("Standalone Account Provider 套餐鉴权已移除");
  });

  it("清理入口是幂等 no-op（旧会话/退出路径仍会调用）", async () => {
    const { port } = fixture();
    expect(() => port.clearProjectTokens()).not.toThrow();
    await expect(port.invalidateChangedCredentials()).resolves.toBeUndefined();
  });
});
