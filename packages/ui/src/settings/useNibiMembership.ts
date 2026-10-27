import { useCallback, useEffect, useState } from "react";
import type { NibiMembershipStatus } from "@nibi/services";
import { useOptionalServices } from "@/hooks/useServices.js";
import {
  nibiMembershipAllowsPaidPlugins,
  resolveNibiMembershipPhase,
  type NibiMembershipPhase,
} from "@/settings/nibiMembershipState.js";

/**
 * 会员状态（只读本地缓存，不联网）。`refresh` 在购买弹窗关闭后调用，
 * 让入口徽标和付费插件门禁立刻跟着更新。
 */
export function useNibiMembership(): {
  status: NibiMembershipStatus | null;
  phase: NibiMembershipPhase;
  canUsePaidPlugins: boolean;
  refresh: () => Promise<void>;
} {
  const services = useOptionalServices();
  const [status, setStatus] = useState<NibiMembershipStatus | null>(null);

  const refresh = useCallback(async () => {
    if (!services) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await services.oauthService.getNibiMembershipStatus());
    } catch {
      // 读不到状态不阻断界面；门禁仍由宿主机最终裁决。
      setStatus(null);
    }
  }, [services]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const phase = resolveNibiMembershipPhase(status);
  return { status, phase, canUsePaidPlugins: nibiMembershipAllowsPaidPlugins(phase), refresh };
}
