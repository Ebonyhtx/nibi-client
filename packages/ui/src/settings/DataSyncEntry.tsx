import type { MouseEvent, ReactNode } from "react";
import { BlocksIcon, CableIcon, ChevronDown, UploadCloud, WandIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { useOpenDataSyncSettings } from "@/hooks/useOpenDataSyncSettings.js";

/** 入口只预选数据同步页已支持的三类；其余分类在页面内切换。 */
export const DATA_SYNC_ENTRY_CATEGORIES = ["skills", "mcp", "plugins"] as const;
export type DataSyncEntryCategory = (typeof DATA_SYNC_ENTRY_CATEGORIES)[number];

const MENU_ITEMS: Record<
  DataSyncEntryCategory,
  { labelId: string; icon: (props: { className?: string }) => ReactNode }
> = {
  skills: { labelId: "remote.syncSkills", icon: WandIcon },
  mcp: { labelId: "remote.syncMcp", icon: CableIcon },
  plugins: { labelId: "remote.syncPlugins", icon: BlocksIcon },
};

/**
 * 设置分区右上角的同步入口。
 * 根因：入口不再自己读写远端，只负责打开统一数据同步页并预选分类，
 * 这样技能 / MCP / 插件三个分区不会各自演化出不同的同步实现。
 */
export function DataSyncEntryButton({
  category,
  labelId,
  size = "icon-lg",
}: {
  category: DataSyncEntryCategory;
  labelId: string;
  size?: "icon-md" | "icon-lg";
}) {
  const { intl } = useNibiIntl();
  const openDataSync = useOpenDataSyncSettings();
  const label = intl.formatMessage({ id: labelId });
  return (
    <ControlHintTooltip title={label}>
      <Button
        type="button"
        variant="outline"
        size={size}
        aria-label={label}
        data-testid={`settings-data-sync-entry-${category}`}
        onClick={() => openDataSync(category)}
      >
        <UploadCloud className="size-3.5" aria-hidden="true" />
      </Button>
    </ControlHintTooltip>
  );
}

/** 工作区头部 / 远程连接弹窗共用的分类菜单项。 */
export function DataSyncEntryMenuItems({
  categories = DATA_SYNC_ENTRY_CATEGORIES,
}: {
  categories?: readonly DataSyncEntryCategory[];
}) {
  const { intl } = useNibiIntl();
  const openDataSync = useOpenDataSyncSettings();
  const stopMouseDown = (event: MouseEvent) => {
    event.stopPropagation();
  };
  return (
    <>
      {categories.map((category) => {
        const { labelId, icon: Icon } = MENU_ITEMS[category];
        return (
          <DropdownMenuItem
            key={category}
            onMouseDown={stopMouseDown}
            onSelect={() => openDataSync(category)}
          >
            <Icon className="size-3.5" />
            {intl.formatMessage({ id: labelId })}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

/** 远程连接成功横幅里的同步入口；语义仍是「把本机数据推到目标设备」。 */
export function DataSyncEntryDropdownButton({
  categories = DATA_SYNC_ENTRY_CATEGORIES,
}: {
  categories?: readonly DataSyncEntryCategory[];
}) {
  const { intl } = useNibiIntl();
  if (categories.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="secondary" size="sm" className="gap-1">
          <UploadCloud className="size-3.5" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.dataSync.title" })}
          <ChevronDown className="size-3.5 text-foreground-subtle" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DataSyncEntryMenuItems categories={categories} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
