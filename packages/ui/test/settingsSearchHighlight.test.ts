// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findSettingsSearchTarget,
  highlightSettingsSearchTarget,
  SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE,
  SETTINGS_SEARCH_HIGHLIGHT_DURATION_MS,
  SETTINGS_SEARCH_TARGET_ATTRIBUTE,
} from "../src/settings-search/settingsSearchHighlight.js";

function makeTarget(root: HTMLElement, targetId: string): HTMLElement {
  const target = document.createElement("div");
  target.setAttribute(SETTINGS_SEARCH_TARGET_ATTRIBUTE, targetId);
  target.scrollIntoView = vi.fn();
  root.append(target);
  return target;
}

let root: HTMLElement;

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement("div");
  document.body.append(root);
});

afterEach(() => {
  root.remove();
  vi.useRealTimers();
});

describe("settingsSearchHighlight", () => {
  it("滚动到设置项并高亮 2 秒后自动取消", () => {
    const target = makeTarget(root, "appearance.fontSmoothing");

    const cleanup = highlightSettingsSearchTarget(root, "appearance.fontSmoothing");

    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(target.getAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE)).toBe("true");

    vi.advanceTimersByTime(SETTINGS_SEARCH_HIGHLIGHT_DURATION_MS - 1);
    expect(target.getAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE)).toBe("true");

    vi.advanceTimersByTime(1);
    expect(target.getAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE)).toBeNull();
    cleanup();
  });

  it("目标项缺失时回退到分区标题", () => {
    const section = makeTarget(root, "section:appearance");

    highlightSettingsSearchTarget(root, "appearance.missing", {
      fallbackTargetId: "section:appearance",
    });

    expect(section.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(section.getAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE)).toBe("true");
  });

  it("清理函数立即取消高亮和定时器", () => {
    const target = makeTarget(root, "appearance.motion");
    const cleanup = highlightSettingsSearchTarget(root, "appearance.motion");

    cleanup();
    expect(target.getAttribute(SETTINGS_SEARCH_HIGHLIGHT_ATTRIBUTE)).toBeNull();
  });

  it("找不到目标时不产生副作用", () => {
    expect(findSettingsSearchTarget(root, "missing")).toBeNull();
    expect(() => highlightSettingsSearchTarget(root, "missing")).not.toThrow();
  });
});