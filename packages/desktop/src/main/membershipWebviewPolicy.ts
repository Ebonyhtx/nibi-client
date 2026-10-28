import { session as electronSession } from "electron";
import { NIBI_MEMBERSHIP_WEBVIEW_PARTITION, isTrustedNibiMembershipWebviewUrl } from "@nibi/shared";

/**
 * 会员购买 webview 的会话级闸门。
 *
 * Electron 未注册 permission handler 的 session 会自动批准所有权限请求（摄像头/麦克风/
 * 地理位置），会员页是外部站点，必须 fail-closed。导航 allowlist 则按 guest 挂在
 * attachMembershipGuestNavigationGuard（desktopWindowChrome 的 did-attach-webview）。
 */

/** 无害权限白名单：与内置浏览器同口径；会员页不需要摄像头/麦克风/定位等敏感权限。 */
const MEMBERSHIP_SILENT_ALLOW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "fullscreen",
  "pointerLock",
  "mediaKeySystem",
]);

export function applyMembershipWebviewSessionPolicy(): void {
  const membershipSession = electronSession.fromPartition(NIBI_MEMBERSHIP_WEBVIEW_PARTITION);
  membershipSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (MEMBERSHIP_SILENT_ALLOW_PERMISSIONS.has(permission)) {
      callback(true);
      return;
    }
    console.warn(`[membership-webview] denied permission request: ${permission}`);
    callback(false);
  });
  membershipSession.setPermissionCheckHandler(
    (_webContents, permission) => MEMBERSHIP_SILENT_ALLOW_PERMISSIONS.has(permission),
  );
}

/**
 * 会员 guest 的导航 allowlist：只允许官网 /membership 及其子路径。
 * 支付跳转走 window.open（宿主统一路由）；主 frame 内的跨站导航一律拒绝，
 * 防止 membership 分区的站点会话被带去任意第三方页面。
 */
export function attachMembershipGuestNavigationGuard(
  guest: Electron.WebContents,
  options: { warn: (message: string, ...details: unknown[]) => void },
): void {
  const e2eStoreBridgeEnabled = process.env.VITE_NIBI_E2E_STORE_BRIDGE === "1";
  const allowed = (url: string | undefined): boolean =>
    isTrustedNibiMembershipWebviewUrl(url, { e2eStoreBridgeEnabled });
  guest.on("will-navigate", (event, url) => {
    if (allowed(url)) return;
    options.warn(`[membership-webview] blocked will-navigate: ${url}`);
    event.preventDefault();
  });
  guest.on("will-redirect", (event, url) => {
    if (allowed(url)) return;
    options.warn(`[membership-webview] blocked will-redirect: ${url}`);
    event.preventDefault();
  });
}
