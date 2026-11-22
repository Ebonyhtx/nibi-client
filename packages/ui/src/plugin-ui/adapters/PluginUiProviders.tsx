import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { isRemoteWorkspaceIdentity } from "@nibi/shared";
import type {
  OpenPluginUiSideTabRequest,
  PluginUiSessionScope,
  PluginUiSessionCommandPort,
  PluginUiToolBinding,
} from "@/plugin-ui/contract.js";
import { documentViewerInstance } from "@/plugin-ui/contract.js";
import { createPluginUiSessionActions } from "@/plugin-ui/adapters/pluginUiSessionBinding.js";
import { registerPluginUiSessionActions } from "@/plugin-ui/adapters/pluginUiSessionActions.js";
import { usePluginUiResourceDeltaFeed } from "@/plugin-ui/adapters/pluginUiResourceDeltaFeed.js";
import { resolvePluginUiSurfaceTitle } from "@/plugin-ui/adapters/usePluginUiSurfaces.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import type { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";

const WorkspaceActions = createContext<((request: OpenPluginUiSideTabRequest) => void) | undefined>(
  undefined,
);
const SessionScope = createContext<PluginUiSessionScope | null>(null);

/** Shell 只在边界提供面板动作，中间布局组件不感知插件请求。 */
export function PluginUiWorkspaceProvider({
  onOpenSidePane,
  children,
}: {
  onOpenSidePane: (request: OpenPluginUiSideTabRequest) => void;
  children: ReactNode;
}) {
  return <WorkspaceActions.Provider value={onOpenSidePane}>{children}</WorkspaceActions.Provider>;
}
export function useOpenPluginUi() {
  return useContext(WorkspaceActions);
}

/**
 * 扩展代码 `nibi.ui.openView` / `nibi.notifications.show` 的 renderer 侧出口。
 *
 * 事件由 Host-local 插件 backend 发出（桌面 Host 内的扩展宿主）；这里只做两件事：
 * 按工作区匹配、复用现有侧栏标签页链路打开面板/弹 toast。没有事件源的 backend
 * （旧 agent 路由、远端）不会调用这里，面板保持不可用而不是假装打开。
 */
export function PluginExtensionUiBridge({
  activeTaskId,
  workspacePath,
  workspaceIdentity,
}: {
  activeTaskId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const services = useOptionalServices();
  const platform = useOptionalPlatform();
  const openPluginUi = useOpenPluginUi();
  const { intl, locale } = useNibiIntl();
  useEffect(() => {
    const service = services?.pluginManagementService;
    const openViewEvent = service?.onPluginUiOpenView?.();
    const notificationEvent = service?.onPluginNotification?.();
    if (!service || !openViewEvent || !notificationEvent) return;
    // 事件可能来自旧 Host（没有 identity），此时按路径匹配；两边都有 identity 时必须一致。
    const matches = (event: { workspacePath: string; workspaceIdentity?: string }): boolean =>
      event.workspacePath === workspacePath &&
      (event.workspaceIdentity === undefined || event.workspaceIdentity === workspaceIdentity);
    const unavailable = intl.formatMessage({ id: "settings.plugins.store.ui.unavailable" });
    const openViewSubscription = openViewEvent((event) => {
      if (!matches(event) || !openPluginUi) return;
      // 面板是本地沙箱页面；远端会话和没有沙箱的宿主不能在本窗口打开。
      if (
        !platform?.pluginSandbox ||
        isRemoteWorkspaceIdentity(workspaceIdentity ?? "")
      ) {
        toast(intl.formatMessage({ id: "settings.plugins.store.ui.unsupported" }));
        return;
      }
      if (!activeTaskId) {
        toast(unavailable);
        return;
      }
      const bridge = services.pluginUiBridgeService;
      if (!bridge) {
        toast(unavailable);
        return;
      }
      void bridge
        .listSurfaces({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        })
        .then((surfaces) => {
          const surface = surfaces.find(
            (candidate) =>
              candidate.pluginId === event.pluginId && candidate.id === event.surfaceId,
          );
          if (!surface) {
            toast(unavailable);
            return;
          }
          openPluginUi({
            parentSessionId: activeTaskId,
            surfaceId: surface.id,
            serverName: surface.server,
            pluginId: surface.pluginId,
            resourceUri: surface.resourceUri,
            ...documentViewerInstance(surface.resourceUri),
            title: resolvePluginUiSurfaceTitle(surface.title, locale),
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          });
        })
        .catch(() => toast(unavailable));
    });
    const notificationSubscription = notificationEvent((event) => {
      if (!matches(event)) return;
      toast(event.body ? `${event.title}: ${event.body}` : event.title);
    });
    return () => {
      openViewSubscription.dispose();
      notificationSubscription.dispose();
    };
  }, [
    activeTaskId,
    intl,
    locale,
    openPluginUi,
    platform,
    services,
    workspaceIdentity,
    workspacePath,
  ]);
  return null;
}

/** SessionPane 拥有命令入口；本适配器只绑定作用域与挂载生命周期。 */
export function PluginUiSessionProvider({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  sessionId,
  readOnly,
  sendText,
  uploadAttachment,
  projectionStore,
  children,
}: Omit<PluginUiSessionScope, "sessionId"> & {
  sessionId: string | null;
  readOnly: boolean;
  /** 本会话的投影 store（lease 就绪后给出），插件资源通知从它的 live 增量路由到沙箱实例。 */
  projectionStore?: ConversationProjectionStore | null;
  children: ReactNode;
} & PluginUiSessionCommandPort) {
  const scope = useMemo(
    () => (sessionId ? { workspacePath, workspaceIdentity, remoteSessionId, sessionId } : null),
    [workspacePath, workspaceIdentity, remoteSessionId, sessionId],
  );
  const port = useRef({ sendText, uploadAttachment });
  port.current = { sendText, uploadAttachment };
  usePluginUiResourceDeltaFeed(projectionStore, scope);
  useEffect(() => {
    if (!scope || readOnly) return;
    // 修复：发送配置变更会重建回调，但不应让同一挂载中的待确认请求失效。
    return registerPluginUiSessionActions(
      scope,
      createPluginUiSessionActions(scope, {
        sendText: (...args) => port.current.sendText(...args),
        uploadAttachment: (...args) => port.current.uploadAttachment(...args),
      }),
    );
  }, [scope, readOnly]);
  return <SessionScope.Provider value={scope}>{children}</SessionScope.Provider>;
}

export function usePluginUiToolBinding(toolCallId: string): PluginUiToolBinding | undefined {
  const scope = useContext(SessionScope);
  const open = useOpenPluginUi();
  return useMemo(
    () =>
      scope
        ? {
            scope: { ...scope, toolCallId },
            ...(open
              ? {
                  onOpenSidePane: (
                    request: Parameters<NonNullable<PluginUiToolBinding["onOpenSidePane"]>>[0],
                  ) =>
                    open({
                      ...request,
                      workspacePath: scope.workspacePath,
                      workspaceIdentity: scope.workspaceIdentity,
                      remoteSessionId: scope.remoteSessionId,
                      parentSessionId: scope.sessionId,
                    }),
                }
              : {}),
          }
        : undefined,
    [open, scope, toolCallId],
  );
}
