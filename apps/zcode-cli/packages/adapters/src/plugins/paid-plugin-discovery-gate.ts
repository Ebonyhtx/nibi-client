/**
 * 发现层内置付费插件门禁（fail-closed）。
 *
 * 为什么在发现层而不是 bootstrap 后处理：启动路径（resolveStartupPlugins）与 CLI
 * 路径（resolveZCodePlugins）都必须裁剪；放在发现层让"新调用方忘记传门禁"不可能发生。
 * 被拒插件按未启用处理，mcpServers/hooks/skillRoots/commandRoots 因此天然为空。
 *
 * 付费判定：marketplace manifest 条目 paid=true，或安装记录 paid=true（插件缓存与
 * 配置可以被复制到别的机器，只看 manifest 等于没拦复制件）。
 * 授权判定：离线验签 + exp + 插件覆盖 + 服务端 refusal，与安装/启用门禁同一实现。
 */
import type { PaidPluginGateInput, PaidPluginGateResult } from "@nibi/contracts";
import {
  listInstalledPluginRecords,
  loadMarketplaceManifestSync,
} from "./marketplace.js";
import {
  readNibiDeviceIdSync,
  readNibiLicenseRefusalSync,
  readNibiLicenseTokenSync,
  resolvePaidPluginAccessFromToken,
} from "./paid-plugin-access.js";

export function createBuiltinPaidPluginGate(input: {
  env?: Record<string, string | undefined>;
  /** 验签公钥覆盖（测试与轮换注入用；默认内置表）。 */
  publicKeys?: Record<string, string>;
  storageRoot: string;
}): (plugin: PaidPluginGateInput) => PaidPluginGateResult {
  let token: string | null | undefined;
  let refusal: string | null | undefined;
  let deviceId: string | null | undefined;
  let installedLoaded = false;
  const installedPaid = new Set<string>();
  const manifests = new Map<string, ReturnType<typeof loadMarketplaceManifestSync>>();
  const manifestFor = (marketplace: string) => {
    if (!manifests.has(marketplace)) {
      manifests.set(
        marketplace,
        loadMarketplaceManifestSync(input.storageRoot, marketplace),
      );
    }
    return manifests.get(marketplace);
  };
  const isPaid = (plugin: PaidPluginGateInput): boolean => {
    if (
      manifestFor(plugin.marketplace)?.plugins.some(
        (item) => item.name === plugin.name && item.paid === true,
      )
    ) {
      return true;
    }
    if (!installedLoaded) {
      installedLoaded = true;
      try {
        for (const record of listInstalledPluginRecords(input.storageRoot)) {
          if (record.paid) installedPaid.add(record.id);
        }
      } catch {
        // 安装记录读不到时按"无法证明付费"处理；授权判定本身仍是 fail-closed。
      }
    }
    return installedPaid.has(plugin.id);
  };
  return (plugin) => {
    if (!isPaid(plugin)) return { allowed: true };
    if (token === undefined) token = readNibiLicenseTokenSync(input.env);
    if (refusal === undefined) refusal = readNibiLicenseRefusalSync(input.env);
    if (deviceId === undefined) deviceId = readNibiDeviceIdSync(input.env);
    try {
      resolvePaidPluginAccessFromToken({
        token: token ?? "",
        pluginName: plugin.name,
        deviceId,
        ...(input.publicKeys ? { publicKeys: input.publicKeys } : {}),
        refusal,
      });
      return { allowed: true };
    } catch (error) {
      return {
        allowed: false,
        code: "plugin_membership_required",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
