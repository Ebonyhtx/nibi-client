import { useEffect, useState } from "react";
import { History } from "lucide-react";
import type { NibiPluginAuditEvent } from "@nibi/shared";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import {
  resolvePluginAuditCapabilityLabelId,
  resolvePluginAuditTypeLabelId,
} from "@/settings/pluginStoreListing.js";

/**
 * 插件详情里的「最近审计」。
 *
 * 为什么需要它：插件能读会话、读工作区文件，这些动作本来只落在本地 ndjson 里。
 * 出事时用户/客服问「它到底动了什么」，没有界面就只能翻日志。
 *
 * 取数口径：只在详情打开时按需拉最近 10 条；失败静默降级成一行提示，
 * 不弹错、不阻断详情其它区块——审计读不到不等于插件不可用。
 */
export function PluginAuditList({
  events,
  status,
}: {
  events: readonly NibiPluginAuditEvent[];
  status: "idle" | "loading" | "ready" | "error";
}) {
  const { intl, locale } = useNibiIntl();

  if (status === "loading" || status === "idle") {
    return (
      <p className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.audit.loading" })}
      </p>
    );
  }
  if (status === "error") {
    return (
      <p className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.audit.unavailable" })}
      </p>
    );
  }
  if (events.length === 0) {
    return (
      <p className="text-ui-xs text-foreground-subtle">
        {intl.formatMessage({ id: "settings.plugins.audit.empty" })}
      </p>
    );
  }

  return (
    <ul className="space-y-1.5" data-testid="plugin-audit-list">
      {events.map((event, index) => {
        const typeLabelId = resolvePluginAuditTypeLabelId(event.type);
        const capabilityLabelId = event.capability
          ? resolvePluginAuditCapabilityLabelId(event.capability)
          : undefined;
        return (
          <li
            className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-ui-xs text-foreground-subtle"
            key={`${event.at}-${event.type}-${index}`}
          >
            <time className="shrink-0 tabular-nums" dateTime={event.at}>
              {formatAuditTime(event.at, locale)}
            </time>
            <span className="text-foreground">
              {typeLabelId
                ? intl.formatMessage({ id: typeLabelId })
                : event.type}
            </span>
            {event.capability ? (
              <span className="min-w-0 truncate">
                {capabilityLabelId
                  ? intl.formatMessage({ id: capabilityLabelId })
                  : event.capability}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * 时间显示成 `2026-11-25 14:22`：审计要看「什么时候」，秒和时区对用户没意义。
 * 解析失败时原样显示，不显示成 Invalid Date。
 */
export function formatAuditTime(iso: string, locale: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(at);
  } catch {
    return iso;
  }
}

/** 审计区块标题（与 rootPath/来源同属「高级信息」）。 */
export function PluginAuditSectionHeader() {
  const { intl } = useNibiIntl();
  return (
    <div className="flex items-center gap-1.5 text-ui-xs font-medium text-foreground">
      <History className="size-3.5" aria-hidden="true" />
      {intl.formatMessage({ id: "settings.plugins.audit.title" })}
    </div>
  );
}

/**
 * 详情页的审计取数 hook：view 进入 detail 且插件已发现时拉一次；
 * 切插件时重置。返回状态供面板渲染。
 */
export function usePluginAudit(input: {
  enabled: boolean;
  load: ((pluginId: string) => Promise<readonly NibiPluginAuditEvent[]>) | undefined;
  pluginId: string | undefined;
}): { events: readonly NibiPluginAuditEvent[]; status: "idle" | "loading" | "ready" | "error" } {
  const [state, setState] = useState<{
    events: readonly NibiPluginAuditEvent[];
    status: "idle" | "loading" | "ready" | "error";
  }>({ events: [], status: "idle" });

  useEffect(() => {
    if (!input.enabled || !input.pluginId || !input.load) {
      setState({ events: [], status: "idle" });
      return;
    }
    let active = true;
    setState({ events: [], status: "loading" });
    void input
      .load(input.pluginId)
      .then((events) => {
        if (active) setState({ events, status: "ready" });
      })
      .catch(() => {
        if (active) setState({ events: [], status: "error" });
      });
    return () => {
      active = false;
    };
  }, [input.enabled, input.load, input.pluginId]);

  return state;
}
