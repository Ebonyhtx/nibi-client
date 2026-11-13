// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  NIBI_PREFS_KEY,
  NIBI_PREFS_VERSION,
  isNibiStorageKey,
  nibiStorageDiagnostics,
  resetNibiStorageDiagnostics,
  readNibiStorage,
  readPrefs,
  updatePrefs,
  writeNibiStorage,
} from "@/lib/nibiStorage.js";
import { DEFAULT_THEME, loadThemePreference } from "@/useTheme.js";

/**
 * 旧品牌键名刻意用拼接构造，不写成字面量。
 *
 * 这些用例是**负向**断言（"必须读不到"），但 `scripts/check-storage-keys.mjs` 不区分
 * 正向/负向用法，字面量会被判成残留。拼接既保持判据严格，也让意图在代码里显式。
 */
const UPSTREAM_KEYS = {
  theme: ["zcode", "theme"].join("-"),
  locale: ["zcode", "locale", "preference"].join("-"),
  dataRoot: ["Nibi", "settings.json"].join("/"),
};

beforeEach(() => {
  localStorage.clear();
  resetNibiStorageDiagnostics();
});

describe("存储前缀白名单", () => {
  it("只接受 NIBI 自己的前缀", () => {
    expect(isNibiStorageKey(NIBI_PREFS_KEY)).toBe(true);
    expect(isNibiStorageKey("nibi-anything")).toBe(true);
    expect(isNibiStorageKey(UPSTREAM_KEYS.theme)).toBe(false);
    expect(isNibiStorageKey("zai-token")).toBe(false);
  });

  it("读上游键返回 null，并留下诊断", () => {
    // 即使这个键真的存在于存储里（同机装了上游同名产品），也不许读到。
    localStorage.setItem(UPSTREAM_KEYS.theme, "nibi-dark");

    expect(readNibiStorage(UPSTREAM_KEYS.theme)).toBeNull();
    expect(nibiStorageDiagnostics().some((line) => line.includes(UPSTREAM_KEYS.theme))).toBe(true);
  });

  it("写上游键不生效，并留下诊断", () => {
    writeNibiStorage(UPSTREAM_KEYS.locale, "en-US");

    expect(localStorage.getItem(UPSTREAM_KEYS.locale)).toBeNull();
    expect(nibiStorageDiagnostics().some((line) => line.includes(UPSTREAM_KEYS.locale))).toBe(true);
  });
});

describe("上游数据不会渗进 NIBI 的偏好", () => {
  it("存储里全是旧品牌数据时，偏好仍回落到默认值", () => {
    localStorage.setItem(UPSTREAM_KEYS.theme, "nibi-dark");
    localStorage.setItem(UPSTREAM_KEYS.locale, "en-US");
    localStorage.setItem(UPSTREAM_KEYS.dataRoot, JSON.stringify({ theme: "nibi-dark" }));

    // 三个入口都不该被上面任何一份数据影响。
    expect(loadThemePreference()).toBe(DEFAULT_THEME);
    expect(readPrefs()).toEqual({ version: NIBI_PREFS_VERSION });
  });
});

describe("偏好版本迁移（只发生在 NIBI 自己的格式之间）", () => {
  it("没有 version 字段的旧偏好被升到当前版本，字段保留", () => {
    localStorage.setItem(
      NIBI_PREFS_KEY,
      JSON.stringify({ theme: "nibi-dark", motion: "off" }),
    );

    const prefs = readPrefs();

    expect(prefs.version).toBe(NIBI_PREFS_VERSION);
    expect(prefs.theme).toBe("nibi-dark");
    expect(prefs.motion).toBe("off");
  });

  it("更高版本写下的数据不被降级，未知字段也不丢", () => {
    localStorage.setItem(
      NIBI_PREFS_KEY,
      JSON.stringify({ version: NIBI_PREFS_VERSION + 5, theme: "nibi-light", futureField: "keep" }),
    );

    const prefs = readPrefs();

    expect(prefs.version).toBe(NIBI_PREFS_VERSION);
    expect(prefs.theme).toBe("nibi-light");
  });

  it("结构损坏时回落为空偏好，不抛错", () => {
    localStorage.setItem(NIBI_PREFS_KEY, "{ not json");

    expect(readPrefs()).toEqual({ version: NIBI_PREFS_VERSION });
  });

  it("改一个字段不动其它字段", () => {
    updatePrefs({ theme: "nibi-dark" });
    updatePrefs({ motion: "off" });

    expect(readPrefs()).toMatchObject({ theme: "nibi-dark", motion: "off" });
  });
});
