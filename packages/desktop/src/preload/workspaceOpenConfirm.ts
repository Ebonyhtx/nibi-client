/**
 * 外部 workspace 深链确认窗的 preload。
 *
 * 窗口只加载本地静态页，data 通过 additionalArguments 传入，不经过主 renderer。
 * 这里只暴露两件事：读本次请求的展示数据、回传用户决定。
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  WORKSPACE_OPEN_CONFIRM_ARG_PREFIX,
  WORKSPACE_OPEN_CONFIRM_RESULT_CHANNEL,
  type WorkspaceOpenConfirmPayload,
} from "../shared/workspaceOpenConfirm.js";

function readPayload(): WorkspaceOpenConfirmPayload | null {
  const raw = process.argv.find((arg) => arg.startsWith(WORKSPACE_OPEN_CONFIRM_ARG_PREFIX));
  if (!raw) return null;
  try {
    return JSON.parse(
      decodeURIComponent(raw.slice(WORKSPACE_OPEN_CONFIRM_ARG_PREFIX.length)),
    ) as WorkspaceOpenConfirmPayload;
  } catch {
    return null;
  }
}

contextBridge.exposeInMainWorld("workspaceOpenConfirm", {
  getPayload: (): WorkspaceOpenConfirmPayload | null => readPayload(),
  resolve: (accepted: boolean): void => {
    ipcRenderer.send(WORKSPACE_OPEN_CONFIRM_RESULT_CHANNEL, accepted === true);
  },
});
