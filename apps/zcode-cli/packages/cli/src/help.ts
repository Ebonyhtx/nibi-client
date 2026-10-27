import { getZCodeCopy, type SupportedLocale, type UiLocale } from "@nibi/i18n";

export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  return getZCodeCopy(locale, detectedLocale).cli.help(version);
}
