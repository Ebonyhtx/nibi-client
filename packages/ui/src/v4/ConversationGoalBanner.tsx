import { memo } from "react";
import { TID_V4_GOAL_BANNER } from "@nibi/shared/test-ids";
import type { GoalState } from "@nibi/shared/nibi-protocol-v4";
import { useNibiIntl } from "@/i18n/IntlProvider.js";

export interface ConversationGoalBannerProps {
  goal: GoalState;
}

/**
 * M4 goal 横幅：展示 sendGoalCommand/resumeGoal 的 goal 状态投影（objective/status/iteration）。
 * memo：goal 不变时不随 SessionPane 其他状态重渲染。
 */
function ConversationGoalBannerImpl({ goal }: ConversationGoalBannerProps) {
  const { intl } = useNibiIntl();
  return (
    <div
      data-testid={TID_V4_GOAL_BANNER}
      data-goal-status={goal.status}
      data-goal-objective={goal.objective}
      className="flex items-center gap-2 border-b border-border/80 bg-header/90 px-3 py-1.5 text-ui-sm backdrop-blur-sm"
    >
      <span className="text-[var(--color-foreground-subtle)]">
        {intl.formatMessage({ id: "chat.goalBanner.label" })}
      </span>
      <span className="min-w-0 flex-1 truncate text-[var(--color-foreground)]">
        {goal.objective}
      </span>
      <span className="shrink-0 rounded-full border border-border bg-card px-2 py-0.5 text-ui-xs font-medium tabular-nums text-[var(--color-foreground-subtle)] shadow-2xs">
        {goal.status} · #{goal.iteration}
      </span>
    </div>
  );
}

export const ConversationGoalBanner = memo(ConversationGoalBannerImpl);
