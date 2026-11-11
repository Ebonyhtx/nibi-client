import type {
  CommandDataSyncPayload,
  CommandsListResult,
  CommandCreateParams,
  CommandUpdateParams,
  CommandDeleteParams,
  CommandSetEnabledParams,
  CommandAgentSource,
  UserCommand,
} from "@nibi/shared";
import { ServiceChannels } from "@nibi/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { IDataSyncCategoryService } from "../data-sync/contract.js";

export interface ICommandsService extends IDataSyncCategoryService<CommandDataSyncPayload> {
  list(params: {
    agentSource?: CommandAgentSource;
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<CommandsListResult>;
  writeCommandFile(params: CommandCreateParams): Promise<{ command: UserCommand }>;
  updateCommandFile(params: CommandUpdateParams): Promise<{ command: UserCommand }>;
  deleteCommandFile(params: CommandDeleteParams): Promise<void>;
  setCommandEnabled(params: CommandSetEnabledParams): Promise<void>;
  getPrimaryUserCommandsDirectory(params?: {
    agentSource?: CommandAgentSource;
  }): Promise<{ path: string }>;
}

export const ICommandsService = createServiceDescriptor<ICommandsService>(ServiceChannels.Commands);
