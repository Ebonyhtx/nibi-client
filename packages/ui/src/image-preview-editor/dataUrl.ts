export interface DecodedImageDataUrl {
  bytes: Uint8Array;
  /** 数据 URL 里的 MIME；仅保留图片类型。 */
  mediaType: string;
}

const BASE64_IMAGE_DATA_URL = /^data:(image\/[^;,]+);base64,([\s\S]*)$/i;

/** 轻量判断：只有 base64 位图 data URL 才能在不额外请求的情况下取到原始字节。 */
export function isAnnotatableImageSource(source: string): boolean {
  return BASE64_IMAGE_DATA_URL.test(source.trim());
}

/**
 * 从 base64 图片 data URL 还原字节。
 * 预览面板的位图字节已经以 data URL 形式存在，标注入口点击时再解码，避免每次预览都复制一份。
 * 非 base64 / 非图片 / 空内容返回 null，由调用方决定是否隐藏或提示。
 */
export function decodeImageDataUrl(source: string): DecodedImageDataUrl | null {
  const match = BASE64_IMAGE_DATA_URL.exec(source.trim());
  if (!match) return null;
  try {
    const binary = atob(match[2] ?? "");
    if (binary.length === 0) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return { bytes, mediaType: (match[1] ?? "image/png").toLowerCase() };
  } catch {
    return null;
  }
}
