import type { IDataSyncCategoryService } from "./contract.js";

/**
 * 旧远端 Agent 缺少数据同步方法时的统一门禁。
 *
 * 根因：数据同步分类方法挂在既有服务通道上（skill-sync / mcp-sync / commands / hooks /
 * subagents / plugin-sync），远端旧版本没有这些方法。ProxyChannel 在服务端直接抛
 * `Error("Method not found: <method>")`（无 code）；走 JSON-RPC 的内核路径则是 -32601。
 * 两者都只说明「方法不存在」，跨 RPC 后只剩 message / name，旧分类页只能显示笼统错误。
 *
 * 这里在调用前用一次只读探测（`getSyncContentHashes({ keys: [] })`）确认对端能力，
 * 探测结果按服务对象缓存（同一连接只探一次）；任何无法确认能力的错误都 fail-closed，
 * 不允许继续 list / 写入，避免半同步。
 */
export const DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE = "remote-agent-outdated";
export const DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE =
  "remote-agent-capability-unverified";

export class DataSyncRemoteAgentOutdatedError extends Error {
  readonly code = DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE;

  constructor(
    readonly method?: string,
    options?: { cause?: unknown },
  ) {
    super(
      method
        ? `The remote agent does not support data sync method "${method}"; update the remote device and retry`
        : "The remote agent does not support data sync; update the remote device and retry",
      options,
    );
    this.name = "DataSyncRemoteAgentOutdatedError";
  }
}

export class DataSyncRemoteAgentCapabilityUnverifiedError extends Error {
  readonly code = DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE;

  constructor(options?: { cause?: unknown }) {
    super(
      "Could not verify that the remote agent supports data sync; no data was read or written",
      options,
    );
    this.name = "DataSyncRemoteAgentCapabilityUnverifiedError";
  }
}

export function isDataSyncRemoteAgentOutdatedError(error: unknown): boolean {
  return readErrorCode(error) === DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE;
}

export function isDataSyncRemoteAgentCapabilityError(error: unknown): boolean {
  const code = readErrorCode(error);
  return (
    code === DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE ||
    code === DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE
  );
}

/**
 * 「能力不存在」的三种跨 RPC 形态：
 * - ProxyChannel 的方法缺失：`Method not found: <method>`（无 code）；
 * - JSON-RPC 内核路径：-32601；
 * - 整个分类通道未注册：ChannelServer 等待注册超时后的 `Unknown channel`。
 */
export function isDataSyncMethodMissingError(error: unknown): boolean {
  if (readErrorCode(error) === -32601) return true;
  if (readErrorName(error) === "Unknown channel") return true;
  return /\bMethod not found\b/i.test(readErrorMessage(error));
}

const capabilityProbes = new WeakMap<object, Promise<void>>();

/**
 * 同一服务对象（同一 attachment / 连接）只探测一次。能力缺失是确定事实，连失败也缓存；
 * 网络等临时错误不缓存，允许重试时重新探测，但本次调用仍 fail-closed。
 */
function ensureDataSyncCapability(service: IDataSyncCategoryService<unknown>): Promise<void> {
  const cached = capabilityProbes.get(service);
  if (cached) return cached;
  const probe = probeDataSyncCapability(service).catch((error: unknown) => {
    if (!isDataSyncRemoteAgentOutdatedError(error)) capabilityProbes.delete(service);
    throw error;
  });
  capabilityProbes.set(service, probe);
  return probe;
}

async function probeDataSyncCapability(
  service: IDataSyncCategoryService<unknown>,
): Promise<void> {
  // 旧对象可能连方法都没有（不是 Proxy）；先做形状检查，避免把 TypeError 误当成网络错误。
  if (typeof service.getSyncContentHashes !== "function") {
    throw new DataSyncRemoteAgentOutdatedError("getSyncContentHashes");
  }
  try {
    // 空 key 不读条目、只证明新合同存在；不要用 checkSyncWriteAccess 探测，它会写标记文件。
    const result = await service.getSyncContentHashes({ keys: [] });
    // 旧/残缺实现可能对未知方法返回 undefined 而不是抛错；没有合法响应时同样不能确认能力。
    if (
      typeof result !== "object" ||
      result === null ||
      typeof (result as { hashes?: unknown }).hashes !== "object" ||
      (result as { hashes?: unknown }).hashes === null
    ) {
      throw new DataSyncRemoteAgentCapabilityUnverifiedError();
    }
  } catch (error) {
    if (isDataSyncRemoteAgentCapabilityError(error)) throw error;
    if (isDataSyncMethodMissingError(error)) {
      throw new DataSyncRemoteAgentOutdatedError("getSyncContentHashes", { cause: error });
    }
    throw new DataSyncRemoteAgentCapabilityUnverifiedError({ cause: error });
  }
}

async function callGuarded<T>(
  service: IDataSyncCategoryService<unknown>,
  method: string,
  run: () => Promise<T>,
): Promise<T> {
  await ensureDataSyncCapability(service);
  try {
    return await run();
  } catch (error) {
    // 兜底：探测成功但某个分类方法仍不存在（部分回移版本）时同样映射为版本过旧。
    if (isDataSyncMethodMissingError(error)) {
      throw new DataSyncRemoteAgentOutdatedError(method, { cause: error });
    }
    throw error;
  }
}

/**
 * 把任一分类服务包装成带能力门禁的同一形状。读、写、探测都经过同一缓存；
 * 无法确认能力时调用直接失败，不会触达后续写入。
 */
export function createDataSyncCapabilityGatedService<T>(
  service: IDataSyncCategoryService<T>,
): IDataSyncCategoryService<T> {
  // 包装层只做协议门禁；具体 payload 形状保持原样，调用方无需感知。
  // 直接用入参（而不是 cast 成 `<unknown>`）保住 T：cast 之后各方法返回
  // `Promise<...<unknown>>`，赋给 `Promise<...<T>>` 会丢类型（TS2322）。
  const raw = service;
  return {
    listSyncItems: () => callGuarded(raw, "listSyncItems", () => raw.listSyncItems()),
    getSyncContentHashes: (params) =>
      callGuarded(raw, "getSyncContentHashes", () => raw.getSyncContentHashes(params)),
    checkSyncWriteAccess: () =>
      callGuarded(raw, "checkSyncWriteAccess", () => raw.checkSyncWriteAccess()),
    exportSyncItems: (params) =>
      callGuarded(raw, "exportSyncItems", () => raw.exportSyncItems(params)),
    importSyncItems: (params) =>
      callGuarded(raw, "importSyncItems", () => raw.importSyncItems(params)),
  };
}

function readErrorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

function readErrorName(error: unknown): unknown {
  return typeof error === "object" && error !== null && "name" in error
    ? (error as { name?: unknown }).name
    : undefined;
}
