import { describe, expect, it } from "vitest";
import {
  PLUGIN_HOOK_EVENT_NAMES,
  PLUGIN_HOOK_EVENT_SUPPORT,
  PLUGIN_HOOK_RUNNABLE_EVENT_NAMES,
  resolvePluginHookEventSupport,
} from "../src/hooks/index.js";

// 计划 §9.5：每个可声明事件都必须有支持度登记，runnable 集合与内核派发集合一致，
// 不可派发的事件必须给出原因。漏一个事件就红——防止新增事件时悄悄变成「声明了但永远不触发」。
describe("插件 hook 事件支持度登记表", () => {
  it("覆盖全部可声明事件，且每个事件只登记一次", () => {
    const registered = PLUGIN_HOOK_EVENT_SUPPORT.map((entry) => entry.event);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...registered].sort()).toEqual([...PLUGIN_HOOK_EVENT_NAMES].sort());
  });

  it("runnable 集合与内核派发集合完全一致", () => {
    const runnable = PLUGIN_HOOK_EVENT_SUPPORT.filter((entry) => entry.runnable).map(
      (entry) => entry.event,
    );
    expect([...runnable].sort()).toEqual([...PLUGIN_HOOK_RUNNABLE_EVENT_NAMES].sort());
  });

  it("不可派发的事件必须写明原因", () => {
    for (const entry of PLUGIN_HOOK_EVENT_SUPPORT) {
      if (entry.runnable) {
        expect(entry.reason, `${entry.event} 可派发时不应带 reason`).toBeUndefined();
      } else {
        expect(entry.reason?.trim(), `${entry.event} 缺少不可派发原因`).toBeTruthy();
      }
    }
  });

  it("按名字查询支持度；未登记名字返回 undefined", () => {
    expect(resolvePluginHookEventSupport("PreToolUse")?.runnable).toBe(true);
    expect(resolvePluginHookEventSupport("TeammateIdle")?.runnable).toBe(false);
    expect(resolvePluginHookEventSupport("FutureEvent")).toBeUndefined();
  });
});
