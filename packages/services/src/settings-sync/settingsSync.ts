import type {
  SettingsSyncDiscoveryResult,
  SettingsSyncClaudeAgentsFileCopyResult,
  SettingsSyncClaudeAgentsFileMigrationStatus,
  SettingsSyncFirstRunPromptState,
  SettingsSyncImportResult,
  SettingsSyncProgressEvent,
  SettingsSyncSelection,
} from "@nibi/shared";
import { ServiceChannels } from "@nibi/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 用户级 AGENTS.md 的编辑上限。个性化页只负责展示，服务端仍要硬校验：
 * 渲染层可以绕过按钮直接调用服务，超限写入会把用户主目录文件撑到难以编辑的尺寸。
 */
export const SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES = 100 * 1024;

export interface SettingsSyncUserAgentsFile {
  /** 固定用户级路径（~/.nibi/AGENTS.md），供页面展示来源。 */
  path: string;
  content: string;
  exists: boolean;
}

export interface SettingsSyncUserAgentsFileWriteResult {
  path: string;
  /** 实际写入的 UTF-8 字节数，供页面确认上限。 */
  bytes: number;
}

export interface ISettingsSyncService {
  getClaudeAgentsFileMigrationStatus(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<SettingsSyncClaudeAgentsFileMigrationStatus>;
  copyClaudeAgentsFileToZcodeAgentsFile(request?: {
    workspacePath?: string;
    workspaceIdentity?: string;
    overwrite?: boolean;
  }): Promise<SettingsSyncClaudeAgentsFileCopyResult>;
  detect(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    categories?: SettingsSyncSelection["category"][];
    intent?: "firstRun" | "manualImport";
  }): Promise<SettingsSyncDiscoveryResult>;
  importSelected(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    selections: SettingsSyncSelection[];
    onProgress?: (event: SettingsSyncProgressEvent) => void;
  }): Promise<SettingsSyncImportResult>;
  getFirstRunPromptState(): Promise<SettingsSyncFirstRunPromptState>;
  markFirstRunPromptHandled(): Promise<void>;
  /** 读取用户级 AGENTS.md（~/.nibi/AGENTS.md）；文件不存在时返回空内容而不是报错。 */
  readUserAgentsFile(): Promise<SettingsSyncUserAgentsFile>;
  /** 原子写用户级 AGENTS.md；UTF-8，超过 100 KB 时拒绝。 */
  writeUserAgentsFile(request: { content: string }): Promise<SettingsSyncUserAgentsFileWriteResult>;
}

export const ISettingsSyncService = createServiceDescriptor<ISettingsSyncService>(
  ServiceChannels.SettingsSync,
);
