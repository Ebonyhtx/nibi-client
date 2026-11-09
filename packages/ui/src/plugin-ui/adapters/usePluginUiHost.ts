import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { isRemoteWorkspaceIdentity } from "@nibi/shared";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { buildPluginUiSurfaceKey, PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX } from "../contract.js";
import { resolvePluginUiLogicalScope } from "../domain/pluginUiLogicalScope.js";
import type { UsePluginUiHostInput, UsePluginUiHostResult } from "./pluginUiHostTypes.js";
import { createPage } from "./pluginUiManagedPage.js";
import { acquirePluginUiPage, pluginUiPages, subscribePage } from "./pluginUiPageRegistry.js";
export type { UsePluginUiHostInput, UsePluginUiHostResult } from "./pluginUiHostTypes.js";

/**
 * 面板准备失败的错误文案：agent 的 `mcp/uiOpenInstance` 在会话里没拿到该 MCP App 连接时回
 * `MCP App connection is unavailable`。这不是“插件坏了”——会话的插件快照在创建时冻结，启用发生在
 * 任务开始之后就补不进来。直接展示协议原文会让人以为插件不可用。
 */
function localizePluginUiError(
  error: unknown,
  formatMessage: (descriptor: { id: string }) => string,
): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("MCP App connection is unavailable")) {
    return formatMessage({ id: "settings.plugins.store.ui.notConnected" });
  }
  return message;
}

function pageIdentity(input: UsePluginUiHostInput): { key: string; input: UsePluginUiHostInput } {
  const scope = resolvePluginUiLogicalScope(input.presentation, input.scope.scope);
  const key = buildPluginUiSurfaceKey({ ...input.scope, ...input.presentation }, scope);
  return { key, input: { ...input, scope: { ...input.scope, scope } } };
}

/** 锚点订阅唯一窗口 owner；切位置、重渲染和卡片卸载不销毁页面。 */
export function usePluginUiHost(input: UsePluginUiHostInput): UsePluginUiHostResult {
  const platform = useOptionalPlatform();
  const services = useOptionalServices();
  const { intl } = useZCodeIntl();
  const local =
    !input.scope.remoteSessionId && !isRemoteWorkspaceIdentity(input.scope.workspaceIdentity ?? "");
  const identified = pageIdentity(input);
  const key = identified.key;
  const [failure, setFailure] = useState<{ key: string; error: string } | null>(null);
  const empty = useMemo<UsePluginUiHostResult>(
    () => ({
      pageKey: key,
      supported: Boolean(local && platform?.pluginSandbox && services?.pluginUiBridgeService),
      phase: failure?.key === key ? "error" : "idle",
      handle: null,
      height: PLUGIN_UI_CARD_DEFAULT_HEIGHT_PX,
      error: failure?.key === key ? failure.error : null,
      appCapabilities: undefined,
      reload: () => setFailure(null),
    }),
    [key, platform, services, failure, local],
  );
  // 创建只发生在 effect；外部 store 的快照身份稳定，不在 render 写入 controller。
  const [subscribe, read] = useMemo(
    () =>
      [
        (listener: () => void) => subscribePage(key, listener),
        () => pluginUiPages.get(key)?.snapshot() ?? empty,
      ] as const,
    [key, empty],
  );
  const result = useSyncExternalStore(subscribe, read, () => empty);
  // 协议错误文案对用户没有意义：会话里没连上该插件时给出可执行的解释（controller 的 error 也走这里）。
  const localized = useMemo(() => {
    if (!result.error) return result;
    const error = localizePluginUiError(result.error, intl.formatMessage);
    return error === result.error ? result : { ...result, error };
  }, [result, intl]);
  useEffect(() => {
    if (
      !local ||
      !platform?.pluginSandbox ||
      !services?.pluginUiBridgeService ||
      input.enabled === false
    )
      return;
    if (failure?.key === key) return;
    let current = true;
    void acquirePluginUiPage(key, () => createPage(key, identified.input, platform, services)).then(
      (page) => {
        if (current) page.update(identified.input);
      },
      (error) => {
        if (current) setFailure({ key, error: String(error) });
      },
    );
    return () => {
      current = false;
    };
  });
  return localized;
}
