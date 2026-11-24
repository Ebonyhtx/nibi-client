import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";

export interface SettingsSegmentedTabItem<TValue extends string> {
  label: string;
  value: TValue;
}

/** 设置详情页共用的紧凑分段切换，避免相同层级出现多套 Tabs 视觉。 */
export function SettingsSegmentedTabs<TValue extends string>({
  items,
  value,
  onValueChange,
}: {
  items: readonly SettingsSegmentedTabItem<TValue>[];
  value: TValue;
  onValueChange: (value: TValue) => void;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as TValue)}
      className="gap-0"
    >
      <TabsList className="flex h-8 rounded-full border border-border/60 bg-surface/90 p-0.5 shadow-[var(--nibi-shadow-input-inset)] group-data-horizontal/tabs:h-8">
        {items.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            className="h-7 flex-none rounded-full border-transparent bg-transparent px-2.5 text-ui-base font-medium text-foreground-subtle data-active:border-border/70 data-active:bg-card data-active:text-foreground data-active:shadow-[var(--nibi-shadow-active-row)] dark:data-active:border-border/80 dark:data-active:bg-card"
          >
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
