import { useCallback } from "react";
import type { IPlatformService } from "@nibi/shared";
import { CopyIcon, EllipsisIcon, ExternalLinkIcon, FolderOpenIcon, SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { useFileContextActions } from "@/hooks/useFileContextActions.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export interface AttachmentFileActionsMenuProps {
  /** 另存为对话框的默认文件名。 */
  fileName: string;
  /**
   * 附件在本机可直达的绝对路径。
   * 上传后的内容引用（nibi-artifact://）与远端工作区路径都不是本机路径，调用方必须缺席。
   */
  localPath?: string;
  /**
   * 附件既有读取路径（composer 的 File、消息行的 attachmentRead）。
   * 返回 null 表示这一项没有可保存的字节；缺席则整项「另存为」不渲染。
   */
  readBytes?: () => Promise<Uint8Array | null>;
  /**
   * 路径类动作是否允许。远端工作区里的绝对路径属于远端主机，
   * 交给本机文件管理器只会打开同名的本地路径（或直接失败），因此调用方要显式关闭。
   */
  localPathActionsEnabled?: boolean;
}

type FileAction = "open" | "save";

/**
 * 聊天附件卡片的文件操作菜单。
 *
 * 与工作流产物卡片复用同一套平台能力：打开走 `openExternalFile`，定位走
 * `openInFileManager`（文件取所在目录，语义与 useFileContextActions 一致），
 * 另存为走 `saveFile`，复制路径走剪贴板。附件模型拿不到本机路径时（上传后的
 * 内容引用、远端工作区路径）只保留「另存为」，不伪造路径类动作；Web/手机远控
 * 没有 `canOpenLocalFiles` 时整块菜单缺席，避免展示不可用的入口。
 */
export function AttachmentFileActionsMenu(props: AttachmentFileActionsMenuProps) {
  const platform = useOptionalPlatform();
  if (!platform) return null;
  return <AttachmentFileActionsMenuInner {...props} platform={platform} />;
}

function AttachmentFileActionsMenuInner({
  fileName,
  localPath,
  readBytes,
  localPathActionsEnabled = true,
  platform,
}: AttachmentFileActionsMenuProps & { platform: IPlatformService }) {
  const { intl } = useZCodeIntl();
  const { canRevealInFileManager, copyAbsolutePath, revealInFileManager } = useFileContextActions({
    canOpenLocalFileManager: platform.canOpenLocalFiles === true,
  });
  const canUseLocalPath =
    platform.canOpenLocalFiles === true &&
    localPathActionsEnabled &&
    localPath !== undefined &&
    localPath.length > 0;
  const canOpen = canUseLocalPath && platform.openExternalFile !== undefined;
  const canReveal =
    canUseLocalPath && canRevealInFileManager({ path: localPath, kind: "file" });
  const canCopyPath = canUseLocalPath;
  const canSaveAs = platform.saveFile !== undefined && readBytes !== undefined;

  const reportFailure = useCallback(
    (action: FileAction, error: unknown) => {
      logger.warn("[chat-attachments] 附件文件操作失败", {
        action,
        error: error instanceof Error ? error.message : String(error),
        fileName,
        localPath,
      });
      toast(
        intl.formatMessage({
          id:
            action === "open"
              ? "chat.attachments.actions.openFailed"
              : "chat.attachments.actions.saveFailed",
        }),
      );
    },
    [fileName, intl, localPath],
  );

  const handleOpen = useCallback(() => {
    if (!localPath || !platform.openExternalFile) return;
    void platform
      .openExternalFile(localPath)
      .then((result) => {
        if (!result.success) reportFailure("open", result.error ?? "unknown-error");
      })
      .catch((error: unknown) => reportFailure("open", error));
  }, [localPath, platform, reportFailure]);

  const handleReveal = useCallback(() => {
    if (!localPath) return;
    void revealInFileManager({ path: localPath, kind: "file" });
  }, [localPath, revealInFileManager]);

  const handleCopyPath = useCallback(() => {
    if (!localPath) return;
    void copyAbsolutePath({ path: localPath });
  }, [copyAbsolutePath, localPath]);

  const handleSaveAs = useCallback(() => {
    const saveFile = platform.saveFile;
    if (!saveFile || !readBytes) return;
    void readBytes()
      .then((bytes) => {
        if (!bytes) {
          reportFailure("save", "attachment-bytes-unavailable");
          return undefined;
        }
        // 只把附件既有读取路径拿到的字节交给原生保存对话框，不在 renderer 里另写文件。
        return saveFile({ data: bytes.slice().buffer, suggestedName: fileName }).then((result) => {
          if (!result.success && !result.canceled) {
            reportFailure("save", result.error ?? "save_failed");
          }
        });
      })
      .catch((error: unknown) => reportFailure("save", error));
  }, [fileName, platform, readBytes, reportFailure]);

  // 没有可用动作时整块菜单缺席，卡片上不出现空触发器。
  if (!canOpen && !canReveal && !canCopyPath && !canSaveAs) {
    return null;
  }

  const menuLabel = intl.formatMessage({ id: "chat.attachments.actions.menu" });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={menuLabel}
          className="shrink-0 text-foreground-subtle hover:text-foreground"
          data-testid="chat-attachment-file-actions-trigger"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          size="icon-xs"
          title={menuLabel}
          type="button"
          variant="ghost"
        >
          <EllipsisIcon aria-hidden="true" className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {canOpen ? (
          <DropdownMenuItem data-testid="chat-attachment-file-actions-open" onSelect={handleOpen}>
            <ExternalLinkIcon aria-hidden="true" className="size-4" />
            {intl.formatMessage({ id: "chat.attachments.actions.open" })}
          </DropdownMenuItem>
        ) : null}
        {canReveal ? (
          <DropdownMenuItem data-testid="chat-attachment-file-actions-reveal" onSelect={handleReveal}>
            <FolderOpenIcon aria-hidden="true" className="size-4" />
            {intl.formatMessage({ id: "chat.attachments.actions.reveal" })}
          </DropdownMenuItem>
        ) : null}
        {canSaveAs ? (
          <DropdownMenuItem data-testid="chat-attachment-file-actions-save-as" onSelect={handleSaveAs}>
            <SaveIcon aria-hidden="true" className="size-4" />
            {intl.formatMessage({ id: "chat.attachments.actions.saveAs" })}
          </DropdownMenuItem>
        ) : null}
        {canCopyPath ? (
          <DropdownMenuItem data-testid="chat-attachment-file-actions-copy-path" onSelect={handleCopyPath}>
            <CopyIcon aria-hidden="true" className="size-4" />
            {intl.formatMessage({ id: "chat.attachments.actions.copyPath" })}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
