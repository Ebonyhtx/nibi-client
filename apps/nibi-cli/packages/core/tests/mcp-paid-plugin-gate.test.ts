import { describe, expect, it, vi } from "vitest";
import type { McpPort } from "@nibi/contracts";
import { registerMcpTools, type McpToolPaidGate } from "../src/mcp/index.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createSessionId, createRootTraceContext } from "@nibi/contracts";
import type { ToolExecutionContext } from "../src/tool/types.js";

function mockPort(callTool = vi.fn(async () => ({ content: [] }))): McpPort {
  return {
    callTool,
    close: async () => {},
    connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
    connectServer: async () => ({
      status: "connected",
      toolCount: 1,
      transport: "stdio",
      updatedAt: "now",
    }),
    disconnectServer: async () => undefined,
    listTools: async () => [],
    status: async () => ({}),
  };
}

function context(): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: createSessionId("paid-gate"),
    toolCallId: "tool-paid",
    traceContext: createRootTraceContext({ sessionId: createSessionId("paid-gate") }),
    traceId: "trace-paid" as never,
    workingDirectory: "/tmp/project",
    workspaceRoot: "/tmp/project",
  } as ToolExecutionContext;
}

const DESCRIPTOR = {
  inputSchema: { properties: {}, type: "object" as const },
  serverName: "plugin:math-modeling:tools",
  toolName: "solve",
};

const SERVER_MAP = new Map([["plugin:math-modeling:tools", "math-modeling@nibi-official"]]);

describe("MCP 付费插件执行期门禁", () => {
  it("注册期就被拒的插件不进入工具表", () => {
    const registry = createToolRegistry();
    const registered = registerMcpTools(registry, mockPort(), [DESCRIPTOR], {
      paidPluginGate: () => ({ allowed: false, message: "会员已到期" }),
      pluginIdByServerName: SERVER_MAP,
    });
    expect(registered).toEqual([]);
    expect(registry.get("mcp__plugin_math-modeling_tools__solve")).toBeUndefined();
  });

  it("注册期放行、调用时到期：handler 抛出门禁消息且不调用底层 MCP", async () => {
    const registry = createToolRegistry();
    const callTool = vi.fn(async () => ({ content: [] }));
    let allowed = true;
    const gate: McpToolPaidGate = () => ({ allowed, message: "会员已到期，续费后可继续使用" });
    registerMcpTools(registry, mockPort(callTool), [DESCRIPTOR], {
      paidPluginGate: gate,
      pluginIdByServerName: SERVER_MAP,
    });
    const entry = registry.get("mcp__plugin_math-modeling_tools__solve");
    expect(entry).toBeDefined();
    await expect(entry?.handler({}, context())).resolves.toBeDefined();

    allowed = false;
    await expect(entry?.handler({}, context())).rejects.toThrow(/会员已到期/u);
    // 被拒的调用绝不能穿透到 MCP server。
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("门禁拿到的是拆分后的插件身份", () => {
    const seen: unknown[] = [];
    registerMcpTools(createToolRegistry(), mockPort(), [DESCRIPTOR], {
      paidPluginGate: (plugin) => {
        seen.push(plugin);
        return { allowed: true };
      },
      pluginIdByServerName: SERVER_MAP,
    });
    expect(seen).toEqual([
      { id: "math-modeling@nibi-official", marketplace: "nibi-official", name: "math-modeling" },
    ]);
  });
});
