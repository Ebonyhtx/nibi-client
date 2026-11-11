import { useMemo } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useRemoteDevicePresentationInputs } from "@/hooks/useSourceServerStatuses.js";
import {
  formatRemoteDeviceName,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import { buildSettingsScopeGroups } from "@/settings-scope/index.js";
import type { SettingsScopeDeviceState } from "@/settings-scope/index.js";
import type { DataSyncDevice } from "@/data-sync/contract.js";

/**
 * 数据同步页的远端设备列表：复用 settings-scope 的设备分组规则。
 * 只列出在线、有「用户」目标的 Source 设备；Web / 手机不能申请 source-settings attachment，列表为空。
 * 在线状态只取自本机 Source 管理快照，离线设备整组不列出（fail-closed）。
 */
export function useDataSyncDevices(): {
  devices: DataSyncDevice[];
  remoteUserAvailable: boolean;
} {
  const remoteUserAvailable = Boolean(useOptionalPlatform()?.requestSourceSettingsAttachment);
  const inputs = useRemoteDevicePresentationInputs();
  return useMemo(() => {
    const deviceStates: SettingsScopeDeviceState[] = [...inputs.entries()].map(
      ([sourceServerId, input]) => ({
        sourceServerId,
        name: formatRemoteDeviceName(input.target, input.displayName) ?? sourceServerId,
        online: resolveRemoteConnectionPresentation(input).status === "online",
      }),
    );
    const groups = buildSettingsScopeGroups({
      targets: [],
      devices: deviceStates,
      remoteUserAvailable,
    });
    const devices = groups.flatMap((group) => {
      if (group.device.kind !== "remote" || !group.device.sourceServerId) return [];
      if (!group.options.some((option) => option.kind === "user")) return [];
      return [
        {
          sourceServerId: group.device.sourceServerId,
          name: group.device.name ?? group.device.sourceServerId,
        },
      ];
    });
    return { devices, remoteUserAvailable };
  }, [inputs, remoteUserAvailable]);
}
