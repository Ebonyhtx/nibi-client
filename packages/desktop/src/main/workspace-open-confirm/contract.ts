/**
 * 外部 workspace 深链的品牌化确认窗（main ↔ preload ↔ 静态页）共用契约。
 *
 * 这条链只服务 `nibi://workspace/open?path=...` 的外部来源：确认必须在任何
 * `statSync`/工作区打开之前完成；窗口由 main 直接持有，不经过主 renderer，
 * 避免页面内容伪造授权。
 */
export const WORKSPACE_OPEN_CONFIRM_RESULT_CHANNEL = "nibi:workspace-open-confirm-result";
export const WORKSPACE_OPEN_CONFIRM_ARG_PREFIX = "--nibi-workspace-open-confirm=";

export interface WorkspaceOpenConfirmCopy {
  /** 窗口标题，例如“在 NIBI 中打开这个文件夹？” */
  windowTitle: string;
  /** 来源说明，例如“来源：外部链接” */
  sourceLabel: string;
  /** 风险说明，例如“只打开你信任来源的文件夹……” */
  warning: string;
  /** [确认, 取消] */
  buttons: [string, string];
}

/**
 * 原生兜底与深链路由沿用的完整文案形状（比品牌化窗多出原生 TaskDialog 的字段）。
 * 定义在契约层，避免确认窗反向依赖 desktopOAuthDeepLink 所在的 legacy desktop 模块。
 */
export interface ExternalWorkspaceOpenDialogCopy extends WorkspaceOpenConfirmCopy {
  title: string;
  message: string;
  detail: (path: string) => string;
}

export interface WorkspaceOpenConfirmPayload {
  path: string;
  dark: boolean;
  copy: WorkspaceOpenConfirmCopy;
}

/**
 * 主进程确认窗对外契约。
 *
 * `parent` 是 Electron BrowserWindow（契约层不 import Electron，保持可移植）；
 * 返回 `false` = 用户取消/关闭，`true` = 明确确认，`undefined` = 品牌化窗不可用，
 * 调用方必须回退原生确认（不得直接打开）。
 */
export interface WorkspaceOpenConfirmContract {
  confirm(input: {
    copy: WorkspaceOpenConfirmCopy;
    parent: unknown;
    path: string;
  }): Promise<boolean | undefined>;
}
