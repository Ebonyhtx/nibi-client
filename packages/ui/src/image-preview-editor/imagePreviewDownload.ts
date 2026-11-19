/**
 * 图片预览下载与有界读取。
 *
 * 这些函数原本内嵌在 image-preview-dialog；抽到 managed 模块后，
 * 预览操作条与对话图片预览共用同一套“原始字节、文件名、50 MiB 上限”语义。
 * 宿主保存端口用结构化类型描述，避免把 UI 模块依赖扩大到 shared 包。
 */

export interface ImagePreviewDownloadItem {
  alt: string;
  filename?: string;
  mediaType?: string;
  src?: string;
}

export type ImagePreviewSaveFile = (
  payload:
    | { data: ArrayBuffer; suggestedName: string }
    | { sourceUrl: string; suggestedName: string },
) => Promise<{
  canceled?: boolean;
  error?: string;
  path?: string;
  success: boolean;
}>;

const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const imageExtensionByMediaType: Record<string, string> = {
  "image/apng": "apng",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function imageDownloadFilename(item: ImagePreviewDownloadItem, mediaType = item.mediaType ?? "") {
  const knownExtension = imageExtensionByMediaType[mediaType.toLowerCase().split(";")[0] ?? ""];
  let sourcePath: string | undefined;
  if (item.src && isHttpSource(item.src)) sourcePath = new URL(item.src).pathname;
  const supportedExtensions = new Set([...Object.values(imageExtensionByMediaType), "jpeg"]);
  const sourceExtension = [item.filename, sourcePath, item.alt]
    .map((name) => /\.([a-z0-9]+)$/iu.exec(name?.trim() ?? "")?.[1]?.toLowerCase())
    .find((extension) => extension !== undefined && supportedExtensions.has(extension));
  // 原字节不能统一命名成 PNG；未知 MIME 保留可信图片后缀，已知 MIME 拒绝不相容的后缀。
  const compatible =
    !knownExtension || (sourceExtension === "jpeg" ? "jpg" : sourceExtension) === knownExtension;
  const extension = (compatible ? sourceExtension : undefined) ?? knownExtension ?? "bin";
  return `${safeDownloadBaseName(item)}.${extension}`;
}

function safeDownloadBaseName(item: ImagePreviewDownloadItem) {
  return (
    (item.filename || item.alt)
      .trim()
      .replace(/\.[a-z0-9]+$/iu, "")
      .replace(/[<>:"/\\|?*]/gu, "-")
      .replace(/\p{Cc}/gu, "-")
      .slice(0, 80) || "image"
  );
}

class ImageDownloadError extends Error {
  constructor(readonly code: "download_failed" | "file_too_large") {
    super(code);
  }
}

function isHttpSource(value: string) {
  return value.startsWith("http://") || value.startsWith("https://");
}

export function sanitizeImageSourceForLog(source: string) {
  if (source.startsWith("data:")) return "data-url";
  try {
    const url = new URL(source);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

export async function readBoundedImageBlob(source: string) {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(source, { signal: controller.signal });
    if (!response.ok || !response.body) throw new ImageDownloadError("download_failed");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new ImageDownloadError("file_too_large");
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > MAX_DOWNLOAD_BYTES) {
        // Web 下载也必须在读取过程中截断，不能等 response.blob() 完整占用 renderer 内存。
        controller.abort();
        throw new ImageDownloadError("file_too_large");
      }
      chunks.push(value);
    }
    if (receivedBytes === 0) throw new ImageDownloadError("download_failed");
    const bytes = new Uint8Array(receivedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Blob([bytes.buffer], {
      type: response.headers.get("content-type") ?? "application/octet-stream",
    });
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
  }
}

function startBrowserNativeDownload(source: string) {
  const link = document.createElement("a");
  link.href = source;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export async function downloadImagePreview(
  item: ImagePreviewDownloadItem,
  saveFile?: ImagePreviewSaveFile,
): Promise<{ kind: "saved"; path: string } | { kind: "started" } | { kind: "canceled" }> {
  if (!item.src) throw new ImageDownloadError("download_failed");
  if (saveFile && isHttpSource(item.src)) {
    const result = await saveFile({
      sourceUrl: item.src,
      suggestedName: imageDownloadFilename(item),
    });
    if (result.canceled) return { kind: "canceled" };
    if (!result.success || !result.path) throw new Error(result.error || "save_failed");
    return { kind: "saved", path: result.path };
  }
  let blob: Blob;
  try {
    blob = await readBoundedImageBlob(item.src);
  } catch (error) {
    if (
      !saveFile &&
      isHttpSource(item.src) &&
      !(error instanceof ImageDownloadError && error.code === "file_too_large")
    ) {
      startBrowserNativeDownload(item.src);
      return { kind: "started" };
    }
    throw error;
  }
  const filename = imageDownloadFilename(item, blob.type);
  if (saveFile) {
    const result = await saveFile({ data: await blob.arrayBuffer(), suggestedName: filename });
    if (result.canceled) return { kind: "canceled" };
    if (!result.success || !result.path) throw new Error(result.error || "save_failed");
    return { kind: "saved", path: result.path };
  }
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
  return { kind: "started" };
}