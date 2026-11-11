import { useEffect, useMemo } from "react";
import { ApiError } from "@nibi/shared";
import type { IClientScenesService } from "@nibi/services";
import {
  isClientScenesBusinessError,
  useClientScenesResource,
} from "@/hooks/useClientScenesResource.js";
import { usePluginReferenceCatalog } from "@/hooks/usePluginReferenceCatalog.js";
import { logger } from "@/logger.js";
import {
  collectSuggestedPromptPluginIds,
  draftSuggestedPromptFallback,
  mapClientScenesToDraftSuggestedPromptItems,
  type DraftSuggestedPromptItem,
} from "@/v4/draftSuggestedPromptItems.js";

/** 服务端尚未提供 draft-suggestion scene 时（业务 404 或 HTTP 404）才启用本地兜底。 */
function isClientScenesNotFoundError(error: unknown): boolean {
  if (isClientScenesBusinessError(error)) return error.code === 404;
  return error instanceof ApiError && error.status === 404;
}

export function useDraftSuggestedPromptItems({
  clientScenesService,
  rpcReady,
  workspaceKey,
}: {
  clientScenesService: IClientScenesService;
  rpcReady: boolean;
  workspaceKey: string;
}): DraftSuggestedPromptItem[] {
  const clientScenes = useClientScenesResource(clientScenesService, {
    enabled: rpcReady,
  });

  useEffect(() => {
    const error = clientScenes.error;
    if (!error) return;
    if (isClientScenesNotFoundError(error)) {
      // 404 不是故障：服务端可能还没上线 draft-suggestion，回退本地通用推荐即可。
      logger.warn("[v4-suggested-prompts] Client scenes 404，回退本地推荐", { workspaceKey });
      return;
    }
    if (isClientScenesBusinessError(error)) {
      logger.warn("[v4-suggested-prompts] Client scenes 返回失败，推荐列表保持为空", {
        code: error.code,
        message: error.responseMessage,
        workspaceKey,
      });
      return;
    }
    logger.warn("[v4-suggested-prompts] Client scenes 请求失败，推荐列表保持为空", {
      error: error.message,
      workspaceKey,
    });
  }, [clientScenes.error, workspaceKey]);

  return useMemo(() => {
    const items = mapClientScenesToDraftSuggestedPromptItems(clientScenes.scenes);
    // 只有“明确 404 且没有任何 scene 条目”才兜底；正常返回空列表仍然是产品选择，不能覆盖。
    return items.length > 0 || !isClientScenesNotFoundError(clientScenes.error)
      ? items
      : draftSuggestedPromptFallback;
  }, [clientScenes.error, clientScenes.scenes]);
}

/**
 * 读取当前 workspace 已安装 Plugin 的权威目录，供推荐卡做运行时可用性过滤。
 *
 * 只用草稿态（sessionId=null）的 workspace catalog：新建任务页还没有会话，不能用某个
 * 已冻结的 session catalog 冒充当前安装状态。
 */
export function useSuggestedPromptPluginAvailability({
  items,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: {
  items: readonly DraftSuggestedPromptItem[];
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
}): ReadonlySet<string> | null {
  const requiresCatalog = useMemo(
    () => items.some((item) => collectSuggestedPromptPluginIds(item).length > 0),
    [items],
  );
  const catalog = usePluginReferenceCatalog(
    workspacePath,
    workspaceIdentity ?? undefined,
    null,
    requiresCatalog,
    {
      preferredRemoteSessionId: remoteSessionId ?? undefined,
    },
  );

  return useMemo(() => {
    if (!requiresCatalog) return new Set<string>();
    // 目录仍在加载或查询失败时不把推荐清空：过滤是防漂移的兜底，不应成为新的空态来源。
    if (catalog.loading || catalog.error || catalog.authority === null) return null;
    return new Set(catalog.entries.map((entry) => entry.pluginId));
  }, [catalog, requiresCatalog]);
}
