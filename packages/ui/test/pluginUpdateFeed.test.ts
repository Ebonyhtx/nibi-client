import { describe, expect, it, beforeEach } from "vitest";
import {
  PLUGIN_UPDATE_CHECK_INTERVAL_MS,
  claimPluginUpdateCheck,
  countUpdatablePlugins,
  resetPluginUpdateFeedForTests,
  shouldCheckPluginUpdates,
} from "../src/settings/pluginUpdateFeed.js";

// 商店外发现插件更新：判据必须「跨重启用 lastUpdated 节流 + 同会话防抖」，
// 否则每次打开工作区都会发一次可能 30s 超时的目录刷新。
describe("插件更新检查节流", () => {
  beforeEach(() => resetPluginUpdateFeedForTests());

  const now = Date.parse("2026-10-26T08:00:00.000Z");

  it("目录刷新在窗口内 → 不检查", () => {
    expect(
      shouldCheckPluginUpdates({
        lastUpdated: new Date(now - 60_000).toISOString(),
        now,
      }),
    ).toBe(false);
  });

  it("目录刷新超过窗口 → 检查", () => {
    expect(
      shouldCheckPluginUpdates({
        lastUpdated: new Date(now - PLUGIN_UPDATE_CHECK_INTERVAL_MS - 1).toISOString(),
        now,
      }),
    ).toBe(true);
  });

  it("没有 lastUpdated（从未成功刷新）→ 检查", () => {
    expect(shouldCheckPluginUpdates({ now })).toBe(true);
  });

  it("本次会话已尝试过（哪怕失败）→ 不再重复", () => {
    expect(claimPluginUpdateCheck("nibi-official", undefined, now)).toBe(true);
    expect(claimPluginUpdateCheck("nibi-official", undefined, now + 60_000)).toBe(false);
  });

  it("lastUpdated 比尝试时间新时，按新的算（手动刷新后重置窗口）", () => {
    expect(claimPluginUpdateCheck("nibi-official", undefined, now)).toBe(true);
    const refreshedAt = new Date(now + 1_000).toISOString();
    expect(
      claimPluginUpdateCheck("nibi-official", refreshedAt, now + PLUGIN_UPDATE_CHECK_INTERVAL_MS),
    ).toBe(false);
  });

  it("lastUpdated 是非法时间串时按「未知」处理（检查一次）", () => {
    expect(shouldCheckPluginUpdates({ lastUpdated: "not-a-date", now })).toBe(true);
  });
});

describe("可更新数量统计", () => {
  it("只数 update-available / version-changed", () => {
    expect(
      countUpdatablePlugins([
        { updateStatus: "update-available" },
        { updateStatus: "version-changed" },
        { updateStatus: "none" },
        {},
        { updateStatus: undefined },
      ]),
    ).toBe(2);
  });

  it("没有列表或全为 none → 0", () => {
    expect(countUpdatablePlugins(undefined)).toBe(0);
    expect(countUpdatablePlugins([])).toBe(0);
    expect(countUpdatablePlugins([{ updateStatus: "none" }])).toBe(0);
  });
});
