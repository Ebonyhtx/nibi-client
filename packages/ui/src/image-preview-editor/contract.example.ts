import type { ImageEditorComposerTarget } from "./contract.js";

/** 接收方沿用既有附件 API；不能从此处调用发送命令。 */
export const exampleImageComposerTarget: ImageEditorComposerTarget = {
  appendImage: (output) => output.mediaType === "image/png" && output.bytes.length > 0,
};
