import type {
  BrowserViewExportPageFormat,
  BrowserViewExportPageResult,
  IPlatformService,
} from "@nibi/shared";
import type { BrowserState } from "@/embeddedBrowserHelpers.js";

export type BrowserPageExportOutcome = "saved" | "canceled" | "failed";

type BrowserPageExportPlatform = Pick<IPlatformService, "browserViewExportPage" | "saveFile">;

// Windows 既拒绝保留字符，也拒绝 C0 控制字符；标题来自 guest 页面，不能假定干净。
// 用 Unicode 属性转义而不是控制字符字面量，避免触发 no-control-regex。
const WINDOWS_INVALID_FILENAME_CHARS = /[<>:"/\\|?*\p{Cc}]/gu;

/**
 * 导出入口是否可用：格式/保存能力、guest ready 与 residency 都必须成立。
 *
 * loading 期间 Chromium 的 capturePage/printToPDF 可能拿到空白中间帧，
 * 这里直接禁用而不是导出半成品；suspended/restoring 由 shell 接管，不能导出。
 */
export function canExportBrowserPage({
  platform,
  browserState,
  isResidencyRestore = false,
  isResidencySuspended = false,
  isExporting = false,
}: {
  platform: BrowserPageExportPlatform | null | undefined;
  browserState: Pick<BrowserState, "guestFailure" | "isLoading" | "isReady">;
  isResidencyRestore?: boolean;
  isResidencySuspended?: boolean;
  isExporting?: boolean;
}): boolean {
  return Boolean(
    platform?.browserViewExportPage &&
    platform.saveFile &&
    browserState.isReady &&
    !browserState.isLoading &&
    !browserState.guestFailure &&
    !isResidencyRestore &&
    !isResidencySuspended &&
    !isExporting,
  );
}

function sanitizeBrowserExportFileBaseName(value: string): string {
  const sanitized = value
    .replace(WINDOWS_INVALID_FILENAME_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Windows 不允许文件名以空格或点结尾（点结尾会被资源管理器吞掉扩展名语义）。
    .replace(/[. ]+$/g, "");
  return sanitized.trim();
}

function resolveHostname(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** 文件名取页面标题 → hostname → "page"，并清洗 Windows 非法字符与结尾空格/点。 */
export function buildBrowserExportFileName({
  title,
  url,
  format,
}: {
  title?: string | null;
  url?: string | null;
  format: BrowserViewExportPageFormat;
}): string {
  const preferred = title?.trim() || resolveHostname(url) || "page";
  const base = sanitizeBrowserExportFileBaseName(preferred) || "page";
  return `${base}.${format}`;
}

/**
 * 导出 guest 并走系统另存为对话框。
 *
 * 取消保存不是错误：不弹 toast，调用方也不会把它展示成失败。
 */
export async function exportBrowserPageToFile({
  key,
  webContentsId,
  format,
  title,
  url,
  platform,
  formatMessage,
  notify,
}: {
  key: string;
  webContentsId: number;
  format: BrowserViewExportPageFormat;
  title?: string | null;
  url?: string | null;
  platform: BrowserPageExportPlatform;
  formatMessage: (descriptor: { id: string }, values?: Record<string, string | number>) => string;
  notify: (message: string) => void;
}): Promise<BrowserPageExportOutcome> {
  const exportPage = platform.browserViewExportPage;
  const saveFile = platform.saveFile;
  if (!exportPage || !saveFile) {
    notify(formatMessage({ id: "browser.export.failed" }));
    return "failed";
  }

  let result: BrowserViewExportPageResult;
  try {
    result = await exportPage({ key, webContentsId, format });
  } catch {
    notify(formatMessage({ id: "browser.export.failed" }));
    return "failed";
  }
  if (!result?.success || !result.data || result.data.byteLength === 0) {
    notify(formatMessage({ id: "browser.export.failed" }));
    return "failed";
  }

  try {
    const saved = await saveFile({
      data: result.data,
      suggestedName: buildBrowserExportFileName({ title, url, format }),
    });
    if (saved.canceled) return "canceled";
    if (!saved.success) {
      notify(formatMessage({ id: "browser.export.failed" }));
      return "failed";
    }
    notify(formatMessage({ id: "browser.export.success" }));
    return "saved";
  } catch {
    notify(formatMessage({ id: "browser.export.failed" }));
    return "failed";
  }
}
