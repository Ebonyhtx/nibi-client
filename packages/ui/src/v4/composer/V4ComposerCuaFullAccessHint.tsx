/**
 * CUA「完全访问」引导条。
 *
 * 为什么需要它（用户实测反馈 2026-10-11）：电脑操控在「变更前确认」模式下**每一次工具调用
 * 都要点一次允许**——一个 6×7 的会话会弹十几次，体验上等同于不可用。上游产品把输入交付
 * 策略定为 background=false（前台交付），但**审批模式**是会话级设置，运行时无法也不该替
 * 用户改（改权限模式是用户决定）。
 *
 * 所以产品策略是：**只提示、不越权**——检测到"电脑操控可用 + 当前不是完全访问"时，
 * 在输入框上方给一条常驻提示，一键切到完全访问（复用 composer 已有的模式切换通路）。
 * 用户点掉即记住（settings.computerUseFullAccessHintDismissed），不再打扰。
 *
 * 可见性判据复用 V4ComposerCuaEntry 的同一套（平台门 + 设置页隐藏 + 插件启用 + 本地
 * workspace），避免两处判定漂移。
 */
import { memo, useCallback } from "react";
import { ShieldCheckIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  supportsLocalMacCuaPermissionOnboarding,
  supportsLocalWindowsCuaEntry,
} from "@/lib/cuaPlatform.js";
import { useCuaComposerEntry } from "@/hooks/useCuaComposerEntry.js";

/** 与 composer 的模式选项同源：yolo 即「完全访问」。 */
const FULL_ACCESS_MODE = "yolo";

export interface V4ComposerCuaFullAccessHintProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  currentSessionBusy?: boolean;
  /** 当前草稿权限模式（draftConfig.mode）。 */
  mode?: string;
  onSwitchMode: (mode: string) => void;
}

function V4ComposerCuaFullAccessHintImpl(props: V4ComposerCuaFullAccessHintProps) {
  const platform = useOptionalPlatform();
  const services = useOptionalServices();
  const platformSupported =
    platform !== null &&
    services !== null &&
    (supportsLocalMacCuaPermissionOnboarding(platform) || supportsLocalWindowsCuaEntry(platform));
  if (!platformSupported) return null;
  return <V4ComposerCuaFullAccessHintMounted {...props} />;
}

function V4ComposerCuaFullAccessHintMounted({
  mode,
  onSwitchMode,
  ...entryParams
}: V4ComposerCuaFullAccessHintProps) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  // 复用 CUA 入口的可见性判定：不可见 = 这台机器上电脑操控根本用不了 → 也就没必要引导权限。
  const { view } = useCuaComposerEntry(entryParams);
  const dismissed = settings?.computerUseFullAccessHintDismissed === true;

  const dismiss = useCallback(() => {
    void update?.({ computerUseFullAccessHintDismissed: true });
  }, [update]);

  const enableFullAccess = useCallback(() => {
    onSwitchMode(FULL_ACCESS_MODE);
    dismiss();
  }, [dismiss, onSwitchMode]);

  if (!view.visible || dismissed || mode === FULL_ACCESS_MODE) return null;

  // 视觉纪律：与输入框同宽同圆角、比错误横幅更轻（muted 背景而非 warning 色块），
  // 只有一枚细描边图标 + 一行说明 + 一个文字按钮 + 一个关闭叉，避免在输入框上方堆成"告示牌"。
  return (
    <div className="mb-2 flex w-full items-center gap-2 rounded-xl border border-border/60 bg-surface-muted/60 px-3 py-1.5 text-ui-sm text-foreground-subtle">
      <ShieldCheckIcon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {intl.formatMessage({ id: "chat.cua.fullAccessHint.message" })}
      </span>
      <button
        type="button"
        className="shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={enableFullAccess}
      >
        {intl.formatMessage({ id: "chat.cua.fullAccessHint.enable" })}
      </button>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "chat.cua.fullAccessHint.dismiss" })}
        className="shrink-0 cursor-pointer rounded-md p-0.5 opacity-50 outline-none hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={dismiss}
      >
        <XIcon className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

export const V4ComposerCuaFullAccessHint = memo(V4ComposerCuaFullAccessHintImpl);
