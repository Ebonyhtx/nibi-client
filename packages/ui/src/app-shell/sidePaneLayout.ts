export const SIDE_PANE_DEFAULT_EXPANDED_SIZE = "45%";
export const SIDE_PANE_DEFAULT_EXPANDED_RATIO = 0.45;
/** 桌面对话列最小宽度；不再按窗口比例计算。手机远控壳仍使用 0px 分支。 */
export const WORKSPACE_CONVERSATION_COLUMN_MIN_SIZE = "360px";
export const WORKSPACE_CONVERSATION_COLUMN_REMOTE_MIN_SIZE = "0px";

const SIDE_PANE_TAB_MIN_WIDTH_PX = 60;
const SIDE_PANE_TAB_GAP_PX = 4;
const SIDE_PANE_TAB_OVERFLOW_TOLERANCE_PX = 1;

export function resolveSidePaneTabsOverflow({
  addButtonInside,
  addButtonWidth,
  tabCount,
  viewportWidth,
}: {
  addButtonInside: boolean;
  addButtonWidth: number;
  tabCount: number;
  viewportWidth: number;
}): boolean {
  const tabsWidth =
    tabCount * SIDE_PANE_TAB_MIN_WIDTH_PX + Math.max(0, tabCount - 1) * SIDE_PANE_TAB_GAP_PX;
  const addButtonGap = tabCount > 0 ? SIDE_PANE_TAB_GAP_PX : 0;
  const viewportWidthWithAddButtonInside = viewportWidth + (addButtonInside ? 0 : addButtonWidth);
  const contentWidthWithAddButtonInside = tabsWidth + addButtonGap + addButtonWidth;

  return (
    contentWidthWithAddButtonInside >
    viewportWidthWithAddButtonInside + SIDE_PANE_TAB_OVERFLOW_TOLERANCE_PX
  );
}
