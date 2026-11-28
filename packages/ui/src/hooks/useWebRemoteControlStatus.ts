import { useEffect, useState } from "react";
import type { IPlatformService, WebRemoteControlStatus } from "@nibi/shared";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

const IDLE_STATUS: WebRemoteControlStatus = { status: "idle" };

function isSameWebRemoteControlStatus(
  left: WebRemoteControlStatus,
  right: WebRemoteControlStatus,
): boolean {
  return (
    left.status === right.status &&
    left.sessionId === right.sessionId &&
    left.windowControlSessionId === right.windowControlSessionId &&
    left.mobileConnected === right.mobileConnected &&
    left.mobileViewState?.activeWorkspaceKey === right.mobileViewState?.activeWorkspaceKey &&
    left.mobileViewState?.activeTaskId === right.mobileViewState?.activeTaskId &&
    left.mobileViewState?.updatedAt === right.mobileViewState?.updatedAt &&
    left.mobileTaskView?.taskId === right.mobileTaskView?.taskId &&
    left.mobileTaskView?.workspacePath === right.mobileTaskView?.workspacePath &&
    left.mobileTaskView?.workspaceIdentity === right.mobileTaskView?.workspaceIdentity &&
    left.mobileTaskView?.remoteSessionId === right.mobileTaskView?.remoteSessionId &&
    left.mobileDeviceInfo?.updatedAt === right.mobileDeviceInfo?.updatedAt &&
    left.mobileDeviceInfo?.userAgent === right.mobileDeviceInfo?.userAgent &&
    left.mobileDeviceInfo?.viewport?.width === right.mobileDeviceInfo?.viewport?.width &&
    left.mobileDeviceInfo?.viewport?.height === right.mobileDeviceInfo?.viewport?.height &&
    left.error === right.error &&
    left.failure?.reason === right.failure?.reason &&
    left.failure?.message === right.failure?.message
  );
}

interface SharedRemoteControlEntry {
  status: WebRemoteControlStatus;
  subscribers: Set<(next: WebRemoteControlStatus) => void>;
  disposePush?: () => void;
  fallbackTimer?: number;
  intervalMs: number;
  cleanupVisibility?: () => void;
}

const sharedRemoteControlByPlatform = new WeakMap<IPlatformService, SharedRemoteControlEntry>();

function subscribeSharedRemoteControl(
  platform: IPlatformService,
  intervalMs: number,
  listener: (next: WebRemoteControlStatus) => void,
): () => void {
  let entry = sharedRemoteControlByPlatform.get(platform);
  if (!entry) {
    const newEntry: SharedRemoteControlEntry = {
      status: IDLE_STATUS,
      subscribers: new Set(),
      intervalMs,
    };
    const applyStatus = (nextStatus: WebRemoteControlStatus) => {
      if (isSameWebRemoteControlStatus(newEntry.status, nextStatus)) return;
      newEntry.status = nextStatus;
      for (const sub of newEntry.subscribers) {
        sub(nextStatus);
      }
    };
    const syncStatus = async () => {
      try {
        applyStatus(await platform.getWebRemoteControlStatus());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.debug("[useWebRemoteControlStatus] 同步 Web 远程控制状态失败", {
          error: message,
        });
      }
    };

    void syncStatus();
    if (typeof platform.onWebRemoteControlStatusChanged === "function") {
      newEntry.disposePush = platform.onWebRemoteControlStatusChanged(applyStatus);
      if (typeof document !== "undefined") {
        const onVisibility = () => {
          if (!document.hidden) void syncStatus();
        };
        document.addEventListener("visibilitychange", onVisibility);
        newEntry.cleanupVisibility = () =>
          document.removeEventListener("visibilitychange", onVisibility);
      }
    } else if (typeof window !== "undefined") {
      // 仅在旧平台无事件推送时保留兜底轮询，且页面隐藏期间跳过 IPC。
      newEntry.fallbackTimer = window.setInterval(() => {
        if (typeof document !== "undefined" && document.hidden) return;
        void syncStatus();
      }, intervalMs);
    }

    entry = newEntry;
    sharedRemoteControlByPlatform.set(platform, entry);
  }

  entry.subscribers.add(listener);
  listener(entry.status);

  return () => {
    const current = sharedRemoteControlByPlatform.get(platform);
    if (!current) return;
    current.subscribers.delete(listener);
    if (current.subscribers.size > 0) return;
    current.disposePush?.();
    current.cleanupVisibility?.();
    if (current.fallbackTimer !== undefined && typeof window !== "undefined") {
      window.clearInterval(current.fallbackTimer);
    }
    sharedRemoteControlByPlatform.delete(platform);
  };
}

export function useWebRemoteControlStatus({
  enabled = true,
  intervalMs = 1000,
}: {
  enabled?: boolean;
  intervalMs?: number;
} = {}): WebRemoteControlStatus {
  const platform = useOptionalPlatform();
  const [status, setStatus] = useState<WebRemoteControlStatus>(IDLE_STATUS);

  useEffect(() => {
    if (!enabled || !platform) {
      setStatus(IDLE_STATUS);
      return;
    }
    return subscribeSharedRemoteControl(platform, intervalMs, setStatus);
  }, [enabled, intervalMs, platform]);

  return status;
}
