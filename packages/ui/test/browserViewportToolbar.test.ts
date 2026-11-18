import { describe, expect, it } from "vitest";
import {
  BROWSER_VIEWPORT_DEVICE_PRESETS,
  resolveBrowserViewportDevicePresetId,
} from "@/browser-use/browserViewportPresets.js";
import {
  BROWSER_ADDRESS_BAR_COMPACT_WIDTH_REM,
  isBrowserAddressBarCompact,
} from "@/browser-use/browserAddressBarModel.js";

describe("浏览器设备预设", () => {
  it("提供手机/平板/桌面/幻灯片四档快捷尺寸", () => {
    expect(BROWSER_VIEWPORT_DEVICE_PRESETS).toEqual([
      { id: "phone", width: 390, height: 844 },
      { id: "tablet", width: 834, height: 1112 },
      { id: "desktop", width: 1440, height: 900 },
      { id: "slide", width: 1920, height: 1080 },
    ]);
  });

  it("当前尺寸命中预设时返回预设 id，否则回退自定义", () => {
    expect(resolveBrowserViewportDevicePresetId({ width: 390, height: 844 })).toBe("phone");
    expect(resolveBrowserViewportDevicePresetId({ width: 1920, height: 1080 })).toBe("slide");
    expect(resolveBrowserViewportDevicePresetId({ width: 800, height: 600 })).toBe("custom");
    expect(resolveBrowserViewportDevicePresetId({ width: 390, height: 845 })).toBe("custom");
  });
});

describe("窄地址栏阈值", () => {
  it("按 9rem 判断，默认根字号 16px 时阈值是 144px", () => {
    expect(BROWSER_ADDRESS_BAR_COMPACT_WIDTH_REM).toBe(9);
    expect(isBrowserAddressBarCompact(143)).toBe(true);
    expect(isBrowserAddressBarCompact(144)).toBe(false);
    expect(isBrowserAddressBarCompact(0)).toBe(false);
    expect(isBrowserAddressBarCompact(Number.NaN)).toBe(false);
  });

  it("跟随根字号缩放阈值", () => {
    expect(isBrowserAddressBarCompact(160, 20)).toBe(true);
    expect(isBrowserAddressBarCompact(180, 20)).toBe(false);
  });
});