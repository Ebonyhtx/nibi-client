import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Copy, Download, Ellipsis, ExternalLink, MessageSquarePlus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { ImageEditorComposerScope, ImageEditorOutput } from "./contract.js";
import { captureImageComposerTarget } from "./composerTarget.js";
import { copyPreviewImage, encodePreviewImagePng } from "./copyImage.js";
import {
  downloadImagePreview,
  readBoundedImageBlob,
  type ImagePreviewDownloadItem,
  type ImagePreviewSaveFile,
} from "./imagePreviewDownload.js";

export interface ImagePreviewActionAvailability {
  addToConversation: boolean;
  copy: boolean;
  draw: boolean;
  saveAndOpen: boolean;
  saveAs: boolean;
}

export interface ImagePreviewActionAvailabilityInput {
  canDraw: boolean;
  hasSource: boolean;
  nativeOpen: boolean;
  ready: boolean;
}

/**
 * 操作可用性矩阵。`ready` 表示当前图片已加载，复制/加入对话/绘制依赖真实像素；
 * 另存为只依赖预览源，加载完成前也可以保存原始字节。
 * 保存并打开只在宿主同时具备本机保存与默认应用打开能力时出现。
 */
export function getImagePreviewActionAvailability({
  canDraw,
  hasSource,
  nativeOpen,
  ready,
}: ImagePreviewActionAvailabilityInput): ImagePreviewActionAvailability {
  const usable = hasSource && ready;
  return {
    addToConversation: usable,
    copy: usable,
    draw: usable && canDraw,
    saveAndOpen: usable && nativeOpen,
    saveAs: hasSource,
  };
}

const attachmentExtensionByMediaType: Record<string, string> = {
  "image/apng": "apng",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/x-ms-bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function imageAttachmentName(item: ImagePreviewDownloadItem, mediaType: string) {
  const base =
    (item.filename || item.alt || "image")
      .trim()
      .replace(/\.[a-z0-9]+$/iu, "")
      .replace(/[<>:"/\\|?*]/gu, "-")
      .replace(/\p{Cc}/gu, "-")
      .slice(0, 80) || "image";
  const extension =
    attachmentExtensionByMediaType[mediaType.toLowerCase().split(";")[0]?.trim() ?? ""] ?? "png";
  return `${base}.${extension}`;
}

function pngAttachmentName(item: ImagePreviewDownloadItem) {
  return imageAttachmentName(item, "image/png");
}

export function ImagePreviewActions({
  item,
  imageRef,
  ready,
  canDraw,
  composerScope,
  onDraw,
  onAdded,
  children,
}: {
  item: ImagePreviewDownloadItem;
  imageRef: RefObject<HTMLImageElement | null>;
  ready: boolean;
  canDraw: boolean;
  composerScope?: ImageEditorComposerScope;
  onDraw: () => void;
  onAdded: () => void;
  /** 最右侧的关闭按钮由 Dialog 拥有，操作条只负责统一避让窗控。 */
  children?: ReactNode;
}) {
  const { intl } = useNibiIntl();
  const platform = useOptionalPlatform();
  const [busy, setBusy] = useState(false);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const nativeOpen = Boolean(
    platform?.canOpenLocalFiles && platform.saveFile && platform.openExternalFile,
  );
  const availability = getImagePreviewActionAvailability({
    canDraw,
    hasSource: Boolean(item.src),
    nativeOpen,
    ready,
  });

  const run = async (
    action: string,
    task: () => Promise<void>,
    failureId = "preview.image.actionFailed",
  ) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setBusy(true);
    try {
      await task();
    } catch (error) {
      if (aliveRef.current) {
        logger.warn("[ImagePreviewActions] 图片操作失败", {
          action,
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: failureId }));
      }
    } finally {
      pendingRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  const saveFile = platform?.saveFile as ImagePreviewSaveFile | undefined;

  const resolveLocalPath = async () => {
    if (localPath) return localPath;
    // 对话图片只有预览字节，不能猜测宿主路径。用户明确保存后才使用返回的本机副本。
    const result = await downloadImagePreview(item, saveFile);
    if (!aliveRef.current || result.kind !== "saved") return null;
    setLocalPath(result.path);
    return result.path;
  };

  const saveAs = () =>
    run(
      "saveAs",
      async () => {
        const result = await downloadImagePreview(item, saveFile);
        if (!aliveRef.current) return;
        if (result.kind === "saved") {
          setLocalPath(result.path);
          toast(intl.formatMessage({ id: "markdownImage.downloadSucceeded" }));
        } else if (result.kind === "started") {
          toast(intl.formatMessage({ id: "markdownImage.downloadStarted" }));
        }
      },
      "markdownImage.downloadFailed",
    );

  const saveAndOpen = () =>
    run("saveAndOpen", async () => {
      const path = await resolveLocalPath();
      if (!path || !platform?.openExternalFile || !aliveRef.current) return;
      const result = await platform.openExternalFile(path);
      if (!result?.success) throw new Error(result?.error || "open_failed");
    });

  const copy = () =>
    run(
      "copy",
      async () => {
        const image = imageRef.current;
        if (!image) throw new Error("preview image is unavailable");
        await copyPreviewImage(image);
        if (aliveRef.current) toast(intl.formatMessage({ id: "preview.image.copied" }));
      },
      "preview.image.copyFailed",
    );

  const addToConversation = () =>
    run(
      "add",
      async () => {
        const image = imageRef.current;
        if (!image || !item.src) throw new Error("preview image is unavailable");
        // 异步读图前锁定接收方，切换会话或关闭弹层后不把附件加到另一段对话。
        const target = captureImageComposerTarget(
          composerScope ? { scope: composerScope } : undefined,
        );
        if (!target) {
          toast(intl.formatMessage({ id: "imageEditor.noComposer" }));
          return;
        }
        // 优先投递原始字节，保留 JPEG/WebP 等原格式；旧接收方没有 appendFile 时回退成 PNG。
        if (target.appendFile) {
          const blob = await readBoundedImageBlob(item.src);
          const mediaType = blob.type || item.mediaType || "image/png";
          const file = new File([blob], imageAttachmentName(item, mediaType), {
            type: mediaType,
          });
          if (!target.appendFile(file)) throw new Error("composer_rejected");
        } else {
          const blob = await encodePreviewImagePng(image);
          const output: ImageEditorOutput = {
            bytes: new Uint8Array(await blob.arrayBuffer()),
            mediaType: "image/png",
            filename: pngAttachmentName(item),
            width: image.naturalWidth,
            height: image.naturalHeight,
            changed: false,
          };
          if (!target.appendImage(output)) throw new Error("composer_rejected");
        }
        if (!aliveRef.current) return;
        toast(intl.formatMessage({ id: "preview.image.added" }));
        onAdded();
      },
      "preview.image.addFailed",
    );

  const labels = {
    add: intl.formatMessage({ id: "workspaceFileTree.addToChat" }),
    copy: intl.formatMessage({ id: "preview.image.copy" }),
    draw: intl.formatMessage({ id: "preview.image.annotate" }),
    more: intl.formatMessage({ id: "preview.image.more" }),
    saveAndOpen: intl.formatMessage({ id: "preview.image.saveAndOpen" }),
    saveAs: intl.formatMessage({ id: "preview.image.saveAs" }),
  };
  const disabled = busy;
  const menuItem = (
    id: string,
    label: string,
    Icon: typeof Copy,
    onSelect: () => void,
    itemDisabled: boolean,
  ) => (
    <DropdownMenuItem
      data-image-preview-action={id}
      disabled={disabled || itemDisabled}
      key={id}
      onSelect={onSelect}
    >
      <Icon aria-hidden="true" />
      {label}
    </DropdownMenuItem>
  );

  return (
    // 顶部操作条与右上角窗控共享同一避让规则：Windows 原生 titleBarOverlay 占用的高度之下再起一行，
    // 右侧留白同步扩大，避免与最小化/最大化/关闭按钮重叠。spec：docs/ui/image-preview-actions.md
    <div
      data-image-preview-actions=""
      className="pointer-events-auto absolute right-4 top-4 z-20 flex max-w-[calc(100%-2rem)] items-center gap-2 [app-region:no-drag] platform-mac-desktop:top-12 platform-linux-desktop:right-6 platform-windows-desktop:right-6 platform-windows-desktop:top-[calc(env(titlebar-area-height,48px)_+_0.5rem)]"
    >
      {availability.saveAndOpen ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={labels.saveAndOpen}
          title={labels.saveAndOpen}
          data-image-preview-action="saveAndOpen"
          disabled={disabled}
          className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
          onClick={() => void saveAndOpen()}
        >
          <ExternalLink />
          <span className="hidden sm:inline">{labels.saveAndOpen}</span>
        </Button>
      ) : null}
      {availability.saveAs ? (
        <Button
          type="button"
          aria-label={labels.saveAs}
          title={labels.saveAs}
          className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
          data-image-preview-action="saveAs"
          disabled={disabled}
          onClick={() => void saveAs()}
          size="icon-md"
          variant="ghost"
        >
          <Download />
        </Button>
      ) : null}
      {availability.copy ? (
        <Button
          type="button"
          aria-label={labels.copy}
          title={labels.copy}
          className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
          data-image-preview-action="copy"
          disabled={disabled}
          onClick={() => void copy()}
          size="icon-md"
          variant="ghost"
        >
          <Copy />
        </Button>
      ) : null}
      {availability.addToConversation ? (
        <Button
          type="button"
          aria-label={labels.add}
          title={labels.add}
          className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
          data-image-preview-action="add"
          disabled={disabled}
          onClick={() => void addToConversation()}
          size="icon-md"
          variant="ghost"
        >
          <MessageSquarePlus />
        </Button>
      ) : null}
      {availability.draw ? (
        <Button
          type="button"
          aria-label={labels.draw}
          title={labels.draw}
          className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
          data-image-preview-action="draw"
          disabled={disabled}
          onClick={onDraw}
          size="icon-md"
          variant="ghost"
        >
          <Pencil />
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            aria-label={labels.more}
            title={labels.more}
            className="rounded-full border border-border bg-background text-foreground shadow-md hover:bg-background/80"
            data-image-preview-action="more"
            size="icon-md"
            variant="ghost"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {menuItem(
            "saveAndOpen",
            labels.saveAndOpen,
            ExternalLink,
            () => void saveAndOpen(),
            !availability.saveAndOpen,
          )}
          {menuItem(
            "saveAs",
            labels.saveAs,
            Download,
            () => void saveAs(),
            !availability.saveAs,
          )}
          {menuItem("copy", labels.copy, Copy, () => void copy(), !availability.copy)}
          {menuItem(
            "add",
            labels.add,
            MessageSquarePlus,
            () => void addToConversation(),
            !availability.addToConversation,
          )}
          {menuItem("draw", labels.draw, Pencil, onDraw, !availability.draw)}
        </DropdownMenuContent>
      </DropdownMenu>
      {children}
    </div>
  );
}