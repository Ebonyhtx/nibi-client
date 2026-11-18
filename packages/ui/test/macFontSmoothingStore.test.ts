// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BroadcastMessage } from "@nibi/services";
import { createNibiStore } from "../src/store/index.js";
import {
  MACOS_FONT_SMOOTHING_CLASS,
  MACOS_FONT_SMOOTHING_STORAGE_KEY,
} from "../src/settings/macosFontSmoothing.js";

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

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove(MACOS_FONT_SMOOTHING_CLASS);
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove(MACOS_FONT_SMOOTHING_CLASS);
});

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