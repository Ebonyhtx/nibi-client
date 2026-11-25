import { useEffect, useState } from "react";
import { AlertCircleIcon } from "lucide-react";
import { Button } from "@nibi/ui";
import type { WebAuthCallbackResult, WebAuthService } from "./webAuthService.js";
import { WebAuthPageShell } from "./WebLoginPage.js";

interface WebCallbackPageProps {
  authService: Pick<WebAuthService, "handleCallback">;
  onSuccess: (result: WebAuthCallbackResult) => void;
  onRetry: () => void;
}

export function WebCallbackPage({ authService, onRetry, onSuccess }: WebCallbackPageProps) {
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
    <WebAuthPageShell>
      {({ copy }) =>
        error ? (
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
            <p className="mt-4 rounded-xl border border-border bg-surface/80 px-3.5 py-2.5 font-mono text-ui-xs leading-relaxed break-words text-foreground-subtle">
              {error}
            </p>
            <Button
              type="button"
              size="lg"
              className="mt-5 h-12 w-full rounded-xl text-ui-base font-medium shadow-[var(--nibi-shadow-primary-btn)]"
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
        )
      }
    </WebAuthPageShell>
  );
}
