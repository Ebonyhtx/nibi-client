import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { FolderIcon, GlobeIcon, TerminalIcon, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { isHighPermissionModeValue } from "@/chat-input-toolbar/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 能力清单按上游文案固定三项；图标只做视觉锚点，读屏依赖标题和描述。 */
const CAPABILITIES: readonly {
  icon: LucideIcon;
  titleId: string;
  descriptionId: string;
}[] = [
  {
    icon: FolderIcon,
    titleId: "chat.fullAccessConfirm.files.title",
    descriptionId: "chat.fullAccessConfirm.files.description",
  },
  {
    icon: TerminalIcon,
    titleId: "chat.fullAccessConfirm.terminal.title",
    descriptionId: "chat.fullAccessConfirm.terminal.description",
  },
  {
    icon: GlobeIcon,
    titleId: "chat.fullAccessConfirm.network.title",
    descriptionId: "chat.fullAccessConfirm.network.description",
  },
];

export interface FullAccessModeConfirmDialogProps {
  open: boolean;
  /** false 由取消、Esc、点击遮罩触发；三种都是放弃切换，不改草稿。 */
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function FullAccessModeConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
}: FullAccessModeConfirmDialogProps) {
  const { intl } = useZCodeIntl();
  const [acknowledged, setAcknowledged] = useState(false);
  const acknowledgeRef = useRef<HTMLButtonElement>(null);
  const acknowledgeId = useId();
  const acknowledgeLabelId = useId();

  // 关闭时清掉勾选，下一次危险切换必须重新确认；否则上次的承诺会被静默带过来。
  useEffect(() => {
    if (!open) setAcknowledged(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid="full-access-mode-confirm-dialog"
        className="gap-4 rounded-2xl border-none bg-popover p-5 shadow-2xl ring-border sm:max-w-md"
        onOpenAutoFocus={(event) => {
          // 根因：确认按钮在勾选前禁用，若焦点落到禁用的主按钮，键盘用户会以为弹窗不可操作。
          // 把初始焦点放在风险勾选项上，读屏先读出承诺文本，Tab 后才到达可执行按钮。
          event.preventDefault();
          acknowledgeRef.current?.focus();
        }}
      >
        <DialogHeader className="gap-2">
          <DialogTitle className="pr-2 text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "chat.fullAccessConfirm.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: "chat.fullAccessConfirm.description" })}
          </DialogDescription>
        </DialogHeader>

        <ul className="grid gap-3">
          {CAPABILITIES.map(({ icon: Icon, titleId, descriptionId }) => (
            <li key={titleId} className="flex min-w-0 items-start gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-surface-muted text-foreground-subtle">
                <Icon aria-hidden="true" className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: titleId })}
                </span>
                <span className="block text-ui-sm leading-5 text-foreground-subtle">
                  {intl.formatMessage({ id: descriptionId })}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-ui-base leading-5 text-foreground">
          {intl.formatMessage({ id: "chat.fullAccessConfirm.warning" })}
        </p>

        <div className="flex min-w-0 items-start gap-2">
          <Checkbox
            ref={acknowledgeRef}
            id={acknowledgeId}
            checked={acknowledged}
            onCheckedChange={(value) => setAcknowledged(value === true)}
            aria-labelledby={acknowledgeLabelId}
            className="mt-0.5"
          />
          <label
            id={acknowledgeLabelId}
            htmlFor={acknowledgeId}
            className="cursor-pointer text-ui-base leading-5 text-foreground"
          >
            {intl.formatMessage({ id: "chat.fullAccessConfirm.acknowledge" })}
          </label>
        </div>

        <DialogFooter className="gap-2 sm:justify-end">
          <Button type="button" variant="secondary" size="lg" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "chat.fullAccessConfirm.cancel" })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="lg"
            disabled={!acknowledged}
            onClick={onConfirm}
          >
            {intl.formatMessage({ id: "chat.fullAccessConfirm.confirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export interface FullAccessModeConfirmationOptions {
  /** 当前草稿模式；同值重复选择直接放行，不重复确认。 */
  currentMode: string | undefined;
  /** 确认后真正应用的切换入口（SessionPane 的 handleDraftSwitchMode）。 */
  onApplyModeSwitch: (mode: string) => void;
}

export interface FullAccessModeConfirmation {
  /** 包装过的模式切换入口：高权限目标先挂起，普通目标直接透传。 */
  requestModeSwitch: (mode: string) => void;
  /** 由消费方渲染在任意稳定位置；弹窗通过 Portal 显示。 */
  confirmDialog: ReactNode;
}

/**
 * 高权限模式切换的二次确认状态机。
 *
 * 根因：完全访问（bypassPermissions / full-access / agent-full-access / yolo）启用后，
 * 任务不再逐次请求确认，文件的删除、终端命令、网络与外发数据都会直接执行。菜单一次误点
 * 就可能造成不可逆的数据丢失或泄露，因此危险目标必须在真正写入草稿前拦截一次；离开高权限
 * 或在普通模式之间切换没有新增风险，保持原来的一步到位。
 */
export function useFullAccessModeConfirmation({
  currentMode,
  onApplyModeSwitch,
}: FullAccessModeConfirmationOptions): FullAccessModeConfirmation {
  const [pendingMode, setPendingMode] = useState<string | null>(null);

  const requestModeSwitch = useCallback(
    (mode: string) => {
      // 已经是同一高权限值时再选一次不会扩大权限，无需再确认；仍走原入口，
      // 让“用户显式选择”的语义（modeExplicit）与未拦截时保持一致。
      if (isHighPermissionModeValue(mode) && mode !== currentMode) {
        // 只记录目标值，不碰草稿/会话；取消时这里被清空即可保持原模式。
        setPendingMode(mode);
        return;
      }
      onApplyModeSwitch(mode);
    },
    [currentMode, onApplyModeSwitch],
  );

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) setPendingMode(null);
  }, []);

  const handleConfirm = useCallback(() => {
    const targetMode = pendingMode;
    setPendingMode(null);
    if (targetMode) onApplyModeSwitch(targetMode);
  }, [onApplyModeSwitch, pendingMode]);

  return {
    requestModeSwitch,
    confirmDialog: (
      <FullAccessModeConfirmDialog
        open={pendingMode !== null}
        onOpenChange={handleOpenChange}
        onConfirm={handleConfirm}
      />
    ),
  };
}
