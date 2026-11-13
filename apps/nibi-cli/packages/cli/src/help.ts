import { getNibiCopy, type SupportedLocale, type UiLocale } from "@nibi/i18n";

export function formatCliHelp(
  version: string,
  locale?: UiLocale,
  detectedLocale?: SupportedLocale,
): string {
  return getNibiCopy(locale, detectedLocale).cli.help(version);
}
