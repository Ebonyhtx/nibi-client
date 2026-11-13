import type { UiLocale, SupportedLocale } from "@nibi/contracts";
import { enUS } from "./locales/en-US.js";
import { zhCN } from "./locales/zh-CN.js";
import {
  DEFAULT_LOCALE,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./locale.js";
import type { NibiCopy } from "./types.js";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
};
export type { LocaleDetectionInput } from "./locale.js";
export type { CliCopy, TuiCopy, UiLocale, SupportedLocale, NibiCopy } from "./types.js";

const CATALOGS: Record<SupportedLocale, NibiCopy> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

export function getNibiCopy(locale?: UiLocale | string, detected?: string | null): NibiCopy {
  return CATALOGS[resolveLocale(locale, detected)];
}
