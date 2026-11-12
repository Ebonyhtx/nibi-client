/**
 * 「编辑后保存为附件」的可用性判定。
 *
 * 按钮必须同时满足：图片已完成解码（导出画布依赖 natural size）、存在至少一条编辑内容、
 * 当前没有在途导出。拆成纯函数便于单测，也避免 UI 与导出流程各自判断出现分叉。
 */
export interface EditedImageSaveState {
  /** 编辑表面已完成图片解码；导出画布需要真实的自然尺寸。 */
  imageReady: boolean;
  /** 当前存在至少一条标注 / 草稿文字。 */
  hasEdits: boolean;
  /** 正在导出并投递给输入框；期间禁用防止重复附件。 */
  saving: boolean;
}

export function canSaveEditedImage(state: EditedImageSaveState): boolean {
  return state.imageReady && state.hasEdits && !state.saving;
}
