import { Check } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import {
  occupations,
  getOccupationIcon,
  type OccupationValue,
} from "@/onboarding/occupationOptions.js";

interface OccupationGridProps {
  occupation: string | null;
  saving: boolean;
  onSelect: (value: OccupationValue) => void;
  label: string;
  /** 职业显示文案（i18n 已格式化）。 */
  formatLabel: (value: OccupationValue) => string;
}

/** 引导第一步的职业选择网格；从 OccupationOnboarding 抽出以控制文件行数。 */
export function OnboardingOccupationGrid({
  occupation,
  saving,
  onSelect,
  label,
  formatLabel,
}: OccupationGridProps) {
  return (
    <div
      className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 [@media(max-height:740px)]:mt-5 [@media(max-height:740px)]:gap-2"
      role="group"
      aria-label={label}
    >
      {occupations.map((value, index) => {
        const Icon = getOccupationIcon(index);
        return (
          <button
            type="button"
            key={value}
            aria-pressed={occupation === value}
            disabled={saving}
            onClick={() => onSelect(value)}
            className={cn(
              "group flex min-h-12 items-center gap-3 rounded-xl border px-3 py-3 [@media(max-height:740px)]:min-h-11 [@media(max-height:740px)]:py-2 text-left text-ui-base transition-[border-color,background-color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused active:scale-[0.985] motion-reduce:transition-none motion-reduce:active:scale-100",
              occupation === value
                ? "border-primary/55 bg-card-selected shadow-[var(--nibi-shadow-active-row)] ring-1 ring-primary/25"
                : "border-card-border bg-card shadow-[var(--nibi-shadow-card)] hover:border-border-hover hover:bg-card hover:shadow-[var(--nibi-shadow-card-hover)]",
            )}
          >
            <Icon
              strokeWidth={1.5}
              className={cn(
                "size-5 shrink-0",
                occupation === value
                  ? "text-foreground"
                  : "text-foreground-subtle dark:text-foreground-subtlest dark:group-hover:text-foreground-subtle",
              )}
            />
            <span className="min-w-0 flex-1">{formatLabel(value)}</span>
            <span
              aria-hidden="true"
              className={cn(
                "flex size-4 shrink-0 items-center justify-center rounded-full border",
                occupation === value
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-transparent",
              )}
            >
              {occupation === value ? <Check className="size-3" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}
