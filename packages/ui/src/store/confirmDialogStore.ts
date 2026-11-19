import { create } from "zustand";
import { logger } from "@/logger.js";

export interface ConfirmDialogRequest {
  title: string;
  testId?: string;
  description?: string;
  /** E2E/可访问性使用的稳定业务语义，不依赖本地化标题文本。 */
  intent?: string;
  /** 特定业务弹框的稳定视觉规范；默认确认框不受影响。 */
  presentation?: "automation-confirmation" | "source-server-boundary";
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: "default" | "destructive";
  /** 需要展示运行中任务等长清单时限制描述高度并在弹窗内滚动；未设置的调用方不受影响。 */
  scrollableDescription?: boolean;
  showCloseButton?: boolean;
  /** 需要用户显式确认的告知弹窗：隐藏取消，并忽略遮罩/Escape 关闭。 */
  requiredAcknowledgement?: boolean;
  showKeyboardHints?: boolean;
  compact?: boolean;
  checkbox?: { label: string; onCheckedChange: (checked: boolean) => void };
  /**
   * 打开弹窗后先执行的异步准备（如永久删除预检）。返回的字段合并进当前弹窗；
   * 准备完成前确认按钮禁用，取消始终可用。
   */
  prepare?: () => Promise<Partial<ConfirmDialogRequest> | void>;
  /** 调用方静态禁用的确认动作（例如没有可删除目标）。 */
  confirmDisabled?: boolean;
}

export type ConfirmDialogChoice = "confirm" | "cancel" | "dismiss";

interface PendingConfirmDialogRequest extends ConfirmDialogRequest {
  resolve: (choice: ConfirmDialogChoice) => void;
  preparePending?: boolean;
}

interface ConfirmDialogState {
  pendingRequest?: PendingConfirmDialogRequest;
  requestConfirmation: (payload: ConfirmDialogRequest) => Promise<boolean>;
  requestChoice: (payload: ConfirmDialogRequest) => Promise<ConfirmDialogChoice>;
  settleConfirmation: (confirmed: boolean) => void;
  settleChoice: (choice: ConfirmDialogChoice) => void;
}

export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  pendingRequest: undefined,
  requestConfirmation: async (payload) => (await get().requestChoice(payload)) === "confirm",
  requestChoice: (payload) => {
    if (get().pendingRequest) {
      logger.warn("[ConfirmDialogStore] confirmation already in progress");
      return Promise.resolve("dismiss");
    }

    return new Promise<ConfirmDialogChoice>((resolve) => {
      set({
        pendingRequest: {
          ...payload,
          resolve,
          ...(payload.prepare ? { preparePending: true } : {}),
        },
      });
      if (!payload.prepare) return;
      // 准备只针对这一次 pending request；弹窗已被取消/替换时丢弃结果，不能改写新弹窗。
      void payload
        .prepare()
        .then((patch) => {
          const current = get().pendingRequest;
          if (!current || current.resolve !== resolve) return;
          set({
            pendingRequest: {
              ...current,
              ...patch,
              prepare: undefined,
              preparePending: false,
            },
          });
        })
        .catch((error) => {
          logger.warn("[ConfirmDialogStore] confirmation prepare failed", error);
          const current = get().pendingRequest;
          if (!current || current.resolve !== resolve) return;
          set({
            pendingRequest: { ...current, prepare: undefined, preparePending: false },
          });
        });
    });
  },
  settleConfirmation: (confirmed) => get().settleChoice(confirmed ? "confirm" : "cancel"),
  settleChoice: (choice) => {
    const pendingRequest = get().pendingRequest;
    if (!pendingRequest) {
      return;
    }

    set({ pendingRequest: undefined });
    pendingRequest.resolve(choice);
  },
}));
