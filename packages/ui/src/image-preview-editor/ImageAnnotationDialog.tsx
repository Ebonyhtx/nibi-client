import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import type { ImageAnnotationDialogProps } from "./contract.js";
import { ImageEditorSurface } from "./ImageEditorSurface.js";

/**
 * 全屏标注对话框。预览面板只负责提供原始字节与尺寸；
 * 对话框不感知会话、不上传、不发送，只把最终输出交回 `onAppended`。
 */
export function ImageAnnotationDialog({
  open,
  input,
  composerScope,
  onOpenChange,
  onAppended,
}: ImageAnnotationDialogProps) {
  const { intl } = useNibiIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="pointer-events-auto h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-none place-items-center gap-0 overflow-hidden border-0 bg-transparent p-0 shadow-none [app-region:no-drag] sm:h-[calc(100dvh-2rem)] sm:w-[calc(100vw-2rem)] platform-linux-desktop:h-[calc(100dvh-4rem)]"
        data-image-editor-dialog=""
      >
        <DialogTitle className="sr-only">
          {intl.formatMessage({ id: "imageEditor.title" })}
        </DialogTitle>
        <ImageEditorSurface
          composerScope={composerScope}
          input={input}
          onAppended={(output) => onAppended?.(output)}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
