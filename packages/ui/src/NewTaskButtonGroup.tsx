import { MessageCirclePlus } from "lucide-react";
import { TID_TASK_NEW_BUTTON } from "@nibi/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export function NewTaskButtonGroup({
  onCreateTask,
  disabled = false,
}: {
  onCreateTask: () => void;
  disabled?: boolean;
}) {
  const { intl } = useNibiIntl();
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  return (
    <div
      role="group"
      aria-disabled={disabled}
      data-testid={TID_TASK_NEW_BUTTON}
      onClick={() => {
        if (!disabled) {
          runUserAction({
            input: { featureId: "task.lifecycle", action: "create", trigger: "button" },
            operation: onCreateTask,
            completed: { resultSource: "optimistic_projection" },
            failureStage: "task_create",
          });
        }
      }}
      className={cn(
        "nibi-new-task-hero group inline-flex h-9.5 w-full shrink-0 cursor-pointer items-center justify-stretch gap-2.5 overflow-hidden rounded-xl border px-3 text-foreground active:scale-[0.985]",
        disabled &&
          "cursor-not-allowed opacity-55 shadow-none active:scale-100",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <MessageCirclePlus className="size-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="nibi-serif-icon-align truncate font-display text-[14px] font-semibold leading-[1.4] tracking-[0.01em]">
          {intl.formatMessage({ id: "taskList.newThread" })}
        </span>
        <span className="ml-auto hidden shrink-0 font-mono text-[11px] font-normal text-foreground-subtlest sm:inline">
          {newTaskShortcutLabel}
        </span>
      </div>
    </div>
  );
}
