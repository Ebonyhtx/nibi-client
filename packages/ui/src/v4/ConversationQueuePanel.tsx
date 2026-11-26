import { BotChannelMessageContent } from "@/v4/ChannelMentionContent.js";
import { parsePromptConversationSelections } from "@/lib/conversationSelectionReference.js";
import { ConversationSelectionReferenceChip } from "@/v4/composer/ConversationSelectionReferenceChip.js";
import { BotGroupSourceLabel } from "@/v4/BotGroupSourceLabel.js";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { memo, useCallback, useMemo, useState, type CSSProperties } from "react";
import {
  TID_V4_QUEUE,
  TID_V4_QUEUE_ITEM,
  TID_V4_QUEUE_ITEM_DELETE,
  TID_V4_QUEUE_ITEM_EDIT,
  TID_V4_QUEUE_ITEM_EDIT_LOCK,
  TID_V4_QUEUE_ITEM_RELEASE_EDIT,
  TID_V4_QUEUE_ITEM_SEND_NOW,
  TID_V4_QUEUE_PAUSED_BANNER,
  TID_V4_QUEUE_RESUME,
  testId,
} from "@nibi/shared/test-ids";
import type { QueueState } from "@nibi/shared/nibi-protocol-v4";
import {
  ArrowUpFromLine,
  GripVertical,
  LockKeyholeIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { getV4EditorId } from "@/v4/editorIdentity.js";

export interface ConversationQueuePanelProps {
  queue: QueueState;
  /** 删除队列项（deleteQueueItem command）。 */
  onDeleteItem?: (queueItemId: string) => void;
  /** 撤回队列项到发起端 composer；权威删除成功后才恢复草稿。 */
  onEditItem?: (queueItemId: string) => Promise<void> | void;
  /** 正在等待 delete ACK / composer restore 的目标项；仅锁该 row。 */
  pendingEditQueueItemId?: string | null;
  /** 立即发送队列项（sendQueuedNow command，stop 当前 + 消费该项）。 */
  onSendNow?: (queueItemId: string) => void;
  /** 拖拽排序项（reorderQueueItem，移动到锚点前；null=队尾）。 */
  onMoveItem?: (queueItemId: string, beforeQueueItemId: string | null) => void;
  /** 暂停队列恢复：CLI setAutoDrain(true)，idle 立即消费、busy 仅武装。 */
  onResume?: () => Promise<void> | void;
  /** 本标签页的 editorId（queue edit lock 的归属判定）；缺省自动取。 */
  editorId?: string;
  /** 本端已收到 lock ACK、但投影尚未回流的 queueItemId（absent + local ACK = self）。 */
  localEditLockQueueItemIds?: readonly string[];
  /** 释放编辑锁（releaseQueueItemEdit）；other 端显示为「释放」，self 端为取消编辑。 */
  onReleaseEditLock?: (queueItemId: string) => Promise<void> | void;
}

type QueueItem = QueueState["items"][number];

export type V4QueueEditLockOwner = "self" | "other";

/** 稳定空表：默认参数不能内联新建数组（memo 组件的引用稳定性门禁）。 */
const NO_LOCAL_EDIT_LOCKS: readonly string[] = [];

/**
 * 队列项编辑锁的归属：
 * - 有锁且 editorId 相同 = self；
 * - 有锁且 editorId 不同 = other（**孤儿锁也算 other**：持有者可能已崩溃/关窗，
 *   UI 必须保留「释放」入口，不能把它当成自己的锁继续编辑）；
 * - 无锁但本端已收到 lock ACK（投影尚未回流）= self；
 * - 其余 = 未加锁。
 */
export function resolveEditLockOwner(
  item: Pick<QueueItem, "queueItemId" | "editLock">,
  editorId: string,
  localEditLockQueueItemIds: readonly string[] = [],
): V4QueueEditLockOwner | null {
  if (item.editLock) {
    return item.editLock.editorId === editorId ? "self" : "other";
  }
  return localEditLockQueueItemIds.includes(item.queueItemId) ? "self" : null;
}

export interface V4QueueReorderAnchor {
  beforeQueueItemId: string | null;
  queueItemId: string;
}

export function resolveV4QueueReorderAnchor(
  items: readonly QueueItem[],
  activeQueueItemId: string,
  overQueueItemId: string,
): V4QueueReorderAnchor | null {
  if (activeQueueItemId === overQueueItemId) {
    return null;
  }

  const fromIndex = items.findIndex((item) => item.queueItemId === activeQueueItemId);
  const overIndex = items.findIndex((item) => item.queueItemId === overQueueItemId);
  if (fromIndex < 0 || overIndex < 0) {
    return null;
  }

  if (fromIndex < overIndex) {
    const itemsAfterRemoval = items.filter((item) => item.queueItemId !== activeQueueItemId);
    const overIndexAfterRemoval = itemsAfterRemoval.findIndex(
      (item) => item.queueItemId === overQueueItemId,
    );
    const nextItem = itemsAfterRemoval[overIndexAfterRemoval + 1];
    return {
      beforeQueueItemId: nextItem?.queueItemId ?? null,
      queueItemId: activeQueueItemId,
    };
  }

  return {
    beforeQueueItemId: overQueueItemId,
    queueItemId: activeQueueItemId,
  };
}

const restrictQueueDragToPanel: Modifier = ({
  transform,
  draggingNodeRect,
  activeNodeRect,
  containerNodeRect,
  windowRect,
}) => {
  const nodeRect = draggingNodeRect ?? activeNodeRect;
  const boundaryRect = containerNodeRect ?? windowRect;
  if (!nodeRect || !boundaryRect) {
    return {
      ...transform,
      x: 0,
    };
  }

  const minY = boundaryRect.top - nodeRect.top;
  const maxY = boundaryRect.bottom - nodeRect.bottom;
  return {
    ...transform,
    x: 0,
    y: Math.min(Math.max(transform.y, minY), maxY),
  };
};

interface QueueRowProps {
  item: QueueItem;
  index: number;
  intl: ReturnType<typeof useNibiIntl>["intl"];
  sortable: boolean;
  onDeleteItem?: (queueItemId: string) => void;
  onEditItem?: (queueItemId: string) => Promise<void> | void;
  editPending: boolean;
  onSendNow?: (queueItemId: string) => void;
  editLockOwner: V4QueueEditLockOwner | null;
  onReleaseEditLock?: (queueItemId: string) => Promise<void> | void;
}

const QueueRow = memo(function QueueRow({
  item,
  index,
  intl,
  sortable,
  onDeleteItem,
  onEditItem,
  onSendNow,
  editPending,
  editLockOwner,
  onReleaseEditLock,
}: QueueRowProps) {
  const dispatchLocked = item.dispatch.state !== "queued";
  // 编辑锁冻结整行：隐藏立即发送/编辑/删除，拖动也禁用。self 也一样——编辑入口已经
  // 在下方 composer（再做行内操作会与 composer 的编辑态分叉）。
  const lockedByEdit = editLockOwner !== null;
  const rowLocked = dispatchLocked || editPending || lockedByEdit;
  const isCompact = item.kind === "compact";
  const parsedInput = {
    ...parsePromptConversationSelections(item.text),
    ...(item.conversationQuotes ? { references: item.conversationQuotes } : {}),
  };
  const attachmentNames = item.attachments.map((attachment) =>
    attachment.sourceKind === "topic-history"
      ? intl.formatMessage(
          { id: "chat.attachments.topicHistory" },
          { count: attachment.messageCount ?? 0 },
        )
      : attachment.fileName,
  );
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    disabled: !sortable || rowLocked,
    id: item.queueItemId,
  });

  const style = useMemo<CSSProperties>(
    () => ({
      transform: CSS.Transform.toString(
        transform
          ? {
              ...transform,
              // dnd-kit 排序时会按 over 节点尺寸附带 scale；
              // 队列行是固定触控目标，缩放会让拖拽中的按钮和文本短暂变形。
              scaleX: 1,
              scaleY: 1,
            }
          : null,
      ),
      transition,
      zIndex: isDragging ? 10 : undefined,
    }),
    [isDragging, transition, transform],
  );
  return (
    <li
      ref={setNodeRef}
      data-testid={testId(TID_V4_QUEUE_ITEM, item.queueItemId)}
      data-queue-item-id={item.queueItemId}
      data-index={index}
      data-kind={item.kind}
      data-dispatch-state={item.dispatch.state}
      data-edit-pending={editPending ? "true" : "false"}
      data-edit-locked={lockedByEdit ? "true" : "false"}
      data-edit-lock-owner={editLockOwner ?? undefined}
      className={cn(
        "relative flex items-center gap-2 rounded-xl px-1.5 py-1 pr-1 transition-colors hover:bg-hover/30",
        isDragging ? "bg-hover/40 shadow-sm" : null,
        editPending ? "opacity-60" : null,
      )}
      style={style}
    >
      <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.drag" })}>
        <Button
          ref={setActivatorNodeRef}
          type="button"
          variant="ghost"
          size="icon-md"
          data-v4-queue-drag-handle="true"
          data-queue-item-id={item.queueItemId}
          aria-label={intl.formatMessage({ id: "chat.queue.drag" })}
          className="shrink-0 cursor-grab touch-none text-foreground-subtlest active:cursor-grabbing"
          disabled={rowLocked}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </Button>
      </ControlHintTooltip>
      <span
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 truncate text-ui-base text-foreground",
          isCompact ? "font-mono" : null,
        )}
        title={parsedInput.visibleContent}
      >
        <span className="flex min-w-0 flex-col">
          <BotGroupSourceLabel source={item.botGroupSource} />
          <span className="truncate">
            <BotChannelMessageContent
              source={isCompact ? undefined : item.botGroupSource}
              text={isCompact ? "/compact" : parsedInput.visibleContent}
            />
          </span>
          {parsedInput.references.length ? (
            <ConversationSelectionReferenceChip references={parsedInput.references} />
          ) : null}
          {item.attachments.length > 0 ? (
            <span
              className="truncate text-ui-sm text-foreground-subtle"
              title={attachmentNames.join(", ")}
            >
              {attachmentNames.join(", ")}
            </span>
          ) : null}
        </span>
      </span>
      {editLockOwner ? (
        <span
          data-testid={testId(TID_V4_QUEUE_ITEM_EDIT_LOCK, item.queueItemId)}
          data-queue-item-id={item.queueItemId}
          data-edit-lock-owner={editLockOwner}
          className={cn(
            // self 是「正在下方编辑」的进行态，和 composer 头带保持同一套铅笔语言；
            // other 是被别人锁住，才需要底色和锁形图标强调。
            "flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtle",
            editLockOwner === "other" && "rounded-md bg-secondary px-2 py-1",
          )}
        >
          {editLockOwner === "self" ? (
            <PencilIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <LockKeyholeIcon className="size-3.5" aria-hidden="true" />
          )}
          {intl.formatMessage({
            id:
              editLockOwner === "self"
                ? "chat.queue.editLockedBySelf"
                : "chat.queue.editLockedByOther",
          })}
        </span>
      ) : null}
      {/* 「释放」只服务 other/孤儿锁：self 的退出入口是 composer 头带里的取消，
          行内再放一个释放会变成两个语义重叠的出口。 */}
      {editLockOwner === "other" && onReleaseEditLock ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid={testId(TID_V4_QUEUE_ITEM_RELEASE_EDIT, item.queueItemId)}
          data-queue-item-id={item.queueItemId}
          onClick={() => void onReleaseEditLock(item.queueItemId)}
        >
          {intl.formatMessage({ id: "chat.queue.releaseEdit" })}
        </Button>
      ) : null}
      {onSendNow && !lockedByEdit ? (
        <Button
          type="button"
          variant="secondary"
          size="default"
          data-icon="inline-start"
          data-testid={testId(TID_V4_QUEUE_ITEM_SEND_NOW, item.queueItemId)}
          data-queue-item-id={item.queueItemId}
          disabled={rowLocked}
          onClick={() =>
            runUserAction({
              input: {
                featureId: "conversation.queue.item",
                action: "send_now",
                trigger: "button",
              },
              operation: () => onSendNow(item.queueItemId),
              completed: { resultSource: "optimistic_projection" },
              failureStage: "queue_send_now",
            })
          }
        >
          <ArrowUpFromLine className="size-3.5" />
          {intl.formatMessage({ id: isCompact ? "chat.queue.runNow" : "chat.queue.sendNow" })}
        </Button>
      ) : null}
      {onEditItem && !isCompact && !lockedByEdit ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.edit" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={testId(TID_V4_QUEUE_ITEM_EDIT, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            aria-label={intl.formatMessage({ id: "chat.queue.edit" })}
            disabled={rowLocked}
            onClick={() => void onEditItem(item.queueItemId)}
          >
            <PencilIcon className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {onDeleteItem && !lockedByEdit ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.queue.remove" })}>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={testId(TID_V4_QUEUE_ITEM_DELETE, item.queueItemId)}
            data-queue-item-id={item.queueItemId}
            aria-label={intl.formatMessage({ id: "chat.queue.remove" })}
            disabled={rowLocked}
            onClick={() => onDeleteItem(item.queueItemId)}
          >
            <Trash2Icon className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
    </li>
  );
});

/**
 * 竖切 queue 面板：渲染 projection.queue.items + 单项删除入口。
 * queue 在运行中的 turn 期间存在（sendText 排队），是 CLI 投影权威态（非 renderer-local）。
 */
function ConversationQueuePanelImpl({
  queue,
  onDeleteItem,
  onEditItem,
  pendingEditQueueItemId = null,
  onSendNow,
  onMoveItem,
  onResume,
  editorId,
  localEditLockQueueItemIds = NO_LOCAL_EDIT_LOCKS,
  onReleaseEditLock,
}: ConversationQueuePanelProps) {
  const { intl } = useNibiIntl();
  const resolvedEditorId = editorId ?? getV4EditorId();
  const [resumePending, setResumePending] = useState(false);
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const itemIds = useMemo(() => queue.items.map((item) => item.queueItemId), [queue.items]);
  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overId = event.over?.id;
      if (!overId) return;
      const anchor = resolveV4QueueReorderAnchor(
        queue.items,
        String(event.active.id),
        String(overId),
      );
      if (!anchor) return;
      onMoveItem?.(anchor.queueItemId, anchor.beforeQueueItemId);
    },
    [onMoveItem, queue.items],
  );
  const handleResume = useCallback(async () => {
    if (!onResume || resumePending) return;
    setResumePending(true);
    try {
      await runUserActionAsync({
        input: { featureId: "conversation.queue.policy", action: "resume", trigger: "button" },
        operation: () => Promise.resolve(onResume()),
        completed: { resultSource: "authority_ack" },
        failureStage: "queue_resume",
      });
    } finally {
      setResumePending(false);
    }
  }, [onResume, resumePending]);

  if (queue.items.length === 0) return null;
  // 补回 v4 视觉迁移时漏掉的旧队列面板 blur 层，让列表保持贴合 composer 的磨砂背景。
  return (
    <div
      data-testid={TID_V4_QUEUE}
      data-queue-count={queue.items.length}
      data-queue-auto-drain={queue.autoDrain ? "true" : "false"}
      className={cn(
        "relative z-0 w-full overflow-hidden rounded-t-2xl border border-border bg-surface p-1 backdrop-blur-md",
        "-mb-7 pb-7",
      )}
    >
      {!queue.autoDrain ? (
        <div
          data-testid={TID_V4_QUEUE_PAUSED_BANNER}
          className="mb-1 flex min-h-10 items-center gap-3 rounded-xl border border-border/70 bg-card px-3 py-2 text-ui-base text-foreground shadow-[var(--nibi-shadow-card)]"
        >
          <span className="min-w-0 flex-1">
            {intl.formatMessage({
              id:
                queue.pauseReason === "stopped"
                  ? "chat.queue.paused.stopped"
                  : queue.pauseReason === "error"
                    ? "chat.queue.paused.error"
                    : "chat.queue.paused.generic",
            })}
          </span>
          {onResume ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              data-testid={TID_V4_QUEUE_RESUME}
              aria-label={intl.formatMessage({ id: "chat.queue.resume.description" })}
              disabled={resumePending}
              className="shrink-0 text-foreground-subtle hover:text-foreground"
              onClick={() => void handleResume()}
            >
              {intl.formatMessage({ id: "chat.queue.resume" })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictQueueDragToPanel]}
        onDragEnd={handleDragEnd}
      >
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          <ul className="space-y-0.5">
            {queue.items.map((item, index) => (
              <QueueRow
                key={item.queueItemId}
                item={item}
                index={index}
                intl={intl}
                sortable={Boolean(onMoveItem)}
                onDeleteItem={onDeleteItem}
                onEditItem={onEditItem}
                onSendNow={onSendNow}
                editPending={pendingEditQueueItemId === item.queueItemId}
                editLockOwner={resolveEditLockOwner(
                  item,
                  resolvedEditorId,
                  localEditLockQueueItemIds,
                )}
                onReleaseEditLock={onReleaseEditLock}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

export const ConversationQueuePanel = memo(ConversationQueuePanelImpl);
