import type { Locale } from "@nibi/shared";
import zhCN from "./locales/zh-CN.js";
import enUS from "./locales/en-US.js";
import jaJP from "./locales/ja-JP.js";
import ruRU from "./locales/ru-RU.js";
import koKR from "./locales/ko-KR.js";

/**
 * 语言 → 翻译消息映射。IntlProvider 与 ErrorBoundary 共用这一份。
 * 日/俄/韩文案表来自上游 3.18.2 的人工翻译，只包含 NIBI 使用的 key；缺失时回退 en-US，
 * 避免界面直接露出 key 或回落到中文。中文表是完整的，不需要合并。
 */
export const LOCALE_MESSAGES: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
  "ja-JP": { ...enUS, ...jaJP },
  "ru-RU": { ...enUS, ...ruRU },
  "ko-KR": { ...enUS, ...koKR },
};
