import { useEffect, useRef, useState } from "react";
import { NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@nibi/shared";
import type { IPluginManagementService } from "@nibi/services";
import { logger } from "@/logger.js";
import { claimPluginUpdateCheck, countUpdatablePlugins } from "./pluginUpdateFeed.js";

/** 打开工作区后等一会儿再查，避免和首屏/会话恢复抢 agent 队列。 */
const PLUGIN_UPDATE_CHECK_DELAY_MS = 8_000;

/**
 * 商店外发现插件更新：工作区就绪后查一次 overview，必要时刷新官方目录，
 * 返回「有更新的已安装插件数量」。失败只记日志（不影响任何主流程）。
 *
 * `refreshToken` 变化时重新统计（例如从商店页返回后，用户可能刚更新过插件）。
 * 服务实例由调用方注入（Shell 已持有 services），不在这里读 context。
 */
export function usePluginUpdateFeed(params: {
  enabled: boolean;
  pluginService: IPluginManagementService;
  refreshToken?: string | number;
  workspaceIdentity?: string | null;
  workspacePath?: string | null;
}): number {
  const { enabled, pluginService, refreshToken, workspaceIdentity, workspacePath } = params;
  const [updatableCount, setUpdatableCount] = useState(0);
  // 同一个工作区只做一次「刷新目录」的判断；统计本身可以随 refreshToken 重跑。
  const refreshedWorkspaceRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !workspacePath) return;
    let cancelled = false;
    const workspace = {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    };

    // 延后一拍再查：启动瞬间 agent 正忙首屏/会话恢复，这组 RPC 不值得抢在前面。
    const timer = setTimeout(() => {
      void (async () => {
        try {
          let overview = await pluginService.getPluginsOverview(workspace);
          if (cancelled) return;

          const official = overview.marketplaces.find(
            (marketplace) => marketplace.id === NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID,
          );
          const alreadyRefreshed = refreshedWorkspaceRef.current === workspacePath;
          if (
            official &&
            !alreadyRefreshed &&
            claimPluginUpdateCheck(NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID, official.lastUpdated)
          ) {
            refreshedWorkspaceRef.current = workspacePath;
            // 拉取式更新检查：刷新目录后宿主会重算每个已安装插件的 updateStatus。
            // 失败（离线/签名不过/防回滚）保留旧目录，不影响下面的统计。
            await pluginService
              .updatePluginMarketplace({
                ...workspace,
                marketplace: NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID,
              })
              .catch((error: unknown) => {
                logger.warn("[plugins] 后台更新检查刷新目录失败（保留旧目录）", {
                  error: error instanceof Error ? error.message : String(error),
                });
              });
            if (cancelled) return;
            overview = await pluginService.getPluginsOverview(workspace);
            if (cancelled) return;
          }

          setUpdatableCount(countUpdatablePlugins(overview.installedPlugins));
        } catch (error) {
          logger.warn("[plugins] 后台更新检查失败（不影响使用）", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, PLUGIN_UPDATE_CHECK_DELAY_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, pluginService, refreshToken, workspaceIdentity, workspacePath]);

  return updatableCount;
}
