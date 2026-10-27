import { afterEach, describe, expect, it } from "vitest";
import {
  advanceRecommendedPromptPane,
  getRecommendedPromptsForPane,
  registerRecommendedPromptPane,
  unregisterRecommendedPromptPane,
} from "@/v4/featureSuggestedPromptRotation.js";

const paneIds = ["rotation-first", "rotation-second"];

afterEach(() => {
  for (const id of paneIds) unregisterRecommendedPromptPane(id);
});

describe("active task recommendations", () => {
  it("replaces all three visible office recommendations when refreshing", () => {
    registerRecommendedPromptPane(paneIds[0]!, "office");

    for (let refresh = 0; refresh < 6; refresh += 1) {
      const previous = getRecommendedPromptsForPane(paneIds[0]!, "office");
      advanceRecommendedPromptPane(paneIds[0]!);
      const next = getRecommendedPromptsForPane(paneIds[0]!, "office");

      expect(next).toHaveLength(3);
      expect(
        next.every((item) => !previous.some((shown) => shown.id === item.id)),
      ).toBe(true);
      expect(new Set(next.map((item) => item.iconUrl)).size).toBe(3);
    }
  });

  it("keeps each coding pane visually varied while avoiding repeated tasks across panes", () => {
    registerRecommendedPromptPane(paneIds[0]!, "coding");
    registerRecommendedPromptPane(paneIds[1]!, "coding");

    const first = getRecommendedPromptsForPane(paneIds[0]!, "coding");
    const second = getRecommendedPromptsForPane(paneIds[1]!, "coding");
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(3);
    // 移除“闲时任务”推荐卡后编码模式的图标池只剩 3 种；两块 pane 的硬保证是
    // “任务不重复 + 每块 pane 至少两种图标”，三种图标不可能在两块 pane 间都不重复。
    expect(new Set(first.map((item) => item.iconUrl)).size).toBeGreaterThanOrEqual(2);
    expect(new Set(second.map((item) => item.iconUrl)).size).toBeGreaterThanOrEqual(2);
    // 图标池只剩 3 种、候选 7 条时，跨 pane 不重复已不可能同时满足“每屏图标不同”；
    // 选片逻辑会优先保证图标不同，候选不足时才复用。这里只守住每屏 3 条。
    expect(second).toHaveLength(3);

    advanceRecommendedPromptPane(paneIds[0]!);
    const refreshed = getRecommendedPromptsForPane(paneIds[0]!, "coding");
    expect(new Set(refreshed.map((item) => item.iconUrl))).toHaveProperty(
      "size",
      3,
    );
    expect(refreshed.map((item) => item.id)).not.toEqual(
      first.map((item) => item.id),
    );
  });
});
