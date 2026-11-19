// 项目数据彻底删除（上游 `packages/shared/src/nibi-protocol-v4/session-data/contract.ts`）。
// CLI 不感知项目：Host 传会话 ID 与目录，CLI 只处理自己写的数据库行与 cli/* 文件。
// 大小只统计磁盘上真实删除的文件；数据库行删除后文件不收缩，不计入。
import { z } from "zod";

const directorySchema = z
  .object({ workspacePath: z.string().min(1), workspaceIdentity: z.string().min(1).optional() })
  .strict();
const bytesSchema = z.number().int().nonnegative();

export const v4SessionDataParamsSchema = z
  .object({ sessionIds: z.array(z.string().min(1)), directories: z.array(directorySchema) })
  .strict();
export type V4SessionDataParams = z.infer<typeof v4SessionDataParamsSchema>;

const sessionBytesSchema = z.object({ sessionId: z.string().min(1), bytes: bytesSchema }).strict();
const memoryBytesSchema = z
  .object({ workspacePath: z.string().min(1), bytes: bytesSchema })
  .strict();

/** 会话大小含其附属后代会话（subagent / workflow / 侧边问答）的文件。 */
export const v4SessionDataMeasureResultSchema = z
  .object({ sessions: z.array(sessionBytesSchema), memory: z.array(memoryBytesSchema) })
  .strict();
export type V4SessionDataMeasureResult = z.infer<typeof v4SessionDataMeasureResultSchema>;

/**
 * 运行中的会话保留（running）；附件仍被本次不删除的会话引用的会话保留（referenced）；
 * 文件删除失败的会话不删行，记入 failed，重试仍可找到。
 */
export const v4SessionDataPurgeResultSchema = z
  .object({
    deleted: z.array(sessionBytesSchema),
    kept: z.array(
      z
        .object({ sessionId: z.string().min(1), reason: z.enum(["running", "referenced"]) })
        .strict(),
    ),
    failed: z.array(
      z
        .object({
          sessionId: z.string().min(1).optional(),
          workspacePath: z.string().min(1).optional(),
          code: z.string().min(1),
        })
        .strict(),
    ),
    memory: z.array(memoryBytesSchema),
  })
  .strict();
export type V4SessionDataPurgeResult = z.infer<typeof v4SessionDataPurgeResultSchema>;

// ── 归档会话的永久删除（v4/storage/sessionData/deletionPreview|deletionExecute）──
// 与上面的项目数据清理是两条路径：这里按删除凭据（session_purge，迁移 0026）
// 先预检再开删、删文件、删行。参数严格（未知键拒绝），revision 是预检给出的版本事实。

export const v4SessionDeletionWorkspaceSchema = z
  .object({
    workspacePath: z.string().min(1),
    workspaceIdentity: z.string().min(1).optional(),
  })
  .strict();
export type V4SessionDeletionWorkspace = z.infer<typeof v4SessionDeletionWorkspaceSchema>;

export const v4SessionDeletionPreviewParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    workspace: v4SessionDeletionWorkspaceSchema,
  })
  .strict();
export type V4SessionDeletionPreviewParams = z.infer<typeof v4SessionDeletionPreviewParamsSchema>;

export const v4SessionDeletionExecuteParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    workspace: v4SessionDeletionWorkspaceSchema,
    revision: z.string().min(1),
    operationId: z.string().min(1),
  })
  .strict();
export type V4SessionDeletionExecuteParams = z.infer<typeof v4SessionDeletionExecuteParamsSchema>;

export const v4SessionDeletionTitledSchema = z
  .object({ sessionId: z.string().min(1), title: z.string() })
  .strict();
export type V4SessionDeletionTitled = z.infer<typeof v4SessionDeletionTitledSchema>;

export const v4SessionDeletionRetainedArtifactSchema = z
  .object({
    sessionId: z.string().min(1),
    artifactId: z.string().min(1),
    fileName: z.string().min(1),
    referrers: z.array(v4SessionDeletionTitledSchema),
  })
  .strict();
export type V4SessionDeletionRetainedArtifact = z.infer<
  typeof v4SessionDeletionRetainedArtifactSchema
>;

export const v4SessionDeletionBlockReasonSchema = z.enum([
  "running",
  "changed",
  "unavailable",
  "not_found",
]);
export type V4SessionDeletionBlockReason = z.infer<typeof v4SessionDeletionBlockReasonSchema>;

export const v4SessionDeletionPreviewResultSchema = z
  .object({
    sessionId: z.string().min(1),
    revision: z.string().min(1),
    sessionIds: z.array(z.string().min(1)),
    forks: z.array(v4SessionDeletionTitledSchema),
    retainedArtifacts: z.array(v4SessionDeletionRetainedArtifactSchema),
    deletedFiles: z.number().int().nonnegative(),
    blockedReason: v4SessionDeletionBlockReasonSchema.optional(),
    incomplete: z.boolean(),
    completed: z.boolean(),
  })
  .strict();
export type V4SessionDeletionPreviewResult = z.infer<typeof v4SessionDeletionPreviewResultSchema>;

export const v4SessionDeletionExecuteResultSchema = z
  .object({
    sessionId: z.string().min(1),
    status: z.enum(["deleted", "blocked", "incomplete"]),
    sessionIds: z.array(z.string().min(1)),
    retainedArtifacts: z.number().int().nonnegative(),
    reason: z.string().optional(),
  })
  .strict();
export type V4SessionDeletionExecuteResult = z.infer<typeof v4SessionDeletionExecuteResultSchema>;
