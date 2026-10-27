// 插件更新检查（商店外的发现）：让用户不打开商店也能知道「有插件可更新」。
//
// 现状：商店页进入时自动刷新目录（10 分钟窗口，见 officialMarketplaceAutoRefresh），
// 但「可更新」角标只存在于商店页内部——用户不点进商店就永远看不到更新。
// 这里在打开工作区时做一次后台检查：
//   1) 读一次 overview（宿主已算出 installedPlugins[].updateStatus）；
//   2) 官方目录上次刷新超过 6 小时就先刷新目录（拉取式更新检查，不是服务端推送）；
//   3) 统计 updateStatus 为 update-available / version-changed 的已安装插件。
//
// 判据与商店页共用同一份数据（宿主算的 updateStatus），不在这里重新比较版本号，
// 避免两套版本语义（预发布标记/版本变更）各说各话。
export const PLUGIN_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const lastAttemptAtByMarketplace = new Map<string, number>();

export function shouldCheckPluginUpdates(params: {
  lastUpdated?: string;
  lastAttemptAt?: number;
  now: number;
}): boolean {
  const lastUpdatedAt = params.lastUpdated ? Date.parse(params.lastUpdated) : Number.NaN;
  const lastKnownAt = Math.max(
    Number.isNaN(lastUpdatedAt) ? -Infinity : lastUpdatedAt,
    params.lastAttemptAt ?? -Infinity,
  );
  return params.now - lastKnownAt >= PLUGIN_UPDATE_CHECK_INTERVAL_MS;
}

/** 判定并占位：通过则记录本次尝试时间，避免同一会话反复触发长超时请求。 */
export function claimPluginUpdateCheck(
  marketplaceId: string,
  lastUpdated: string | undefined,
  now: number = Date.now(),
): boolean {
  const shouldCheck = shouldCheckPluginUpdates({
    lastUpdated,
    lastAttemptAt: lastAttemptAtByMarketplace.get(marketplaceId),
    now,
  });
  if (shouldCheck) lastAttemptAtByMarketplace.set(marketplaceId, now);
  return shouldCheck;
}

export function resetPluginUpdateFeedForTests(): void {
  lastAttemptAtByMarketplace.clear();
}

/** 已安装插件里「有更新」的数量（宿主判定的 updateStatus，不在这里重算版本）。 */
export function countUpdatablePlugins(
  installedPlugins: ReadonlyArray<{ updateStatus?: string }> | undefined,
): number {
  if (!installedPlugins) return 0;
  return installedPlugins.filter(
    (plugin) =>
      plugin.updateStatus === "update-available" || plugin.updateStatus === "version-changed",
  ).length;
}
