import type { CSSProperties, ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";

export function WorkspacePurposeSection({
  title,
  open,
  onOpenChange,
  action,
  children,
  testId,
  sortableId,
  dragHandleLabel,
  inset = false,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: ReactNode;
  children: ReactNode;
  testId: string;
  sortableId: string;
  dragHandleLabel: string;
  inset?: boolean;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    active,
    activeIndex,
    index,
    isOver,
  } = useSortable({ id: sortableId });
  // 原因：分区原来只有位移动画，无法判断落点；与项目行一样从同一排序状态派生蓝线。
  const dropPosition =
    isOver && active && !isDragging && activeIndex >= 0
      ? activeIndex > index
        ? "before"
        : "after"
      : null;
  const style: CSSProperties = {
    transform: transform
      ? CSS.Transform.toString({ ...transform, scaleX: 1, scaleY: 1 })
      : undefined,
    transition,
    zIndex: dropPosition ? 20 : isDragging ? 10 : undefined,
    opacity: isDragging ? 0.85 : 1,
  };

  return (
    <section
      ref={setNodeRef}
      style={style}
      data-testid={testId}
      data-source-hierarchy-children={inset ? "true" : undefined}
      aria-label={title}
      className={cn("group/purpose-section relative min-w-0", inset && "ml-6 mr-1")}
    >
      {dropPosition && (
        <div
          aria-hidden="true"
          data-testid="purpose-section-drop-indicator"
          data-drop-position={dropPosition}
          className={`pointer-events-none absolute left-5 right-2 z-20 h-0.5 bg-icon-blue ${dropPosition === "before" ? "top-0 -translate-y-1/2" : "bottom-0 translate-y-1/2"}`}
        >
          <span className="absolute -left-1 top-1/2 size-2 -translate-y-1/2 rounded-full border-2 border-icon-blue bg-sidebar" />
        </div>
      )}
      <Collapsible open={open} onOpenChange={onOpenChange}>
        {/* 原因：右侧 margin 与 action padding 叠加，多出 10px；与项目行统一保留 6px。 */}
        <div className="ml-2 mr-1.5 flex h-6.5 min-w-0 items-center">
          <CollapsibleTrigger asChild>
            {/* 与同级侧栏分组标题统一为紧凑低噪点微标题。 */}
            <button
              ref={setActivatorNodeRef}
              {...attributes}
              {...listeners}
              type="button"
              aria-describedby={`purpose-section-drag-description-${sortableId}`}
              data-purpose-section-drag-trigger={sortableId}
              className="flex h-6.5 min-w-0 flex-1 touch-none items-center gap-1 px-2.5 text-left text-ui-sm font-medium tracking-[0.02em] text-foreground-subtlest outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
            >
              <span className="min-w-0 truncate">{title}</span>
              {open ? (
                <ChevronDown
                  aria-hidden="true"
                  data-purpose-section-chevron="expanded"
                  className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100 [@media(hover:none)]:opacity-100"
                />
              ) : (
                <ChevronRight
                  aria-hidden="true"
                  data-purpose-section-chevron="collapsed"
                  className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100 [@media(hover:none)]:opacity-100"
                />
              )}
            </button>
          </CollapsibleTrigger>
          <span id={`purpose-section-drag-description-${sortableId}`} className="sr-only">
            {dragHandleLabel}
          </span>
          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/purpose-section:opacity-100 group-focus-within/purpose-section:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100">
            {action}
          </div>
        </div>
        <CollapsibleContent>{children}</CollapsibleContent>
      </Collapsible>
    </section>
  );
}
