import type { ReactNode } from "react";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import { cn } from "@/components/lib/utils.js";
import { useImageFilePreview, type ImageFilePreviewContext } from "@/hooks/useImageFilePreview.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";

function InteractiveImageFileMention({
  className,
  children,
  label,
  preview,
}: {
  className: string;
  children: ReactNode;
  label: string;
  preview: ReturnType<typeof useImageFilePreview>;
}) {
  const { intl } = useNibiIntl();
  return (
    <>
      <button
        type="button"
        data-image-file-mention=""
        aria-haspopup="dialog"
        aria-label={`${intl.formatMessage({ id: "chat.attachments.preview.open" })}: ${label}`}
        className={cn(
          className,
          "cursor-pointer rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        onClick={() => void preview.open()}
      >
        {children}
      </button>
      <ImagePreviewDialog
        initialIndex={0}
        open={preview.state !== null}
        onOpenChange={(open) => {
          if (!open) preview.close();
        }}
        items={[
          {
            alt: label,
            filename: label,
            src: preview.state?.src,
            loading: preview.state?.loading,
            error: preview.state?.error,
          },
        ]}
      />
    </>
  );
}

export function ConversationImageFileMention({
  href,
  label,
  context,
  className,
  children,
}: {
  href: string;
  label: string;
  context?: ImageFilePreviewContext;
  className: string;
  children: ReactNode;
}) {
  const preview = useImageFilePreview(href, context);
  if (!preview.available) return <span className={className}>{children}</span>;
  return (
    <InteractiveImageFileMention className={className} label={label} preview={preview}>
      {children}
    </InteractiveImageFileMention>
  );
}
