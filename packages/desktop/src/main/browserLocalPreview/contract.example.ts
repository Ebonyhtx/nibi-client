/**
 * browser-local-preview 标准调用示例：Host 装配时只做两步——创建共享实例并装到
 * 内置浏览器分区；导航入口通过 resolveBrowserLocalPreviewNavigation 复用同一份密钥。
 */
import { createBrowserLocalPreview } from "./index.js";
import type {
  BrowserLocalPreview,
  BrowserLocalPreviewFileFetcher,
} from "./contract.js";

export function exampleBrowserLocalPreview(
  fetchFile: BrowserLocalPreviewFileFetcher,
): BrowserLocalPreview {
  return createBrowserLocalPreview({ fetchFile });
}
