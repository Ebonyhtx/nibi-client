/**
 * workspace prepare 的协议 RPC 收口。
 *
 * 拆出原因：useWorkspacePrepare.ts 只保留可单测的轻量判定入口；
 * 这里只读取 workspace presentation（mode/slash commands）；模型选择事实由目标 Host View 提供。
 */
import type { INibiSessionService } from "@nibi/services";
import { type NibiProvider, type NibiWorkspacePrepareResult } from "@nibi/shared";
import { getChatErrorMessage } from "@/lib/chatPrepareError.js";
import { logger } from "@/logger.js";
import { nibiWorkspacePresentationToConfigOptions } from "@/lib/nibiSessionProjection.js";

export async function prepareWorkspaceWithNibiSessionService(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: NibiProvider;
  nibiSessionService: Pick<INibiSessionService, "readWorkspacePresentation">;
}): Promise<NibiWorkspacePrepareResult> {
  const startedAt = Date.now();
  logger.info("[nibi-workspace-presentation] workspace prepare start", {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity ?? null,
    provider: params.provider,
  });

  let presentation: Awaited<ReturnType<INibiSessionService["readWorkspacePresentation"]>>;
  try {
    presentation = await params.nibiSessionService.readWorkspacePresentation({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
  } catch (error) {
    logger.warn("[nibi-workspace-presentation] readWorkspacePresentation failed", {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? null,
      provider: params.provider,
      durationMs: Date.now() - startedAt,
      error: getChatErrorMessage(error),
    });
    throw error;
  }

  const readPresentationDurationMs = Date.now() - startedAt;
  const configOptions = nibiWorkspacePresentationToConfigOptions(presentation.mode);
  const totalDurationMs = Date.now() - startedAt;
  logger.info("[nibi-workspace-presentation] readWorkspacePresentation done", {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity ?? null,
    provider: params.provider,
    readPresentationDurationMs,
    totalDurationMs,
    configOptionsCount: configOptions.length,
    modeCurrent: presentation.mode,
  });

  return {
    workspacePath: params.workspacePath,
    preparedSessionId: "",
    version: "NIBI Protocol/1",
    provider: params.provider,
    configOptions,
    slashCommands: presentation.slashCommands,
  };
}
