/**
 * 标注入口能力判定。
 *
 * 只在桌面 / Host 形态、且当前渲染进程具备 2D canvas 与 Blob URL 导出能力时显示入口。
 * Web 手机（`canOpenLocalFiles === false`）即使 Chromium 有 canvas 也保持隐藏：
 * 远端页面的图片来自 Host 侧预览字节，标注后的附件应回到桌面输入框，
 * 由手机端编辑容易造成跨端归属不清。
 */
export interface ImageEditorEnvironment {
  /** 是否桌面 / Host 形态；Web 远控为 false。 */
  desktopHost: boolean;
  /** 当前环境是否有可用的 2D canvas 与对象 URL 导出能力。 */
  canvas: boolean;
}

export function canUseImageEditor(environment: ImageEditorEnvironment): boolean {
  return environment.desktopHost && environment.canvas;
}

/** 运行时探测 canvas 导出能力；SSR 或不支持时返回 false。 */
export function detectImageEditorCanvas(): boolean {
  if (
    typeof document === "undefined" ||
    typeof HTMLCanvasElement === "undefined" ||
    typeof URL === "undefined" ||
    typeof URL.createObjectURL !== "function"
  ) {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    return canvas.getContext("2d") !== null;
  } catch {
    return false;
  }
}
