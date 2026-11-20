"use client";

import { ArrowLeftIcon, ArrowRightIcon, MinusIcon, PlusIcon, XIcon } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import {
  canUseImageEditor,
  decodeImageDataUrl,
  detectImageEditorCanvas,
  ImageEditorSurface,
  ImagePreviewActions,
  isAnnotatableImageSource,
  readBoundedImageBlob,
  sanitizeImageSourceForLog,
  type ImageEditorComposerScope,
  type ImageEditorInput,
} from "@/image-preview-editor/index.js";
import { logger } from "@/logger.js";

export { downloadImagePreview, sanitizeImageSourceForLog } from "@/image-preview-editor/index.js";

/** 预览条目可直接携带的位图原始字节；没有时由 src 或 loadEditSource 惰性读取。 */
export interface ImagePreviewEditSource {
  bytes: Uint8Array;
  mediaType: string;
}

export interface ImagePreviewDialogItem {
  alt: string;
  error?: boolean;
  filename?: string;
  /** 惰性读取原始位图（消息附件只有预览 URL 时使用）。 */
  loadEditSource?: () => Promise<ImagePreviewEditSource | null>;
  loading?: boolean;
  mediaType?: string;
  src?: string;
}

interface PreviewOffset {
  x: number;
  y: number;
}

interface PreviewSize {
  height: number;
  width: number;
}

const defaultPreviewOffset: PreviewOffset = { x: 0, y: 0 };

export function clampImagePreviewOffset(
  offset: PreviewOffset,
  scale: number,
  imageSize: PreviewSize,
  viewportSize: PreviewSize,
): PreviewOffset {
  const maxX = Math.max(0, (imageSize.width * scale - viewportSize.width) / 2);
  const maxY = Math.max(0, (imageSize.height * scale - viewportSize.height) / 2);
  return {
    x: maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, offset.x)),
    y: maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, offset.y)),
  };
}

/**
 * 解析当前预览项的编辑源。
 * 顺序：调用方惰性读取 → base64 data URL → 预览 URL 回读。
 * 回读统一经过 `readBoundedImageBlob`，让远程大图在编辑前就命中与下载相同的上限。
 */
async function readPreviewImageEditSource(
  item: ImagePreviewDialogItem,
): Promise<ImagePreviewEditSource | null> {
  if (item.loadEditSource) return item.loadEditSource();
  const source = item.src;
  if (!source) return null;
  if (isAnnotatableImageSource(source)) return decodeImageDataUrl(source);
  const blob = await readBoundedImageBlob(source);
  const declaredType = item.mediaType?.toLowerCase().split(";")[0] ?? "";
  const blobType = blob.type.toLowerCase().split(";")[0] ?? "";
  const mediaType = blobType.startsWith("image/")
    ? blobType
    : declaredType.startsWith("image/")
      ? declaredType
      : "image/png";
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mediaType };
}

export function ImagePreviewDialog({
  composerScope,
  dialogTestId,
  imageTestId,
  initialIndex,
  items,
  onActiveIndexChange,
  onOpenChange,
  open,
}: {
  composerScope?: ImageEditorComposerScope;
  dialogTestId?: string;
  imageTestId?: string;
  initialIndex: number;
  items: readonly ImagePreviewDialogItem[];
  onActiveIndexChange?: (index: number) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const { intl } = useNibiIntl();
  const platform = useOptionalPlatform();
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [previewScale, setPreviewScale] = useState(1);
  const [previewOffset, setPreviewOffset] = useState(defaultPreviewOffset);
  const [previewImageReady, setPreviewImageReady] = useState(false);
  const [videoState, setVideoState] = useState<"loading" | "ready" | "unsupported">("loading");
  const [editorInput, setEditorInput] = useState<ImageEditorInput | null>(null);
  const [preparingEdit, setPreparingEdit] = useState(false);
  const editRequestRef = useRef(0);
  const previewViewportRef = useRef<HTMLDivElement>(null);
  const previewImageRef = useRef<HTMLImageElement>(null);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const previewPointersRef = useRef(new Map<number, PreviewOffset>());
  const dragStartRef = useRef<{
    offset: PreviewOffset;
    pointer: PreviewOffset;
  } | null>(null);
  const pinchStartRef = useRef<{ distance: number; scale: number } | null>(null);
  const activeItem = items[activeIndex];
  const activeItemIsVideo = activeItem?.mediaType?.startsWith("video/") === true;
  const editing = editorInput !== null;
  const hasMultiple = items.length > 1;
  const activeSource = activeItem?.src ?? "";
  const hasEditLoader = Boolean(activeItem?.loadEditSource);
  const canEditActiveImage = useMemo(() => {
    if (activeItemIsVideo || activeItem?.loading || activeItem?.error) return false;
    if (!activeSource && !hasEditLoader) return false;
    // 与预览面板一致：只在桌面/Host 且具备 canvas 导出能力时提供编辑入口。
    const desktopHost = platform?.canOpenLocalFiles === true;
    return canUseImageEditor({
      desktopHost,
      canvas: desktopHost ? detectImageEditorCanvas() : false,
    });
  }, [
    activeItem?.error,
    activeItem?.loading,
    activeItemIsVideo,
    activeSource,
    hasEditLoader,
    platform,
  ]);

  const resetPreviewTransform = () => {
    const viewport = previewViewportRef.current;
    if (viewport) {
      for (const pointerId of previewPointersRef.current.keys()) {
        if (viewport.hasPointerCapture(pointerId)) {
          viewport.releasePointerCapture(pointerId);
        }
      }
    }
    previewPointersRef.current.clear();
    dragStartRef.current = null;
    pinchStartRef.current = null;
    setPreviewScale(1);
    setPreviewOffset(defaultPreviewOffset);
  };

  const navigate = (direction: -1 | 1) => {
    if (editing || items.length <= 1) return;
    const next = (activeIndex + direction + items.length) % items.length;
    setActiveIndex(next);
    onActiveIndexChange?.(next);
    resetPreviewTransform();
  };

  useEffect(() => {
    if (!open) return;
    setActiveIndex(Math.min(Math.max(initialIndex, 0), Math.max(items.length - 1, 0)));
    resetPreviewTransform();
  }, [initialIndex, items.length, open]);

  useEffect(() => {
    // 切换图片或关闭预览时丢弃编辑态；在途的编辑源读取也会因 request id 过期而作废。
    editRequestRef.current += 1;
    setEditorInput(null);
    setPreparingEdit(false);
    setPreviewImageReady(false);
  }, [activeIndex, open]);

  useEffect(() => {
    setVideoState("loading");
  }, [activeIndex, activeItem?.src, open]);

  useEffect(() => {
    return () => {
      // 媒体 gallery 切离 video 时旧播放器可能继续解码或发声；显式暂停，
      // 让图片/视频混合导航只保留当前项的播放生命周期。
      previewVideoRef.current?.pause();
    };
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (editing || preparingEdit) return;
      if (event.key === "ArrowLeft") navigate(-1);
      else if (event.key === "ArrowRight") navigate(1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, editing, items.length, open, preparingEdit]);

  const clampPreviewOffset = (offset: PreviewOffset, scale: number) => {
    const image = previewImageRef.current;
    const viewport = previewViewportRef.current;
    if (!image || !viewport) return defaultPreviewOffset;
    return clampImagePreviewOffset(
      offset,
      scale,
      { height: image.offsetHeight, width: image.offsetWidth },
      { height: viewport.clientHeight, width: viewport.clientWidth },
    );
  };

  useEffect(() => {
    if (!open) return;
    const clampCurrentOffset = () => {
      setPreviewOffset((current) => clampPreviewOffset(current, previewScale));
    };
    window.addEventListener("resize", clampCurrentOffset);
    return () => window.removeEventListener("resize", clampCurrentOffset);
  }, [open, previewScale]);

  const changePreviewScale = (delta: number) => {
    const nextScale = Math.min(3, Math.max(0.5, previewScale + delta));
    setPreviewScale(nextScale);
    setPreviewOffset((current) => clampPreviewOffset(current, nextScale));
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const pointer = { x: event.clientX, y: event.clientY };
    previewPointersRef.current.set(event.pointerId, pointer);
    if (previewPointersRef.current.size === 1) {
      dragStartRef.current = { offset: previewOffset, pointer };
      pinchStartRef.current = null;
      return;
    }
    const [first, second] = Array.from(previewPointersRef.current.values());
    if (!first || !second) return;
    const distance = Math.hypot(second.x - first.x, second.y - first.y);
    if (distance === 0) return;
    pinchStartRef.current = { distance, scale: previewScale };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!previewPointersRef.current.has(event.pointerId)) return;
    previewPointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const pointers = Array.from(previewPointersRef.current.values());
    if (pointers.length >= 2) {
      const [first, second] = pointers;
      if (!first || !second || !pinchStartRef.current) return;
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      const nextScale = Math.min(
        3,
        Math.max(0.5, pinchStartRef.current.scale * (distance / pinchStartRef.current.distance)),
      );
      setPreviewScale(nextScale);
      setPreviewOffset((current) => clampPreviewOffset(current, nextScale));
      return;
    }
    const dragStart = dragStartRef.current;
    const pointer = pointers[0];
    if (!dragStart || !pointer) return;
    setPreviewOffset(
      clampPreviewOffset(
        {
          x: dragStart.offset.x + pointer.x - dragStart.pointer.x,
          y: dragStart.offset.y + pointer.y - dragStart.pointer.y,
        },
        previewScale,
      ),
    );
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    // 显式释放图片拖拽捕获；残留 capture 会让后续 hover/click 继续命中视口而非浮层按钮。
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    previewPointersRef.current.delete(event.pointerId);
    pinchStartRef.current = null;
    const remainingPointer = Array.from(previewPointersRef.current.values())[0];
    dragStartRef.current = remainingPointer
      ? { offset: previewOffset, pointer: remainingPointer }
      : null;
  };

  const startEditing = async () => {
    const item = activeItem;
    const image = previewImageRef.current;
    if (!item || activeItemIsVideo || preparingEdit) return;
    if (!image || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
      toast(intl.formatMessage({ id: "imageEditor.loadFailed" }));
      return;
    }
    const requestId = ++editRequestRef.current;
    setPreparingEdit(true);
    try {
      const source = await readPreviewImageEditSource(item);
      if (editRequestRef.current !== requestId) return;
      if (!source || source.bytes.byteLength === 0) {
        throw new Error("Image preview has no editable bytes");
      }
      setEditorInput({
        bytes: source.bytes,
        mediaType: source.mediaType,
        width: image.naturalWidth,
        height: image.naturalHeight,
        filename: item.filename?.trim() || item.alt,
      });
    } catch (error) {
      if (editRequestRef.current !== requestId) return;
      logger.warn("[ImagePreviewDialog] 图片编辑源读取失败", {
        src: item.src ? sanitizeImageSourceForLog(item.src) : "missing",
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "imageEditor.loadFailed" }));
    } finally {
      if (editRequestRef.current === requestId) setPreparingEdit(false);
    }
  };

  const handleSavedToConversation = () => {
    setEditorInput(null);
    toast(intl.formatMessage({ id: "imagePreview.saved" }));
    // 保存后关闭预览，让用户回到输入框看到待发送附件。
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        // Radix modal 会禁用 body 指针事件；预览层需显式恢复命中并退出 Electron 拖拽区。
        className="pointer-events-auto h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none place-items-center gap-0 overflow-hidden border-0 bg-transparent p-10 shadow-none [app-region:no-drag] sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] platform-linux-desktop:h-[calc(100dvh-4rem)]"
        data-testid={dialogTestId}
        onEscapeKeyDown={(event) => {
          // 编辑态下 Escape 只退出编辑（由 ImageEditorSurface 处理），不能顺带关闭整个预览。
          if (editing) event.preventDefault();
        }}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {activeItem?.alt || intl.formatMessage({ id: "chat.attachments.preview.title" })}
        </DialogTitle>
        {activeItem && !activeItemIsVideo && !editing ? (
          <ImagePreviewActions
            item={activeItem}
            imageRef={previewImageRef}
            ready={previewImageReady}
            canDraw={canEditActiveImage}
            composerScope={composerScope}
            onDraw={() => void startEditing()}
            onAdded={() => onOpenChange(false)}
          >
            <DialogClose asChild>
              <Button
                type="button"
                aria-label={intl.formatMessage({ id: "common.close" })}
                className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
                size="icon-md"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </DialogClose>
          </ImagePreviewActions>
        ) : (
          <div className="pointer-events-auto absolute right-4 top-4 z-20 flex items-center gap-2 [app-region:no-drag] platform-mac-desktop:top-12 platform-linux-desktop:right-6 platform-linux-desktop:top-4 platform-windows-desktop:right-6 platform-windows-desktop:top-[calc(env(titlebar-area-height,48px)_+_0.5rem)]">
            <DialogClose asChild>
              <Button
                type="button"
                aria-label={intl.formatMessage({ id: "common.close" })}
                className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
                size="icon-md"
                variant="ghost"
              >
                <XIcon />
              </Button>
            </DialogClose>
          </div>
        )}
        {hasMultiple && !editing ? (
          <>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.previous" })}
              className="pointer-events-auto absolute left-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-background text-foreground shadow-md [app-region:no-drag] hover:bg-background/80"
              onClick={() => navigate(-1)}
              size="icon-md"
              variant="ghost"
            >
              <ArrowLeftIcon />
            </Button>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.next" })}
              className="pointer-events-auto absolute right-4 top-1/2 z-20 -translate-y-1/2 rounded-full border border-border bg-background text-foreground shadow-md [app-region:no-drag] hover:bg-background/80"
              onClick={() => navigate(1)}
              size="icon-md"
              variant="ghost"
            >
              <ArrowRightIcon />
            </Button>
          </>
        ) : null}
        {editorInput ? (
          <ImageEditorSurface
            composerScope={composerScope}
            emptyHintId="imagePreview.editHint"
            input={editorInput}
            onAppended={handleSavedToConversation}
            onClose={() => setEditorInput(null)}
            saveLabelId="imagePreview.saveToConversation"
            savePlacement="bottom-left"
            saveTestId="image-preview-save-to-conversation"
          />
        ) : activeItem ? (
          activeItemIsVideo ? (
            <div className="flex size-full min-h-0 min-w-0 items-center justify-center overflow-hidden">
              {activeItem.src ? (
                videoState === "unsupported" ? (
                  <p
                    className="max-w-xl px-6 text-center text-ui-base text-foreground-subtle"
                    role="alert"
                  >
                    {intl.formatMessage({
                      id: "chat.attachments.preview.videoUnsupported",
                    })}
                  </p>
                ) : (
                  <>
                    {videoState === "loading" ? (
                      <p className="text-ui-base text-foreground-subtle" role="status">
                        {intl.formatMessage({
                          id: "chat.attachments.preview.videoLoading",
                        })}
                      </p>
                    ) : null}
                    {/* 可发送的 video MIME 不保证当前 Chromium 能解码其容器或 codec；
                解码失败只收口当前 gallery item，不能关闭预览或影响相邻媒体。 */}
                    <video
                      controls
                      playsInline
                      className={cn(
                        "max-h-full max-w-full rounded-xl border border-border bg-background shadow-2xl",
                        videoState === "loading" && "invisible absolute",
                      )}
                      onError={() => setVideoState("unsupported")}
                      onLoadedMetadata={() => setVideoState("ready")}
                      ref={previewVideoRef}
                      src={activeItem.src}
                    />
                  </>
                )
              ) : activeItem.error ? (
                <p className="px-6 text-center text-ui-base text-destructive" role="alert">
                  {intl.formatMessage({
                    id: "chat.attachments.preview.videoUnavailable",
                  })}
                </p>
              ) : activeItem.loading ? (
                <p className="text-ui-base text-foreground-subtle" role="status">
                  {intl.formatMessage({
                    id: "chat.attachments.preview.videoLoading",
                  })}
                </p>
              ) : null}
            </div>
          ) : activeItem.src ? (
            <div
              className="flex size-full min-h-0 min-w-0 touch-none cursor-grab items-center justify-center overflow-hidden active:cursor-grabbing"
              onPointerCancel={handlePointerEnd}
              onPointerDown={handlePointerDown}
              onLostPointerCapture={handlePointerEnd}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              ref={previewViewportRef}
            >
              <img
                alt={activeItem.alt}
                className="max-h-full max-w-full select-none rounded-xl border border-border bg-background object-contain shadow-2xl"
                data-testid={imageTestId}
                draggable={false}
                onLoad={() => {
                  setPreviewImageReady(true);
                  resetPreviewTransform();
                }}
                ref={previewImageRef}
                src={activeItem.src}
                style={{
                  transform: `translate3d(${previewOffset.x}px, ${previewOffset.y}px, 0) scale(${previewScale})`,
                }}
              />
            </div>
          ) : activeItem.error ? (
            <p className="px-6 text-center text-ui-base text-destructive" role="alert">
              {intl.formatMessage({
                id: "chat.attachments.preview.unavailable",
              })}
            </p>
          ) : activeItem.loading ? (
            <p className="text-ui-base text-foreground-subtle" role="status">
              {intl.formatMessage({
                id: "chat.attachments.preview.loading",
              })}
            </p>
          ) : null
        ) : null}
        {!activeItemIsVideo && !editing ? (
          <div className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-popover-border bg-popover/95 p-1 shadow-md [app-region:no-drag]">
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.zoomOut" })}
              className="rounded-full"
              disabled={previewScale <= 0.5}
              onClick={() => changePreviewScale(-0.5)}
              size="icon-sm"
              variant="ghost"
            >
              <MinusIcon />
            </Button>
            <span className="min-w-12 text-center text-ui-base text-foreground">
              {Math.round(previewScale * 100)}%
            </span>
            <Button
              type="button"
              aria-label={intl.formatMessage({ id: "markdownImage.zoomIn" })}
              className="rounded-full"
              disabled={previewScale >= 3}
              onClick={() => changePreviewScale(0.5)}
              size="icon-sm"
              variant="ghost"
            >
              <PlusIcon />
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
