import type { Locale } from "@nibi/shared";
import zhCN from "./locales/zh-CN.js";
import enUS from "./locales/en-US.js";

type LocaleMessageTable = Record<string, string>;

/**
 * 首屏同步语言只有 en-US（回退）和 zh-CN（默认中文界面）。
 * ja/ko/ru 文案表体积接近 1.5MB，改为切换语言时动态 import：
 * - 加载完成前用 en-US 兜底，界面不会出现空 key 或中文泄漏；
 * - 加载结果会原地补进 LOCALE_MESSAGES，ErrorBoundary 等同步读取方仍拿到完整表；
 * - 同一个语言只加载一次，失败后保留英文并允许下次重试。
 */
const LAZY_LOCALE_LOADERS = {
  "ja-JP": () => import("./locales/ja-JP.js"),
  "ru-RU": () => import("./locales/ru-RU.js"),
  "ko-KR": () => import("./locales/ko-KR.js"),
} as const satisfies Partial<
  Record<Locale, () => Promise<{ default: LocaleMessageTable }>>
>;

const lazyLocalePromises = new Map<Locale, Promise<LocaleMessageTable>>();

export const LOCALE_MESSAGES: Record<Locale, LocaleMessageTable> = {
  "zh-CN": zhCN,
  "en-US": enUS,
  "ja-JP": { ...enUS },
  "ru-RU": { ...enUS },
  "ko-KR": { ...enUS },
};

export function hasLazyLocaleMessages(locale: Locale): boolean {
  return locale in LAZY_LOCALE_LOADERS;
}

export function getLocaleMessages(locale: Locale): LocaleMessageTable {
  return LOCALE_MESSAGES[locale] ?? LOCALE_MESSAGES["en-US"];
}

export function loadLocaleMessages(locale: Locale): Promise<LocaleMessageTable> {
  const loader = LAZY_LOCALE_LOADERS[locale as keyof typeof LAZY_LOCALE_LOADERS];
  if (!loader) {
    return Promise.resolve(getLocaleMessages(locale));
  }

  const existing = lazyLocalePromises.get(locale);
  if (existing) {
    return existing;
  }

  const promise = Promise.resolve()
    .then(() => loader())
    .then((module) => {
      // 与原来的静态合并表保持同一语义：英文补齐缺失 key，显式翻译覆盖英文。
      const merged = { ...enUS, ...module.default };
      LOCALE_MESSAGES[locale] = merged;
      return merged;
    })
    .catch(() => {
      // 加载失败不阻断界面：继续使用 en-US，并允许下次语言切换重新尝试。
      lazyLocalePromises.delete(locale);
      return getLocaleMessages(locale);
    });

  lazyLocalePromises.set(locale, promise);
  return promise;
}
