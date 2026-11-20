// 显式打开会话的 UI 事件通道。
//
// Host 不自己导航、不聚焦、不抬升 OS 窗口：它只把一条带 requestId 的打开请求投给
// Renderer，等待 UI 在自己的任务列表里定位后回执。没有订阅者或超时都返回 unavailable，
// 绝不回退到「猜一个窗口」或打开别的会话。
import { Emitter } from "@nibi/rpc";
import type {
  AppControlOpenSessionEvent,
  AppControlOpenSessionResult,
  AppControlOpenSessionSettlement,
  IAppControlNavigationService,
} from "./contract.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export interface AppControlNavigationDependencies {
  /** UI 回执的上限；到期仍没有回执就是 unavailable。 */
  timeoutMs?: number;
  createRequestId?: () => string;
}

export interface AppControlNavigationRuntime {
  service: IAppControlNavigationService;
  /** Host 侧发起一次打开；request 不含 requestId，由这里铸造。 */
  openSession(
    request: Omit<AppControlOpenSessionEvent, "requestId">,
    signal?: AbortSignal,
  ): Promise<AppControlOpenSessionResult>;
  dispose(): void;
}

interface PendingOpen {
  resolve(result: AppControlOpenSessionResult): void;
  timer: ReturnType<typeof setTimeout>;
  cleanup(): void;
}

export function createAppControlNavigationService(
  dependencies: AppControlNavigationDependencies = {},
): AppControlNavigationRuntime {
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let requestSequence = 0;
  const createRequestId =
    dependencies.createRequestId ??
    (() => {
      // 不引入随机源依赖：requestId 只需要在本次进程内唯一，Host 与 UI 用同一条回执关联。
      requestSequence += 1;
      return `app-open-${process.pid}-${requestSequence}`;
    });
  let listeners = 0;
  const pending = new Map<string, PendingOpen>();
  const emitter = new Emitter<AppControlOpenSessionEvent>({
    onWillAddFirstListener: () => {
      listeners += 1;
    },
    onDidRemoveLastListener: () => {
      listeners = Math.max(0, listeners - 1);
    },
  });

  function settle(settlement: AppControlOpenSessionSettlement): void {
    const entry = pending.get(settlement.requestId);
    if (!entry) return;
    pending.delete(settlement.requestId);
    entry.cleanup();
    if (settlement.reason !== undefined) {
      entry.resolve({ status: "unavailable", reason: settlement.reason });
      return;
    }
    if (settlement.uiTarget !== undefined) {
      entry.resolve({ status: "opened", uiTarget: settlement.uiTarget });
      return;
    }
    entry.resolve({
      status: "unavailable",
      reason: "The app window did not report a destination",
    });
  }

  return {
    service: {
      onDidOpenSession: emitter.event,
      settleOpenSession(settlement) {
        if (!settlement || typeof settlement.requestId !== "string") return;
        settle(settlement);
      },
    },

    async openSession(request, signal) {
      if (signal?.aborted) {
        return { status: "unavailable", reason: "cancelled" };
      }
      if (listeners === 0) {
        // 没有窗口接收：立即失败，不等待超时，也不做任何本地回退。
        return {
          status: "unavailable",
          reason: "No app window is listening for open requests",
        };
      }
      const requestId = createRequestId();
      const result = await new Promise<AppControlOpenSessionResult>((resolve) => {
        const onAbort = () => {
          const entry = pending.get(requestId);
          if (!entry) return;
          pending.delete(requestId);
          entry.cleanup();
          resolve({ status: "unavailable", reason: "cancelled" });
        };
        const timer = setTimeout(() => {
          const entry = pending.get(requestId);
          if (!entry) return;
          pending.delete(requestId);
          entry.cleanup();
          resolve({
            status: "unavailable",
            reason: "The app window did not accept the open request in time",
          });
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        pending.set(requestId, { resolve, timer, cleanup });
        emitter.fire({ requestId, ...request });
      });
      return result;
    },

    dispose() {
      for (const entry of pending.values()) {
        entry.cleanup();
        entry.resolve({ status: "unavailable", reason: "The app host is shutting down" });
      }
      pending.clear();
      emitter.dispose();
    },
  };
}