import { AlertTriangleIcon, InfoIcon, ShieldAlertIcon, WifiOffIcon } from "lucide-react";
import { Button } from "@nibi/ui/button";
import type { WebRemoteControlFailure } from "@nibi/shared";
import { WebRemoteControlBrand } from "#src/web-remote-control/ui/webRemoteControlBrand.js";
import { WebRemoteControlSwitchAccountDialog } from "#src/web-remote-control/ui/webRemoteControlSwitchAccountDialog.js";

import {
  resolveWebRemoteControlScreenCopy,
  type WebRemoteControlScreenLocale,
  type WebRemoteControlScreenCopy,
} from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";
export {
  resolveWebRemoteControlScreenCopy,
  resolveWebRemoteControlScreenLocale,
} from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";

function resolveToneClassName(tone: WebRemoteControlScreenCopy["tone"]): {
  badge: string;
  icon: string;
} {
  switch (tone) {
    case "danger":
      return {
        badge: "border-destructive/30 bg-destructive-surface text-destructive-surface-foreground",
        icon: "border-destructive/30 bg-destructive-surface text-destructive-surface-foreground",
      };
    case "warning":
      return {
        badge: "border-warning/30 bg-warning-surface text-warning-surface-foreground",
        icon: "border-warning/30 bg-warning-surface text-warning-surface-foreground",
      };
    default:
      return {
        badge: "border-border bg-surface text-foreground-subtle",
        icon: "border-border bg-surface text-foreground-subtle",
      };
  }
}

function FailureToneIcon({
  reason,
  tone,
}: {
  reason: WebRemoteControlFailure["reason"];
  tone: WebRemoteControlScreenCopy["tone"];
}) {
  if (reason === "device-not-owned") {
    return <ShieldAlertIcon aria-hidden="true" className="size-5" />;
  }
  if (reason === "desktop-disconnected" || reason === "relay-unavailable") {
    return <WifiOffIcon aria-hidden="true" className="size-5" />;
  }
  if (tone === "neutral") {
    return <InfoIcon aria-hidden="true" className="size-5" />;
  }
  return <AlertTriangleIcon aria-hidden="true" className="size-5" />;
}

interface WebRemoteControlFailureScreenProps {
  failure: WebRemoteControlFailure;
  locale: WebRemoteControlScreenLocale;
  onReload(): void;
  primaryActionLabel?: string;
  secondaryAction?: { label: string; onClick(): void };
}

export function WebRemoteControlFailureScreen({
  failure,
  locale,
  onReload,
  primaryActionLabel,
  secondaryAction,
}: WebRemoteControlFailureScreenProps) {
  const copy = resolveWebRemoteControlScreenCopy(failure, locale);
  const toneClassName = resolveToneClassName(copy.tone);

  return (
    <div
      className="flex min-h-screen flex-col bg-background pt-[calc(env(safe-area-inset-top)+12px)] pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+24px)] pl-[max(1rem,env(safe-area-inset-left))] text-foreground"
      style={{ minHeight: "100dvh" }}
    >
      <div className="mx-auto flex h-10 w-full max-w-md items-center">
        <WebRemoteControlBrand subtitle={locale === "zh-CN" ? "Web 远程控制" : "Web Remote"} />
      </div>
      <div className="flex flex-1 items-center justify-center py-6">
        <main className="w-full max-w-md rounded-2xl border border-card-border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-3.5">
            <div
              className={`flex size-11 shrink-0 items-center justify-center rounded-xl border ${toneClassName.icon}`}
              aria-hidden="true"
            >
              <FailureToneIcon reason={failure.reason} tone={copy.tone} />
            </div>
            <div className="min-w-0 flex-1">
              <div
                className={`mb-2 inline-flex max-w-full items-center rounded-full border px-2.5 py-0.5 text-ui-xs font-medium ${toneClassName.badge}`}
              >
                <span className="min-w-0 truncate">{copy.badge}</span>
              </div>
              <h1 className="text-ui-xl font-semibold text-balance text-foreground">
                {copy.title}
              </h1>
              <p className="mt-1.5 text-ui-sm leading-relaxed text-pretty text-foreground-subtle">
                {copy.description}
              </p>
            </div>
          </div>

          <section className="mt-5 rounded-xl border border-border bg-surface p-4">
            <h2 className="text-ui-sm font-semibold text-foreground">{copy.nextStepsTitle}</h2>
            <ol className="mt-2.5 space-y-2.5 text-ui-sm leading-relaxed text-foreground-subtle">
              {copy.nextSteps.map((step, index) => (
                <li key={step} className="flex items-start gap-2.5">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-ui-xs font-medium text-foreground">
                    {index + 1}
                  </span>
                  <span className="min-w-0 text-pretty">{step}</span>
                </li>
              ))}
            </ol>
          </section>

          {failure.message ? (
            <section className="mt-4 rounded-xl border border-border bg-background-alt px-3.5 py-2.5">
              <div className="text-ui-xs font-medium text-foreground-subtle">
                {copy.detailLabel}
              </div>
              <div className="mt-1 font-mono text-ui-xs leading-relaxed break-words text-foreground-subtle">
                {failure.message}
              </div>
            </section>
          ) : null}

          {failure.reason === "device-not-owned" ? (
            <WebRemoteControlSwitchAccountDialog locale={locale} onConfirm={onReload}>
              <Button
                type="button"
                className="mt-5 h-12 w-full rounded-xl text-ui-base font-medium"
              >
                {primaryActionLabel ?? copy.action}
              </Button>
            </WebRemoteControlSwitchAccountDialog>
          ) : (
            <Button
              type="button"
              className="mt-5 h-12 w-full rounded-xl text-ui-base font-medium"
              onClick={onReload}
            >
              {primaryActionLabel ?? copy.action}
            </Button>
          )}
          {secondaryAction ? (
            <Button
              type="button"
              variant="outline"
              className="mt-2.5 h-11 w-full rounded-xl"
              onClick={secondaryAction.onClick}
            >
              {secondaryAction.label}
            </Button>
          ) : null}
        </main>
      </div>
    </div>
  );
}
