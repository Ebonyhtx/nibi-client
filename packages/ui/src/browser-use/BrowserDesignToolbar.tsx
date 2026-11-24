import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight, PanelRight } from "lucide-react";
import {
  TID_BROWSER_DESIGN_PANEL_BUTTON,
  TID_BROWSER_DESIGN_SLIDE_COUNTER,
  TID_BROWSER_DESIGN_SLIDE_NEXT,
  TID_BROWSER_DESIGN_SLIDE_PREV,
  TID_BROWSER_DESIGN_TOOLBAR,
  TID_BROWSER_DESIGN_VARIANT_OPTION,
  TID_BROWSER_DESIGN_VARIANT_SELECT,
} from "@nibi/shared/test-ids";
import type { BrowserDesignModeController } from "@/browser-use/useBrowserDesignMode.js";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";

// 设计工具行：调整面板开关、方案、翻页。纯展示，状态与动作都来自 useBrowserDesignMode。
// 只在设计稿页面（data-nibi-design / 本机设计信号）且 Design 插件启用时出现。

const ALL_VARIANTS_VALUE = "__nibi-all-variants__";

function ToolButton({
  active,
  children,
  icon,
  onClick,
  testId,
}: {
  active: boolean;
  children: string;
  icon: ReactNode;
  onClick: () => void;
  testId: string;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "secondary" : "ghost"}
      aria-label={children}
      aria-pressed={active}
      title={children}
      className="shrink-0"
      data-testid={testId}
      onClick={onClick}
    >
      {icon}
      <span className="@max-xl/design-toolbar:hidden">{children}</span>
    </Button>
  );
}

export function BrowserDesignToolbar({
  design,
  viewportControls,
}: {
  design: BrowserDesignModeController;
  /** 自由尺寸打开时的设备预设控件：放进同一行中间 */
  viewportControls?: ReactNode;
}): React.JSX.Element {
  const { intl } = useNibiIntl();
  const info = design.pageInfo;
  const { slide } = design;
  return (
    <div
      aria-label={intl.formatMessage({ id: "browser.design.toolbar" })}
      className="@container/design-toolbar flex min-h-8 shrink-0 flex-wrap items-center gap-x-1 border-y border-border/80 bg-header/90 px-2 backdrop-blur-sm"
      data-testid={TID_BROWSER_DESIGN_TOOLBAR}
      role="toolbar"
    >
      {design.mode !== "off" ? (
        <ToolButton
          active={design.panelOpen}
          icon={<PanelRight className="size-4" />}
          testId={TID_BROWSER_DESIGN_PANEL_BUTTON}
          onClick={() => design.setPanelOpen(!design.panelOpen)}
        >
          {intl.formatMessage({ id: "browser.design.panel" })}
        </ToolButton>
      ) : null}
      {info && info.variants.length > 0 ? (
        <Select
          value={design.variant ?? ALL_VARIANTS_VALUE}
          onValueChange={(value) => design.setVariant(value === ALL_VARIANTS_VALUE ? null : value)}
        >
          <SelectTrigger
            aria-label={intl.formatMessage({ id: "browser.design.variant" })}
            className="min-w-24 shrink-0 font-medium"
            data-testid={TID_BROWSER_DESIGN_VARIANT_SELECT}
            size="default"
            variant="ghost"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem
              data-testid={`${TID_BROWSER_DESIGN_VARIANT_OPTION}-all`}
              value={ALL_VARIANTS_VALUE}
            >
              {intl.formatMessage({ id: "browser.design.variant.all" })}
            </SelectItem>
            {info.variants.map((name) => (
              <SelectItem
                data-testid={`${TID_BROWSER_DESIGN_VARIANT_OPTION}-${name}`}
                key={name}
                value={name}
              >
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {slide.count > 0 ? (
        <div className="flex shrink-0 items-center">
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "browser.design.slidePrev" })}
            data-testid={TID_BROWSER_DESIGN_SLIDE_PREV}
            disabled={slide.index <= 0}
            onClick={() => design.goToSlide(slide.index - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span
            className="min-w-12 text-center text-ui-base font-medium tabular-nums"
            data-testid={TID_BROWSER_DESIGN_SLIDE_COUNTER}
          >
            {slide.index + 1} / {slide.count}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label={intl.formatMessage({ id: "browser.design.slideNext" })}
            data-testid={TID_BROWSER_DESIGN_SLIDE_NEXT}
            disabled={slide.index >= slide.count - 1}
            onClick={() => design.goToSlide(slide.index + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-auto justify-center">{viewportControls}</div>
    </div>
  );
}