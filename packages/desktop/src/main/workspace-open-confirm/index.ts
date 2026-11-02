import { join } from "node:path";
import { BrowserWindow, ipcMain, nativeTheme } from "electron";
import {
  WORKSPACE_OPEN_CONFIRM_ARG_PREFIX,
  WORKSPACE_OPEN_CONFIRM_RESULT_CHANNEL,
  type WorkspaceOpenConfirmCopy,
  type WorkspaceOpenConfirmPayload,
} from "./contract.js";

// 窗口比可见卡片四周各多 24px：透明窗口让 CSS 圆角与投影完整显示，
// 不再出现「圆角卡片画在方形不透明窗口里」的双层边框。
const WINDOW_WIDTH = 568;
const WINDOW_HEIGHT = 384;

let activeWindow: BrowserWindow | null = null;

/**
 * 运行中外部 workspace 深链的品牌化确认窗。
 *
 * 由 main 直接创建并加载本地静态页，不经过主 renderer——页面内容无法伪造授权；
 * 返回 `undefined` 表示品牌化窗不可用（创建/加载失败），调用方应回退到原生
 * `confirmExternalWorkspaceOpen`，由后者继续承担同步确认。
 *
 * 安全约束不变：确认完成前不调用 `handleOpenWorkspacePath`，也不做目录探测。
 */
export async function confirmWorkspaceOpenInWindow(input: {
  copy: WorkspaceOpenConfirmCopy;
  logger: { warn: (...args: unknown[]) => void };
  parent: BrowserWindow;
  path: string;
}): Promise<boolean | undefined> {
  if (activeWindow && !activeWindow.isDestroyed()) {
    // 并发深链极少见；已有确认窗时聚焦它，新的请求按取消处理，避免叠窗。
    activeWindow.focus();
    input.logger.warn("[deep-link] 已有 workspace 确认窗，忽略并发请求", { path: input.path });
    return false;
  }
  if (input.parent.isDestroyed()) return undefined;

  const dark = nativeTheme.shouldUseDarkColors;
  const payload: WorkspaceOpenConfirmPayload = {
    path: input.path,
    dark,
    copy: {
      windowTitle: input.copy.windowTitle,
      sourceLabel: input.copy.sourceLabel,
      warning: input.copy.warning,
      buttons: input.copy.buttons,
    },
  };

  let win: BrowserWindow;
  try {
    win = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      parent: input.parent,
      modal: true,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      roundedCorners: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/workspaceOpenConfirm.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: false,
        spellcheck: false,
        additionalArguments: [
          `${WORKSPACE_OPEN_CONFIRM_ARG_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`,
        ],
      },
    });
  } catch (error) {
    input.logger.warn("[deep-link] 品牌化确认窗创建失败，回退原生弹窗", {
      error: error instanceof Error ? error.message : String(error),
      path: input.path,
    });
    return undefined;
  }

  activeWindow = win;
  win.setMenu(null);

  return await new Promise<boolean | undefined>((resolve) => {
    let settled = false;
    const finish = (accepted: boolean | undefined): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(WORKSPACE_OPEN_CONFIRM_RESULT_CHANNEL, onResult);
      if (activeWindow === win) activeWindow = null;
      if (!win.isDestroyed()) win.close();
      resolve(accepted);
    };
    const onResult = (event: Electron.IpcMainEvent, accepted: unknown): void => {
      if (event.sender !== win.webContents) return;
      finish(accepted === true);
    };

    ipcMain.on(WORKSPACE_OPEN_CONFIRM_RESULT_CHANNEL, onResult);
    win.once("closed", () => {
      if (activeWindow === win) activeWindow = null;
      if (!settled) {
        settled = true;
        ipcMain.removeListener(WORKSPACE_OPEN_CONFIRM_RESULT_CHANNEL, onResult);
        resolve(false);
      }
    });
    win.webContents.once("did-fail-load", () => finish(undefined));
    win.once("ready-to-show", () => {
      win.show();
      win.focus();
    });
    void win
      .loadFile(join(import.meta.dirname, "../renderer/workspace-open-confirm.html"))
      .catch(() => finish(undefined));
  });
}
