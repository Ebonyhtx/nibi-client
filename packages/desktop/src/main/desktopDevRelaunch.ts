import { app, BrowserWindow } from "electron";

/**
 * 开发态下"重启应用"应退化为"重载渲染进程"。
 *
 * 为什么（2026-10-20 实测）：`app.relaunch()` 只拉起一个新的 Electron 进程，而开发态的
 * 渲染页由父链里的 Vite 提供；`concurrently -k` 会在 Electron 退出时把 tsup/vite 一起收掉，
 * 于是新进程拿到的 `ELECTRON_RENDERER_URL` 指向一个已经死掉的端口 —— 用户看到的是一个
 * 空白窗口（标题还停在 "NIBI Dev"），必须手动重跑整个 dev 链才能恢复。
 *
 * 退出登录（`RelaunchApp`）与"清除全部数据"都会走这里。开发态重载一次渲染进程即可：
 * 凭据已在磁盘上被清掉，页面重新初始化就会回到未登录态，开发循环也不必等几分钟重建。
 *
 * 生产构建（`app.isPackaged`）不受影响，仍由调用方执行真正的进程重启。
 */
export function reloadRendererInDevelopment(logger: {
  info: (...args: unknown[]) => void;
}): boolean {
  if (app.isPackaged) {
    return false;
  }
  const windows = BrowserWindow.getAllWindows();
  if (windows.length === 0) {
    return false;
  }
  logger.info("[relaunch] dev runtime: reloading renderer instead of restarting the process chain", {
    windows: windows.length,
  });
  for (const window of windows) {
    if (!window.isDestroyed()) {
      window.webContents.reload();
    }
  }
  return true;
}
