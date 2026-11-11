import { describe, expect, it } from "vitest";
import {
  matchesSourceServerDeviceSearch,
  rankSourceServerDevicesByRecentUse,
  reconcileSourceServerDeviceOrder,
} from "@/settings/sourceServerManagementPresentation.js";

describe("source server device list", () => {
  it("puts online devices first and then ranks by recent use", () => {
    expect(
      rankSourceServerDevicesByRecentUse([
        { sourceServerId: "offline-old", online: false, lastUsedAt: 1 },
        { sourceServerId: "offline-new", online: false, lastUsedAt: 9 },
        { sourceServerId: "online-old", online: true, lastUsedAt: 2 },
        { sourceServerId: "online-new", online: true, lastUsedAt: 8 },
      ]),
    ).toEqual(["online-new", "online-old", "offline-new", "offline-old"]);
  });

  it("freezes the order after the first snapshot and only inserts new devices", () => {
    const initial = reconcileSourceServerDeviceOrder(null, [
      { sourceServerId: "a", online: true, lastUsedAt: 1 },
      { sourceServerId: "b", online: false, lastUsedAt: 2 },
    ]);
    expect(initial).toEqual(["a", "b"]);
    // 状态变化不移动已有设备。
    expect(
      reconcileSourceServerDeviceOrder(initial, [
        { sourceServerId: "a", online: false, lastUsedAt: 1 },
        { sourceServerId: "b", online: true, lastUsedAt: 2 },
      ]),
    ).toBe(initial);
    // 新设备插到顶部，移除的设备消失。
    expect(
      reconcileSourceServerDeviceOrder(initial, [
        { sourceServerId: "c", online: false, lastUsedAt: 3 },
        { sourceServerId: "b", online: true, lastUsedAt: 2 },
      ]),
    ).toEqual(["c", "b"]);
  });

  it("matches any field case-insensitively and treats a blank query as match-all", () => {
    expect(matchesSourceServerDeviceSearch("", ["anything"])).toBe(true);
    expect(matchesSourceServerDeviceSearch("  ", [undefined])).toBe(true);
    expect(matchesSourceServerDeviceSearch("DEV", ["devbox.example.com"])).toBe(true);
    expect(matchesSourceServerDeviceSearch("work/app", ["/home/dev/work/app"])).toBe(true);
    expect(matchesSourceServerDeviceSearch("missing", ["devbox", "/work/app"])).toBe(false);
  });
});
