import { useState, type ReactNode } from "react";
import {
  LanguagesIcon,
  LoaderCircleIcon,
  MonitorSmartphoneIcon,
  MoonIcon,
  ShieldCheckIcon,
  SunIcon,
} from "lucide-react";
import { NIBI_PROVIDER_ID } from "@nibi/shared";
import { NibiAppLogo } from "@nibi/ui/app-logo";
import { renderOAuthProviderIcon } from "@nibi/ui/oauth-provider-icon";
import { Button, updatePrefs } from "@nibi/ui";
import {
  applyThemeWithTransition,
  loadThemePreference,
  resolveTheme,
  type Theme,
} from "@nibi/ui/useTheme";
import type { WebOAuthProviderId } from "./browserOAuthCredentialRepo.js";
import {
  getWebAuthCopy,
  persistWebAuthLocale,
  resolveWebAuthLocale,
  type WebAuthLocale,
  type WebAuthPageCopy,
} from "./webAuthLocale.js";

interface WebLoginPageProps {
  onLogin: (provider: WebOAuthProviderId) => void;
}

// NIBI 4.0 的手机页只认自家账号中心：上游两个 provider 的代码仍在（分享页/兼容用），
// 但远控入口只给 NIBI 账号，避免用户拿另一个平台的账号登录后被中继判为"设备不属于你"。
const LOGIN_PROVIDERS = [NIBI_PROVIDER_ID] as const;

export function WebAuthPageShell({
  children,
}: {
  children: (context: { copy: WebAuthPageCopy; locale: WebAuthLocale }) => ReactNode;
}) {
  const [locale, setLocale] = useState<WebAuthLocale>(() => resolveWebAuthLocale());
  const [theme, setTheme] = useState<Theme>(() =>
    typeof window === "undefined" ? "nibi-light" : loadThemePreference(),
  );
  const copy = getWebAuthCopy(locale);
  const resolvedTheme =
    theme === "system" &&
    (typeof window === "undefined" || typeof window.matchMedia !== "function")
      ? "light"
      : resolveTheme(theme);

  const handleToggleLocale = () => {
    const nextLocale: WebAuthLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    persistWebAuthLocale(nextLocale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = nextLocale;
    }
    setLocale(nextLocale);
  };

  const handleToggleTheme = () => {
    const nextTheme: Theme = resolvedTheme === "dark" ? "nibi-light" : "nibi-dark";
    updatePrefs({ theme: nextTheme });
    setTheme(nextTheme);
    applyThemeWithTransition(nextTheme);
  };

  const localeLabel = locale === "zh-CN" ? copy.switchToEnglish : copy.switchToChinese;
  const themeLabel = resolvedTheme === "dark" ? copy.switchToLightTheme : copy.switchToDarkTheme;
  const ThemeIcon = resolvedTheme === "dark" ? SunIcon : MoonIcon;

  return (
    <main className="flex min-h-dvh flex-col bg-background pt-[calc(env(safe-area-inset-top)+12px)] pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+24px)] pl-[max(1rem,env(safe-area-inset-left))] text-foreground">
      <div className="mx-auto flex h-10 w-full max-w-md items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-2.5">
          <NibiAppLogo className="size-6 shrink-0 rounded-md shadow-xs" />
          <span className="text-ui-base font-semibold tracking-tight text-foreground">
            {copy.brand}
          </span>
          <span className="inline-flex shrink-0 items-center rounded-full border border-border bg-surface px-2.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
            {copy.remoteBadge}
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            data-testid="web-auth-locale-toggle"
            aria-label={localeLabel}
            title={localeLabel}
            onClick={handleToggleLocale}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-border/80 bg-card/85 px-2.5 text-ui-xs font-medium text-foreground shadow-2xs transition-[background-color,border-color,transform] duration-150 hover:border-border-hover hover:bg-hover active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <LanguagesIcon aria-hidden="true" className="size-3.5 text-foreground-subtle" />
            <span>{locale === "zh-CN" ? "EN" : "中"}</span>
          </button>
          <button
            type="button"
            data-testid="web-auth-theme-toggle"
            aria-label={themeLabel}
            title={themeLabel}
            onClick={handleToggleTheme}
            className="inline-flex size-8 items-center justify-center rounded-lg border border-border/80 bg-card/85 text-foreground shadow-2xs transition-[background-color,border-color,transform] duration-150 hover:border-border-hover hover:bg-hover active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <ThemeIcon aria-hidden="true" className="size-4" />
          </button>
        </div>
      </div>
      <div className="flex flex-1 items-center justify-center py-6">
        <section className="w-full max-w-sm rounded-2xl border border-card-border bg-card p-6 shadow-[var(--nibi-shadow-card)]">
          {children({ copy, locale })}
        </section>
      </div>
    </main>
  );
}

export function WebLoginPage({ onLogin }: WebLoginPageProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <WebAuthPageShell>
      {({ copy }) => (
        <>
          <div className="flex items-start gap-3.5">
            <NibiAppLogo className="size-11 rounded-xl shadow-xs" />
            <div className="min-w-0 flex-1">
              <h1 className="text-ui-xl font-semibold text-balance text-foreground">
                {copy.loginTitle}
              </h1>
              <p className="mt-1.5 text-ui-sm leading-relaxed text-pretty text-foreground-subtle">
                {copy.loginDescription}
              </p>
            </div>
          </div>

          <ul className="mt-5 space-y-2.5 rounded-xl border border-border bg-surface/80 p-3.5 text-ui-sm text-foreground-subtle">
            <li className="flex items-start gap-2.5">
              <MonitorSmartphoneIcon
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-primary"
              />
              <span className="min-w-0 text-pretty">{copy.loginHighlights[0]}</span>
            </li>
            <li className="flex items-start gap-2.5">
              <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
              <span className="min-w-0 text-pretty">{copy.loginHighlights[1]}</span>
            </li>
          </ul>

          <div className="mt-5 space-y-2">
            {LOGIN_PROVIDERS.map((provider) => (
              <Button
                key={provider}
                type="button"
                size="lg"
                className="h-12 w-full rounded-xl text-ui-base font-medium shadow-[var(--nibi-shadow-primary-btn)]"
                disabled={isSubmitting}
                onClick={() => {
                  setIsSubmitting(true);
                  onLogin(provider);
                }}
              >
                {isSubmitting ? (
                  <LoaderCircleIcon
                    aria-hidden="true"
                    className="size-4 animate-spin motion-reduce:animate-none"
                  />
                ) : (
                  renderOAuthProviderIcon(provider, "size-4")
                )}
                <span>{copy.loginAction[provider]}</span>
                {copy.loginRegion[provider] ? (
                  <span className="ml-1 inline-flex h-5 shrink-0 items-center rounded-full border border-primary-foreground/35 px-2 text-ui-xs font-medium leading-none text-primary-foreground/90">
                    {copy.loginRegion[provider]}
                  </span>
                ) : null}
              </Button>
            ))}
          </div>
        </>
      )}
    </WebAuthPageShell>
  );
}
