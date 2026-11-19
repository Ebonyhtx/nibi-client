import type { CaptureBrowserGuestPageRequest, CaptureBrowserGuestPageResult } from "@nibi/shared";
import type { PageElementRect } from "@nibi/design-runtime";

// 设计模式元素截图：renderer 侧 <webview>.capturePage() 会让 renderer 原生崩溃，所以和导出 PNG 一样
// 交给 main 取帧，main 再按 CSS rect 与实测「帧 / CSS 视口」比例裁剪，DPR、Windows 小数缩放与自由尺寸
// 都在 main 一处换算。这里只负责等两帧（让运行时的高亮浮层先移除）后带上视口尺寸。

/** 等两帧再读视口：locate-for-capture 隐藏了浮层，但移除后的画面要到下一次合成才进帧。 */
const READ_VIEWPORT_AFTER_PAINT_SCRIPT = `new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    resolve({ width: window.innerWidth, height: window.innerHeight });
  }));
})`;

export interface BrowserElementScreenshotWebview {
  getWebContentsId(): number;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
}

function readViewport(value: unknown): { width: number; height: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { width?: unknown; height?: unknown };
  return typeof width === "number" && typeof height === "number" && width > 0 && height > 0
    ? { width, height }
    : null;
}

export async function captureBrowserElementScreenshot({
  captureGuestPage,
  key,
  rect,
  webview,
}: {
  captureGuestPage: (
    request: CaptureBrowserGuestPageRequest,
  ) => Promise<CaptureBrowserGuestPageResult>;
  /** Browser tab id：main 用它校验 guest 归属。 */
  key: string;
  rect: PageElementRect;
  webview: BrowserElementScreenshotWebview;
}): Promise<ArrayBuffer | null> {
  if (!key) return null;
  let webContentsId: number;
  try {
    webContentsId = webview.getWebContentsId();
  } catch {
    return null;
  }
  if (!(webContentsId > 0)) return null;
  const viewport = readViewport(await webview.executeJavaScript(READ_VIEWPORT_AFTER_PAINT_SCRIPT));
  if (!viewport) return null;
  if (rect.width <= 0 || rect.height <= 0) return null;
  const result = await captureGuestPage({
    key,
    webContentsId,
    clip: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
    },
  });
  if (!result.success || !result.data) throw new Error(result.error ?? "capture_failed");
  return result.data;
}