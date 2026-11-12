import { parentPort, workerData } from "node:worker_threads";
import { tasksStorageWorkerDataSchema } from "./contract.js";
import {
  prepareTasksIndexStorage,
  createSettingService,
  resolveAgentSessionDbPath,
} from "@nibi/services/storage-startup";
import {
  classifyDatabaseStartupError,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
} from "@nibi/shared";

const data = tasksStorageWorkerDataSchema.parse(workerData);
try {
  // Worker 必须携带旧设置完成项目迁移，否则后续 Host 只能看到已记账的空项目种子。
  const settings = await createSettingService().get();
  // CLI 会话库是启动自愈判断“磁盘上是否真的没有该会话”的唯一证据源。解析失败
  // （配置不可读等）不能阻断启动，降级为只用 CLI orphan 证据。
  const agentSessionDbPath = await resolveAgentSessionDbPath().catch(() => null);
  await prepareTasksIndexStorage(
    data.path,
    (phase, migration) => parentPort?.postMessage({ type: "progress", phase, migration }),
    settings,
    { agentSessionDbPath },
  );
  parentPort?.postMessage({ type: "done" });
} catch (error) {
  const migration = databaseMigrationFactsSchema.safeParse(
    error && typeof error === "object"
      ? (error as { startupMigration?: unknown }).startupMigration
      : undefined,
  );
  parentPort?.postMessage({
    type: "failed",
    migration: migration.success ? migration.data : undefined,
    errorCode: classifyDatabaseStartupError(error),
    ...databaseStartupErrorDetails(error),
  });
} finally {
  parentPort?.close();
}
