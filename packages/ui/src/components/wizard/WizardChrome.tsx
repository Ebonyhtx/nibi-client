import { CheckIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";

export interface WizardStepDefinition<StepKey extends string> {
  key: StepKey;
  titleId: string;
}

/**
 * 首启与设置页共用的左侧步骤导航。
 * 首启保持只读；设置页传入 onSelectStep 后，已完成步骤可以回看修改。
 */
export function WizardStepSidebar<StepKey extends string>(props: {
  steps: readonly WizardStepDefinition<StepKey>[];
  currentStep: StepKey;
  labelId?: string;
  className?: string;
  /** 当前步骤卡片是否显示边框；首启沿用白底无边框的既有观感。 */
  currentStepBordered?: boolean;
  onSelectStep?: (step: StepKey) => void;
  navigationDisabled?: boolean;
}) {
  const { intl } = useNibiIntl();
  const currentIndex = props.steps.findIndex((step) => step.key === props.currentStep);

  return (
    <aside className={cn("hidden shrink-0 flex-col gap-2 p-1 md:flex", props.className)}>
      <div className="flex h-full flex-col gap-4 rounded-xl border border-border bg-surface p-4">
        {props.labelId ? (
          <div className="text-ui-base font-medium uppercase tracking-wide text-foreground-subtle">
            {intl.formatMessage({ id: props.labelId })}
          </div>
        ) : null}
        <div className="space-y-2">
          {props.steps.map((step, index) => {
            const isCurrent = step.key === props.currentStep;
            const isCompleted = index < currentIndex;
            const row = (
              <>
                <div
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-ui-base font-mono font-semibold",
                    isCurrent
                      ? "bg-primary text-primary-foreground"
                      : isCompleted
                        ? "border-success bg-success text-success-foreground"
                        : "border-border bg-background text-foreground-subtle",
                  )}
                >
                  {isCompleted ? <CheckIcon className="size-4" /> : index + 1}
                </div>
                <div className="min-w-0">
                  <div
                    className={cn(
                      "text-ui-base font-medium",
                      isCurrent || isCompleted ? "text-foreground" : "text-foreground-subtle",
                    )}
                  >
                    {intl.formatMessage({ id: step.titleId })}
                  </div>
                </div>
              </>
            );
            const rowClassName = cn(
              "flex items-center gap-3 rounded-xl px-3 py-3 transition-colors",
              isCurrent
                ? props.currentStepBordered
                  ? "border border-border-hover bg-card"
                  : "border-0 bg-card"
                : isCompleted
                  ? "border-0 border-transparent bg-background-alt"
                  : "border-0 border-transparent bg-transparent",
            );

            if (!props.onSelectStep) {
              return (
                <div key={step.key} className={rowClassName}>
                  {row}
                </div>
              );
            }

            return (
              <button
                key={step.key}
                type="button"
                disabled={props.navigationDisabled || index >= currentIndex}
                onClick={() => props.onSelectStep?.(step.key)}
                className={cn(
                  rowClassName,
                  "w-full text-left",
                  index >= currentIndex ? "cursor-default" : "hover:bg-surface-hover/60",
                  props.navigationDisabled && "cursor-not-allowed opacity-60",
                )}
              >
                {row}
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

export function WizardStepHeader(props: { title: string; description: string }) {
  return (
    <div className="space-y-2">
      <div className="text-lg font-medium text-foreground">{props.title}</div>
      {props.description.trim().length > 0 ? (
        <div className="text-ui-base leading-6 text-foreground-subtle">{props.description}</div>
      ) : null}
    </div>
  );
}
