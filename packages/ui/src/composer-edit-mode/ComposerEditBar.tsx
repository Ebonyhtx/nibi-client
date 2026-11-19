import { FileClockIcon, PencilLineIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button.js";
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
 * data-edit-target-* 是 E2E/单测的稳定事实面：kind/id 来自 target，state/reason 来自
 * 同一份投影裁决，不在 DOM 上另造状态。
 */
export function ComposerEditBar({
  target,
  state,
  invalidReason = null,
  canRewind = false,
  rewindDisabled = false,
  onRewind,
  onCancel,
}: ComposerEditBarProps) {
  const { intl } = useNibiIntl();
  const identity = composerEditTargetIdentity(target);
  const title =
    target.kind === "userQuery"
      ? intl.formatMessage({ id: "chat.composerEdit.title.userQuery" })
      : intl.formatMessage({ id: "chat.composerEdit.title.queueItem" });
  return (
    <div
      data-testid="v4-composer-edit-bar"
      data-edit-target-kind={identity.kind}
      data-edit-target-id={identity.id}
      data-edit-state={state}
      data-invalid-reason={invalidReason ?? undefined}
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-2 rounded-lg border px-2.5 py-1.5 text-ui-sm",
        state === "invalid"
          ? "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 text-foreground"
          : "border-border bg-surface text-foreground-subtle",
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="v4-composer-edit-rewind"
          disabled={rewindDisabled || state === "submitting"}
          onClick={onRewind}
        >
          <FileClockIcon className="size-3.5" />
          {intl.formatMessage({ id: "chat.composerEdit.rewind" })}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="v4-composer-edit-cancel"
        disabled={state === "submitting"}
        onClick={onCancel}
      >
        <XIcon className="size-3.5" />
        {intl.formatMessage({ id: "chat.composerEdit.cancel" })}
      </Button>
    </div>
  );
}
