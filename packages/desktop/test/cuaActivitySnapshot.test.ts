import { describe, expect, it } from "vitest";

import {
  cuaActivityEventFromSnapshot,
  cuaActivityKey,
} from "../src/host/cuaActivitySnapshot.js";

describe("cuaActivityEventFromSnapshot", () => {
  it("daemon 模式：保留坐标 + summary，并把 nativeCursor 放进事件（曾经漏掉）", () => {
    const event = cuaActivityEventFromSnapshot({
      active: true,
      session_id: "sess-1",
      action: "left_click",
      summary: "点击「7」",
      x: 757,
      y: 473,
      native_cursor: true,
      at: 1_700_000_000_000,
    });
    expect(event).toEqual({
      active: true,
      sessionId: "sess-1",
      action: "left_click",
      summary: "点击「7」",
      x: 757,
      y: 473,
      nativeCursor: true,
      at: 1_700_000_000_000,
    });
  });

  it("进程内模式：没有 native_cursor 时不带 nativeCursor（indicator 画自有光标）", () => {
    const event = cuaActivityEventFromSnapshot({
      active: true,
      action: "left_click",
      x: 10,
      y: 20,
      native_cursor: false,
    });
    expect(event.nativeCursor).toBeUndefined();
    expect(event.x).toBe(10);
    expect(event.y).toBe(20);
  });

  it("inactive：动作名退化成 idle，空摘要不占字段（引擎模式标记保留）", () => {
    const event = cuaActivityEventFromSnapshot(
      { active: false, action: null, summary: "   ", native_cursor: true },
      123,
    );
    expect(event).toEqual({
      active: false,
      sessionId: null,
      action: "idle",
      nativeCursor: true,
      at: 123,
    });
  });
});

describe("cuaActivityKey", () => {
  it("nativeCursor / summary 变化都会触发重发", () => {
    const base = cuaActivityEventFromSnapshot({ active: true, action: "left_click", x: 1, y: 2 });
    const withNative = cuaActivityEventFromSnapshot({
      active: true,
      action: "left_click",
      x: 1,
      y: 2,
      native_cursor: true,
    });
    const withSummary = cuaActivityEventFromSnapshot({
      active: true,
      action: "left_click",
      x: 1,
      y: 2,
      summary: "点击",
    });
    expect(cuaActivityKey(base)).not.toBe(cuaActivityKey(withNative));
    expect(cuaActivityKey(base)).not.toBe(cuaActivityKey(withSummary));
  });
});
