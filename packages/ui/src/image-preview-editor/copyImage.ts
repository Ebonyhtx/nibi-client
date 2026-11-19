/**
 * 把已加载的预览图片编码成 PNG 并写入系统剪贴板。
 *
 * 复制与“加入对话”共用同一份 PNG 编码：剪贴板通常只接受 PNG，
 * 加入对话也复用现有 Composer 的 `appendImage` 入口，因此两边都不复制棋盘背景。
 */

/** 按图片自然尺寸编码 PNG；保留透明度。 */
export function encodePreviewImagePng(image: HTMLImageElement): Promise<Blob> {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return Promise.reject(new Error("Preview image is not loaded"));
  }
  return new Promise<Blob>((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      reject(new Error("Image canvas is unavailable"));
      return;
    }
    context.drawImage(image, 0, 0);
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
      "image/png",
    );
  });
}

export function copyPreviewImage(image: HTMLImageElement): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard?.write ||
    typeof ClipboardItem === "undefined"
  ) {
    return Promise.reject(new Error("Image clipboard is unavailable"));
  }
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return Promise.reject(new Error("Preview image is not loaded"));
  }
  // Safari 在异步转换后可能丢失用户激活，必须在点击调用栈内提交带 Promise 的 ClipboardItem。
  return navigator.clipboard.write([
    new ClipboardItem({ "image/png": encodePreviewImagePng(image) }),
  ]);
}