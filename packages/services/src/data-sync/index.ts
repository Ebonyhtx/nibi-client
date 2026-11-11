// 浏览器安全的公共入口：只导出契约与门禁。Renderer 经 @nibi/services 引到这里，不能带入 node:fs 等实现。
export type { IDataSyncCategoryService, ISkillDataSyncMethods } from "./contract.js";
export {
  DATA_SYNC_REMOTE_AGENT_CAPABILITY_UNVERIFIED_ERROR_CODE,
  DATA_SYNC_REMOTE_AGENT_OUTDATED_ERROR_CODE,
  DataSyncRemoteAgentCapabilityUnverifiedError,
  DataSyncRemoteAgentOutdatedError,
  createDataSyncCapabilityGatedService,
  isDataSyncMethodMissingError,
  isDataSyncRemoteAgentCapabilityError,
  isDataSyncRemoteAgentOutdatedError,
} from "./capabilityGate.js";
