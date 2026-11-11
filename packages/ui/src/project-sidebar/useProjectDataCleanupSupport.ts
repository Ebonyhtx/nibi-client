import { useCallback, useEffect, useState } from "react";
import type { IProjectService, ProjectDataSupport } from "@/project-sidebar/contract.js";
import { logger } from "@/logger.js";

/** 同一 service 只探测一次：旧内核结果不会在本次进程内变好，未知值也等首次测量再收敛。 */
const supportFlights = new WeakMap<object, Promise<ProjectDataSupport>>();

function readProjectDataSupportOnce(service: IProjectService): Promise<ProjectDataSupport> {
  const cached = supportFlights.get(service);
  if (cached) return cached;
  // 旧装配（Web/手机或滚动升级中的 Host）没有这个能力方法：按未知处理，入口保留，
  // 真正测量时由 service 返回 project.data-unsupported 再隐藏。不能在这里抛错拆掉侧栏。
  const readSupport = (service as Partial<IProjectService>).readProjectDataSupport;
  if (typeof readSupport !== "function") {
    const unknown = Promise.resolve({ supported: "unknown" as const });
    supportFlights.set(service, unknown);
    return unknown;
  }
  const flight = readSupport.call(service).catch((cause) => {
    logger.warn("[project-data] 读取清理能力失败", cause);
    // 探测失败不等于内核不支持；入口保留，真正测量时再决定。
    return { supported: "unknown" as const };
  });
  supportFlights.set(service, flight);
  return flight;
}

export function useProjectDataCleanupSupport(service: IProjectService | undefined) {
  const [supported, setSupported] = useState<boolean | "unknown" | undefined>(undefined);
  useEffect(() => {
    if (!service) {
      setSupported(false);
      return;
    }
    let alive = true;
    void readProjectDataSupportOnce(service).then((result) => {
      if (alive) setSupported(result.supported);
    });
    return () => {
      alive = false;
    };
  }, [service]);
  return {
    supported,
    markUnsupported: useCallback(() => setSupported(false), []),
    markSupported: useCallback(() => setSupported(true), []),
  };
}
