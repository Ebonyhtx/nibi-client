import { describe, expect, it, vi } from "vitest";
import type { PluginReferenceCatalog } from "@nibi/contracts";
import {
  assertPaidPluginExecutionAllowed,
  assertPluginAgentExecutionAllowed,
  createToolPluginExecutionGate,
  resolvePluginAgentOwnerIds,
} from "../src/runtime/plugin-execution-gate.js";

const catalog: PluginReferenceCatalog = {
  plugins: [
    {
      conflictingPluginIds: [],
      enabled: true,
      marketplace: "nibi-official",
      mcpServerNames: [],
      name: "math-modeling",
      pluginId: "math-modeling@nibi-official",
      rootPath: "/plugins/math",
      skillQualifiedNames: ["math-modeling:solve"],
      subagentNames: ["math-modeling:proof-reader"],
    },
    {
      conflictingPluginIds: [],
      enabled: true,
      marketplace: "other-market",
      mcpServerNames: [],
      name: "unpaid",
      pluginId: "unpaid@other-market",
      rootPath: "/plugins/unpaid",
      skillQualifiedNames: [],
      subagentNames: ["unpaid:helper"],
    },
  ],
};

describe("PaidPluginGate 执行期复核", () => {
  it("放行时安静返回", () => {
    expect(() =>
      assertPaidPluginExecutionAllowed(() => ({ allowed: true }), "math-modeling@nibi-official"),
    ).not.toThrow();
  });

  it("拒绝时抛出 gate 给的用户文案", () => {
    expect(() =>
      assertPaidPluginExecutionAllowed(
        () => ({ allowed: false, message: "会员已到期，续费后可继续使用" }),
        "math-modeling@nibi-official",
      ),
    ).toThrow(/会员已到期/u);
  });

  it("缺省 gate 或拿不到 pluginId 时不拦", () => {
    expect(() => assertPaidPluginExecutionAllowed(undefined, "x@y")).not.toThrow();
    expect(() => assertPaidPluginExecutionAllowed(() => ({ allowed: false }), undefined)).not.toThrow();
    // 坏 id 不猜归属：与发现层一致，按「非付费」放行。
    expect(() => assertPaidPluginExecutionAllowed(() => ({ allowed: false }), "no-marketplace")).not.toThrow();
  });

  it("只按精确 pluginId 判定，不做前缀匹配", () => {
    const gate = vi.fn(() => ({ allowed: false, message: "denied" }));
    expect(() => assertPaidPluginExecutionAllowed(gate, "math-modeling@nibi-official")).toThrow();
    expect(gate).toHaveBeenCalledWith({
      id: "math-modeling@nibi-official",
      marketplace: "nibi-official",
      name: "math-modeling",
    });
  });
});

describe("子代理归属与门禁", () => {
  it("按 catalog 的 subagentNames 找回声明插件", () => {
    expect(resolvePluginAgentOwnerIds(catalog, "math-modeling:proof-reader")).toEqual([
      "math-modeling@nibi-official",
    ]);
    // 内置 agent 不属于任何插件 → 空数组。
    expect(resolvePluginAgentOwnerIds(catalog, "general-purpose")).toEqual([]);
  });

  it("插件子代理在派发前被拦", () => {
    const gate = (plugin: { id: string }) =>
      plugin.id === "math-modeling@nibi-official"
        ? { allowed: false, message: "会员已到期" }
        : { allowed: true };
    expect(() =>
      assertPluginAgentExecutionAllowed(gate, catalog, "math-modeling:proof-reader"),
    ).toThrow(/会员已到期/u);
    // 非插件 agent 不受影响。
    expect(() => assertPluginAgentExecutionAllowed(gate, catalog, "general-purpose")).not.toThrow();
  });

  it("同名冲突时逐个复核（任一未授权即拒绝）", () => {
    const conflicting: PluginReferenceCatalog = {
      plugins: [
        { ...catalog.plugins[0]!, conflictingPluginIds: ["dup@b"], name: "dup" },
        { ...catalog.plugins[1]!, conflictingPluginIds: ["math-modeling@nibi-official"], name: "dup" },
      ],
    };
    // 两个插件都声明同一个 agent 名时，取交集逐个判定。
    for (const plugin of conflicting.plugins) plugin.subagentNames = ["dup:agent"];
    const gate = (plugin: { id: string }) =>
      plugin.id === "unpaid@other-market"
        ? { allowed: false, message: "not entitled" }
        : { allowed: true };
    expect(resolvePluginAgentOwnerIds(conflicting, "dup:agent")).toEqual([
      "math-modeling@nibi-official",
      "unpaid@other-market",
    ]);
    expect(() => assertPluginAgentExecutionAllowed(gate, conflicting, "dup:agent")).toThrow(
      /not entitled/u,
    );
  });
});

describe("工具上下文门禁工厂", () => {
  it("无 gate 时返回 undefined（嵌入方不拦）", () => {
    expect(createToolPluginExecutionGate(undefined)).toBeUndefined();
  });

  it("有 gate 时返回的函数每次调用都重新判定", () => {
    let allowed = true;
    const check = createToolPluginExecutionGate(() => ({ allowed, message: "到期" }));
    expect(() => check?.("a@b")).not.toThrow();
    allowed = false;
    expect(() => check?.("a@b")).toThrow(/到期/u);
  });
});
