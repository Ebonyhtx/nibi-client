import type { CSSProperties, SyntheticEvent } from "react";
import { useCallback, useMemo, useRef, useState } from "react";
import { Copy, Download, Ellipsis, MessageSquarePlus, Pencil } from "lucide-react";
import { downloadImagePreview } from "@/components/ai-elements/image-preview-dialog.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import {
  canUseImageEditor,
  decodeImageDataUrl,
  detectImageEditorCanvas,
  ImageAnnotationDialog,
  isAnnotatableImageSource,
  type ImageEditorComposerScope,
  type ImageEditorInput,
} from "@/image-preview-editor/index.js";
import {
  dispatchWorkspaceFileAddToChat,
  type WorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";

interface ImagePreviewContentProps {
  title: string;
  imageSource: string;
  fitToContainer?: boolean;
  sourcePath?: string;
  fileReference?: WorkspaceFileDragPayload;
  loadDownloadSource?: () => Promise<string>;
  /** 标注后附件的目标会话/草稿；与预览所属会话一致，避免投递到其它 pane。 */
  composerScope?: ImageEditorComposerScope;
}

interface ImageNaturalSize {
  source: string;
  width: number;
  height: number;
}

const IMAGE_PREVIEW_CHECKERBOARD_CLASS =
  "[background-color:var(--color-background)] [background-image:linear-gradient(45deg,var(--color-surface)_25%,transparent_25%),linear-gradient(-45deg,var(--color-surface)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,var(--color-surface)_75%),linear-gradient(-45deg,transparent_75%,var(--color-surface)_75%)] [background-position:0_0,0_4px,4px_-4px,-4px_0] [background-size:8px_8px]";

export function getImagePreviewPixelRatio(sourceName: string): number {
  const fileName = sourceName.replace(/\\/g, "/").split("/").at(-1) ?? "";
  const match = /@(\d+(?:\.\d+)?)x(?=(?:\.[^./\\]+)?$)/i.exec(fileName);
  const ratio = match ? Number(match[1]) : 1;

  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

export function copyPreviewImage(image: HTMLImageElement): Promise<void> {
  if (
    typeof navigator === "undefined" ||
    !navigator.clipboard?.write ||
    typeof ClipboardItem === "undefined"
  ) {
    return Promise.reject(new Error("Image clipboard is unavailable"));
  }
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return Promise.reject(new Error("Preview image is not loaded"));
  }

  // 剪贴板通常只接受 PNG；使用已加载图片的自然尺寸，保留透明度且不复制预览棋盘背景。
  const png = new Promise<Blob>((resolve, reject) => {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      reject(new Error("Image canvas is unavailable"));
      return;
    }
    context.drawImage(image, 0, 0);
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
      "image/png",
    );
  });
  // Safari 在异步转换后可能丢失用户激活，必须在点击调用栈内提交带 Promise 的 ClipboardItem。
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export function ImagePreviewContent({
  title,
  fitToContainer = false,
  imageSource,
  sourcePath,
  fileReference,
  loadDownloadSource,
  composerScope,
}: ImagePreviewContentProps) {
  const { intl } = useNibiIntl();
  const platform = useOptionalPlatform();
  const imageRef = useRef<HTMLImageElement>(null);
  const actionPendingRef = useRef(false);
  const [actionPending, setActionPending] = useState(false);
  const [naturalSize, setNaturalSize] = useState<ImageNaturalSize | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState<{
    input: ImageEditorInput;
    scope?: ImageEditorComposerScope;
  } | null>(null);
  const copyLabel = intl.formatMessage({ id: "preview.image.copy" });
  const annotateLabel = intl.formatMessage({ id: "imageEditor.annotate" });
  const canUseImage =
    !actionPending &&
    naturalSize?.source === imageSource &&
    naturalSize.width > 0 &&
    naturalSize.height > 0;
  // 只在桌面/Host 且具备 canvas 导出能力时提供标注；Web 手机远控保持隐藏。
  // SVG 预览使用 URL 编码而不是 base64 字节，因此也不显示入口。
  const canAnnotate = useMemo(() => {
    const desktopHost = platform?.canOpenLocalFiles === true;
    return (
      isAnnotatableImageSource(imageSource) &&
      canUseImageEditor({
        desktopHost,
        canvas: desktopHost ? detectImageEditorCanvas() : false,
      })
    );
  }, [imageSource, platform]);
  const handleAnnotate = useCallback(() => {
    if (!canAnnotate || !canUseImage || !naturalSize) return;
    const decoded = decodeImageDataUrl(imageSource);
    if (!decoded) {
      toast(intl.formatMessage({ id: "imageEditor.loadFailed" }));
      return;
    }
    setAnnotationDraft({
      input: {
        bytes: decoded.bytes,
        mediaType: decoded.mediaType,
        width: naturalSize.width,
        height: naturalSize.height,
        filename: sourcePath ? getPathLeaf(sourcePath) : title,
      },
      ...(composerScope ? { scope: composerScope } : {}),
    });
  }, [canAnnotate, canUseImage, composerScope, imageSource, intl, naturalSize, sourcePath, title]);
  const handleCopy = useCallback(async () => {
    const image = imageRef.current;
    if (!image || actionPendingRef.current || !canUseImage) return;
    actionPendingRef.current = true;
    setActionPending(true);
    try {
      await copyPreviewImage(image);
      toast(intl.formatMessage({ id: "preview.image.copied" }));
      logger.info("[ImagePreview] 图片已复制");
    } catch (error) {
      logger.warn("[ImagePreview] 复制图片失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "preview.image.copyFailed" }));
    } finally {
      actionPendingRef.current = false;
      setActionPending(false);
    }
  }, [canUseImage, intl]);
  const handleDownload = useCallback(async () => {
    if (actionPendingRef.current || !canUseImage) return;
    actionPendingRef.current = true;
    setActionPending(true);
    try {
      const src = loadDownloadSource ? await loadDownloadSource() : imageSource;
      const result = await downloadImagePreview(
        { alt: title, filename: sourcePath ? getPathLeaf(sourcePath) : title, src },
        platform?.saveFile,
      );
      if (result.kind === "saved") {
        toast(intl.formatMessage({ id: "markdownImage.downloadSucceeded" }));
      } else if (result.kind === "started") {
        toast(intl.formatMessage({ id: "markdownImage.downloadStarted" }));
      }
    } catch (error) {
      logger.warn("[ImagePreview] 下载图片失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "markdownImage.downloadFailed" }));
    } finally {
      actionPendingRef.current = false;
      setActionPending(false);
    }
  }, [canUseImage, imageSource, intl, loadDownloadSource, platform, sourcePath, title]);
  const handleAddToChat = useCallback(() => {
    if (!fileReference || !canUseImage) return;
    const added = dispatchWorkspaceFileAddToChat(fileReference);
    toast(intl.formatMessage({ id: added ? "preview.image.added" : "preview.image.addFailed" }));
  }, [canUseImage, fileReference, intl]);
  const pixelRatio = useMemo(
    () => getImagePreviewPixelRatio(sourcePath ?? title),
    [sourcePath, title],
  );
  const imageStyle = useMemo<CSSProperties | undefined>(() => {
    if (
      fitToContainer ||
      pixelRatio <= 1 ||
      naturalSize?.source !== imageSource ||
      naturalSize.width <= 0 ||
      naturalSize.height <= 0
    ) {
      return undefined;
    }

    return {
      // Retina 文件名里的 @2x/@3x 表示物理像素倍率，预览时折算为 CSS 像素，避免素材被放大显示。
      height: naturalSize.height / pixelRatio,
      width: naturalSize.width / pixelRatio,
    };
  }, [fitToContainer, imageSource, naturalSize, pixelRatio]);
  const handleLoad = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const image = event.currentTarget;

      setNaturalSize({
        source: imageSource,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
    },
    [imageSource],
  );
  const imageClassName = fitToContainer
    ? "h-full max-h-full w-full max-w-full object-contain"
    : "h-auto max-h-full w-auto max-w-full object-contain";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-image-preview
          aria-busy={actionPending || undefined}
          tabIndex={0}
          aria-label={title}
          onKeyDown={(event) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
            event.preventDefault();
            // Radix 只监听 contextmenu；Chromium/Electron 不会始终为聚焦的 div 派发键盘菜单事件。
            const bounds = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                clientX: bounds.left + bounds.width / 2,
                clientY: bounds.top + bounds.height / 2,
              }),
            );
          }}
          className={`relative flex h-full min-h-0 items-center justify-center overflow-hidden p-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${IMAGE_PREVIEW_CHECKERBOARD_CLASS}`}
        >
          <img
            ref={imageRef}
            alt={title}
            className={imageClassName}
            onLoad={handleLoad}
            onError={() => setNaturalSize(null)}
            src={imageSource}
            style={imageStyle}
          />
          {canAnnotate ? (
            <Button
              className="absolute top-3 right-3 hidden min-h-11 gap-2 bg-menu sm:inline-flex"
              variant="outline"
              aria-label={annotateLabel}
              data-image-preview-annotate=""
              disabled={!canUseImage}
              onClick={handleAnnotate}
            >
              <Pencil aria-hidden="true" />
              {annotateLabel}
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="absolute top-3 right-3 min-h-11 gap-2 bg-menu sm:hidden"
                variant="outline"
                aria-label={intl.formatMessage({ id: "preview.image.actions" })}
              >
                <Ellipsis aria-hidden="true" />
                {intl.formatMessage({ id: "preview.image.actions" })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canAnnotate ? (
                <DropdownMenuItem
                  className="min-h-11"
                  data-image-preview-annotate
                  disabled={!canUseImage}
                  onSelect={handleAnnotate}
                >
                  <Pencil aria-hidden="true" />
                  {annotateLabel}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                className="min-h-11"
                data-image-preview-add
                disabled={!canUseImage || !fileReference}
                onSelect={handleAddToChat}
              >
                <MessageSquarePlus aria-hidden="true" />
                {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11"
                data-image-preview-copy
                disabled={!canUseImage}
                onSelect={() => void handleCopy()}
              >
                <Copy aria-hidden="true" />
                {copyLabel}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="min-h-11"
                data-image-preview-download
                disabled={!canUseImage}
                onSelect={() => void handleDownload()}
              >
                <Download aria-hidden="true" />
                {intl.formatMessage({ id: "markdownImage.download" })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {canAnnotate ? (
          <ContextMenuItem
            data-image-preview-annotate
            disabled={!canUseImage}
            onSelect={handleAnnotate}
          >
            <Pencil aria-hidden="true" />
            {annotateLabel}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          data-image-preview-add
          disabled={!canUseImage || !fileReference}
          onSelect={handleAddToChat}
        >
          <MessageSquarePlus aria-hidden="true" />
          {intl.formatMessage({ id: "workspaceFileTree.addToChat" })}
        </ContextMenuItem>
        <ContextMenuItem
          data-image-preview-copy
          disabled={!canUseImage}
          onSelect={() => void handleCopy()}
        >
          <Copy aria-hidden="true" />
          {copyLabel}
        </ContextMenuItem>
        <ContextMenuItem
          data-image-preview-download
          disabled={!canUseImage}
          onSelect={() => void handleDownload()}
        >
          <Download aria-hidden="true" />
          {intl.formatMessage({ id: "markdownImage.download" })}
        </ContextMenuItem>
      </ContextMenuContent>
      {annotationDraft ? (
        <ImageAnnotationDialog
          composerScope={annotationDraft.scope}
          input={annotationDraft.input}
          open
          onAppended={() => {
            // 附件已进入当前输入框的既有上传队列；这里只提示并关闭编辑器，不触发发送。
            toast(intl.formatMessage({ id: "imageEditor.added" }));
            setAnnotationDraft(null);
          }}
          onOpenChange={(open) => {
            if (!open) setAnnotationDraft(null);
          }}
        />
      ) : null}
    </ContextMenu>
  );
}

export function SvgPreviewContent({
  title,
  svgContent,
  fileReference,
  sourcePath,
  loadDownloadSource,
}: {
  title: string;
  svgContent: string;
  fileReference?: WorkspaceFileDragPayload;
  sourcePath?: string;
  loadDownloadSource?: () => Promise<string>;
}) {
  return (
    <ImagePreviewContent
      fitToContainer
      title={title}
      fileReference={fileReference}
      sourcePath={sourcePath}
      loadDownloadSource={loadDownloadSource}
      imageSource={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}`}
    />
  );
}
