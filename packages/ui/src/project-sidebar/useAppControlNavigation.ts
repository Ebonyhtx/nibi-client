// App 控制工具（OpenSession）的显式打开：只消费 Host 投来的事件，定位到任务行后回执。
// 不做任何回退：定位失败或 workspace 未连接时如实回 unavailable，不打开别的会话、不抬升窗口。
import { useEffect, useRef } from "react";

/** 与 `@nibi/services` 的 App 控制事件同形；这里只依赖结构，不把 service 实现拉进 UI。 */
export interface AppControlOpenSessionEvent {
  requestId: string;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  sourceServerId?: string;
  projectId?: string;
}

interface AppControlNavigationPort {
  onOpenSession(): (listener: (event: AppControlOpenSessionEvent) => void) => {
    dispose(): void;
  };
  settleOpenSession(settlement: {
    requestId: string;
    uiTarget?: string;
    reason?: string;
  }): void;
}

export interface AppControlNavigationOptions {
  services: { appControlNavigationService?: AppControlNavigationPort };
  /** 与侧栏任务行同一条导航：激活 workspace tab 并选中 session。 */
  onSelectTask: (
    workspacePath: string,
    taskId: string,
    workspaceIdentity?: string,
  ) => void;
  /** 任务定位成功后的补充导航（手机远控切到聊天页）；失败不回执成功。 */
  onOpened?: () => void;
  enabled?: boolean;
}

export function useAppControlNavigation({
  services,
  onSelectTask,
  onOpened,
  enabled = true,
}: AppControlNavigationOptions): void {
  const onSelectTaskRef = useRef(onSelectTask);
  onSelectTaskRef.current = onSelectTask;
  const onOpenedRef = useRef(onOpened);
  onOpenedRef.current = onOpened;
  const navigation = services.appControlNavigationService;

  useEffect(() => {
    if (!enabled || !navigation?.onOpenSession) return;
    const settle = (settlement: Parameters<typeof navigation.settleOpenSession>[0]) => {
      try {
        navigation.settleOpenSession(settlement);
      } catch {
        // Host 没注册这个频道（手机 allowlist / 旧 host）时没有可结算的请求；不影响 UI。
      }
    };
    let subscription: { dispose(): void } | undefined;
    try {
      subscription = navigation.onOpenSession()((event: AppControlOpenSessionEvent) => {
        try {
          if (!event.workspacePath.trim() || !event.sessionId.trim()) {
            settle({
              requestId: event.requestId,
              reason: "The open request has no usable session target",
            });
            return;
          }
          onSelectTaskRef.current(event.workspacePath, event.sessionId, event.workspaceIdentity);
          onOpenedRef.current?.();
          settle({ requestId: event.requestId, uiTarget: "window:main" });
        } catch (error) {
          settle({
            requestId: event.requestId,
            reason:
              error instanceof Error
                ? error.message
                : "The app window could not open the session",
          });
        }
      });
    } catch {
      return;
    }
    return () => subscription?.dispose();
  }, [enabled, navigation]);
}