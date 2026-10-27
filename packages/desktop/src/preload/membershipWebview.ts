import { contextBridge, ipcRenderer } from "electron";
import { NibiMembershipWebviewChannels, isTrustedNibiMembershipWebviewUrl } from "@nibi/shared";

/**
 * NIBI 会员购买页（我们自己的官网 `/membership`）专用 preload。
 *
 * 上游 Coding Plan 页已从 NIBI 构建中移除；这里是 NIBI 自己的商品与支付流程，
 * 只暴露一个业务最小面：
 *   `window.nibiBridge.notifyPurchaseComplete({ provider: "nibi" })`
 * 不暴露 ipcRenderer / Node 原语，也不注入上游的凭据与语言变量。
 *
 * 注入时机：Electron `<webview>` 在 `will-attach-webview` 里按 src 判断为会员页时，
 * 把 webPreferences.preload 切到本文件（见 desktopWindowChrome.ts）。
 */

const PUBLIC_BRIDGE_KEY = "nibiBridge";
const NATIVE_BRIDGE_KEY = "__nibiMembershipWebviewNativeBridge__";

interface MembershipPurchaseCompletePayload {
  provider: "nibi";
}

interface MembershipNativeBridge {
  notifyPurchaseComplete(payload: MembershipPurchaseCompletePayload): void;
}

if (
  isTrustedNibiMembershipWebviewUrl(window.location.href, {
    e2eStoreBridgeEnabled: process.env.VITE_NIBI_E2E_STORE_BRIDGE === "1",
  })
) {
  contextBridge.exposeInMainWorld(NATIVE_BRIDGE_KEY, {
    notifyPurchaseComplete(payload: MembershipPurchaseCompletePayload) {
      try {
        ipcRenderer.sendToHost(NibiMembershipWebviewChannels.PurchaseComplete, {
          provider: "nibi",
          timestamp: Date.now(),
        } satisfies import("@nibi/shared").NibiMembershipPurchaseCompletePayload);
      } catch {
        // host renderer 尚未 attach 或 webview 被销毁时 sendToHost 会抛；
        // 官网页面不依赖此调用成功，静默即可。
      }
    },
  } satisfies MembershipNativeBridge);

  contextBridge.executeInMainWorld({
    func: (publicBridgeKey: string, nativeBridgeKey: string) => {
      const nativeBridge = (
        window as unknown as Record<string, MembershipNativeBridge | undefined>
      )[nativeBridgeKey];
      if (!nativeBridge) return;
      const bridge = {
        notifyPurchaseComplete(payload: MembershipPurchaseCompletePayload) {
          if (payload?.provider !== "nibi") return;
          nativeBridge.notifyPurchaseComplete(payload);
        },
      };
      Object.defineProperty(window, publicBridgeKey, {
        value: bridge,
        writable: false,
        configurable: false,
        enumerable: false,
      });
    },
    args: [PUBLIC_BRIDGE_KEY, NATIVE_BRIDGE_KEY],
  });
}
