// 手机远控的跨层导航请求。
//
// Host 的 OpenSession 先在 App 层定位任务（可能跨 workspace），移动壳只负责把页面
// 从任务首页切到聊天页。没有移动壳订阅时是 no-op，桌面端不会被它影响。
type WebRemoteControlMobileChatNavigationListener = () => void;

const listeners = new Set<WebRemoteControlMobileChatNavigationListener>();

export function requestWebRemoteControlMobileChatNavigation(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribeWebRemoteControlMobileChatNavigation(
  listener: WebRemoteControlMobileChatNavigationListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}