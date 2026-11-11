import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createSessionId,
  createTraceId,
  type McpConnectionSnapshot,
  type McpPort,
  type PermissionBrokerPort,
  type PermissionBrokerRequest,
  type SessionEventStorePort,
  type SessionId,
} from "@nibi/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

describe("AgentRuntime MCP integration", () => {
  it("keeps the session resident while detached MCP startup is pending", async () => {
    const sessionId = createSessionId("runtime-mcp-residency");
    const startup = deferred<McpConnectionSnapshot>();
    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        mcpPort: createMockMcpPort({
          connectConfiguredServers: async () => startup.promise,
        }),
      },
    );

    expect(runtime.hasResidencyBlockingWork()).toBe(true);
    startup.resolve(emptyMcpSnapshot());
    await runtime.startMcpStartup({
      sessionId,
      traceId: createTraceId("runtime-mcp-residency"),
    });
    expect(runtime.hasResidencyBlockingWork()).toBe(false);
  });

  it("starts configured MCP servers when the runtime is constructed", () => {
    const sessionId = createSessionId("runtime-mcp-startup");
    const eventStore = createTestSessionEventStore();
    let connectCalls = 0;
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => {
        connectCalls++;
        return emptyMcpSnapshot();
      },
    });

    createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
      },
    );

    expect(connectCalls).toBe(1);
  });

  it("passes a 15s OAuth authorization wait limit to session MCP startup", () => {
    const sessionId = createSessionId("runtime-mcp-oauth-timeout");
    const eventStore = createTestSessionEventStore();
    let connectOptions: Parameters<McpPort["connectConfiguredServers"]>[1];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async (_servers, options) => {
        connectOptions = options;
        return emptyMcpSnapshot();
      },
    });

    createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            notion: {
              type: "http",
              url: "https://mcp.example.test/mcp",
              oauth: {
                type: "authorization_code",
              },
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
      },
    );

    expect(connectOptions?.oauthAuthorizationTimeoutMs).toBe(15_000);
  });

  it("emits turn_started before pending MCP startup resolves and waits before model request", async () => {
    const sessionId = createSessionId("runtime-mcp-background-startup");
    const eventStore = createTestSessionEventStore();
    const startup = deferred<McpConnectionSnapshot>();
    let modelRequestCount = 0;
    let toolNames: string[] = [];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => startup.promise,
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelRequestCount++;
            toolNames = request.tools.map((tool: { name: string }) => tool.name);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    const turn = runtime.executeTurn("use mcp if needed");
    await waitForEvent(eventStore, sessionId, SessionEventType.TurnStarted);
    expect(modelRequestCount).toBe(0);

    startup.resolve({
      statuses: {
        local: {
          status: "connected",
          transport: "stdio",
          toolCount: 1,
          updatedAt: "now",
        },
      },
      tools: [
        {
          serverName: "local",
          toolName: "ping",
          inputSchema: {
            type: "object",
            properties: {},
          },
          annotations: {
            readOnlyHint: true,
          },
        },
      ],
    });

    await turn;
    expect(modelRequestCount).toBe(1);
    expect(toolNames).toContain("mcp__local__ping");
  });

  it("registers configured MCP tools before the first model request", async () => {
    const sessionId = createSessionId("runtime-mcp-tools");
    const eventStore = createTestSessionEventStore();
    let toolNames: string[] = [];
    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          local: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "local",
            toolName: "ping",
            inputSchema: {
              type: "object",
              properties: {},
            },
            annotations: {
              readOnlyHint: true,
            },
          },
        ],
      }),
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "build",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            toolNames = request.tools.map((tool: { name: string }) => tool.name);
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    await runtime.executeTurn("use mcp if needed");

    expect(toolNames).toContain("mcp__local__ping");
  });

  // A1（7eb98256）后的正确语义：Plan 闸门对「非只读、非 destructive」的 MCP 工具是
  // **询问**而不是直接放行，也不能给「始终允许」——否则 Plan 会比 build 更宽
  // （EnterPlanMode 本身免确认，任何 MCP 写工具都能绕过审批）。这条用例因此断言
  // 「询问一次 → 用户批准 → 执行」，并钉住 no-always-allow。
  it("asks before running non-destructive MCP tools in plan mode without readOnlyHint", async () => {
    const sessionId = createSessionId("runtime-mcp-plan-mode");
    const eventStore = createTestSessionEventStore();
    let modelCallCount = 0;
    let mcpCallCount = 0;
    let permissionRequestCount = 0;
    let permissionRequest: PermissionBrokerRequest | undefined;

    const permissionBroker: PermissionBrokerPort = {
      async requestPermission(request) {
        permissionRequestCount++;
        permissionRequest = request;
        return { decision: "allow" };
      },
    };

    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          local: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "local",
            toolName: "lookup",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
          },
        ],
      }),
      callTool: async (request) => {
        mcpCallCount++;
        return {
          content: [{ type: "text", text: `lookup:${request.arguments?.query}` }],
        };
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: {
            local: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        permissionBroker,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelCallCount++;
            if (modelCallCount === 1) {
              expect(request.tools.map((tool: { name: string }) => tool.name)).toContain(
                "mcp__local__lookup",
              );
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "I will look this up.",
                toolCalls: [
                  {
                    id: "mcp-lookup",
                    name: "mcp__local__lookup",
                    input: { query: "plan context" },
                  },
                ],
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            expect(
              request.messages.some((message: any) => {
                return (
                  message.role === "tool" && String(message.content).includes("lookup:plan context")
                );
              }),
            ).toBe(true);

            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("use mcp while planning");

    expect(result.response).toBe("done");
    expect(mcpCallCount).toBe(1);
    expect(permissionRequestCount).toBe(1);
    // Plan 下不许记住「始终允许」：规则不能跳过这个询问。
    expect(permissionRequest?.optionsPolicy).toBe("no-always-allow");
    expect(permissionRequest?.ruleId).toBe("mode.plan.mcp");
  });

  it("denies destructive MCP tools in plan mode before calling the MCP server", async () => {
    const sessionId = createSessionId("runtime-mcp-plan-destructive");
    const eventStore = createTestSessionEventStore();
    let modelCallCount = 0;
    let mcpCallCount = 0;
    let secondRequest: any;

    const mcpPort = createMockMcpPort({
      connectConfiguredServers: async () => ({
        statuses: {
          device: {
            status: "connected",
            transport: "stdio",
            toolCount: 1,
            updatedAt: "now",
          },
        },
        tools: [
          {
            serverName: "device",
            toolName: "reset",
            inputSchema: {
              type: "object",
              properties: {},
            },
            annotations: {
              destructiveHint: true,
            },
          },
        ],
      }),
      callTool: async () => {
        mcpCallCount++;
        return { content: [{ type: "text", text: "should-not-run" }] };
      },
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      {
        mode: "plan",
        mcp: {
          enabled: true,
          servers: {
            device: {
              type: "stdio",
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
      {
        eventStore,
        mcpPort,
        modelFactory: createTestModelFactory({
          async generateText(request: any) {
            modelCallCount++;
            if (modelCallCount === 1) {
              return {
                finishReason: "tool-calls",
                providerMetadata: undefined,
                text: "I will reset the device.",
                toolCalls: [
                  {
                    id: "mcp-reset",
                    name: "mcp__device__reset",
                    input: {},
                  },
                ],
                usage: {
                  inputTokens: 1,
                  outputTokens: 1,
                  totalTokens: 2,
                },
              };
            }

            secondRequest = request;
            return {
              finishReason: "stop",
              providerMetadata: undefined,
              text: "done",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
              },
            };
          },
        } as never),
      },
    );

    const result = await runtime.executeTurn("do not mutate while planning");
    const toolMessage = secondRequest.messages.find((message: any) => message.role === "tool");

    expect(result.response).toBe("done");
    expect(mcpCallCount).toBe(0);
    expect(toolMessage?.content).toContain(
      "Plan mode only allows read-only, non-destructive tools",
    );
  });
});

function createMockMcpPort(overrides: Partial<McpPort> = {}): McpPort {
  return {
    connectConfiguredServers: async () => emptyMcpSnapshot(),
    connectServer: async () => ({
      status: "connected",
      transport: "stdio",
      toolCount: 1,
      updatedAt: "now",
    }),
    disconnectServer: async () => undefined,
    status: async () => ({}),
    listTools: async () => [],
    callTool: async () => ({ content: [{ type: "text", text: "pong" }] }),
    close: async () => {},
    ...overrides,
  };
}

function emptyMcpSnapshot(): McpConnectionSnapshot {
  return {
    statuses: {},
    tools: [],
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
} {
  let reject!: (error: unknown) => void;
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function waitForEvent(
  eventStore: SessionEventStorePort,
  sessionId: SessionId,
  type: string,
): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    const events = await eventStore.getEvents(sessionId);
    if (events.some((event) => event.type === type)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for event: ${type}`);
}
