import { useEffect, useState } from "react";
import { AlertCircleIcon, LoaderCircleIcon } from "lucide-react";
import type { WebAuthCallbackResult, WebAuthService } from "../../web/src/auth/webAuthService.js";

type ShareAuthLocale = "zh-CN" | "en-US";

const SHARE_AUTH_COPY: Record<
  ShareAuthLocale,
  {
    brand: string;
    badge: string;
    errorTitle: string;
    retry: string;
    completing: string;
  }
> = {
  "zh-CN": {
    brand: "NIBI",
    badge: "会话分享",
    errorTitle: "无法完成登录",
    retry: "重试",
    completing: "正在完成登录…",
  },
  "en-US": {
    brand: "NIBI",
    badge: "Conversation Share",
    errorTitle: "Unable to sign in",
    retry: "Try again",
    completing: "Completing sign in…",
  },
};

function resolveShareAuthLocale(explicit?: ShareAuthLocale): ShareAuthLocale {
  if (explicit) return explicit;
  if (typeof window !== "undefined" && window.location.pathname.startsWith("/cn/share")) {
    return "zh-CN";
  }
  const lang = typeof document !== "undefined" ? document.documentElement.lang : "";
  return /^zh(?:-|$)/iu.test(lang) ? "zh-CN" : "en-US";
}

const pageClass =
  "flex min-h-dvh flex-col bg-background pt-[calc(env(safe-area-inset-top)+12px)] pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+24px)] pl-[max(1rem,env(safe-area-inset-left))] text-foreground";
const cardClass =
  "w-full max-w-sm rounded-2xl border border-card-border bg-card p-6 shadow-[var(--nibi-shadow-card)]";

export function ShareCallbackPage({
  authService,
  onSuccess,
  onRetry,
  locale,
}: {
  authService: Pick<WebAuthService, "handleCallback">;
  onSuccess: (result: WebAuthCallbackResult) => void;
  onRetry: () => void;
  locale?: ShareAuthLocale;
}) {
  const copy = SHARE_AUTH_COPY[resolveShareAuthLocale(locale)];
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    authService
      .handleCallback(window.location.href)
      .then((result) => {
        if (mounted && result) onSuccess(result);
      })
      .catch((caught) => {
        if (mounted) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      mounted = false;
    };
  }, [authService, onSuccess]);

  return (
    <main className={pageClass}>
      <div className="mx-auto flex h-10 w-full max-w-md items-center">
        <span className="inline-flex items-center gap-2">
          <span className="text-ui-base font-semibold tracking-tight text-foreground">
            {copy.brand}
          </span>
          <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
            {copy.badge}
          </span>
        </span>
      </div>
      <div className="flex flex-1 items-center justify-center py-6">
        <section className={cardClass}>
          {error ? (
            <div role="alert">
              <div className="flex items-start gap-3">
                <div
                  aria-hidden="true"
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-destructive/25 bg-destructive-surface text-destructive-surface-foreground"
                >
                  <AlertCircleIcon className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h1 className="text-ui-lg font-semibold text-foreground">{copy.errorTitle}</h1>
                </div>
              </div>
              <p className="mt-4 rounded-xl border border-border bg-surface px-3.5 py-2.5 font-mono text-ui-xs leading-relaxed break-words text-foreground-subtle">
                {error}
              </p>
              <button
                type="button"
                className="mt-5 h-11 w-full rounded-xl bg-primary px-4 text-ui-base font-medium text-primary-foreground shadow-[var(--nibi-shadow-primary-btn)] transition-[background-color,filter,box-shadow,transform] duration-150 hover:bg-primary/92 hover:brightness-[1.03] active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused motion-reduce:transition-none motion-reduce:active:scale-100"
                onClick={onRetry}
              >
                {copy.retry}
              </button>
            </div>
          ) : (
            <div
              role="status"
              aria-live="polite"
              aria-busy="true"
              className="flex items-center justify-center gap-2.5 py-4 text-ui-base text-foreground-subtle"
            >
              <LoaderCircleIcon
                aria-hidden="true"
                className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none"
              />
              <span>{copy.completing}</span>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
