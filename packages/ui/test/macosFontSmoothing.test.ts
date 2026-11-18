// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastMessage } from "@nibi/services";
import { createNibiStore } from "../src/store/index.js";
import {
  applyMacFontSmoothingEnabled,
  MACOS_FONT_SMOOTHING_CLASS,
  MACOS_FONT_SMOOTHING_STORAGE_KEY,
  normalizeMacFontSmoothingEnabled,
  persistMacFontSmoothingEnabled,
  readMacFontSmoothingEnabled,
  shouldShowMacFontSmoothingSetting,
} from "../src/settings/macosFontSmoothing.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove(MACOS_FONT_SMOOTHING_CLASS);
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove(MACOS_FONT_SMOOTHING_CLASS);
});

describe("macosFontSmoothing", () => {
  it("默认开启；缺省、空值与非法值都按开启处理", () => {
    expect(readMacFontSmoothingEnabled()).toBe(true);
    expect(normalizeMacFontSmoothingEnabled(undefined)).toBe(true);
    expect(normalizeMacFontSmoothingEnabled(null)).toBe(true);
    expect(normalizeMacFontSmoothingEnabled("yes")).toBe(true);
    expect(normalizeMacFontSmoothingEnabled(false)).toBe(false);
    expect(normalizeMacFontSmoothingEnabled("false")).toBe(false);
  });

  it("写入关闭后移除 :root class，重新开启恢复", () => {
    expect(persistMacFontSmoothingEnabled(true)).toBe(true);
    expect(localStorage.getItem(MACOS_FONT_SMOOTHING_STORAGE_KEY)).toBe("true");
    expect(document.documentElement.classList.contains(MACOS_FONT_SMOOTHING_CLASS)).toBe(true);

    expect(persistMacFontSmoothingEnabled(false)).toBe(false);
    expect(localStorage.getItem(MACOS_FONT_SMOOTHING_STORAGE_KEY)).toBe("false");
    expect(document.documentElement.classList.contains(MACOS_FONT_SMOOTHING_CLASS)).toBe(false);
    expect(readMacFontSmoothingEnabled()).toBe(false);

    applyMacFontSmoothingEnabled(true);
    expect(document.documentElement.classList.contains(MACOS_FONT_SMOOTHING_CLASS)).toBe(true);
  });

  it("仅 macOS 桌面显示设置入口", () => {
    expect(shouldShowMacFontSmoothingSetting({ isDesktop: true, isMacDesktop: true })).toBe(true);
    expect(shouldShowMacFontSmoothingSetting({ isDesktop: true, isMacDesktop: false })).toBe(false);
    expect(shouldShowMacFontSmoothingSetting({ isDesktop: false, isMacDesktop: true })).toBe(false);
    expect(shouldShowMacFontSmoothingSetting({})).toBe(false);
  });
});

function createBroadcastStub() {
  let handler: (message: BroadcastMessage) => void = () => {};
  return {
    send: vi.fn(),
    onMessage: (next: (message: BroadcastMessage) => void) => {
      handler = next;
    },
    emit(message: BroadcastMessage) {
      handler(message);
    },
  };
}

describe("macOS font smoothing store sync", () => {
  it("store 默认开启并落地 :root class", () => {
    const store = createNibiStore(createBroadcastStub() as never);

    expect(store.getState().macFontSmoothingEnabled).toBe(true);
    expect(document.documentElement.classList.contains(MACOS_FONT_SMOOTHING_CLASS)).toBe(true);
  });

  it("本窗口切换会广播，其他窗口消息会同步状态与 localStorage", () => {
    const broadcast = createBroadcastStub();
    const store = createNibiStore(broadcast as never);

    store.getState().setMacFontSmoothingEnabled(false);
    expect(store.getState().macFontSmoothingEnabled).toBe(false);
    expect(localStorage.getItem(MACOS_FONT_SMOOTHING_STORAGE_KEY)).toBe("false");
    expect(document.documentElement.classList.contains(MACOS_FONT_SMOOTHING_CLASS)).toBe(false);
    expect(broadcast.send).toHaveBeenCalledWith({
      channel: "state:macFontSmoothingEnabled",
      payload: false,
    });

    broadcast.emit({ channel: "state:macFontSmoothingEnabled", payload: true });
    expect(store.getState().macFontSmoothingEnabled).toBe(true);
    expect(localStorage.getItem(MACOS_FONT_SMOOTHING_STORAGE_KEY)).toBe("true");
    expect(document.documentElement.classList.contains(MACOS_FONT_SMOOTHING_CLASS)).toBe(true);
  });
});