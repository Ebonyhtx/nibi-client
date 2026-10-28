import { useCallback, useEffect, useState } from "react";
import type { NibiMembershipStatus } from "@nibi/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import {
  nibiMembershipAllowsPaidPlugins,
  resolveNibiMembershipPhase,
  type NibiMembershipPhase,
} from "@/settings/nibiMembershipState.js";

/**
 * 会员状态变更的进程内广播：购买/续费完成、强制刷新成功后 bump 版本号，
 * 所有挂载中的 useNibiMembership 实例（侧栏徽标、商店页、插件区、弹窗）
 * 共享同一份状态，而不是各读一次本地缓存。
 */
type NibiMembershipListener = () => void;
const membershipListeners = new Set<NibiMembershipListener>();
let membershipVersion = 0;

function notifyNibiMembershipChanged(): void {
  membershipVersion += 1;
  for (const listener of [...membershipListeners]) listener();
}

/** 购买/续费成功、退出登录后由调用方触发，让所有会员状态消费点立即重读。 */
export function notifyNibiMembershipInvalidated(): void {
  notifyNibiMembershipChanged();
}

function useNibiMembershipVersion(): number {
  const [version, setVersion] = useState(membershipVersion);
  useEffect(() => {
    const listener = () => setVersion(membershipVersion);
    membershipListeners.add(listener);
    return () => {
      membershipListeners.delete(listener);
    };
  }, []);
  return version;
}

/**
 * 会员状态。默认读本地缓存；`refresh({ force: true })` 真实请求一次
 * /licenses/check 并广播新状态（购买/续费完成的唯一可靠恢复路径）。
 */
export function useNibiMembership(): {
  status: NibiMembershipStatus | null;
  phase: NibiMembershipPhase;
  canUsePaidPlugins: boolean;
  refreshing: boolean;
  refresh: (options?: { force?: boolean }) => Promise<NibiMembershipStatus | null>;
} {
  const services = useOptionalServices();
  const [status, setStatus] = useState<NibiMembershipStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 版本号只用于触发重读；读到的状态统一走下面的 fetch。
  const version = useNibiMembershipVersion();

  const fetchStatus = useCallback(
    async (options?: { force?: boolean }): Promise<NibiMembershipStatus | null> => {
      if (!services) {
        setStatus(null);
        return null;
      }
      try {
        const next = await services.oauthService.getNibiMembershipStatus(
          options?.force ? { force: true } : undefined,
        );
        setStatus(next);
        return next;
      } catch {
        // 读不到状态不阻断界面；门禁仍由宿主机最终裁决。force 失败保留旧状态由调用方报错。
        if (!options?.force) setStatus(null);
        return null;
      }
    },
    [services],
  );

  const refresh = useCallback(
    async (options?: { force?: boolean }): Promise<NibiMembershipStatus | null> => {
      setRefreshing(true);
      try {
        return await fetchStatus(options);
      } finally {
        setRefreshing(false);
      }
    },
    [fetchStatus],
  );

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus, version]);

  const phase = resolveNibiMembershipPhase(status);
  return { status, phase, canUsePaidPlugins: nibiMembershipAllowsPaidPlugins(phase), refreshing, refresh };
}
