import { describe, expect, it, vi } from "vitest";
import { createSessionId, createTraceId } from "@nibi/contracts";
import type { AppSessionControlBinding } from "@nibi/contracts";
import type { AppTrustedContext } from "@nibi/session-control/contracts";
import { appSessionControlToolEntries } from "../src/tool/handlers/app-session-control.js";
import { appSessionControlForRuntime } from "../src/tool/session-control/contract.js";
import type { ToolEntry, ToolExecutionContext } from "../src/tool/types.js";

const SESSION_ID = createSessionId("sess_app_root");
const WORKSPACE = "/workspace";

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    sessionId: SESSION_ID,
    toolCallId: "toolu_app_1",
    traceId: createTraceId(),
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
    ...overrides,
  };
}

function binding(
  control: Partial<AppSessionControlBinding["control"]> = {},
): AppSessionControlBinding {
  const trusted: AppTrustedContext = {
    callerId: `app:${SESSION_ID}`,
    rootSession: {
      kind: "app",
      workspacePath: WORKSPACE,
      sessionId: SESSION_ID,
    },
    allowedScopes: [{ kind: "app", scope: "host" }],
    discoveryScopes: [],
  };
  return {
    kind: "app",
    control: {
      listProjects: vi.fn(async () => ({ projects: [], searchScope: { scopes: [], unavailableSources: [] } })),
      openSession: vi.fn(async () => ({ status: "unavailable" as const, reason: "no window" })),
      setSessionArchived: vi.fn(async (_ctx, input) => ({
        status: "applied" as const,
        requestId: input.requestId,
      })),
      setSessionPinned: vi.fn(async (_ctx, input) => ({
        status: "applied" as const,
        requestId: input.requestId,
      })),
      ...control,
    },
    context: () => trusted,
  };
}

function entry(name: string): ToolEntry {
  const found = appSessionControlToolEntries.find((item) => item.metadata.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("App session control tools", () => {
  it("registers the 4 tools with App permissions and deferred metadata", () => {
    expect(appSessionControlToolEntries.map((item) => item.metadata.name)).toEqual([
      "ListProjects",
      "OpenSession",
      "SetSessionArchived",
      "SetSessionPinned",
    ]);
    for (const item of appSessionControlToolEntries) {
      expect(item.metadata.shouldDefer).toBe(true);
      expect(item.metadata.maxOutputBytes).toBe(32_768);
      expect(item.permission?.permission).toMatch(/^session_control\./);
    }
    expect(entry("ListProjects").metadata.readOnly).toBe(true);
    expect(entry("ListProjects").metadata.needsApproval).toBe(false);
    expect(entry("OpenSession").metadata.needsApproval).toBe(true);
    expect(entry("SetSessionArchived").metadata.needsApproval).toBe(true);
    expect(entry("SetSessionPinned").metadata.needsApproval).toBe(true);
  });

  it("fails closed without an App binding", async () => {
    await expect(entry("ListProjects").handler({}, context())).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("rejects subagents even when the root session matches", async () => {
    await expect(
      entry("ListProjects").handler(
        {},
        context({ appSessionControl: binding(), runtimeScope: "subagent" }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a binding whose root session differs from the executing session", async () => {
    const other = binding();
    await expect(
      entry("ListProjects").handler(
        {},
        context({ appSessionControl: other, sessionId: createSessionId("sess_other") }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("injects retryOf, else the tool call id, as requestId", async () => {
    const control = binding();
    const entryArchived = entry("SetSessionArchived");
    await entryArchived.handler(
      { sessionId: "sess_target", archived: true },
      context({ appSessionControl: control }),
    );
    await entryArchived.handler(
      { sessionId: "sess_target", archived: true, retryOf: "req-retry" },
      context({ appSessionControl: control }),
    );
    expect(control.control.setSessionArchived).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ sessionId: "sess_target", archived: true, requestId: "toolu_app_1" }),
    );
    expect(control.control.setSessionArchived).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({ requestId: "req-retry" }),
    );
  });

  it("rejects a mutation receipt that echoes a different requestId", async () => {
    const control = binding({
      setSessionPinned: vi.fn(async () => ({ status: "applied", requestId: "someone-else" })),
    });
    await expect(
      entry("SetSessionPinned").handler(
        { sessionId: "sess_target", pinned: true },
        context({ appSessionControl: control }),
      ),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("parses ListProjects and OpenSession results strictly", async () => {
    const control = binding({
      listProjects: vi.fn(async () => ({
        projects: [
          {
            project: { kind: "app", projectId: "proj-1", sourceServerId: "src-1" },
            title: "Alpha",
          },
        ],
        searchScope: {
          scopes: [{ kind: "app", scope: "host" }],
          unavailableSources: [{ sourceServerId: "src-offline", reason: "offline" }],
        },
      })),
      openSession: vi.fn(async () => ({ status: "opened", uiTarget: "window:1" })),
    });
    await expect(
      entry("ListProjects").handler({ query: "a" }, context({ appSessionControl: control })),
    ).resolves.toMatchObject({ projects: [{ title: "Alpha" }] });
    await expect(
      entry("OpenSession").handler(
        { sessionId: "sess_target" },
        context({ appSessionControl: control }),
      ),
    ).resolves.toEqual({ status: "opened", uiTarget: "window:1" });
  });

  it("rejects an unknown status from the App host", async () => {
    const control = binding({
      openSession: vi.fn(async () => ({ status: "opened_elsewhere" })),
    });
    await expect(
      entry("OpenSession").handler(
        { sessionId: "sess_target" },
        context({ appSessionControl: control }),
      ),
    ).rejects.toMatchObject({ code: "invalid_output" });
  });
});

describe("appSessionControlForRuntime", () => {
  it("gates App bindings by task type, root session and subagent scope", () => {
    const control = binding();
    expect(appSessionControlForRuntime(control, "interactive", SESSION_ID)).toBe(control);
    expect(appSessionControlForRuntime(control, "fork", SESSION_ID)).toBe(control);
    expect(appSessionControlForRuntime(control, "workflow_parent", SESSION_ID)).toBe(control);
    expect(appSessionControlForRuntime(control, "workflow_child", SESSION_ID)).toBeUndefined();
    expect(appSessionControlForRuntime(control, "subagent_child", SESSION_ID)).toBeUndefined();
    expect(appSessionControlForRuntime(control, "interactive", "sess_other")).toBeUndefined();
    expect(appSessionControlForRuntime(control, "interactive", SESSION_ID, "subagent")).toBeUndefined();
    expect(appSessionControlForRuntime(undefined, "interactive", SESSION_ID)).toBeUndefined();
  });
});