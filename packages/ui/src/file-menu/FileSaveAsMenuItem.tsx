import { useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { ContextMenuItem } from "@/components/ui/context-menu.js";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { fileSaveSuccessMessageId, saveFileCopy } from "@/file-menu/fileCopy.js";
import { logger } from "@/logger.js";

interface Props {
  path: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  variant?: "context" | "dropdown";
  disabled?: boolean;
}

/**
 * 另存为副本：从所属 workspace 的 file service 读原始字节，再交给原生保存对话框。
 *
 * 平台没有 `saveFile`（Web）或页面不在 workspace ServiceProvider 内时整项不渲染，
 * 避免出现永远不可用的入口；读取失败与超限沿用现有文件动作的 toast 文案。
 */
export function FileSaveAsMenuItem(props: Props) {
  const services = useOptionalServices();
  const platform = usePlatform();
  if (!services || !platform.saveFile) {
    return null;
  }
  return <WorkspaceFileSaveAsMenuItem {...props} />;
}

function WorkspaceFileSaveAsMenuItem(props: Props) {
  const platform = usePlatform();
  const { intl } = useNibiIntl();
  const { fileService } = useWorkspaceServices(
    props.workspacePath,
    props.workspaceRemoteSessionId,
    props.workspaceIdentity,
  );
  const pending = useRef(false);
  const [saving, setSaving] = useState(false);
  const Item = props.variant === "context" ? ContextMenuItem : DropdownMenuItem;
  const save = async () => {
    if (pending.current || !platform.saveFile) return;
    pending.current = true;
    setSaving(true);
    try {
      const result = await saveFileCopy(fileService, props.path, platform.saveFile.bind(platform));
      const messageId = fileSaveSuccessMessageId(result, platform.canOpenLocalFiles);
      if (messageId) toast(intl.formatMessage({ id: messageId }));
    } catch (error) {
      logger.warn("[FileSaveAs] 保存文件副本失败", { path: props.path, error: String(error) });
      const code = error instanceof Error ? error.message : "";
      toast(
        intl.formatMessage({
          id:
            code === "file_too_large"
              ? "fileActions.saveAsTooLarge"
              : code === "file_size_unavailable"
                ? "fileActions.saveAsUnavailable"
                : "fileActions.saveAsFailed",
        }),
      );
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return (
    <Item disabled={props.disabled || saving} onSelect={() => void save()}>
      <DownloadIcon className="size-4" />
      {intl.formatMessage({ id: "fileActions.saveAs" })}
    </Item>
  );
}
