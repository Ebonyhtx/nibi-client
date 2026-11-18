import type { EditorInfo, OpenInEditorRemoteTarget } from "@nibi/shared";
import type { IDisposable } from "@nibi/rpc";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { WorkspaceFileGitStatus, WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";

export interface WorkspaceFileTreeProps {
  workspacePath: string;
  workspaceName?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
  canOpenLocalFileManager?: boolean;
  /** 设置开关：单击本地 HTML 时用内置浏览器打开；缺省保持源码预览。 */
  htmlClickOpensBrowser?: boolean;
  activePreviewPath?: string | null;
  onClose?: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenPreview?: (source: CodeViewerSource) => void;
}

export interface WorkspaceFileTreeWatcherRegistration {
  id: string;
  subscription: IDisposable;
  unwatch: () => Promise<void>;
}

export interface WorkspaceFileTreeStickyFolderItem {
  row: WorkspaceFileTreeRow;
  index: number;
}

export interface WorkspaceFileTreeContextMenuLabels {
  addToChat: string;
  copyAbsolutePath: string;
  copyRelativePath: string;
  open: string;
  openInBrowser: string;
  openFailed: string;
  openWith: string;
  reveal: string;
}

export interface WorkspaceFileTreeEditorState {
  canOpenLocalFileManager: boolean;
  installedEditors: EditorInfo[];
  isRemoteWorkspaceFileTree: boolean;
  remoteTarget?: OpenInEditorRemoteTarget;
}

export type WorkspaceFileGitStatusLabels = Record<WorkspaceFileGitStatus, string>;
