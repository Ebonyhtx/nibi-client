/** 图片输入能力只按模型配置事实展示；上游套餐桥接例外已随套餐业务线移除。 */
export function shouldShowModelVisionBadge(
  _modelId: string,
  supportsImage: boolean | null | undefined,
): boolean {
  return supportsImage === true;
}
