import { expect, it, vi } from "vitest";
import { createRemoteIdentityRegistrationCache } from "#src/project/index.js";

it("同一物理连接内同一路径只登记一次，并发调用共用同一次飞行", async () => {
  const cache = createRemoteIdentityRegistrationCache();
  const connection = {};
  const register = vi.fn(async (path: string) => `stable:${path}`);

  const [first, second] = await Promise.all([
    cache(connection, "/workspace", () => register("/workspace")),
    cache(connection, "/workspace", () => register("/workspace")),
  ]);
  const third = await cache(connection, "/workspace", () => register("/workspace"));

  expect(register).toHaveBeenCalledExactlyOnceWith("/workspace");
  expect(first).toBe("stable:/workspace");
  expect(second).toBe("stable:/workspace");
  expect(third).toBe("stable:/workspace");
});

it("同一连接的不同路径各自登记，不同物理连接重新登记", async () => {
  const cache = createRemoteIdentityRegistrationCache();
  const firstConnection = {};
  const secondConnection = {};
  const register = vi.fn(async (path: string) => `stable:${path}`);

  await cache(firstConnection, "/one", () => register("/one"));
  await cache(firstConnection, "/two", () => register("/two"));
  await cache(firstConnection, "/one", () => register("/one"));
  // Core 重启/重连会换新的物理连接对象，映射表随之重建，必须重新登记。
  await cache(secondConnection, "/one", () => register("/one"));

  expect(register.mock.calls).toEqual([["/one"], ["/two"], ["/one"]]);
});

it("登记失败不缓存，下一次读取重新登记", async () => {
  const cache = createRemoteIdentityRegistrationCache();
  const connection = {};
  const failure = new Error("resolveWorkspace failed");
  const register = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce("stable:/workspace");

  await expect(cache(connection, "/workspace", register)).rejects.toThrow(failure);
  await expect(cache(connection, "/workspace", register)).resolves.toBe("stable:/workspace");

  expect(register).toHaveBeenCalledTimes(2);
  // 成功后的映射继续命中，不再重复登记。
  await expect(cache(connection, "/workspace", register)).resolves.toBe("stable:/workspace");
  expect(register).toHaveBeenCalledTimes(2);
});
