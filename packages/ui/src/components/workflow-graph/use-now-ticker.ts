import { useEffect, useState } from "react";
import { useSecondClock } from "@/hooks/useRunningBackgroundTaskElapsedClock.js";

/** 倒计时的自然粒度：秒级文案再快一格文字也不会变。 */
export const NOW_TICKER_INTERVAL_MS = 1_000;

/**
 * 一个只在 `active` 时走的"现在"。
 *
 * 默认 1s 粒度复用共享可见性感知时钟；自定义间隔同样在 `document.hidden` 时跳过 tick，恢复可见时立即补一次。
 */
export function useNowTicker(active: boolean, intervalMs: number = NOW_TICKER_INTERVAL_MS): number {
  const useSharedClock = intervalMs === NOW_TICKER_INTERVAL_MS;
  const sharedNow = useSecondClock(active && useSharedClock);
  const [customNow, setCustomNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || useSharedClock) return undefined;
    const syncNow = () => setCustomNow(Date.now());
    const onVisibility = () => {
      if (typeof document === "undefined" || !document.hidden) syncNow();
    };
    syncNow();
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      syncNow();
    }, intervalMs);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    return () => {
      clearInterval(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
    };
  }, [active, intervalMs, useSharedClock]);
  return useSharedClock ? sharedNow : customNow;
}
