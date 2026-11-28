import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { type WebRemoteControlMobileNavigationIntent } from "@nibi/shared";
import { Button } from "@/components/ui/button.js";
import { NibiWorkingIndicator } from "@/components/mobile-ui/NibiWorkingIndicator.js";
import { WebRemoteControlThemeMenu } from "@/WebRemoteControlThemeMenu.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { subscribeWebRemoteControlMobileChatNavigation } from "@/lib/webRemoteControlMobileNavigation.js";
import { WebRemoteControlTaskViewReporter } from "@/web-remote-control/index.js";
import type { WebRemoteControlTerminalTransportState } from "@/root/types.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { useWebRemoteControlTerminalTransportState } from "@/webRemoteControlTerminalTransportState.js";

type WebRemoteControlMobilePage = "home" | "chat";

interface WebRemoteControlMobileHistoryState {
  nibiMobilePage?: WebRemoteControlMobilePage;
}

export function isWebRemoteControlMobileChatHistoryState(
  state: unknown,
): state is WebRemoteControlMobileHistoryState {
  return (
    typeof state === "object" &&
    state !== null &&
    (state as WebRemoteControlMobileHistoryState).nibiMobilePage === "chat"
  );
}

function pushWebRemoteControlMobileChatHistory() {
  if (typeof window === "undefined") {
    return;
  }

  if (isWebRemoteControlMobileChatHistoryState(window.history.state)) {
    return;
  }

  window.history.pushState({ nibiMobilePage: "chat" }, "");
}

function resolveInitialWebRemoteControlMobilePage(
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
): WebRemoteControlMobilePage {
  if (initialNavigationIntent === "chat") {
    return "chat";
  }

  // Bugfix: 手机端在聊天页刷新时，React 内存状态会丢失，但浏览器会保留当前 history.state。
  // 这里复用点击进入聊天页时写入的 history state，避免刷新后只恢复 task 选中态却回到任务首页。
  if (
    typeof window !== "undefined" &&
    isWebRemoteControlMobileChatHistoryState(window.history.state)
  ) {
    return "chat";
  }

  return "home";
}

export function WebRemoteControlMobileShell({
  children,
  isMobileViewport = true,
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  taskViewEnabled = true,
  chatContent,
  chatOverlay,
  initialNavigationIntent,
  isSidePaneOpen = false,
  onCloseSidePane,
  renderTaskHome,
  renderChatHeader,
  sidePaneContent,
  switcher,
  webRemoteControlTerminalTransportState,
}: {
  children?: ReactNode;
  isMobileViewport?: boolean;
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  taskViewEnabled?: boolean;
  initialNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  isSidePaneOpen?: boolean;
  onCloseSidePane?: () => void;
  renderTaskHome: (options: {
    navigateToChat(): void;
    setSwitching(switching: boolean): void;
  }) => ReactNode;
  renderChatHeader: (options: { onBackHome: () => void }) => ReactNode;
  chatContent: ReactNode;
  chatOverlay?: ReactNode;
  sidePaneContent?: ReactNode;
  webRemoteControlTerminalTransportState?: WebRemoteControlTerminalTransportState;
}) {
  const { intl } = useNibiIntl();
  const [currentPage, setCurrentPage] = useState<WebRemoteControlMobilePage>(() =>
    resolveInitialWebRemoteControlMobilePage(initialNavigationIntent),
  );
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const terminalTransportState = useWebRemoteControlTerminalTransportState(
    webRemoteControlTerminalTransportState,
  );
  const isReconnecting = terminalTransportState === "reconnecting";
  const shouldInertChatSurface = Boolean(sidePaneContent) && isSidePaneOpen;

  const navigateToChat = useCallback(() => {
    setCurrentPage("chat");
    pushWebRemoteControlMobileChatHistory();
  }, []);

  const navigateHome = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      isWebRemoteControlMobileChatHistoryState(window.history.state)
    ) {
      window.history.back();
      return;
    }

    setCurrentPage("home");
  }, []);

  useEffect(() => {
    // 初始意图只随导航变化消费；断点恢复不能重放旧 chat 意图，覆盖用户已经返回的 Home。
    if (initialNavigationIntent === "chat") setCurrentPage("chat");
  }, [initialNavigationIntent]);

  useEffect(() => {
    if (!isMobileViewport) return;
    // Host 的 OpenSession 先在 App 层定位任务；移动壳收到请求后切到聊天页并压一条历史，
    // 保证手机返回键仍回到任务列表。桌面宽度的远控页没有这个订阅，不受影响。
    return subscribeWebRemoteControlMobileChatNavigation(() => {
      setCurrentPage("chat");
      pushWebRemoteControlMobileChatHistory();
    });
  }, [isMobileViewport]);

  useEffect(() => {
    if (isMobileViewport && currentPage === "chat") pushWebRemoteControlMobileChatHistory();
  }, [isMobileViewport, currentPage]);

  useEffect(() => {
    if (!isMobileViewport || typeof window === "undefined") {
      return;
    }

    const handlePopState = (event: PopStateEvent) => {
      const nextPage = isWebRemoteControlMobileChatHistoryState(event.state) ? "chat" : "home";
      setCurrentPage(nextPage);
    };

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, [isMobileViewport]);

  // Bugfix: 移动端聊天/侧栏都是 flex 子树，默认 min-width:auto 会按长消息的
  // min-content 宽度撑开抽屉；窄屏随后从左侧裁掉正文。沿整条宽度链显式允许收缩，
  // 让 subagent 输出、进程面板和正文在抽屉内换行。
  return (
    <>
      <WebRemoteControlTaskViewReporter
        enabled={
          taskViewEnabled &&
          (!isMobileViewport ||
            (currentPage === "chat" && !shouldInertChatSurface && !switchingWorkspace))
        }
        activeTaskId={activeTaskId}
        workspacePath={activeWorkspacePath}
        workspaceIdentity={activeWorkspaceIdentity}
        switcher={switcher}
      />
      {isMobileViewport ? (
        <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-background">
          {isReconnecting ? (
            <div
              className={[
                "flex shrink-0 justify-center border-b border-border/60 px-3 py-1.5 pt-[calc(env(safe-area-inset-top)+0.375rem)]",
                currentPage === "home" ? "bg-sidebar" : "bg-header",
              ].join(" ")}
              aria-live="polite"
              aria-busy="true"
              data-web-remote-control-reconnect-notice="true"
            >
              <div className="flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-full border border-popover-border bg-popover/96 px-3 py-1 text-ui-xs font-medium text-foreground shadow-[var(--nibi-shadow-card)]">
                <NibiWorkingIndicator compact phase="starting" />
                <span className="min-w-0 whitespace-nowrap">
                  {intl.formatMessage({ id: "webRemoteControl.mobileShell.reconnecting" })}
                </span>
              </div>
            </div>
          ) : null}
          {currentPage === "home" ? (
            <section
              className={[
                "flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar pb-[env(safe-area-inset-bottom)]",
                isReconnecting ? "" : "pt-[env(safe-area-inset-top)]",
              ]
                .filter(Boolean)
                .join(" ")}
              data-mobile-page="home"
            >
              {renderTaskHome({ navigateToChat, setSwitching: setSwitchingWorkspace })}
            </section>
          ) : (
            <section
              className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground"
              data-mobile-page="chat"
            >
              <div
                className={[
                  "flex min-h-11 shrink-0 items-center gap-2 border-b border-border/75 bg-header px-2",
                  isReconnecting ? "" : "pt-[env(safe-area-inset-top)]",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={intl.formatMessage({
                    id: "webRemoteControl.mobileShell.backHome",
                  })}
                  onClick={navigateHome}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <span className="min-w-0 flex-1 truncate font-display text-ui-base font-semibold leading-[1.4]">
                  {intl.formatMessage({ id: "webRemoteControl.mobileShell.chatTitle" })}
                </span>
                <WebRemoteControlThemeMenu />
              </div>
              {renderChatHeader({ onBackHome: navigateHome })}
              <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <main
                  className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                  aria-hidden={shouldInertChatSurface ? true : undefined}
                  data-mobile-chat-surface={shouldInertChatSurface ? "inert" : undefined}
                  inert={shouldInertChatSurface ? true : undefined}
                >
                  {/* Bugfix: 手机侧栏打开时底部 composer 会被抽屉覆盖。
                  如果聊天区仍留在交互树里，模型选择等控件会被遮挡但仍可被浏览器命中，
                  造成“按钮不可点”的误导。这里把被覆盖的聊天表面设为 inert，
                  让右侧抽屉成为唯一可交互区域。 */}
                  {chatContent}
                </main>
                {sidePaneContent ? (
                  <div
                    className={[
                      "absolute inset-0 z-30 transition-opacity duration-200 ease-out",
                      isSidePaneOpen ? "opacity-100" : "pointer-events-none opacity-0",
                    ].join(" ")}
                    aria-hidden={!isSidePaneOpen}
                    data-mobile-side-pane-overlay="true"
                  >
                    <button
                      type="button"
                      className="absolute inset-0 bg-background/72"
                      aria-label={intl.formatMessage({ id: "sidePane.collapse" })}
                      onClick={onCloseSidePane}
                    />
                    <div
                      className={[
                        "absolute top-0 right-0 h-full w-[min(88vw,28rem)] max-w-full border-l border-border bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-[var(--nibi-shadow-popover)] transition-transform duration-200 ease-out",
                        isSidePaneOpen ? "translate-x-0" : "translate-x-full",
                      ].join(" ")}
                    >
                      {/* Bugfix: 手机远控之前把 side pane 作为底部纵向面板渲染，
                      会挤压聊天区且不像桌面右侧栏。这里改成右侧覆盖抽屉，
                      只覆盖手机聊天区，不改变桌面端分栏布局。 */}
                      {sidePaneContent}
                    </div>
                  </div>
                ) : null}
                {chatOverlay ? (
                  <div
                    className="pointer-events-none absolute inset-0 z-40"
                    data-mobile-chat-overlay="true"
                  >
                    {/* Bugfix: 查找框属于聊天视觉区域，但不能成为 inert 聊天表面的后代。
                    独立 overlay 保留抽屉隔离，同时让文件变更查找仍可聚焦、切换和关闭。 */}
                    <div className="pointer-events-auto">{chatOverlay}</div>
                  </div>
                ) : null}
              </div>
            </section>
          )}

          {switchingWorkspace ? (
            <div
              className="absolute inset-0 z-40 flex items-center justify-center bg-background/82"
              aria-live="polite"
              aria-busy="true"
            >
              <div className="flex items-center gap-2 rounded-xl border border-popover-border bg-popover/96 px-3.5 py-2 text-ui-base text-foreground-subtle shadow-[var(--nibi-shadow-popover)]">
                <NibiWorkingIndicator compact phase="starting" />
                {intl.formatMessage({ id: "common.loading" })}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        children
      )}
    </>
  );
}
