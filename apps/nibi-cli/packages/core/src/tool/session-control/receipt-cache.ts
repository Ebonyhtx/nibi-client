// 会话控制写请求的幂等回执缓存。
// 身份由工具层注入（retryOf ?? toolCallId），这里只按可信 callers/root 隔离并复验指纹；
// 不能把模型输入当授权或跨会话复用。容量到达后拒绝新请求，不淘汰仍可对账的旧回执。
import { createHash } from "node:crypto";
import { SessionControlError, type CliSessionRef } from "@nibi/session-control/contracts";

const DEFAULT_MAX_REQUESTS = 4096;
const DEFAULT_MAX_ROOTS = 128;

export interface SessionControlReceiptCacheOptions {
  /** 默认 4096。到达上限后新请求返回 unavailable，已有回执仍可重放。 */
  maxRequests?: number;
  /** 默认 128 个 (callerId, rootSession) 组合。 */
  maxRoots?: number;
}

export interface SessionControlReceiptInput<T> {
  callerId: string;
  rootSession: CliSessionRef;
  requestId: string;
  /** 工具方法名，参与指纹；同名方法不同入参不能重放。 */
  action: string;
  /** 已解析的端口输入（含 requestId）；同指纹重放，不同指纹 conflict。 */
  payload: unknown;
  run(): Promise<T>;
}

interface Receipt {
  fingerprint: string;
  result: Promise<unknown>;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new SessionControlError("invalid_input", `${name} must be a positive integer`);
  return value;
}

export class SessionControlReceiptCache {
  private readonly receipts = new Map<string, Receipt>();
  private readonly roots = new Set<string>();
  private readonly maxRequests: number;
  private readonly maxRoots: number;

  constructor(options: SessionControlReceiptCacheOptions = {}) {
    this.maxRequests = positiveInteger(options.maxRequests, DEFAULT_MAX_REQUESTS, "maxRequests");
    this.maxRoots = positiveInteger(options.maxRoots, DEFAULT_MAX_ROOTS, "maxRoots");
  }

  get size(): number {
    return this.receipts.size;
  }

  get rootCount(): number {
    return this.roots.size;
  }

  /**
   * 同步登记 promise 后再开始执行：同一同步片里的重入与重试只能命中同一请求。
   * 不同指纹复用同一 requestId 是调用方错误，不能覆盖原回执。
   */
  remember<T>(input: SessionControlReceiptInput<T>): Promise<T> {
    const key = digest([input.callerId, input.rootSession, input.requestId]);
    const fingerprint = digest([input.action, input.payload]);
    const previous = this.receipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new SessionControlError(
          "conflict",
          "requestId already belongs to a different request",
        );
      return previous.result as Promise<T>;
    }
    const rootKey = digest([input.callerId, input.rootSession]);
    if (!this.roots.has(rootKey)) {
      if (this.roots.size >= this.maxRoots)
        throw new SessionControlError(
          "unavailable",
          "CLI root capacity reached; existing receipts remain queryable",
        );
      this.roots.add(rootKey);
    }
    if (this.receipts.size >= this.maxRequests) {
      // 新根的第一个请求也在容量门内拒绝；根集合保留它，重试同一请求仍会在同一门失败。
      throw new SessionControlError(
        "unavailable",
        "CLI request capacity reached; existing receipts remain queryable",
      );
    }
    const result = Promise.resolve().then(input.run);
    this.receipts.set(key, { fingerprint, result });
    return result as Promise<T>;
  }
}
