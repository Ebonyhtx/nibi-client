import { BROWSER_LOCAL_PREVIEW_SCHEME } from "@nibi/shared";
import type { DesignEditableProperty, DesignSelectedElement } from "@nibi/design-runtime";
import { browserLocalPreviewSourceUrl } from "@/embeddedBrowserHelpers.js";

// 设计模式的纯函数：浏览器地址 ↔ 本地源文件、属性面板可改的 CSS 属性。
// 不做任何授权判定：真正的 workspace 约束与 expected-content 校验在 Host 的
// IFileService.readDesignSourceFile / writeDesignSourceFile 里。

export type DesignStyleProperty = Exclude<DesignEditableProperty, "text">;

/** 面板属性 → 写进 style 属性的 CSS 名。 */
export const DESIGN_STYLE_CSS_NAMES: Record<DesignStyleProperty, string> = {
  color: "color",
  background: "background-color",
  fontSize: "font-size",
  fontWeight: "font-weight",
  textAlign: "text-align",
  borderRadius: "border-radius",
  padding: "padding",
  opacity: "opacity",
};

export const DESIGN_STYLE_PROPERTIES = [
  "color",
  "background",
  "fontSize",
  "fontWeight",
  "textAlign",
  "borderRadius",
  "padding",
  "opacity",
] as const satisfies readonly DesignStyleProperty[];

/** 同一页面（忽略 hash）的 key：换页时清空选中与保存状态。 */
export function toDesignPageKey(url: string): string {
  return url.split("#")[0] ?? url;
}

function fileUrlToLocalPath(fileUrl: string): string | null {
  try {
    const url = new URL(fileUrl);
    if (url.protocol !== "file:") return null;
    // file://host/... 是 UNC/网络共享；本地设计写回只接受本机路径。
    if (url.host && url.host !== "localhost") return null;
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname || pathname.includes("\0")) return null;
    // Windows 的 file URL 形如 /C:/dir/page.html；去掉前导斜杠后 fs 可直接使用。
    return /^\/[A-Za-z]:\//u.test(pathname) ? pathname.slice(1) : pathname;
  } catch {
    return null;
  }
}

/**
 * 浏览器地址 → 本地 HTML 源文件路径；不是本地 HTML 预览页时返回 null。
 * nibi-html://<sig>/<encodedRoot>/<file> 由 browserLocalPreviewSourceUrl 还原成 file:，
 * 原始 file: 直接使用；query/hash 不参与文件定位。
 */
export function designSourcePathForBrowserUrl(url: string): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    // 与 guest preload 的桥接校验保持一致：只有带 64 位签名 host 的 nibi-html URL 才是有效预览页。
    if (
      parsed.protocol === `${BROWSER_LOCAL_PREVIEW_SCHEME}:` &&
      !/^[a-f0-9]{64}$/u.test(parsed.hostname)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const fileUrl = browserLocalPreviewSourceUrl(url) ?? url;
  const path = fileUrlToLocalPath(fileUrl);
  if (!path || !/\.html?$/iu.test(path)) return null;
  return path;
}

export function isDesignSourcePageUrl(url: string): boolean {
  return designSourcePathForBrowserUrl(url) !== null;
}

/** 面板标题：tag + id/class 摘要；不伪造不可见信息。 */
export function describeDesignElement(selection: DesignSelectedElement): string {
  const { tagName } = selection.element;
  const id = selection.element.attributes?.["id"];
  if (id) return `${tagName}#${id}`;
  const className = selection.element.attributes?.["class"]?.trim().split(/\s+/u)[0];
  return className ? `${tagName}.${className}` : tagName;
}

/** 选中元素当前属性值；用于输入框初始值。 */
export function designStyleValue(
  selection: DesignSelectedElement,
  property: DesignStyleProperty,
): string {
  return selection.editable[property] ?? "";
}
