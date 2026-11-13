export { prepareTasksIndexStorage } from "#src/project-storage/startup.js";
export { markTasksStoragePrepared } from "#src/session/tasksDatabase/prepared.js";
export { getTasksIndexDatabasePath } from "#src/paths.js";
export { resolveDefaultNibiAgentCommand } from "#src/nibi-agent/nibiAgentProcessManager.js";
export { resolveNibiAgentSpawnCwd } from "#src/nibi-agent/nibiAgentSpawnCwd.js";

export { createSettingService } from "#src/setting/settingService.js";
// 启动 Worker 需要解析 CLI 会话库路径；null 表示路径无法确定（相对路径/project 覆盖），
// 此时启动自愈只能使用 CLI 对账的 orphan 证据，不能按磁盘缺席删除。
export { resolveAgentSessionDbPath } from "#src/onboarding/localUsageEvidence.js";
