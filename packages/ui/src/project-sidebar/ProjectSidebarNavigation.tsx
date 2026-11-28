import type { ReactNode } from "react";
import { Blocks, CalendarClock, type LucideIcon } from "lucide-react";
import { TID_AUTOMATIONS_OPEN } from "@nibi/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { NewTaskButtonGroup } from "@/NewTaskButtonGroup.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { WebRemoteControlDeviceHeader } from "@/web-remote-control/WebRemoteControlDeviceHeader.js";
import { PluginUiNavPrimarySlots } from "@/plugin-ui/components/PluginUiLauncherItems.js";

interface SidebarBentoTileItem {
  key: string;
  active: boolean;
  testId: string;
  onClick: () => void;
  Icon: LucideIcon;
  label: string;
  badge?: ReactNode;
}

function SidebarBentoNavTile({ item, twoCol }: { item: SidebarBentoTileItem; twoCol: boolean }) {
  const { Icon } = item;
  const trailingIndicator =
    item.badge ??
    (item.active ? (
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
    ) : null);
  return (
    <button
      type="button"
      aria-pressed={item.active}
      data-testid={item.testId}
      onClick={item.onClick}
      className={cn(
        "nibi-bento-tile group relative w-full cursor-pointer rounded-xl border px-2.5 py-2 text-left active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        twoCol
          ? "flex min-h-[48px] flex-col items-start justify-between gap-1.5"
          : "flex min-h-[38px] flex-row items-center justify-between gap-2.5",
        item.active
          ? "border-primary/35 bg-card text-foreground shadow-[var(--nibi-shadow-active-row)]"
          : "border-border/55 bg-background/50 text-foreground/85 hover:border-border/85 hover:bg-card/80 hover:text-foreground hover:shadow-[var(--nibi-shadow-active-row)]",
      )}
    >
      <span className={cn("flex items-center gap-2", twoCol ? "w-full justify-between" : "min-w-0")}>
        <Icon
          className={cn(
            "size-4 shrink-0 transition-colors",
            item.active ? "text-primary" : "text-foreground-subtle group-hover:text-primary",
          )}
          aria-hidden="true"
        />
        {twoCol ? trailingIndicator : (
          <span className="nibi-serif-icon-align min-w-0 truncate font-display text-[13px] font-medium leading-[1.35] tracking-[0.005em]">
            {item.label}
          </span>
        )}
      </span>
      {twoCol ? (
        <span className="w-full truncate font-display text-[13px] font-medium leading-[1.35] tracking-[0.005em]">
          {item.label}
        </span>
      ) : (
        trailingIndicator
      )}
    </button>
  );
}

/** 顶部导航只展示 Shell 的选中状态，路由仍由 Shell 唯一持有。 */
export function ProjectSidebarNavigation({
  props,
  onCreate,
}: {
  props: Pick<
    ProjectSidebarProps,
    | "isWebRemoteControl"
    | "onOpenAutomations"
    | "automationsActive"
    | "onOpenPluginStore"
    | "pluginStoreActive"
    | "pluginUpdatesAvailable"
    | "webRemoteControlWorkspaceSwitcher"
    | "workspacePath"
    | "workspaceIdentity"
  >;
  onCreate(): void;
}) {
  const { intl } = useNibiIntl();
  const deviceNavigation = props.webRemoteControlWorkspaceSwitcher?.deviceNavigation;
  const updatesAvailable = props.pluginUpdatesAvailable ?? 0;
  const twoCol = Boolean(props.onOpenAutomations);
  const tiles: SidebarBentoTileItem[] = [
    ...(props.onOpenAutomations
      ? [
          {
            key: "automations",
            active: Boolean(props.automationsActive),
            testId: TID_AUTOMATIONS_OPEN,
            // 点击事件不能进入业务导航的可选 automationId 参数。
            onClick: () => props.onOpenAutomations?.(),
            Icon: CalendarClock,
            label: intl.formatMessage({ id: "workspace.openScheduledSettings" }),
          },
        ]
      : []),
    {
      key: "plugin-store",
      active: Boolean(props.pluginStoreActive),
      testId: "plugin-store-sidebar-open",
      onClick: () => props.onOpenPluginStore?.(),
      Icon: Blocks,
      label: intl.formatMessage({ id: "workspace.openPluginsSettings" }),
      badge:
        updatesAvailable > 0 ? (
          // 商店外发现：不点进商店也能知道有插件可更新（数字来自宿主算的 updateStatus）。
          <span
            data-testid="plugin-store-update-count"
            title={intl.formatMessage(
              { id: "workspace.pluginUpdatesAvailable" },
              { count: updatesAvailable },
            )}
            aria-label={intl.formatMessage(
              { id: "workspace.pluginUpdatesAvailable" },
              { count: updatesAvailable },
            )}
            className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-success-surface px-1.5 text-[10.5px] font-medium leading-none text-success-surface-foreground"
          >
            {updatesAvailable}
          </span>
        ) : undefined,
    },
  ];
  return (
    <div
      data-testid="sidebar-primary-navigation"
      className={`flex flex-col gap-2 border-b border-border/45 px-2.5 pt-1.5 pb-3 ${props.isWebRemoteControl && !deviceNavigation ? "max-md:pt-11" : ""}`}
    >
      {/* Relay V2 远控：当前电脑是项目与任务的上一级，放在导航首行；手机端占用原顶部留白。 */}
      {deviceNavigation ? <WebRemoteControlDeviceHeader navigation={deviceNavigation} /> : null}
      <NewTaskButtonGroup onCreateTask={onCreate} />
      <div className={twoCol ? "grid grid-cols-2 gap-2" : "grid grid-cols-1"}>
        {tiles.map((item) => (
          <SidebarBentoNavTile key={item.key} item={item} twoCol={twoCol} />
        ))}
      </div>
      <PluginUiNavPrimarySlots
        workspacePath={props.workspacePath}
        {...(props.workspaceIdentity ? { workspaceIdentity: props.workspaceIdentity } : {})}
      />
    </div>
  );
}
