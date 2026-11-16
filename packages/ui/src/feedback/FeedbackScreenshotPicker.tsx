import { useCallback, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import type { FeedbackSubmissionAttachmentDraft } from "@/feedback/feedbackSubmissionJob.js";
import { ImageIcon, TriangleAlertIcon, XIcon } from "lucide-react";

export interface ScreenshotAttachmentDraft extends FeedbackSubmissionAttachmentDraft {
  id: string;
}

export function FeedbackScreenshotPicker({
  screenshots,
  screenshotHint,
  screenshotPrivacyHint,
  addScreenshotLabel,
  removeScreenshotLabel,
  onChange,
  onAddFiles,
}: {
  screenshots: ScreenshotAttachmentDraft[];
  screenshotHint: string;
  screenshotPrivacyHint: string;
  addScreenshotLabel: string;
  removeScreenshotLabel: string;
  onChange: (screenshots: ScreenshotAttachmentDraft[]) => void;
  onAddFiles: (files: File[]) => void;
}) {
  const screenshotInputRef = useRef<HTMLInputElement | null>(null);
  const [previewScreenshot, setPreviewScreenshot] = useState<ScreenshotAttachmentDraft | null>(
    null,
  );
  const [dragActive, setDragActive] = useState(false);

  const handleScreenshotDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      setDragActive(false);
      const files = Array.from(event.dataTransfer.files).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (files.length === 0) return;
      onAddFiles(files);
    },
    [onAddFiles],
  );

  const removeScreenshot = useCallback(
    (id: string) => {
      onChange(screenshots.filter((item) => item.id !== id));
    },
    [onChange, screenshots],
  );

  return (
    <>
      <div
        tabIndex={0}
        onDragEnter={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setDragActive(false);
          }
        }}
        onDrop={handleScreenshotDrop}
        className={cn(
          "flex flex-col gap-3 rounded-xl border border-dashed border-border bg-surface p-3 outline-none transition-colors hover:border-border-hover focus-visible:ring-2 focus-visible:ring-primary/30",
          dragActive ? "border-border-hover bg-surface-hover" : "",
        )}
      >
        {screenshots.length > 0 ? (
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-6">
            {screenshots.map((item) => (
              <ScreenshotThumb
                key={item.id}
                item={item}
                removeLabel={removeScreenshotLabel}
                onPreview={() => setPreviewScreenshot(item)}
                onRemove={() => removeScreenshot(item.id)}
              />
            ))}
          </ul>
        ) : null}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-0.5 text-ui-sm leading-5">
            <div className="flex items-center gap-2 text-foreground-subtle">
              <ImageIcon className="size-3.5 shrink-0" />
              <span className="min-w-0">{screenshotHint}</span>
            </div>
            <div className="flex items-center gap-2 text-feedback-privacy-hint">
              <TriangleAlertIcon className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{screenshotPrivacyHint}</span>
            </div>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => screenshotInputRef.current?.click()}
            className="h-7 shrink-0 rounded-lg"
          >
            {addScreenshotLabel}
          </Button>
          <input
            ref={screenshotInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              onAddFiles(files);
            }}
          />
        </div>
      </div>

      <Dialog
        open={Boolean(previewScreenshot)}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewScreenshot(null);
          }
        }}
      >
        <DialogContent className="rounded-xl max-w-4xl">
          <DialogHeader>
            <DialogTitle className="truncate text-ui-base">
              {previewScreenshot?.filename}
            </DialogTitle>
          </DialogHeader>
          {previewScreenshot ? (
            <div className="max-h-[72vh] overflow-auto rounded-lg border border-border bg-background p-2">
              <img
                src={getScreenshotDataUrl(previewScreenshot)}
                alt={previewScreenshot.filename}
                className="mx-auto max-h-[68vh] max-w-full rounded-md object-contain"
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScreenshotThumb({
  item,
  removeLabel,
  onPreview,
  onRemove,
}: {
  item: ScreenshotAttachmentDraft;
  removeLabel: string;
  onPreview: () => void;
  onRemove: () => void;
}) {
  return (
    <li className="group relative min-w-0 overflow-hidden rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={onPreview}
        className="block aspect-square w-full text-left outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary/50"
        title={item.filename}
      >
        <img
          src={getScreenshotDataUrl(item)}
          alt={item.filename}
          className="size-full object-cover"
        />
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full border border-border bg-popover text-foreground-subtle opacity-90 shadow-sm transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/50 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
        aria-label={removeLabel}
        title={removeLabel}
      >
        <XIcon className="size-3" />
      </button>
    </li>
  );
}

export const MAX_SCREENSHOT_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_SCREENSHOT_OUTPUT_BYTES = 5 * 1024 * 1024;
export const SCREENSHOT_SOURCE_TOO_LARGE = "SCREENSHOT_SOURCE_TOO_LARGE";
export const SCREENSHOT_OUTPUT_TOO_LARGE = "SCREENSHOT_OUTPUT_TOO_LARGE";
const MAX_SCREENSHOT_DIMENSION = 2048;

function readFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("截图读取失败"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

function dataUrlPayload(dataUrl: string): { base64: string; bytes: number } {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return { base64: "", bytes: 0 };
  const base64 = dataUrl.slice(commaIndex + 1);
  return { base64, bytes: Math.floor((base64.length * 3) / 4) };
}

function jpegFileName(name: string): string {
  const base = (name || `screenshot-${Date.now()}`).replace(/\.[^.]+$/, "");
  return `${base || "screenshot"}.jpg`;
}

/**
 * 截图入草稿前先在本地压缩：最长边 2048，JPEG 质量 0.9→0.5，仍超 5MiB 就继续缩小。
 * 原图 >20MiB 直接拒绝（避免解码大图把渲染进程内存打爆）；不把原图发给服务端。
 */
export async function readScreenshotDraft(file: File): Promise<ScreenshotAttachmentDraft> {
  if (file.size > MAX_SCREENSHOT_SOURCE_BYTES) throw new Error(SCREENSHOT_SOURCE_TOO_LARGE);

  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    const dataUrl = await readFileDataUrl(file);
    const { base64, bytes } = dataUrlPayload(dataUrl);
    if (!base64 || bytes > MAX_SCREENSHOT_OUTPUT_BYTES) throw new Error(SCREENSHOT_OUTPUT_TOO_LARGE);
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      filename: file.name || `screenshot-${Date.now()}.png`,
      contentType: file.type || "image/png",
      dataBase64: base64,
      size: bytes,
    };
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    const dataUrl = await readFileDataUrl(file);
    const { base64, bytes } = dataUrlPayload(dataUrl);
    if (!base64 || bytes > MAX_SCREENSHOT_OUTPUT_BYTES) throw new Error(SCREENSHOT_OUTPUT_TOO_LARGE);
    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      filename: file.name || `screenshot-${Date.now()}.png`,
      contentType: file.type || "image/png",
      dataBase64: base64,
      size: bytes,
    };
  }

  try {
    const scale = Math.min(1, MAX_SCREENSHOT_DIMENSION / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));
    for (let attempt = 0; attempt < 5; attempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) break;
      context.drawImage(bitmap, 0, 0, width, height);
      for (const quality of [0.9, 0.8, 0.7, 0.6, 0.5]) {
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        const { base64, bytes } = dataUrlPayload(dataUrl);
        if (!base64) continue;
        if (bytes <= MAX_SCREENSHOT_OUTPUT_BYTES) {
          return {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            filename: jpegFileName(file.name),
            contentType: "image/jpeg",
            dataBase64: base64,
            size: bytes,
          };
        }
      }
      width = Math.max(1, Math.round(width * 0.8));
      height = Math.max(1, Math.round(height * 0.8));
    }
  } finally {
    bitmap.close();
  }
  throw new Error(SCREENSHOT_OUTPUT_TOO_LARGE);
}

function getScreenshotDataUrl(item: ScreenshotAttachmentDraft) {
  return `data:${item.contentType};base64,${item.dataBase64}`;
}
