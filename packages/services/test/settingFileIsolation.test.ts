import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSettingService } from "../src/setting/settingService.js";

// 回归：setting.json 必须遵守 NIBI_SETTINGS_DIR。
//
// 2026-10-22 实测缺陷：工厂里直接写死 `join(resolveUserHomeDir(), ".nibi", "v2", "setting.json")`，
// 绕过了这个覆盖 —— dev 实例把语言与 lastActiveWorkspace 写进了真实用户的 ~/.nibi。
// 症状是"跑一次开发端，正式端的设置被改了"，而所有门禁都是绿的。
const originalSettingsDir = process.env.NIBI_SETTINGS_DIR;
const originalHome = process.env.HOME;
const originalDesktopHome = process.env.NIBI_DESKTOP_HOME_DIR;
const dirs: string[] = [];

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  restore("NIBI_SETTINGS_DIR", originalSettingsDir);
  restore("HOME", originalHome);
  restore("NIBI_DESKTOP_HOME_DIR", originalDesktopHome);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "nibi-settings-dir-"));
  dirs.push(dir);
  return dir;
}

describe("setting.json 的落点", () => {
  it("NIBI_SETTINGS_DIR 生效：写进隔离目录，而不是 home", async () => {
    const home = tempRoot();
    const isolated = tempRoot();
    process.env.HOME = home;
    delete process.env.NIBI_DESKTOP_HOME_DIR;
    process.env.NIBI_SETTINGS_DIR = isolated;

    const service = createSettingService();
    await service.update({ locale: "en-US" });

    const inIsolated = readFileSync(join(isolated, "setting.json"), "utf8");
    expect(JSON.parse(inIsolated).locale).toBe("en-US");
    // 真实 home 下绝不能出现 setting.json
    expect(() => readFileSync(join(home, ".nibi", "v2", "setting.json"), "utf8")).toThrow();
  });

  it("未设置 NIBI_SETTINGS_DIR 时仍落在 home 下的 .nibi/v2（未设置行为不变）", async () => {
    const home = tempRoot();
    process.env.HOME = home;
    delete process.env.NIBI_DESKTOP_HOME_DIR;
    delete process.env.NIBI_SETTINGS_DIR;

    const service = createSettingService();
    await service.update({ locale: "zh-CN" });

    const json = JSON.parse(readFileSync(join(home, ".nibi", "v2", "setting.json"), "utf8"));
    expect(json.locale).toBe("zh-CN");
  });
});
