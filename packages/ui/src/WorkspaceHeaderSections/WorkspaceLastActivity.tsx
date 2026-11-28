import { Clock } from "lucide-react";
import type { NibiTaskMeta } from "@nibi/shared";
import { useMinuteClock } from "@/hooks/useRunningBackgroundTaskElapsedClock.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

export function WorkspaceLastActivity({ task }: { task: NibiTaskMeta | null }) {
  const { intl } = useNibiIntl();
  const timestamp = task
    ? (getTaskListRowActivity(task)?.lastActivityAt ?? task.updatedAt)
    : undefined;
  const now = useMinuteClock(Boolean(timestamp && Number.isFinite(timestamp)));
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  const time =
    minutes < 1
      ? intl.formatMessage({ id: "sidePane.time.justNow" })
      : intl.formatMessage(
          {
            id:
              minutes < 60
                ? "sidePane.time.minutesAgo"
                : minutes < 1440
                  ? "sidePane.time.hoursAgo"
                  : "sidePane.time.daysAgo",
          },
          { count: minutes < 60 ? minutes : Math.floor(minutes / (minutes < 1440 ? 60 : 1440)) },
        );
  return (
    <span data-workspace-last-activity="" className="flex min-w-0 items-center gap-2 font-normal">
      <Clock className="size-4 shrink-0" />
      <span>{intl.formatMessage({ id: "workspace.context.lastActivity" }, { time })}</span>
    </span>
  );
}
