import { describe, expect, it } from "vitest";
import {
  LOCALE_NATIVE_NAMES,
  hasLegacyIncompatiblePersistedLocale,
  isLocale,
  isLocalePreference,
  resolveLocaleFromLanguageTag,
  resolvePersistedUiLocale,
  resolvePersistedUiLocalePreference,
  toLegacyPersistedLocalePreference,
  toPersistedSettingsLocaleFields,
  toZhOrEnLocale,
} from "../src/locale.js";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  type Locale,
  type LocalePreference,
} from "../src/protocol.js";

describe("supported locales", () => {
  it("暴露五个界面语言与本名，顺序即语言选择器顺序", () => {
    expect(SUPPORTED_LOCALES).toEqual(["zh-CN", "en-US", "ja-JP", "ru-RU", "ko-KR"]);
    expect(SUPPORTED_LOCALES.map((locale) => LOCALE_NATIVE_NAMES[locale])).toEqual([
      "中文简体",
      "English",
      "日本語",
      "Русский",
      "한국어",
    ]);
    expect(DEFAULT_LOCALE).toBe("zh-CN");
    for (const locale of SUPPORTED_LOCALES) {
      expect(isLocale(locale)).toBe(true);
      expect(isLocalePreference(locale)).toBe(true);
    }
    expect(isLocalePreference("system")).toBe(true);
    expect(isLocale("ja")).toBe(false);
    expect(isLocalePreference("fr-FR")).toBe(false);
  });
});

describe("resolveLocaleFromLanguageTag", () => {
  it.each([
    ["zh", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh_TW", "zh-CN"],
    ["ja", "ja-JP"],
    ["ja-JP", "ja-JP"],
    ["JA_jp", "ja-JP"],
    ["ko-KR", "ko-KR"],
    ["ko_KR", "ko-KR"],
    ["ru", "ru-RU"],
    ["ru-RU-u-ca-gregory", "ru-RU"],
    ["en-US", "en-US"],
    ["fr-FR", "en-US"],
    ["", "en-US"],
    [null, "en-US"],
    [undefined, "en-US"],
  ] as const)("%s → %s", (tag, expected) => {
    expect(resolveLocaleFromLanguageTag(tag)).toBe(expected);
  });

  it("只有中英内容的界面显式回退英文，不回落到中文", () => {
    expect(toZhOrEnLocale("zh-CN")).toBe("zh-CN");
    expect(toZhOrEnLocale("en-US")).toBe("en-US");
    for (const locale of ["ja-JP", "ru-RU", "ko-KR"] as const) {
      expect(toZhOrEnLocale(locale)).toBe("en-US");
    }
    expect(toZhOrEnLocale(undefined)).toBe("en-US");
  });
});

describe("setting.json 界面语言持久化", () => {
  const allLocales = SUPPORTED_LOCALES satisfies readonly Locale[];
  const allPreferences = ["system", ...allLocales] satisfies readonly LocalePreference[];

  it("真实语言写入新字段，旧字段始终降级为旧版本认识的值", () => {
    for (const locale of allLocales) {
      for (const localePreference of allPreferences) {
        const persisted = toPersistedSettingsLocaleFields({ locale, localePreference });
        expect(["zh-CN", "en-US"]).toContain(persisted.locale);
        expect(["system", "zh-CN", "en-US"]).toContain(persisted.localePreference);
        expect(persisted.uiLocale).toBe(locale);
        expect(persisted.uiLocalePreference).toBe(localePreference);
      }
    }
  });

  it("新字段优先，缺失时回落旧字段：读写往返保持真实语言", () => {
    for (const locale of allLocales) {
      for (const localePreference of allPreferences) {
        const persisted = toPersistedSettingsLocaleFields({ locale, localePreference });
        expect(resolvePersistedUiLocale({ ...persisted })).toBe(locale);
        expect(resolvePersistedUiLocalePreference({ ...persisted })).toBe(localePreference);
      }
    }
  });

  it("旧版本降级：新字段被 strip 后仍读到中英旧值，不会整份设置解析失败", () => {
    const persisted = toPersistedSettingsLocaleFields({
      locale: "ja-JP",
      localePreference: "ja-JP",
    });
    // 旧版本 schema 只认 zh-CN/en-US；降级后的旧字段必须能通过。
    expect(persisted.locale).toBe("en-US");
    expect(persisted.localePreference).toBe("en-US");
    expect(persisted.uiLocale).toBe("ja-JP");
    expect(toLegacyPersistedLocalePreference("ko-KR")).toBe("en-US");
    expect(toLegacyPersistedLocalePreference("system")).toBe("system");
  });

  it("手改旧字段时以旧字段为准，避免新字段把它盖回去", () => {
    expect(resolvePersistedUiLocale({ locale: "zh-CN", uiLocale: "ja-JP" })).toBe("zh-CN");
    expect(
      resolvePersistedUiLocalePreference({
        localePreference: "system",
        uiLocalePreference: "ja-JP",
      }),
    ).toBe("system");
    // 旧字段缺失时直接用新字段。
    expect(resolvePersistedUiLocale({ uiLocale: "ru-RU" })).toBe("ru-RU");
    expect(resolvePersistedUiLocalePreference({ uiLocalePreference: "ko-KR" })).toBe("ko-KR");
  });

  it("识别内部测试版写进旧字段的新语言，触发迁移落盘", () => {
    expect(hasLegacyIncompatiblePersistedLocale({ locale: "ja-JP" })).toBe(true);
    expect(hasLegacyIncompatiblePersistedLocale({ localePreference: "ko-KR" })).toBe(true);
    expect(
      hasLegacyIncompatiblePersistedLocale({ locale: "zh-CN", localePreference: "system" }),
    ).toBe(false);
    expect(hasLegacyIncompatiblePersistedLocale({})).toBe(false);
  });
});
