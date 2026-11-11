import { describe, expect, it, vi } from "vitest";
import type { IDataSyncCategoryService } from "../src/data-sync/contract.js";
import {
  DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE,
  DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE,
  createDataSyncCapabilityGatedService,
  isDataSyncRemoteAgentCapabilityError,
  isDataSyncRemoteAgentOutdatedError,
} from "../src/data-sync/capabilityGate.js";

type CategoryService = IDataSyncCategoryService<unknown>;

function categoryService(overrides: Partial<CategoryService> = {}): CategoryService {
  return {
    listSyncItems: vi.fn(async () => ({ items: [], homeDir: "/home/test" })),
    getSyncContentHashes: vi.fn(async () => ({ hashes: {} })),
    checkSyncWriteAccess: vi.fn(async () => ({ ok: true, path: "/home/test" })),
    exportSyncItems: vi.fn(async () => ({})),
    importSyncItems: vi.fn(async () => ({ results: [] })),
    ...overrides,
  };
}

function methodNotFound(method: string): Error {
  return new Error(`Method not found: ${method}`);
}

describe("data sync capability gate", () => {
  it("maps a missing probe method to outdated and never lists or writes", async () => {
    const service = categoryService({
      getSyncContentHashes: vi.fn(async () => {
        throw methodNotFound("getSyncContentHashes");
      }),
    });
    const gated = createDataSyncCapabilityGatedService(service);

    await expect(gated.listSyncItems()).rejects.toMatchObject({
      code: DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE,
    });
    await expect(
      gated.importSyncItems({ payload: {}, items: [{ key: "a", mode: "createOnly" }] }),
    ).rejects.toMatchObject({ code: DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE });

    expect(service.getSyncContentHashes).toHaveBeenCalledTimes(1);
    expect(service.listSyncItems).not.toHaveBeenCalled();
    expect(service.importSyncItems).not.toHaveBeenCalled();
    expect(isDataSyncRemoteAgentOutdatedError({ code: DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE })).toBe(
      true,
    );
  });

  it("treats -32601 like a missing method", async () => {
    const service = categoryService({
      getSyncContentHashes: vi.fn(async () => {
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      }),
    });
    const gated = createDataSyncCapabilityGatedService(service);

    await expect(gated.listSyncItems()).rejects.toMatchObject({
      code: DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE,
    });
    expect(service.listSyncItems).not.toHaveBeenCalled();
  });

  it("treats an unregistered category channel like a missing capability", async () => {
    const service = categoryService({
      getSyncContentHashes: vi.fn(async () => {
        throw Object.assign(new Error("Channel name 'skill-sync' timed out after 1000ms"), {
          name: "Unknown channel",
        });
      }),
    });
    const gated = createDataSyncCapabilityGatedService(service);

    await expect(gated.listSyncItems()).rejects.toMatchObject({
      code: DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE,
    });
    expect(service.listSyncItems).not.toHaveBeenCalled();
  });

  it("probes a supported peer once and passes every call through", async () => {
    const service = categoryService();
    const gated = createDataSyncCapabilityGatedService(service);

    await gated.listSyncItems();
    await gated.getSyncContentHashes({ keys: ["a"] });
    await gated.checkSyncWriteAccess();
    await gated.exportSyncItems({ keys: ["a"] });
    await gated.importSyncItems({ payload: {}, items: [{ key: "a", mode: "createOnly" }] });

    // 第一次哈希是空 key 探测，第二次才是调用方请求。
    expect(service.getSyncContentHashes).toHaveBeenCalledTimes(2);
    expect(service.getSyncContentHashes).toHaveBeenNthCalledWith(1, { keys: [] });
    expect(service.getSyncContentHashes).toHaveBeenNthCalledWith(2, { keys: ["a"] });
    expect(service.listSyncItems).toHaveBeenCalledTimes(1);
    expect(service.checkSyncWriteAccess).toHaveBeenCalledTimes(1);
    expect(service.exportSyncItems).toHaveBeenCalledTimes(1);
    expect(service.importSyncItems).toHaveBeenCalledTimes(1);
  });

  it("maps a late method-not-found on write to outdated", async () => {
    const service = categoryService({
      importSyncItems: vi.fn(async () => {
        throw methodNotFound("importSyncItems");
      }),
    });
    const gated = createDataSyncCapabilityGatedService(service);

    await expect(
      gated.importSyncItems({ payload: {}, items: [{ key: "a", mode: "createOnly" }] }),
    ).rejects.toMatchObject({ code: DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE });
    expect(service.importSyncItems).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the probe returns no valid hash result", async () => {
    const service = categoryService({
      getSyncContentHashes: vi.fn(async () => undefined as never),
    });
    const gated = createDataSyncCapabilityGatedService(service);

    await expect(gated.listSyncItems()).rejects.toMatchObject({
      code: DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE,
    });
    expect(service.listSyncItems).not.toHaveBeenCalled();
    expect(service.importSyncItems).not.toHaveBeenCalled();
  });

  it("fails closed when capability cannot be verified and retries transient probes", async () => {
    const service = categoryService({
      getSyncContentHashes: vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    });
    const gated = createDataSyncCapabilityGatedService(service);

    await expect(gated.listSyncItems()).rejects.toMatchObject({
      code: DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE,
    });
    expect(service.listSyncItems).not.toHaveBeenCalled();
    expect(service.importSyncItems).not.toHaveBeenCalled();

    await expect(
      gated.importSyncItems({ payload: {}, items: [{ key: "a", mode: "createOnly" }] }),
    ).rejects.toMatchObject({
      code: DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE,
    });
    // 临时错误不缓存，重试会重新探测；但写入始终没有发生。
    expect(service.getSyncContentHashes).toHaveBeenCalledTimes(2);
    expect(service.importSyncItems).not.toHaveBeenCalled();
    expect(isDataSyncRemoteAgentCapabilityError({ code: "other" })).toBe(false);
  });
});
