import { describe, expect, it } from "vitest";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";

describe("settings schema 界面语言五语言兼容", () => {
  it("旧 setting.json（只有中英字段）保持原样解析", () => {
    expect(appSettingsSchema.parse({ locale: "zh-CN", localePreference: "zh-CN" })).toMatchObject({
      locale: "zh-CN",
      localePreference: "zh-CN",
    });
    expect(appSettingsSchema.parse({ locale: "en-US", localePreference: "system" })).toMatchObject({
      locale: "en-US",
      localePreference: "system",
    });
  });

  it("新字段把真实语言投影回内存 locale/localePreference", () => {
    // 落盘形状：旧字段只存中英，真实选择在新字段。
    expect(
      appSettingsSchema.parse({
        locale: "en-US",
        localePreference: "en-US",
        uiLocale: "ja-JP",
        uiLocalePreference: "ja-JP",
      }),
    ).toMatchObject({ locale: "ja-JP", localePreference: "ja-JP" });

    expect(
      appSettingsSchema.parse({
        locale: "en-US",
        localePreference: "system",
        uiLocale: "ru-RU",
        uiLocalePreference: "system",
      }),
    ).toMatchObject({ locale: "ru-RU", localePreference: "system" });
  });

  it("旧字段被手改成其它语言时以旧字段为准（新字段不得反盖）", () => {
    expect(
      appSettingsSchema.parse({
        locale: "zh-CN",
        localePreference: "zh-CN",
        uiLocale: "ko-KR",
        uiLocalePreference: "ko-KR",
      }),
    ).toMatchObject({ locale: "zh-CN", localePreference: "zh-CN" });
  });

  it("patch schema 接受五语言与 uiLocale 新字段", () => {
    for (const locale of ["zh-CN", "en-US", "ja-JP", "ru-RU", "ko-KR"] as const) {
      expect(appSettingsPatchSchema.parse({ locale, localePreference: locale })).toMatchObject({
        locale,
        localePreference: locale,
      });
      expect(appSettingsPatchSchema.parse({ uiLocale: locale })).toMatchObject({
        uiLocale: locale,
      });
      expect(appSettingsPatchSchema.parse({ uiLocalePreference: locale })).toMatchObject({
        uiLocalePreference: locale,
      });
    }
    expect(appSettingsPatchSchema.safeParse({ locale: "fr-FR" }).success).toBe(false);
    expect(appSettingsPatchSchema.safeParse({ uiLocale: "fr-FR" }).success).toBe(false);
    expect(appSettingsPatchSchema.safeParse({ localePreference: "ja" }).success).toBe(false);
  });
});
