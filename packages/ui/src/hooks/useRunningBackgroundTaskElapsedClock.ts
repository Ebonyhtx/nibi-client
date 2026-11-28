import { useEffect, useState } from "react";

/**
 * 进程内共享定时器的延迟清理时钟工厂：按间隔将多个订阅者收拢到单条 `setInterval`，
 * 并在 `document.hidden` 时暂停 tick、恢复可见时立即补齐一次，避免大列表或隐藏标签空转。
 */
function createSharedClock(intervalMs: number) {
  const subscribers = new Set<(now: number) => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let visibilityBound = false;

  function tick(now = Date.now()): void {
    for (const subscriber of subscribers) {
      subscriber(now);
    }
  }

  function handleVisibilityChange(): void {
    if (typeof document !== "undefined" && !document.hidden) {
      tick();
    }
  }

  function ensureTimer(): void {
    if (typeof window === "undefined" || timer !== null) {
      return;
    }
    timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      tick();
    }, intervalMs);
    if (!visibilityBound && typeof document !== "undefined") {
      visibilityBound = true;
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }
  }

  function releaseTimerIfIdle(): void {
    if (subscribers.size > 0) {
      return;
    }
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (visibilityBound && typeof document !== "undefined") {
      visibilityBound = false;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    }
  }

  return function useSharedClock(enabled: boolean): number {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
      if (!enabled) {
        return;
      }
      const subscriber = (value: number) => setNow(value);
      subscribers.add(subscriber);
      ensureTimer();
      // 订阅时立即对齐一次：共享时钟可能已经比本地 state 新。
      setNow(Date.now());
      return () => {
        subscribers.delete(subscriber);
        releaseTimerIfIdle();
      };
    }, [enabled]);

    return now;
  };
}

/** 秒级共享时钟：供状态面板、后台任务计时、重连倒计时复用，`document.hidden` 时暂停。 */
export const useSecondClock = createSharedClock(1000);

/** 30 秒级共享时钟：供工作流等待提示复用，避免每行各自持有定时器。 */
export const useHalfMinuteClock = createSharedClock(30_000);

/** 分钟级共享时钟：供相对时间标签与服务器面板共用，`document.hidden` 时暂停。 */
export const useMinuteClock = createSharedClock(60_000);

export function useRunningBackgroundTaskElapsedClock(runningTaskCount: number) {
  // 与状态面板/连接进度共用同一条秒级 interval；没有运行中任务时不订阅。
  // 单个任务完成不需要重启计时器：订阅键只看「有没有运行中任务」。
  return useSecondClock(runningTaskCount > 0);
}
