import { FileClockIcon, PencilLineIcon } from "lucide-react";

import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { cn } from "@/components/lib/utils.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";

import type { ComposerEditBarProps, ComposerEditInvalidReason } from "./contract.js";
import { composerEditTargetIdentity } from "./editorIdentity.js";

function invalidReasonMessageKey(reason: ComposerEditInvalidReason): string {
  return `chat.composerEdit.invalid.${reason}`;
}

/**
 * 编辑条：目标身份、失效原因、rewind 与取消。
 *
 * 它是 composer 卡片内部的头带（由 ConversationComposer 放进 ChatPromptEditor 的
 * topContent），不再自带外边框：卡片自身的圆角/底色负责与队列条分隔。
 *
 * data-edit-target-* 是 E2E/单测的稳定事实面：kind/id 来自 target，state/reason 来自
 * 同一份投影裁决，不在 DOM 上另造状态。
 */
export function ComposerEditBar({
  target,
  state,
  invalidReason = null,
  canRewind = false,
  rewindDisabled = false,
  workspaceRewind,
  onRewind,
  onCancel,
}: ComposerEditBarProps) {
  const { intl } = useNibiIntl();
  const identity = composerEditTargetIdentity(target);
  const title =
    target.kind === "userQuery"
      ? intl.formatMessage({ id: "chat.composerEdit.title.userQuery" })
      : intl.formatMessage({ id: "chat.composerEdit.title.queueItem" });
  const effectiveRewindDisabled =
    rewindDisabled ||
    state === "submitting" ||
    (workspaceRewind !== undefined && !workspaceRewind.enabled);
  const rewindButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="v4-composer-edit-rewind"
      disabled={effectiveRewindDisabled}
      onClick={onRewind}
    >
      <FileClockIcon className="size-3.5" />
      {intl.formatMessage({ id: "chat.composerEdit.rewind" })}
    </Button>
  );
  return (
    <div
      data-testid="v4-composer-edit-bar"
      data-edit-target-kind={identity.kind}
      data-edit-target-id={identity.id}
      data-edit-state={state}
      data-invalid-reason={invalidReason ?? undefined}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1 text-ui-sm",
        state === "invalid"
          ? "border-warning/35 bg-[var(--color-warning)]/10 text-foreground"
          : "border-border/55 bg-surface/85 text-foreground-subtle",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <PencilLineIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium text-foreground">{title}</span>
        {invalidReason ? (
          <span
            role="alert"
            data-composer-edit-invalid-reason={invalidReason}
            className="min-w-0 truncate text-warning"
          >
            {intl.formatMessage({ id: invalidReasonMessageKey(invalidReason) })}
          </span>
        ) : null}
      </span>
      {target.kind === "userQuery" && canRewind && onRewind ? (
        <ControlHintTooltip
          standalone
          title={intl.formatMessage({ id: "chat.edit.resetConversationAndFiles.tooltip" })}
          description={
            workspaceRewind
              ? intl.formatMessage({
                  id: `chat.edit.resetConversationAndFiles.${workspaceRewind.reason}`,
                })
              : undefined
          }
        >
          {effectiveRewindDisabled ? (
            // disabled 按钮不响应 pointer 事件，外层 span 承接悬停以展示不可用原因。
            <span className="inline-flex" data-disabled-tooltip-trigger="true">
              {rewindButton}
            </span>
          ) : (
            rewindButton
          )}
        </ControlHintTooltip>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="v4-composer-edit-cancel"
        disabled={state === "submitting"}
        onClick={onCancel}
      >
        {intl.formatMessage({ id: "chat.composerEdit.cancel" })}
      </Button>
    </div>
  );
}
