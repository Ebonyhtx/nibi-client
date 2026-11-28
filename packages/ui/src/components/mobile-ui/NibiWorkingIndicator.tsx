import type { NibiWorkingIndicatorProps } from "@/components/mobile-ui/contract.js";
import { cn } from "@/components/lib/utils.js";

/**
 * 「羽汐掠墨」工作指示器：五瓣斜锋羽阵配合灵羽暖晕与可选人文衬线流光标签。
 * 供桌面消息流与手机远控连接/切工作区/OAuth 回调共用，零 store 与国际化依赖。
 */
export function NibiWorkingIndicator({
  label,
  phase = "thinking",
  compact = false,
  className,
}: NibiWorkingIndicatorProps) {
  return (
    <span
      data-nibi-working-indicator="true"
      data-working-phase={phase}
      data-compact={compact ? "true" : undefined}
      className={cn(
        "nibi-working-indicator",
        compact && "nibi-working-indicator--compact",
        className,
      )}
    >
      <span className="nibi-working-emblem" aria-hidden="true">
        <span className="nibi-working-glow" />
        <span className="nibi-working-lattice">
          <span className="nibi-working-vane nibi-working-vane--1" />
          <span className="nibi-working-vane nibi-working-vane--2" />
          <span className="nibi-working-vane nibi-working-vane--3" />
          <span className="nibi-working-vane nibi-working-vane--4" />
          <span className="nibi-working-vane nibi-working-vane--5" />
        </span>
      </span>
      {label ? (
        <span className="nibi-working-label font-display text-ui-caption" aria-hidden="true">
          {label}
        </span>
      ) : null}
    </span>
  );
}
