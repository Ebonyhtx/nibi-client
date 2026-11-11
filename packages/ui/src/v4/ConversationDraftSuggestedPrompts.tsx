import {
  forwardRef,
  useId,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
} from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog.js";
/* New task 草稿页推荐提示词入口。
   推荐配置来自 Client Scenes 的 draft-suggestion scene。 */
import { X, Check, Info, LoaderCircle, SquareCode, TriangleAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMotionDisabled } from "@/lib/motionPreference.js";
import { ClientSceneLucideIcon } from "@/components/ClientSceneLucideIcon.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  resolveDraftSuggestedPromptText,
  type DraftSuggestedPromptItem,
} from "@/v4/draftSuggestedPromptItems.js";
import type { DraftSuggestedPluginActionPopoverState } from "@/v4/useDraftSuggestedPluginActionPopover.js";

export type { DraftSuggestedPromptItem } from "@/v4/draftSuggestedPromptItems.js";

const PLUGIN_SUCCESS_ROLL_TRANSITION = {
  duration: 0.2,
  ease: [0.4, 0, 0.2, 1],
} as const;

function SuggestedPromptIcon({ item }: { item: DraftSuggestedPromptItem }) {
  if (item.iconUrl) {
    return (
      <img
        src={item.iconUrl}
        alt=""
        draggable={false}
        className="size-4 rounded-sm object-contain"
      />
    );
  }
  return (
    <ClientSceneLucideIcon
      name={item.iconName}
      aria-hidden="true"
      className="size-4"
      strokeWidth={2}
      fallback={<SquareCode aria-hidden="true" className="size-4" strokeWidth={2} />}
    />
  );
}

interface SuggestedPromptCardProps extends ComponentPropsWithoutRef<"button"> {
  item: DraftSuggestedPromptItem;
  label: string;
  description?: string;
  waterfallDelayMs: number;
}

/**
 * 两套推荐卡（新建任务草稿、办公模式主动推荐）共用的唯一外观。
 * 不另建设计系统：沿用设置页任务卡的圆角、描边与 hover，保证同一窗口内卡片语言一致。
 */
const SuggestedPromptCard = forwardRef<HTMLButtonElement, SuggestedPromptCardProps>(
  function SuggestedPromptCard(
    { item, label, description, waterfallDelayMs, className, ...buttonProps },
    ref,
  ) {
    const descriptionId = useId();
    return (
      <button
        ref={ref}
        type="button"
        data-draft-suggested-prompt={item.id}
        aria-label={label}
        aria-describedby={description ? descriptionId : undefined}
        title={label}
        className={cn(
          // 根因：旧草稿卡是固定 h-8 的横排 chip，办公推荐是竖排列表，两套圆角/图标/间距各不相同。
          // 这里统一成同一种卡片；高度由 line-clamp 内容决定，不再依赖固定槽位或滚动容器。
          "zcode-draft-prompt-waterfall group/prompt flex min-h-14 w-full min-w-0 items-start gap-2.5",
          "rounded-xl border border-card-border bg-background p-3 text-left text-foreground",
          "transition-colors hover:border-border-hover hover:bg-hover active:bg-surface-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
        {...buttonProps}
        style={
          {
            "--zcode-draft-prompt-waterfall-delay": `${waterfallDelayMs}ms`,
          } as CSSProperties
        }
      >
        <span
          data-draft-suggested-prompt-icon="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle transition-colors group-hover/prompt:text-foreground motion-reduce:transition-none"
        >
          <SuggestedPromptIcon item={item} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            data-draft-suggested-prompt-text="true"
            className="line-clamp-2 break-words text-ui-base font-medium leading-5 text-foreground"
          >
            {label}
          </span>
          {description ? (
            <span
              id={descriptionId}
              className="line-clamp-2 break-words text-ui-sm leading-4.5 text-foreground-subtle"
            >
              {description}
            </span>
          ) : null}
        </span>
      </button>
    );
  },
);

interface ConversationDraftSuggestedPromptsProps {
  className?: string;
  /** 推荐项列表；由上层从 Client Scenes / 主动推荐池映射后下发。 */
  items?: DraftSuggestedPromptItem[];
  /** 点击回调；完整配置交给上层解析 prompt 与 Plugin catalog。 */
  onSelect?: (item: DraftSuggestedPromptItem) => void;
  disabled?: boolean;
  onRefresh?: () => void;
  onClose?: () => void;
  refreshDisabled?: boolean;
  pluginActionPopover?: DraftSuggestedPluginActionPopoverState | null;
}

function DraftSuggestedPluginActionPopoverContent({
  state,
}: {
  state: DraftSuggestedPluginActionPopoverState;
}) {
  const isConfirmation = state.phase === "confirmation";
  const reducedMotion = useMotionDisabled();
  const statusIcon =
    state.phase === "progress" ? (
      <LoaderCircle
        aria-hidden="true"
        className="size-4 shrink-0 animate-spin text-foreground-subtle motion-reduce:animate-none"
      />
    ) : state.phase === "success" ? (
      <Check
        aria-hidden="true"
        data-draft-suggested-plugin-success-icon="true"
        className="size-4 shrink-0 text-foreground"
      />
    ) : state.phase === "error" ? (
      <TriangleAlert aria-hidden="true" className="size-4 shrink-0 text-warning" />
    ) : (
      <Info aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
    );
  const statusContent = (
    <>
      {statusIcon}
      <div
        data-draft-suggested-plugin-popover-message="true"
        className="min-w-0 flex-1 text-ui-base leading-4.5 text-foreground"
      >
        {state.message}
      </div>
    </>
  );

  return (
    <PopoverContent
      side="bottom"
      align="center"
      sideOffset={6}
      collisionPadding={16}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => event.preventDefault()}
      onFocusOutside={(event) => event.preventDefault()}
      onPointerDownOutside={(event) => {
        const isPrimaryPointer = event.detail.originalEvent.button === 0;
        if (!isConfirmation || !state.onDismiss || !isPrimaryPointer) {
          event.preventDefault();
          return;
        }
        state.onDismiss();
      }}
      data-draft-suggested-plugin-popover={state.phase}
      data-draft-suggested-plugin-popover-offset="9"
      data-anchor-item-id={state.anchorItemId}
      className={cn(
        // 固定 80px 确认态只容得下一行标题，较长的本地化 Plugin 名称换行后会把按钮挤出并被裁切。
        "h-auto w-60 max-w-[calc(100vw-2rem)] border-popover-border bg-popover p-3 shadow-md",
        isConfirmation ? "gap-3" : "gap-0",
      )}
    >
      {/* Plugin 名称、状态和按钮不压进同一横排、不从锚点上方展开：遵循设计稿的确认/结果两种结构。 */}
      <div
        role={state.phase === "error" ? "alert" : "status"}
        aria-live={state.phase === "error" ? "assertive" : "polite"}
        data-draft-suggested-plugin-status-viewport="true"
        className="relative min-w-0 overflow-hidden"
      >
        {reducedMotion ? (
          <div
            data-draft-suggested-plugin-success-content={
              state.phase === "success" ? "true" : undefined
            }
            className="flex min-w-0 items-center gap-1.5"
          >
            {statusContent}
          </div>
        ) : (
          // 旧 CSS rotateX 只让成功内容自身翻入，无法像模型标签一样表达“进度被成功替换”。
          // steady key 覆盖确认、进度、失败和重试，仅在进入成功态时触发一出一入的纵向滚动。
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div
              key={state.phase === "success" ? "success" : "steady"}
              data-draft-suggested-plugin-success-content={
                state.phase === "success" ? "true" : undefined
              }
              className="flex min-w-0 items-center gap-1.5"
              initial={{ y: "0.75em", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "-0.75em", opacity: 0 }}
              transition={PLUGIN_SUCCESS_ROLL_TRANSITION}
            >
              {statusContent}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
      {isConfirmation && state.actionLabel && state.onAction ? (
        <Button
          type="button"
          size="sm"
          variant="default"
          className="self-end"
          onClick={state.onAction}
        >
          {state.actionLabel}
        </Button>
      ) : null}
    </PopoverContent>
  );
}

export function ConversationDraftSuggestedPrompts({
  className,
  items = [],
  onSelect,
  disabled = false,
  onRefresh,
  onClose,
  refreshDisabled = false,
  pluginActionPopover,
}: ConversationDraftSuggestedPromptsProps) {
  const { locale, intl } = useZCodeIntl();
  const [confirmClose, setConfirmClose] = useState(false);

  if (items.length === 0) return null;

  const hasHeader = Boolean(onRefresh || onClose);

  return (
    <div
      data-v4-draft-suggested-prompts="true"
      // 命名容器驱动列数：同一组件在宽会话页排 3 列，在窄侧栏/远控宽度自动落到 1 列。
      className={cn("w-full min-w-0 @container/suggestions", className)}
    >
      {hasHeader ? (
        <div className="mb-2 flex items-center justify-between gap-2 px-1 text-ui-sm text-foreground-subtle">
          <span>{intl.formatMessage({ id: "occupationOnboarding.suggestionsHeading" })}</span>
          <div className="flex shrink-0 items-center gap-2">
            {onRefresh ? (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="px-0 text-ui-sm text-foreground-subtle"
                disabled={disabled || refreshDisabled}
                onClick={onRefresh}
              >
                {intl.formatMessage({ id: "chat.officeSuggestions.refresh" })}
              </Button>
            ) : null}
            {onClose ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled || refreshDisabled}
                aria-label={intl.formatMessage({ id: "chat.officeSuggestions.closeTitle" })}
                onClick={() => setConfirmClose(true)}
              >
                <X className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {onClose ? (
        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {intl.formatMessage({ id: "chat.officeSuggestions.closeTitle" })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {intl.formatMessage({ id: "chat.officeSuggestions.closeDescription" })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{intl.formatMessage({ id: "common.cancel" })}</AlertDialogCancel>
              <AlertDialogAction onClick={onClose}>
                {intl.formatMessage({ id: "common.confirm" })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {/* 根因：旧 chips 行用 w-max + overflow-x-auto，窄窗把它变成横向滚动区；主动推荐列表
          又可能把内容顶高，二者都会出现滚动条。改为自适应 grid 后高度随内容增长，页面不再有内嵌滚动。 */}
      <ul
        data-v4-draft-suggested-prompts-group="true"
        className="m-0 grid w-full list-none grid-cols-1 gap-2 p-0 @min-[480px]/suggestions:grid-cols-2 @min-[840px]/suggestions:grid-cols-3"
      >
        {items.map((item, index) => {
          const label = resolveDraftSuggestedPromptText(item.label, locale);
          const description = item.description
            ? resolveDraftSuggestedPromptText(item.description, locale)
            : "";
          const isPopoverAnchor = pluginActionPopover?.anchorItemId === item.id;
          return (
            <Popover key={item.id} open={isPopoverAnchor} modal={false}>
              <li className="min-w-0">
                {/* 只在 Popover 打开时才包 Root/Anchor 会重挂按钮并重播 waterfall，
                    Radix 因而连续测量到带 translateY 的锚点。所有推荐项从首次渲染起保持同一结构。 */}
                <PopoverAnchor
                  asChild
                  data-slot="button"
                  data-draft-suggested-plugin-popover-anchor={isPopoverAnchor ? "true" : undefined}
                >
                  <SuggestedPromptCard
                    item={item}
                    label={label}
                    description={description || undefined}
                    waterfallDelayMs={index * 65}
                    disabled={!onSelect || disabled}
                    onClick={onSelect ? () => onSelect(item) : undefined}
                  />
                </PopoverAnchor>
                {isPopoverAnchor ? (
                  <DraftSuggestedPluginActionPopoverContent state={pluginActionPopover} />
                ) : null}
              </li>
            </Popover>
          );
        })}
      </ul>
    </div>
  );
}
