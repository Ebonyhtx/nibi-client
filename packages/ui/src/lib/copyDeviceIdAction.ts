import type { IPlatformService } from "@nibi/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";

// 设备号此前只在 Source 设备面板可见，帮助菜单补一个复制入口。
// 复用 platform.getDeviceId()（桌面端由 preload 注入的 deviceMid）这条既有权威读取路径，
// 不新开 RPC，也不另存一份设备标识。
export async function runCopyDeviceIdAction(
  platform: Pick<IPlatformService, "getDeviceId">,
  intl: IntlInstance,
): Promise<void> {
  const deviceId = platform.getDeviceId().trim();
  if (!deviceId || typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    toast(intl.formatMessage({ id: "workspaceHeader.help.copyDeviceIdFailed" }));
    return;
  }

  try {
    await navigator.clipboard.writeText(deviceId);
    toast(intl.formatMessage({ id: "workspaceHeader.help.copyDeviceIdSucceeded" }));
  } catch {
    toast(intl.formatMessage({ id: "workspaceHeader.help.copyDeviceIdFailed" }));
  }
}
