import { useRef, useState, type ReactNode } from "react";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import type { ComposerPlanGroup } from "@/lib/composerPlanGroups.js";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { isNoThoughtLevel } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { ComposerEffortHeading } from "@/chat-input-toolbar/ComposerEffortHeading.js";
import { ComposerProviderMenu } from "@/chat-input-toolbar/ComposerProviderMenu.js";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu.js";
import "@/chat-input-toolbar/thinking-feather-rail.css";
import { ThinkingFeatherRail } from "@/chat-input-toolbar/ThinkingFeatherRail.js";

export interface ComposerModelOptions {
  providerMenu?: {
    groups: readonly ComposerPlanGroup[];
    selectedKey?: string;
    pending: boolean;
    error: string | null;
    onSelect: (group: ComposerPlanGroup) => void;
  };
  providerLabel: string;
  modelsLabel: string;
  effortLabel: string;
  effortShortcutLabel?: string;
  selectModelLabel: string;
  levels: readonly { value: string; label: string }[];
  value: string;
  onValueChange: (value: string) => void;
}

export function getComposerThoughtDisplay(options: ComposerModelOptions) {
  const current = options.levels.find((level) => level.value === options.value);
  const thinking = options.levels.filter((level) => !isNoThoughtLevel(level));
  const progress =
    current && !isNoThoughtLevel(current)
      ? ((thinking.findIndex((level) => level.value === current.value) + 1) / thinking.length) * 100
      : 0;
  return { label: current?.label ?? "—", progress };
}

export function ComposerThoughtIndicator({ options }: { options: ComposerModelOptions }) {
  const { label, progress } = getComposerThoughtDisplay(options);
  return (
    <>
      <span
        className="shrink-0 text-foreground-subtle group-data-[composer-compact=true]/combined:hidden"
        data-composer-thought-label
      >
        {label}
      </span>
      <span
        aria-hidden="true"
        data-testid="composer-thought-meter"
        data-progress={progress}
        className="relative hidden h-4 w-1 shrink-0 overflow-hidden rounded-full bg-foreground/10 group-data-[composer-compact=true]/combined:block"
      >
        <span
          className="composer-thought-meter-fill absolute bottom-0 left-0 w-full rounded-full bg-success"
          style={{ height: `${progress}%` }}
        />
      </span>
    </>
  );
}

export function ComposerModelMenu({
  groups,
  normalizedValue,
  options,
  renderItems,
  renderConnection,
  providerFooter,
  isItemLocked,
  onSelectModel,
}: {
  groups: readonly ModelSelectGroup[];
  normalizedValue: string;
  options: ComposerModelOptions;
  renderItems: (items: ModelSelectGroup["items"]) => ReactNode;
  renderConnection: (group: ModelSelectGroup) => ReactNode;
  providerFooter?: ReactNode;
  isItemLocked: (value: string) => boolean;
  onSelectModel: (value: string) => void;
}) {
  // 无可用模型的分组仍可浏览配置；实际选择始终由 Composer owner 回传。
  const [browse, setBrowse] = useState<{ key: string; selection: string } | null>(null);
  const menuGroups: readonly ComposerPlanGroup[] = options.providerMenu?.groups ?? groups;
  const selected =
    menuGroups.find((group) => group.key === options.providerMenu?.selectedKey) ??
    menuGroups.find((group) => group.items.some((item) => item.value === normalizedValue));
  const group =
    (browse?.selection === normalizedValue
      ? menuGroups.find((item) => item.key === browse.key)
      : undefined) ??
    selected ??
    menuGroups[0];
  const currentGroupSelected = group?.key === selected?.key && Boolean(selected);
  const currentIndex = options.levels.findIndex((level) => level.value === options.value);
  const { label } = getComposerThoughtDisplay(options);
  const sliderRef = useRef<HTMLInputElement>(null);
  const catalogPending = groups.length === 0 && Boolean(normalizedValue);
  const showEffort = options.levels.length > 0 || catalogPending;
  const [nearIndex, setNearIndex] = useState<number | null>(null);
  const [railHovering, setRailHovering] = useState(false);
  const sliderDisabled =
    Boolean(options.providerMenu?.pending) || !currentGroupSelected || options.levels.length < 2;
  const sliderProgress =
    options.levels.length > 1 && currentIndex >= 0 && currentGroupSelected
      ? (currentIndex / (options.levels.length - 1)) * 100
      : 0;
  const sliderFilled =
    currentGroupSelected && currentIndex >= 0 && !isNoThoughtLevel(options.levels[currentIndex]!);
  const selectSliderValue = (index: number) => {
    const level = options.levels[index];
    if (!sliderDisabled && level && level.value !== options.value)
      options.onValueChange(level.value);
  };
  return (
    <>
      <ComposerProviderMenu
        groups={menuGroups}
        error={options.providerMenu?.error}
        disabled={options.providerMenu?.pending}
        loading={options.providerMenu?.pending}
        isDisabled={(candidate) => Boolean((candidate as ComposerPlanGroup).connection?.disabled)}
        separatorBeforeKey={
          options.providerMenu
            ? menuGroups.find(
                (candidate) =>
                  !candidate.connection && !candidate.key.startsWith("registry-provider:account:"),
              )?.key
            : undefined
        }
        group={group}
        label={options.providerLabel}
        providerFooter={providerFooter}
        onSelect={(candidate) => {
          if (options.providerMenu) {
            options.providerMenu.onSelect(candidate as ComposerPlanGroup);
            return;
          }
          setBrowse({ key: candidate.key, selection: normalizedValue });
          // 复用唯一选择链路，供应商页只负责导航，不缓存模型状态。
          const model =
            candidate.items.find(
              (item) => item.value === normalizedValue && !isItemLocked(item.value),
            ) ?? candidate.items.find((item) => !isItemLocked(item.value));
          if (model && model.value !== normalizedValue) onSelectModel(model.value);
        }}
      >
        <DropdownMenuSeparator className="bg-border/50" />
        <DropdownMenuLabel className="text-ui-sm text-foreground-subtle">
          {options.modelsLabel}
        </DropdownMenuLabel>
        {group ? renderConnection(group) : null}
        <ScrollFadeViewport
          className="max-h-60 flex-initial"
          inert={options.providerMenu?.pending || undefined}
          data-composer-model-list
        >
          {group ? renderItems(group.items) : null}
        </ScrollFadeViewport>
        {showEffort ? (
          <>
            <DropdownMenuSeparator className="bg-border/50" />
            {options.levels.length === 1 ? (
              // 单一档位没有可调范围；旧逻辑渲染禁用滑杆并提示快捷键，误导用户可调档。
              <div className="px-2 py-2">
                <ComposerEffortHeading
                  label={options.effortLabel}
                  value={currentGroupSelected ? label : "—"}
                />
              </div>
            ) : (
              <DropdownMenuItem
                className="block px-2 py-2 focus:bg-transparent"
                aria-disabled={sliderDisabled}
                onSelect={(event) => event.preventDefault()}
                onFocus={(event) => {
                  if (event.target === event.currentTarget) sliderRef.current?.focus();
                }}
              >
                <ComposerEffortHeading
                  label={options.effortLabel}
                  value={currentGroupSelected ? label : "—"}
                  shortcut={options.effortShortcutLabel}
                />
                <div
                  className="composer-thinking-feather relative h-9 w-full rounded-full"
                  data-hovering={railHovering}
                  data-disabled={sliderDisabled}
                >
                  <ThinkingFeatherRail
                    // 模型或档位目录变化时只重置视觉层，避免跨模型补间，同时保留 input 焦点。
                    key={JSON.stringify([
                      normalizedValue,
                      group?.key,
                      options.levels.map((level) => level.value),
                    ])}
                    value={
                      sliderFilled && currentGroupSelected && currentIndex >= 0
                        ? sliderProgress
                        : 0
                    }
                    stopCount={options.levels.length}
                    currentIndex={Math.max(0, currentIndex)}
                    filled={sliderFilled}
                    disabled={sliderDisabled}
                    nearIndex={nearIndex}
                  />
                  <input
                    ref={sliderRef}
                    type="range"
                    min={0}
                    max={Math.max(0, options.levels.length - 1)}
                    step={1}
                    value={Math.max(0, currentIndex)}
                    // 目录在调档后会短暂重读；原生 disabled 会移走焦点，后续方向键落到菜单。
                    // 用 aria-disabled 保留焦点，等待期间通过事件与提交入口阻止交互。
                    aria-disabled={sliderDisabled}
                    aria-label={options.effortLabel}
                    aria-valuetext={currentGroupSelected ? label : "—"}
                    data-testid="composer-thought-slider"
                    data-levels={JSON.stringify(options.levels.map((level) => level.value))}
                    className="composer-thinking-range absolute inset-0 m-0 h-9 w-full cursor-pointer appearance-none bg-transparent outline-none aria-disabled:cursor-default"
                    onPointerDown={(event) => {
                      // 拦截冒泡会让 Radix 的内部点击标记残留，导致第一次外部点击无法关闭菜单。
                      if (sliderDisabled) event.preventDefault();
                    }}
                    onPointerEnter={() => setRailHovering(true)}
                    onPointerLeave={() => {
                      setRailHovering(false);
                      setNearIndex(null);
                    }}
                    onPointerMove={(event) => {
                      // 原生 range 覆盖圆点，用坐标反馈悬停，避免圆点截获拖拽事件。
                      if (sliderDisabled || event.pointerType === "touch") {
                        setNearIndex(null);
                        return;
                      }
                      const rect = event.currentTarget.getBoundingClientRect();
                      const trackWidth = Math.max(1, rect.width - 28);
                      const index = Math.round(
                        ((event.clientX - rect.left - 14) / trackWidth) *
                          (options.levels.length - 1),
                      );
                      setNearIndex(
                        Math.min(options.levels.length - 1, Math.max(0, index)),
                      );
                    }}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={() => setNearIndex(null)}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") {
                        event.stopPropagation();
                        if (sliderDisabled && event.key !== "Tab") event.preventDefault();
                      }
                    }}
                    // 原因：缺失档位时 range 的物理位置仍为 0；Home 或点击首格不触发 change，
                    // 必须在明确完成手势时接纳首格选择，不能把展示位置提前当成用户意图。
                    onKeyUp={(event) => {
                      if (
                        [
                          "Home",
                          "End",
                          "ArrowLeft",
                          "ArrowRight",
                          "ArrowUp",
                          "ArrowDown",
                          "PageUp",
                          "PageDown",
                        ].includes(event.key)
                      )
                        selectSliderValue(Number(event.currentTarget.value));
                    }}
                    onPointerUp={(event) => {
                      selectSliderValue(Number(event.currentTarget.value));
                    }}
                    onChange={(event) => selectSliderValue(Number(event.currentTarget.value))}
                  />
                </div>
              </DropdownMenuItem>
            )}
          </>
        ) : null}
      </ComposerProviderMenu>
    </>
  );
}
