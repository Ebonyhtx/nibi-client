import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";

const PLUGIN_PERMISSION_MESSAGE_IDS: Record<string, string> = {
  "filesystem.read": "settings.plugins.consent.permission.filesystemRead",
  "filesystem.write": "settings.plugins.consent.permission.filesystemWrite",
  "full-access": "settings.plugins.consent.permission.fullAccess",
  code: "settings.plugins.consent.permission.code",
  "nibi.sessions.read": "settings.plugins.consent.capability.sessionsRead",
  "nibi.workspace.files.read": "settings.plugins.consent.capability.filesRead",
  "nibi.ui.view": "settings.plugins.consent.capability.uiView",
  "nibi.settings.own": "settings.plugins.consent.capability.settingsOwn",
  "nibi.notifications.show": "settings.plugins.consent.capability.notificationsShow",
  network: "settings.plugins.consent.permission.network",
  process: "settings.plugins.consent.permission.process",
};

/**
 * 社区/本地插件的 hooks 与 MCP 会启动子进程；启用前必须逐项展示并取得用户确认。
 * 官方/内置插件不走这个弹窗。
 */
export function PluginConsentDialog({
  open,
  pluginName,
  permissions,
  capabilities = [],
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  pluginName: string;
  permissions: readonly string[];
  capabilities?: ReadonlyArray<{ id: string; scope: string }>;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useNibiIntl();
  const items = [
    ...permissions,
    ...capabilities.map((grant) => grant.id),
  ];
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <AlertDialogContent data-testid="plugin-consent-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({ id: "settings.plugins.consent.title" }, { name: pluginName })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "settings.plugins.consent.description" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-1.5 py-2 text-ui-base text-foreground">
          {items.map((permission) => (
            <li key={permission} className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-1 size-1.5 shrink-0 rounded-full bg-foreground-subtle" />
              <span>
                {intl.formatMessage({
                  id:
                    PLUGIN_PERMISSION_MESSAGE_IDS[permission] ??
                    "settings.plugins.consent.permission.unknown",
                })}
              </span>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel
            type="button"
            size="sm"
            data-testid="plugin-consent-cancel"
            disabled={pending}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            type="button"
            data-testid="plugin-consent-confirm"
            size="sm"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {intl.formatMessage({ id: "settings.plugins.consent.confirm" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
// 卸载是破坏性的彻底清除（缓存 + data 目录 + config 残留），UI 各入口共用同一个确认弹窗，
// 文案与行为保持一致，避免「已安装」与「市场」两个面板各写一份。
export function PluginUninstallConfirmDialog({
  open,
  pluginName,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  pluginName: string;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useNibiIntl();
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="plugin-store-uninstall-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage(
              { id: "settings.plugins.uninstall.confirmTitle" },
              { name: pluginName },
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "settings.plugins.uninstall.confirmDescription" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            type="button"
            size="sm"
            data-testid="plugin-store-uninstall-cancel"
            disabled={pending}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            type="button"
            data-testid="plugin-store-uninstall-confirm"
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={(event) => {
              // 阻止 Radix 默认在点击 action 后关闭弹窗；卸载是异步操作，等结果再由父组件收起。
              event.preventDefault();
              onConfirm();
            }}
          >
            {intl.formatMessage({ id: "settings.plugins.uninstall.confirm" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
