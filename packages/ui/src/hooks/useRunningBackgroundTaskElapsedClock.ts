import { useEffect, useState } from "react";

/**
 * 秒级"现在"时钟：进程内**共享一个** interval，页面不可见时暂停。
 *
 * 为什么需要它：状态面板的终端/子代理/工作流三个分区、后台任务计时、连接进度等各自
 * 起一个 `setInterval(1000)`。多会话/多侧栏同时挂载时就是十几条定时器在同帧 setState；
 * 应用最小化后仍然空转。这里把订阅者收进一个集合，只保留一条 interval，并在
 * `document.hidden` 时跳过 tick、恢复可见时立即补一次。
 *
 * 返回值为当前秒级时间戳；`enabled=false` 时不订阅、不触发重渲染。
 */
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
  }, 1000);
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

export function useSecondClock(enabled: boolean): number {
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
}

export function useRunningBackgroundTaskElapsedClock(runningTaskCount: number) {
  // 与状态面板/连接进度共用同一条秒级 interval；没有运行中任务时不订阅。
  // 单个任务完成不需要重启计时器：订阅键只看「有没有运行中任务」。
  return useSecondClock(runningTaskCount > 0);
}
