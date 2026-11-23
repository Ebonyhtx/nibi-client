import { useEffect, useState } from "react";
import { AlertCircleIcon } from "lucide-react";
import { Button } from "@nibi/ui";
import { NibiAppLogo } from "@nibi/ui/app-logo";
import type { WebAuthCallbackResult, WebAuthService } from "./webAuthService.js";
import { getWebAuthCopy } from "./webAuthLocale.js";

interface WebCallbackPageProps {
  authService: Pick<WebAuthService, "handleCallback">;
  onSuccess: (result: WebAuthCallbackResult) => void;
  onRetry: () => void;
}

export function WebCallbackPage({ authService, onRetry, onSuccess }: WebCallbackPageProps) {
  const copy = getWebAuthCopy();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    authService
      .handleCallback(window.location.href)
      .then((result) => {
        if (!isMounted || !result) {
          return;
        }
        onSuccess(result);
      })
      .catch((caught) => {
        if (!isMounted) {
          return;
        }
        setError(caught instanceof Error ? caught.message : String(caught));
      });

    return () => {
      isMounted = false;
    };
  }, [authService, onSuccess]);

  return (
    <main className="flex min-h-dvh flex-col bg-background pt-[calc(env(safe-area-inset-top)+12px)] pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+24px)] pl-[max(1rem,env(safe-area-inset-left))] text-foreground">
      <div className="mx-auto flex h-10 w-full max-w-md items-center">
        <span className="inline-flex items-center gap-2.5">
          <NibiAppLogo className="size-6 rounded-md shadow-xs" />
          <span className="text-ui-base font-semibold tracking-tight text-foreground">
            {copy.brand}
          </span>
          <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
            {copy.remoteBadge}
          </span>
        </span>
      </div>
      <div className="flex flex-1 items-center justify-center py-6">
        <section className="w-full max-w-sm rounded-2xl border border-card-border bg-card p-6 shadow-sm">
          {error ? (
            <div role="alert">
              <div className="flex items-start gap-3">
                <div
                  aria-hidden="true"
                  className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-destructive/25 bg-destructive-surface text-destructive-surface-foreground"
                >
                  <AlertCircleIcon className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h1 className="text-ui-xl font-semibold text-balance text-foreground">
                    {copy.callbackErrorTitle}
                  </h1>
                  <p className="mt-1.5 text-ui-sm leading-relaxed text-pretty text-foreground-subtle">
                    {copy.callbackErrorDescription}
                  </p>
                </div>
              </div>
              <p className="mt-4 rounded-xl border border-border bg-surface px-3.5 py-2.5 font-mono text-ui-xs leading-relaxed break-words text-foreground-subtle">
                {error}
              </p>
              <Button
                type="button"
                size="lg"
                className="mt-5 h-12 w-full rounded-xl text-ui-base font-medium"
                onClick={onRetry}
              >
                {copy.retryAction}
              </Button>
            </div>
          ) : (
            <div
              role="status"
              aria-live="polite"
              aria-busy="true"
              className="flex flex-col items-center py-4 text-center"
            >
              <progress aria-label={copy.callbackTitle} className="nibi-remote-spinner mb-5" />
              <h1 className="text-ui-xl font-semibold text-balance text-foreground">
                {copy.callbackTitle}
              </h1>
              <p className="mt-2 text-ui-sm leading-relaxed text-pretty text-foreground-subtle">
                {copy.callbackDescription}
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
