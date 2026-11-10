import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { WorkspaceMcpTrustPresentation } from "./presentation.js";

/**
 * 项目级 MCP 行的 Host 审核状态。
 *
 * 徽标、指纹、来源与脱敏声明全部来自 Host；按钮只提交「信任/撤销」决定，
 * 不可审核（未登记/离线/不可归一化）时只读展示原因且不提供动作。
 */
export function WorkspaceMcpTrustPanel({
  serverName,
  presentation,
  busy,
  canDecide,
  onDecide,
}: {
  serverName: string;
  presentation: WorkspaceMcpTrustPresentation;
  busy: boolean;
  canDecide: boolean;
  onDecide: (trusted: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const badge = intl.formatMessage({ id: presentation.badgeMessageId });
  const hint = presentation.hintMessageId
    ? intl.formatMessage({ id: presentation.hintMessageId })
    : undefined;
  const reason = presentation.reasonMessageId
    ? intl.formatMessage({ id: presentation.reasonMessageId })
    : undefined;
  const fingerprintLabel = intl.formatMessage({
    id: "settings.mcp.workspaceTrust.fingerprintLabel",
  });
  const sourceLabel = intl.formatMessage({ id: "settings.mcp.workspaceTrust.sourceLabel" });
  const displayLabel = intl.formatMessage({ id: "settings.mcp.workspaceTrust.displayLabel" });
  const trustLabel = intl.formatMessage({ id: "settings.mcp.workspaceTrust.trust" });
  const revokeLabel = intl.formatMessage({ id: "settings.mcp.workspaceTrust.revoke" });
  const trustAriaLabel = intl.formatMessage(
    { id: "settings.mcp.workspaceTrust.trustAria" },
    { name: serverName },
  );
  const revokeAriaLabel = intl.formatMessage(
    { id: "settings.mcp.workspaceTrust.revokeAria" },
    { name: serverName },
  );
  const busyLabel = intl.formatMessage({ id: "settings.mcp.workspaceTrust.updating" });
  const unavailable = !presentation.canTrust && !presentation.canRevoke;
  const showActions = presentation.canTrust || presentation.canRevoke || unavailable;

  return (
    <div
      className="mt-2 space-y-1.5 rounded-lg border border-border bg-surface px-2.5 py-2"
      data-testid="mcp-workspace-trust"
      data-workspace-mcp-trust-state={presentation.state}
      aria-busy={busy}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex rounded-md px-1.5 py-0.5 text-ui-sm ring-1 ${
            presentation.state === "trusted"
              ? "bg-green-500/10 text-green-600 ring-green-500/30 dark:text-green-400"
              : presentation.state === "pending" || presentation.state === "changed"
                ? "bg-yellow-500/10 text-yellow-700 ring-yellow-500/30 dark:text-yellow-400"
                : "bg-surface text-foreground-subtle ring-border"
          }`}
        >
          {badge}
        </span>
        {presentation.fingerprint ? (
          <code
            className="truncate font-mono text-ui-sm text-foreground-subtle"
            title={`${fingerprintLabel}: ${presentation.declarationDigest}`}
          >
            {presentation.fingerprint}
          </code>
        ) : null}
        {hint ? <span className="text-ui-sm text-foreground-subtle">{hint}</span> : null}
      </div>

      {presentation.sourcePaths.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-baseline gap-1 text-ui-sm text-foreground-subtle">
          <span className="shrink-0">{sourceLabel}:</span>
          <span className="min-w-0 break-all font-mono">
            {presentation.sourcePaths.join(", ")}
          </span>
        </div>
      ) : null}

      {presentation.display ? (
        <pre
          className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md bg-background px-2 py-1.5 font-mono text-ui-sm text-foreground-subtle"
          aria-label={displayLabel}
        >
          {presentation.display}
        </pre>
      ) : null}

      {reason ? (
        <p className="text-ui-sm text-foreground-subtle" role="status">
          {reason}
        </p>
      ) : null}

      {showActions ? (
        <div className="flex flex-wrap items-center gap-2">
          {presentation.canTrust ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={trustAriaLabel}
              data-testid="mcp-workspace-trust-accept"
              disabled={!canDecide || busy}
              onClick={() => onDecide(true)}
            >
              {busy ? busyLabel : trustLabel}
            </Button>
          ) : null}
          {presentation.canRevoke ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={revokeAriaLabel}
              data-testid="mcp-workspace-trust-revoke"
              disabled={!canDecide || busy}
              onClick={() => onDecide(false)}
            >
              {busy ? busyLabel : revokeLabel}
            </Button>
          ) : null}
          {unavailable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={trustAriaLabel}
              data-testid="mcp-workspace-trust-accept"
              disabled
              title={reason}
            >
              {trustLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
