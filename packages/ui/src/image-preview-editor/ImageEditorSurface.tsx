import { MinusIcon, PlusIcon } from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { exportAnnotatedImage, AnnotationLayer } from "./annotations.js";
import { captureImageComposerTarget } from "./composerTarget.js";
import type { ImageEditorSurfaceProps } from "./contract.js";
import {
  clampOffset,
  clientPointToNormalized,
  findTopmostAnnotation,
  moveAnnotation,
  redoHistory,
  undoHistory,
  updateHistory,
  zoomAtPoint,
  type Annotation,
  type AnnotationTool,
  type History,
  type Point,
  type Transform,
} from "./geometry.js";
import { ImageEditorToolbar } from "./ImageEditorToolbar.js";

type Gesture = {
  /** 选择/平移用屏幕坐标，绘制用归一化坐标；由 annotation 是否存在区分。 */
  start: Point;
  transform: Transform;
  annotation?: Annotation;
  moving?: boolean;
};

const ZERO: Point = { x: 0, y: 0 };
const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const DEFAULT_COLOR = "#ef4444";

function createAnnotationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `annotation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** 屏幕 3px 换算成归一化命中容差；容器尺寸未就绪时给一个安全默认值。 */
function normalizedHitTolerance(rect: DOMRect): number {
  const shortest = Math.min(rect.width, rect.height);
  return shortest > 0 ? 3 / shortest : 0.01;
}

/** 屏幕 3px 换算成归一化线宽，并限制最小可见宽度。 */
function normalizedStrokeWidth(rect: DOMRect): number {
  const shortest = Math.min(rect.width, rect.height);
  return shortest > 0 ? Math.max(0.002, 3 / shortest) : 0.004;
}

export function ImageEditorSurface({
  input,
  composerScope,
  onClose,
  onAppended,
}: ImageEditorSurfaceProps) {
  const { intl } = useZCodeIntl();
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [sourceUrl, setSourceUrl] = useState("");
  const [imageState, setImageState] = useState<"loading" | "ready" | "error">("loading");
  const [transform, setTransform] = useState<Transform>({ scale: 1, offset: ZERO });
  const [tool, setTool] = useState<AnnotationTool>("select");
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [history, setHistory] = useState<History<Annotation>>({
    past: [],
    present: [],
    future: [],
  });
  const [draft, setDraft] = useState<Annotation | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState<Annotation | null>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const gestureRef = useRef<Gesture | null>(null);
  const draftRef = useRef<Annotation | null>(null);
  const pointersRef = useRef(new Map<number, Point>());
  const pinchRef = useRef<{ distance: number; transform: Transform } | null>(null);
  const sendPendingRef = useRef(false);
  const aliveRef = useRef(true);

  // 输入字节只用于生成一次预览对象 URL；不在编辑器里改写原图。
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([input.bytes.slice()], { type: input.mediaType }));
    setSourceUrl(url);
    setImageState("loading");
    return () => URL.revokeObjectURL(url);
  }, [input.bytes, input.mediaType]);

  const natural = useMemo(
    () => ({
      width: Math.max(1, Math.round(input.width)),
      height: Math.max(1, Math.round(input.height)),
    }),
    [input.height, input.width],
  );

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    const viewportElement = viewportRef.current;
    if (!viewportElement) return;
    const update = () =>
      setViewport({
        width: viewportElement.clientWidth,
        height: viewportElement.clientHeight,
      });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewportElement);
    return () => observer.disconnect();
  }, []);

  const fit = Math.min(
    1,
    viewport.width > 0 ? viewport.width / natural.width : 1,
    viewport.height > 0 ? viewport.height / natural.height : 1,
  );
  const size = { width: natural.width * fit, height: natural.height * fit };
  const canPan =
    size.width * transform.scale > viewport.width + 1 ||
    size.height * transform.scale > viewport.height + 1;
  const cursor =
    tool === "select"
      ? canPan
        ? dragging
          ? "grabbing"
          : "grab"
        : "default"
      : tool === "text"
        ? "text"
        : "crosshair";

  const displayed = history.present.map((annotation) =>
    draft?.id === annotation.id ? draft : annotation,
  );
  if (draft && !history.present.some((annotation) => annotation.id === draft.id)) {
    displayed.push(draft);
  }
  if (textDraft?.text?.trim()) displayed.push(textDraft);
  const hasContent = displayed.length > 0;

  const setCurrentDraft = (value: Annotation | null) => {
    draftRef.current = value;
    setDraft(value);
  };

  const commit = (annotations: Annotation[]) => {
    setHistory((current) => updateHistory(current, annotations));
  };

  const undo = () => {
    setHistory(undoHistory);
    setSelected(null);
    setTextDraft(null);
  };

  const redo = () => {
    setHistory(redoHistory);
    setSelected(null);
    setTextDraft(null);
  };

  const applyTransform = (value: Transform) => {
    setTransform({
      ...value,
      offset: clampOffset(value.offset, value.scale, size, viewport),
    });
  };

  const zoom = (scale: number, anchor: Point = ZERO) => {
    applyTransform(zoomAtPoint(transform, Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale)), anchor));
  };

  useEffect(() => {
    // 图片适配尺寸或窗口变化时重新夹取偏移；标注本身是归一化的，不需要重算坐标。
    setTransform((current) => ({
      ...current,
      offset: clampOffset(current.offset, current.scale, size, viewport),
    }));
  }, [size.width, size.height, viewport.width, viewport.height]);

  const wheel = useEffectEvent((event: WheelEvent) => {
    if (sending || gestureRef.current || imageState !== "ready") return;
    event.preventDefault();
    const viewportElement = viewportRef.current;
    if (!viewportElement) return;
    const rect = viewportElement.getBoundingClientRect();
    const delta =
      event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    zoom(transform.scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002), {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    });
  });

  useEffect(() => {
    const viewportElement = viewportRef.current;
    // React 的委托 wheel 默认 passive，无法阻止页面滚动；监听只归当前编辑视口所有。
    const listener = (event: WheelEvent) => wheel(event);
    viewportElement?.addEventListener("wheel", listener, { passive: false });
    return () => viewportElement?.removeEventListener("wheel", listener);
  }, []);

  const commitTextDraft = () => {
    if (textDraft?.text?.trim()) commit([...history.present, textDraft]);
    setTextDraft(null);
  };

  const keyboard = useEffectEvent((event: KeyboardEvent) => {
    if (
      sending ||
      (event.target instanceof Element &&
        event.target.closest("input,textarea,[contenteditable=true]"))
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (selected && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      commit(history.present.filter((annotation) => annotation.id !== selected));
      setSelected(null);
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyboard(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (sending || imageState !== "ready" || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const client = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, client);
    if (pointersRef.current.size === 2) {
      const [first, second] = [...pointersRef.current.values()];
      if (first && second) {
        pinchRef.current = {
          distance: Math.hypot(second.x - first.x, second.y - first.y),
          transform,
        };
      }
      setCurrentDraft(null);
      gestureRef.current = null;
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const start = clientPointToNormalized(client, rect);
    const tolerance = normalizedHitTolerance(rect);
    const hit = findTopmostAnnotation(history.present, start, tolerance);
    if (tool === "eraser") {
      if (hit) commit(history.present.filter((annotation) => annotation.id !== hit.id));
      setSelected(null);
      return;
    }
    if (tool === "text") {
      // 切换文字锚点前先把上一段非空文字落进历史，避免连续输入丢字。
      if (textDraft?.text?.trim()) commit([...history.present, textDraft]);
      setTextDraft({
        id: createAnnotationId(),
        tool: "text",
        color,
        width: normalizedStrokeWidth(rect),
        points: [start],
        text: "",
      });
      return;
    }
    if (tool === "select") {
      setSelected(hit?.id ?? null);
      setDragging(Boolean(hit || canPan));
      gestureRef.current = {
        start: hit ? start : client,
        transform,
        annotation: hit ?? undefined,
        moving: Boolean(hit),
      };
      return;
    }
    const mark: Annotation = {
      id: createAnnotationId(),
      tool,
      color,
      width: normalizedStrokeWidth(rect),
      points: [start],
    };
    gestureRef.current = { start, transform, annotation: mark };
    setCurrentDraft(mark);
  };

  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const client = { x: event.clientX, y: event.clientY };
    pointersRef.current.set(event.pointerId, client);
    if (pinchRef.current && pointersRef.current.size >= 2) {
      const [first, second] = [...pointersRef.current.values()];
      if (first && second) {
        const scale = Math.min(
          MAX_SCALE,
          Math.max(
            MIN_SCALE,
            (pinchRef.current.transform.scale *
              Math.hypot(second.x - first.x, second.y - first.y)) /
              (pinchRef.current.distance || 1),
          ),
        );
        applyTransform({ ...pinchRef.current.transform, scale });
      }
      return;
    }
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (!gesture.annotation) {
      if (canPan) {
        applyTransform({
          ...transform,
          offset: {
            x: gesture.transform.offset.x + client.x - gesture.start.x,
            y: gesture.transform.offset.y + client.y - gesture.start.y,
          },
        });
      }
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const current = clientPointToNormalized(client, rect);
    const mark = gesture.annotation;
    if (gesture.moving) {
      setCurrentDraft(
        moveAnnotation(mark, {
          x: current.x - gesture.start.x,
          y: current.y - gesture.start.y,
        }),
      );
      return;
    }
    setCurrentDraft({
      ...mark,
      points:
        mark.tool === "pen"
          ? [...(draftRef.current?.points ?? mark.points), current]
          : [gesture.start, current],
    });
  };

  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const mark = draftRef.current;
    // cancel/lostcapture 不提交半条标注；主动 release 后的重复事件由 pointer 集合过滤。
    if (event.type === "pointerup" && mark) {
      commit(
        gestureRef.current?.moving
          ? history.present.map((annotation) => (annotation.id === mark.id ? mark : annotation))
          : [...history.present, mark],
      );
    }
    setCurrentDraft(null);
    gestureRef.current = null;
    pinchRef.current = null;
    setDragging(false);
  };

  const changeTool = (value: AnnotationTool) => {
    setTool(value);
    setSelected(null);
    if (textDraft?.text?.trim()) commit([...history.present, textDraft]);
    setTextDraft(null);
  };

  const clear = () => {
    if (!hasContent) return;
    setCurrentDraft(null);
    setSelected(null);
    setTextDraft(null);
    commit([]);
  };

  const send = async () => {
    if (
      sendPendingRef.current ||
      !hasContent ||
      imageState !== "ready" ||
      !imageRef.current ||
      !overlayRef.current
    ) {
      return;
    }
    const target = captureImageComposerTarget(composerScope ? { scope: composerScope } : undefined);
    if (!target) {
      toast(intl.formatMessage({ id: "imageEditor.noComposer" }));
      return;
    }
    sendPendingRef.current = true;
    setSending(true);
    try {
      const output = await exportAnnotatedImage(imageRef.current, overlayRef.current, {
        width: natural.width,
        height: natural.height,
        filename: input.filename?.trim() || "image",
        changed: hasContent,
      });
      if (!aliveRef.current) return;
      // 接收方同步走既有附件 admission；拒绝（例如已达附件上限）时不能关闭编辑器。
      if (!target.appendImage(output)) throw new Error("Composer rejected the image");
      onAppended(output);
    } catch (error) {
      if (!aliveRef.current) return;
      logger.warn("[ImagePreviewEditor] 标注图片发送失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "imageEditor.saveFailed" }));
    } finally {
      sendPendingRef.current = false;
      if (aliveRef.current) setSending(false);
    }
  };

  return (
    <>
      <div
        className="absolute inset-x-4 bottom-28 top-20 overflow-hidden sm:inset-x-20 sm:bottom-24"
        data-image-editor-viewport=""
        ref={viewportRef}
      >
        <div
          data-image-editor-surface=""
          className="absolute left-1/2 top-1/2 touch-none select-none"
          onLostPointerCapture={pointerEnd}
          onPointerCancel={pointerEnd}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerEnd}
          style={{
            width: size.width,
            height: size.height,
            cursor,
            transform: `translate(-50%, -50%) translate(${transform.offset.x}px, ${transform.offset.y}px) scale(${transform.scale})`,
          }}
        >
          {sourceUrl ? (
            <img
              alt={intl.formatMessage({ id: "imageEditor.title" })}
              className="size-full rounded-xl object-contain"
              data-image-editor-image=""
              draggable={false}
              onError={() => setImageState("error")}
              onLoad={() => setImageState("ready")}
              ref={imageRef}
              src={sourceUrl}
            />
          ) : null}
          <svg
            className="pointer-events-none absolute inset-0 size-full overflow-hidden text-foreground"
            ref={overlayRef}
            viewBox={`0 0 ${natural.width} ${natural.height}`}
            xmlns="http://www.w3.org/2000/svg"
          >
            <AnnotationLayer annotations={displayed} selected={selected} size={natural} />
          </svg>
        </div>
        {imageState === "error" ? (
          <p
            className="absolute left-1/2 top-1/2 max-w-md -translate-x-1/2 -translate-y-1/2 text-center text-ui-base text-destructive"
            role="alert"
          >
            {intl.formatMessage({ id: "imageEditor.imageUnavailable" })}
          </p>
        ) : null}
      </div>
      <ImageEditorToolbar
        canClear={hasContent}
        canRedo={history.future.length > 0}
        canUndo={history.past.length > 0}
        clear={clear}
        color={color}
        disabled={sending || imageState !== "ready"}
        onColor={setColor}
        onTool={changeTool}
        redo={redo}
        tool={tool}
        undo={undo}
      />
      {textDraft ? (
        <div
          className="absolute left-1/2 top-20 z-30 flex max-w-full -translate-x-1/2 gap-1 rounded-xl border border-popover-border bg-popover p-2"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Input
            autoFocus
            aria-label={intl.formatMessage({ id: "imageEditor.textValue" })}
            className="w-48 text-mobile-input-safe sm:text-ui-base"
            disabled={sending}
            onChange={(event) => setTextDraft({ ...textDraft, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                commitTextDraft();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTextDraft(null);
              }
            }}
            value={textDraft.text}
          />
          <Button disabled={sending} onClick={commitTextDraft}>
            {intl.formatMessage({ id: "imageEditor.applyText" })}
          </Button>
        </div>
      ) : null}
      {!hasContent && imageState === "ready" ? (
        <div className="pointer-events-none absolute bottom-24 left-1/2 z-10 -translate-x-1/2 rounded-full border border-popover-border bg-popover/95 px-3 py-1 text-ui-base text-foreground-subtle shadow-md sm:bottom-16">
          {intl.formatMessage({ id: "imageEditor.empty" })}
        </div>
      ) : null}
      <div className="absolute left-4 top-4 z-20">
        <Button
          data-image-editor-send=""
          disabled={sending || !hasContent || imageState !== "ready"}
          onClick={() => void send()}
        >
          {intl.formatMessage({ id: sending ? "imageEditor.sending" : "imageEditor.send" })}
        </Button>
      </div>
      <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full border border-popover-border bg-popover p-1 shadow-md">
        <Button
          aria-label={intl.formatMessage({ id: "markdownImage.zoomOut" })}
          className="rounded-full"
          disabled={sending || transform.scale <= MIN_SCALE}
          onClick={() => zoom(transform.scale - 0.5)}
          size="icon-sm"
          variant="ghost"
        >
          <MinusIcon />
        </Button>
        <span className="min-w-12 text-center text-ui-base">
          {Math.round(transform.scale * 100)}%
        </span>
        <Button
          aria-label={intl.formatMessage({ id: "markdownImage.zoomIn" })}
          className="rounded-full"
          disabled={sending || transform.scale >= MAX_SCALE}
          onClick={() => zoom(transform.scale + 0.5)}
          size="icon-sm"
          variant="ghost"
        >
          <PlusIcon />
        </Button>
      </div>
    </>
  );
}
