import { describe, expect, it } from "vitest";
import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  SubagentRow,
  ToolCallRow,
  UserInputRow,
} from "@nibi/shared/nibi-protocol-v4";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { LOCALE_MESSAGES } from "@/i18n/localeMessages.js";
import { buildAssistantWorkRenderItems } from "@/v4/conversationAssistantWorkItems.js";
import {
  buildAssistantSummaryWorkRenderItems,
  formatAssistantSummaryStatistics,
  getActiveAssistantSummaryItem,
  getAssistantSummaryChangeFiles,
  getAssistantSummaryIconItem,
  getAssistantSummaryTailRowId,
  getAssistantSummaryToolCategory,
  groupConsecutiveAssistantSummaries,
} from "@/v4/conversationSummaryGroups.js";
import { reconcileContinuousGroupIdentity } from "@/v4/useContinuousGroupKeys.js";

const SHOW_ALL_REASONING = { messageStreamShowReasoning: true } as const;

function buildRenderItems(
  rows: Parameters<typeof buildAssistantWorkRenderItems>[0],
  reasoningVisibility: Parameters<typeof buildAssistantWorkRenderItems>[1] = SHOW_ALL_REASONING,
  options?: Parameters<typeof buildAssistantWorkRenderItems>[2],
) {
  return buildAssistantWorkRenderItems(rows, reasoningVisibility, {
    ...options,
    enableChangesGrouping: options?.enableChangesGrouping ?? true,
  });
}

function toolCall(
  rowId: number,
  toolName: string,
  input: unknown,
  overrides: Partial<ToolCallRow> = {},
): ToolCallRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName,
    status: "success",
    input,
    inputText: JSON.stringify(input),
    ...overrides,
  };
}

function subagent(rowId: number, overrides: Partial<SubagentRow> = {}): SubagentRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "subagent",
    subagentType: "Explore",
    status: "running",
    summaryText: "正在分析工作区",
    childSessionId: `child-session-${rowId}`,
    ...overrides,
  };
}

function reasoning(rowId: number): ReasoningRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "reasoning",
    state: "complete",
    text: `reasoning-${rowId}`,
  };
}

describe("buildAssistantWorkRenderItems", () => {
  it("keeps a single Explore, Terminal, or Changes tool ungrouped", () => {
    expect(buildRenderItems([toolCall(1, "Read", { path: "package.json" })])).toMatchObject([
      { kind: "row", row: { rowId: 1 } },
    ]);
    expect(buildRenderItems([toolCall(2, "Bash", { command: "pnpm test" })])).toMatchObject([
      { kind: "row", row: { rowId: 2 } },
    ]);
    expect(
      buildRenderItems([toolCall(3, "Edit", { path: "package.json", newText: "{}" })]),
    ).toMatchObject([{ kind: "row", row: { rowId: 3 } }]);
  });

  it("groups two consecutive tools of the same display family", () => {
    expect(
      buildRenderItems([
        toolCall(1, "Read", { path: "package.json" }),
        toolCall(2, "Grep", { pattern: "group" }),
      ]),
    ).toMatchObject([{ kind: "exploreGroup", rows: [{ rowId: 1 }, { rowId: 2 }] }]);
    expect(
      buildRenderItems([
        toolCall(3, "Bash", { command: "pnpm test" }),
        toolCall(4, "Bash", { command: "pnpm lint" }),
      ]),
    ).toMatchObject([{ kind: "executeGroup", rows: [{ rowId: 3 }, { rowId: 4 }] }]);
    expect(
      buildRenderItems([
        toolCall(5, "Write", { file_path: "src/a.ts", content: "a" }),
        toolCall(6, "Edit", {
          file_path: "src/b.ts",
          old_string: "b",
          new_string: "c",
        }),
      ]),
    ).toMatchObject([{ kind: "changesGroup", rows: [{ rowId: 5 }, { rowId: 6 }] }]);
  });

  it("marks a terminal Explore group as stopped when a child was cancelled", () => {
    const items = buildRenderItems([
      toolCall(1, "Read", { path: "package.json" }),
      toolCall(2, "Grep", { pattern: "group" }, { status: "cancelled" }),
    ]);

    expect(items).toMatchObject([
      {
        kind: "exploreGroup",
        node: { toolCall: { status: "stopped" } },
        rows: [{ rowId: 1 }, { rowId: 2 }],
      },
    ]);
  });

  it("does not group same-family tools across a visible tool boundary", () => {
    const items = buildRenderItems([
      toolCall(1, "Read", { path: "src/a.ts" }),
      toolCall(2, "Edit", { path: "src/a.ts", newText: "a" }),
      toolCall(3, "Read", { path: "src/b.ts" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["row", "row", "row"]);
  });

  it("keeps reasoning outside without closing and lets an uncorrelated message close", () => {
    const rows = [
      toolCall(1, "mcp__computer-use__get_app_state", { app_ref: { pid: 691 } }),
      reasoning(2),
      {
        rowId: 3,
        turnId: "turn-1",
        createdAt: 1_700_000_000_003,
        createdAtSeq: 3,
        kind: "assistantText",
        text: "更新数据……",
        state: "complete",
      } satisfies ConversationRow,
      toolCall(4, "mcp__computer-use__left_click", {
        target: { type: "element", state_id: "s-1", index: 59 },
      }),
      toolCall(5, "Bash", { command: "pnpm test" }),
    ];

    const items = buildRenderItems(rows);

    expect(items.map((item) => item.kind)).toEqual(["cuaGroup", "row", "row", "cuaGroup", "row"]);
    const group = items[0];
    expect(group?.kind).toBe("cuaGroup");
    if (group?.kind !== "cuaGroup") throw new Error("expected CUA group");
    expect(group.key).toBe("cua:1");
    expect(group.node.toolCall.toolId).toBe("cua:tool-1");
    expect(group.node.toolCall.status).toBe("completed");
    expect(group.rows.map((row) => row.rowId)).toEqual([1]);
    expect(group.events.map((event) => event.row.rowId)).toEqual([1]);
  });

  it("keeps a tail CUA group active across reasoning and starts a new group after a tool boundary", () => {
    const first = buildRenderItems(
      [toolCall(1, "mcp__computer-use__list_apps", {}, { status: "running" })],
      SHOW_ALL_REASONING,
      { stageTailIsRunning: true },
    );
    const grown = buildRenderItems(
      [
        toolCall(1, "mcp__computer-use__list_apps", {}),
        reasoning(2),
        toolCall(3, "mcp__computer-use__get_app_state", {}, { status: "running" }),
      ],
      SHOW_ALL_REASONING,
      { stageTailIsRunning: true },
    );
    const bounded = buildRenderItems([
      toolCall(1, "mcp__computer-use__list_apps", {}),
      toolCall(2, "Read", { path: "package.json" }),
      toolCall(3, "mcp__computer-use__screenshot", {}),
    ]);

    const firstGroup = first[0];
    const grownGroup = grown[0];
    expect(firstGroup?.kind).toBe("cuaGroup");
    expect(grown.map((item) => item.kind)).toEqual(["cuaGroup", "row"]);
    expect(grownGroup?.kind).toBe("cuaGroup");
    if (firstGroup?.kind !== "cuaGroup" || grownGroup?.kind !== "cuaGroup") {
      throw new Error("expected stable CUA groups");
    }
    expect(grownGroup.key).toBe(firstGroup.key);
    expect(grownGroup.node.toolCall.toolId).toBe(firstGroup.node.toolCall.toolId);
    expect(grownGroup.node.toolCall.status).toBe("in_progress");
    expect(grownGroup.rows.map((row) => row.rowId)).toEqual([1, 3]);
    expect(bounded.map((item) => item.kind)).toEqual(["cuaGroup", "row", "cuaGroup"]);
  });

  it("does not group third-party computer-use names and honors the release gate", () => {
    const official = toolCall(1, "mcp__computer-use__wait", {});
    const thirdParty = toolCall(2, "mcp__third-party-computer-use__wait", {});

    expect(buildRenderItems([thirdParty]).map((item) => item.kind)).toEqual(["row"]);
    expect(
      buildAssistantWorkRenderItems([official], SHOW_ALL_REASONING, {
        enableCuaGrouping: false,
      }).map((item) => item.kind),
    ).toEqual(["row"]);
  });

  it("keeps Explore-compatible tools as individual rows when Explore grouping is disabled", () => {
    const rows = [
      toolCall(1, "Read", { path: "src/a.ts" }),
      toolCall(2, "Grep", { pattern: "test" }),
      toolCall(3, "Bash", { command: "rg test src" }),
    ];

    expect(
      buildAssistantWorkRenderItems(rows, SHOW_ALL_REASONING, {
        enableExploreGrouping: false,
      }).map((item) => item.kind),
    ).toEqual(["row", "row", "row"]);
  });

  it("keeps mutating Shell tools as individual rows when Terminal grouping is disabled", () => {
    const rows = [
      toolCall(1, "Bash", { command: "pnpm test" }),
      toolCall(2, "Bash", { command: "mkdir -p tmp/output" }),
    ];

    expect(
      buildAssistantWorkRenderItems(rows, SHOW_ALL_REASONING, {
        enableTerminalGrouping: false,
      }).map((item) => item.kind),
    ).toEqual(["row", "row"]);
  });

  it("keeps file-write tools as individual rows when Changes grouping uses the release default", () => {
    const rows = [
      toolCall(1, "Write", { file_path: "src/a.ts", content: "a" }),
      toolCall(2, "Edit", {
        file_path: "src/b.ts",
        old_string: "b",
        new_string: "c",
      }),
      toolCall(3, "ApplyPatch", {
        patch: "*** Begin Patch\n*** Add File: src/c.ts\n+c\n*** End Patch",
      }),
    ];

    expect(
      buildAssistantWorkRenderItems(rows, SHOW_ALL_REASONING).map((item) => item.kind),
    ).toEqual(["row", "row", "row"]);
  });

  it.each(["inputStreaming", "running"] as const)(
    "defers unclassified shell-family tools with status %s",
    (status) => {
      for (const toolName of ["Bash", "execute", "shell"]) {
        const pending = toolCall(
          1,
          toolName,
          {},
          {
            input: undefined,
            inputText: "",
            status,
          },
        );

        expect(buildRenderItems([pending])).toEqual([]);
      }
    },
  );

  it("classifies a deferred shell tool after its command arrives", () => {
    const readonly = toolCall(
      1,
      "Bash",
      { command: "rg test packages/ui" },
      { status: "inputStreaming" },
    );
    const executable = toolCall(2, "Bash", { command: "pnpm test" }, { status: "running" });

    expect(buildRenderItems([readonly])).toMatchObject([{ kind: "row", row: { rowId: 1 } }]);
    expect(buildRenderItems([executable])).toMatchObject([{ kind: "row", row: { rowId: 2 } }]);
  });

  it("keeps a running Explore tail stable while a later shell awaits its command", () => {
    const explore = toolCall(1, "Grep", { pattern: "renderer" });
    const pendingShell = toolCall(2, "Bash", undefined, {
      inputText: "",
      status: "inputStreaming",
    });

    const pendingItems = buildRenderItems([explore, pendingShell], SHOW_ALL_REASONING, {
      stageTailIsRunning: true,
    });
    expect(pendingItems).toHaveLength(1);
    expect(pendingItems[0]).toMatchObject({ kind: "row", row: { rowId: 1 } });

    const readonlyItems = buildRenderItems(
      [
        explore,
        toolCall(
          2,
          "Bash",
          { command: "ls packages/ui/src/ToolCallBlocks/renderers" },
          { status: "running" },
        ),
      ],
      SHOW_ALL_REASONING,
      { stageTailIsRunning: true },
    );
    const readonlyExplore = readonlyItems[0];
    expect(readonlyExplore?.kind).toBe("exploreGroup");
    if (readonlyExplore?.kind !== "exploreGroup") {
      throw new Error("expected readonly shell to join Explore");
    }
    expect(readonlyExplore.rows.map((row) => row.rowId)).toEqual([1, 2]);
    expect(readonlyExplore.node.toolCall.status).toBe("in_progress");

    const executeItems = buildRenderItems(
      [explore, toolCall(2, "Bash", { command: "pnpm test" }, { status: "running" })],
      SHOW_ALL_REASONING,
      { stageTailIsRunning: true },
    );
    expect(executeItems.map((item) => item.kind)).toEqual(["row", "row"]);
  });

  it("upgrades consecutive non-explore shell calls to a stable group", () => {
    const initialItems = buildRenderItems([
      toolCall(1, "Bash", { command: "pnpm install" }, { status: "running" }),
    ]);
    const grownItems = buildRenderItems(
      [
        toolCall(1, "Bash", { command: "pnpm install" }),
        toolCall(2, "Bash", { command: "pnpm test" }, { status: "running" }),
      ],
      SHOW_ALL_REASONING,
      { stageTailIsRunning: true },
    );
    const extendedItems = buildRenderItems(
      [
        toolCall(1, "Bash", { command: "pnpm install" }),
        toolCall(2, "Bash", { command: "pnpm test" }),
        toolCall(3, "Bash", { command: "pnpm lint" }, { status: "running" }),
      ],
      SHOW_ALL_REASONING,
      { stageTailIsRunning: true },
    );
    const initialExecute = initialItems[0];
    const grownExecute = grownItems[0];
    const extendedExecute = extendedItems[0];

    expect(initialExecute?.kind).toBe("row");
    expect(grownExecute?.kind).toBe("executeGroup");
    expect(extendedExecute?.kind).toBe("executeGroup");
    if (grownExecute?.kind !== "executeGroup" || extendedExecute?.kind !== "executeGroup") {
      throw new Error("expected stable execute groups");
    }

    expect(extendedExecute.key).toBe(grownExecute.key);
    expect(extendedExecute.node.toolCall.toolId).toBe(grownExecute.node.toolCall.toolId);
    expect(grownExecute.rows.map((row) => row.rowId)).toEqual([1, 2]);
    expect(grownExecute.node.toolCall.status).toBe("in_progress");
  });

  it("keeps child failures on execute children and stops at explore boundaries", () => {
    const items = buildRenderItems([
      toolCall(1, "Bash", { command: "pnpm install" }),
      toolCall(2, "Bash", { command: "pnpm build" }, { status: "error" }),
      toolCall(3, "Bash", { command: "git status" }),
      toolCall(4, "Bash", { command: "pnpm test" }, { status: "cancelled" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["executeGroup", "row", "row"]);
    const firstExecute = items[0];
    if (firstExecute?.kind !== "executeGroup") throw new Error("expected execute group");
    expect(firstExecute.node.toolCall.status).toBe("completed");
    expect(firstExecute.node.childToolCalls[1]?.toolCall.status).toBe("failed");
    expect(items[2]).toMatchObject({ kind: "row", row: { status: "cancelled" } });
  });

  it("merges execute calls across hidden later reasoning only", () => {
    const rows = [
      reasoning(1),
      toolCall(2, "Bash", { command: "pnpm install" }),
      reasoning(3),
      toolCall(4, "Bash", { command: "pnpm test" }),
    ];

    const hiddenItems = buildRenderItems(rows, {
      messageStreamShowReasoning: false,
      messageStreamFirstReasoningRowId: 1,
    });
    expect(hiddenItems.map((item) => item.kind)).toEqual(["row", "executeGroup"]);
    const hiddenExecute = hiddenItems[1];
    if (hiddenExecute?.kind !== "executeGroup") {
      throw new Error("expected merged execute group");
    }
    expect(hiddenExecute.rows.map((row) => row.rowId)).toEqual([2, 4]);

    expect(buildRenderItems(rows).map((item) => item.kind)).toEqual(["row", "row", "row", "row"]);
  });

  it("keeps an unclassified failed shell tool visible", () => {
    const failed = toolCall(
      1,
      "Bash",
      {},
      {
        error: { message: "Permission denied" },
        input: undefined,
        inputText: "",
        status: "error",
      },
    );

    expect(buildRenderItems([failed])).toMatchObject([
      { kind: "row", row: { rowId: 1, status: "error" } },
    ]);
  });

  it("groups consecutive read-only tool calls into one explore item", () => {
    const rows = [
      toolCall(1, "Read", { path: "package.json" }),
      toolCall(2, "Bash", { command: "rg test packages/ui" }),
    ];

    const items = buildRenderItems(rows);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "exploreGroup",
      rowId: 1,
    });
    const first = items[0];
    expect(first?.kind).toBe("exploreGroup");
    if (first?.kind !== "exploreGroup") {
      throw new Error("expected explore group");
    }
    expect(first.rows).toHaveLength(2);
  });

  it("upgrades read-only tools to an Explore group with stable identity", () => {
    const initialItems = buildRenderItems([
      toolCall(1, "Read", { path: "package.json" }, { status: "running" }),
    ]);
    const grownItems = buildRenderItems([
      toolCall(1, "Read", { path: "package.json" }, { status: "success" }),
      toolCall(2, "Bash", { command: "rg test packages/ui" }, { status: "running" }),
    ]);
    const extendedItems = buildRenderItems([
      toolCall(1, "Read", { path: "package.json" }),
      toolCall(2, "Bash", { command: "rg test packages/ui" }),
      toolCall(3, "Grep", { pattern: "renderer" }, { status: "running" }),
    ]);
    const initialExplore = initialItems[0];
    const grownExplore = grownItems[0];
    const extendedExplore = extendedItems[0];

    expect(initialExplore?.kind).toBe("row");
    expect(grownExplore?.kind).toBe("exploreGroup");
    expect(extendedExplore?.kind).toBe("exploreGroup");
    if (grownExplore?.kind !== "exploreGroup" || extendedExplore?.kind !== "exploreGroup") {
      throw new Error("expected stable explore groups");
    }

    expect(extendedExplore.key).toBe(grownExplore.key);
    expect(extendedExplore.node.toolCall.toolId).toBe(grownExplore.node.toolCall.toolId);
    expect(grownExplore.rows).toHaveLength(2);
  });

  it("derives Explore parent status from the running stage tail", () => {
    const completedItems = buildRenderItems(
      [
        toolCall(1, "Read", { path: "package.json" }),
        toolCall(2, "Grep", { pattern: "missing" }, { status: "error" }),
      ],
      SHOW_ALL_REASONING,
      { stageTailIsRunning: true },
    );
    const boundedItems = buildRenderItems([
      toolCall(1, "Read", { path: "missing.json" }, { status: "error" }),
      toolCall(2, "Grep", { pattern: "still-running" }, { status: "running" }),
      toolCall(3, "Bash", { command: "pnpm test" }, { status: "running" }),
    ]);
    const runningExplore = completedItems[0];
    const boundedExplore = boundedItems[0];

    expect(runningExplore?.kind).toBe("exploreGroup");
    expect(boundedExplore?.kind).toBe("exploreGroup");
    if (runningExplore?.kind !== "exploreGroup" || boundedExplore?.kind !== "exploreGroup") {
      throw new Error("expected explore groups");
    }

    expect(runningExplore.node.toolCall.status).toBe("in_progress");
    expect(runningExplore.node.childToolCalls[1]?.toolCall.status).toBe("failed");
    expect(boundedExplore.node.toolCall.status).toBe("completed");
    expect(boundedExplore.node.childToolCalls[1]?.toolCall.status).toBe("in_progress");
  });

  it("derives Execute parent status from the running stage tail", () => {
    const tailItems = buildRenderItems(
      [
        toolCall(1, "Bash", { command: "pnpm test" }),
        toolCall(2, "Bash", { command: "pnpm lint" }),
      ],
      SHOW_ALL_REASONING,
      { stageTailIsRunning: true },
    );
    const boundedItems = buildRenderItems(
      [
        toolCall(1, "Bash", { command: "pnpm test" }, { status: "running" }),
        toolCall(2, "Bash", { command: "pnpm lint" }),
        toolCall(3, "Read", { path: "package.json" }),
      ],
      SHOW_ALL_REASONING,
      { stageTailIsRunning: true },
    );
    const terminalItems = buildRenderItems([
      toolCall(1, "Bash", { command: "pnpm test" }, { status: "running" }),
      toolCall(2, "Bash", { command: "pnpm lint" }),
    ]);
    const tailExecute = tailItems[0];
    const boundedExecute = boundedItems[0];
    const terminalExecute = terminalItems[0];

    expect(tailExecute?.kind).toBe("executeGroup");
    expect(boundedExecute?.kind).toBe("executeGroup");
    expect(terminalExecute?.kind).toBe("executeGroup");
    if (
      tailExecute?.kind !== "executeGroup" ||
      boundedExecute?.kind !== "executeGroup" ||
      terminalExecute?.kind !== "executeGroup"
    ) {
      throw new Error("expected execute groups");
    }

    expect(tailExecute.node.toolCall.status).toBe("in_progress");
    expect(boundedExecute.node.toolCall.status).toBe("completed");
    expect(boundedExecute.node.childToolCalls[0]?.toolCall.status).toBe("in_progress");
    expect(terminalExecute.node.toolCall.status).toBe("completed");
  });

  it("merges explore calls across hidden later reasoning only", () => {
    const rows = [
      reasoning(1),
      toolCall(2, "Read", { path: "package.json" }),
      reasoning(3),
      toolCall(4, "Bash", { command: "rg test packages/ui" }),
    ];

    const hiddenReasoningItems = buildRenderItems(
      rows,
      {
        messageStreamShowReasoning: false,
        messageStreamFirstReasoningRowId: 1,
      },
      { stageTailIsRunning: true },
    );
    expect(hiddenReasoningItems.map((item) => item.kind)).toEqual(["row", "exploreGroup"]);
    const hiddenExplore = hiddenReasoningItems[1];
    expect(hiddenExplore?.kind).toBe("exploreGroup");
    if (hiddenExplore?.kind !== "exploreGroup") {
      throw new Error("expected merged explore group");
    }
    expect(hiddenExplore.rows.map((row) => row.rowId)).toEqual([2, 4]);
    expect(hiddenExplore.node.toolCall.status).toBe("in_progress");

    const visibleReasoningItems = buildRenderItems(rows, SHOW_ALL_REASONING, {
      stageTailIsRunning: true,
    });
    expect(visibleReasoningItems.map((item) => item.kind)).toEqual(["row", "row", "row", "row"]);
  });

  it("ends Explore and starts a Changes group for write tools", () => {
    const rows = [
      toolCall(1, "Read", { path: "package.json" }),
      toolCall(2, "Edit", { path: "package.json", newText: "{}" }),
      {
        rowId: 3,
        turnId: "turn-1",
        createdAt: 1_700_000_003,
        createdAtSeq: 3,
        kind: "assistantText",
        text: "done",
        state: "complete",
      } satisfies ConversationRow,
    ];

    const items = buildRenderItems(rows);

    expect(items.map((item) => item.kind)).toEqual(["row", "row", "row"]);
  });

  it("upgrades consecutive Write/Edit rows to a stable group", () => {
    const initial = buildRenderItems([
      toolCall(1, "Write", { file_path: "src/a.ts", content: "a" }),
    ]);
    const grown = buildRenderItems(
      [
        toolCall(1, "Write", { file_path: "src/a.ts", content: "a" }),
        toolCall(2, "Edit", {
          file_path: "src/b.ts",
          old_string: "b",
          new_string: "c",
        }),
      ],
      SHOW_ALL_REASONING,
      { stageTailIsRunning: true },
    );
    const extended = buildRenderItems(
      [
        toolCall(1, "Write", { file_path: "src/a.ts", content: "a" }),
        toolCall(2, "Edit", {
          file_path: "src/b.ts",
          old_string: "b",
          new_string: "c",
        }),
        toolCall(3, "Write", { file_path: "src/c.ts", content: "c" }),
      ],
      SHOW_ALL_REASONING,
      { stageTailIsRunning: true },
    );
    const first = initial[0];
    const next = grown[0];
    const last = extended[0];
    expect(first?.kind).toBe("row");
    expect(next?.kind).toBe("changesGroup");
    expect(last?.kind).toBe("changesGroup");
    if (next?.kind !== "changesGroup" || last?.kind !== "changesGroup")
      throw new Error("expected Changes groups");
    expect(last.key).toBe(next.key);
    expect(last.node.toolCall.toolId).toBe(next.node.toolCall.toolId);
    expect(next.rows.map((row) => row.rowId)).toEqual([1, 2]);
    expect(next.node.toolCall.status).toBe("in_progress");
  });

  it("completes Changes at visible boundaries without inheriting child cancellation", () => {
    const items = buildRenderItems([
      toolCall(
        1,
        "Edit",
        { file_path: "src/a.ts", old_string: "a", new_string: "b" },
        { status: "cancelled" },
      ),
      toolCall(2, "Write", { file_path: "src/b.ts", content: "b" }),
      toolCall(3, "Read", { path: "src/a.ts" }),
    ]);
    const changes = items[0];
    expect(changes?.kind).toBe("changesGroup");
    if (changes?.kind !== "changesGroup") throw new Error("expected Changes group");
    expect(changes.node.toolCall.status).toBe("completed");
    expect(changes.node.childToolCalls[0]?.toolCall.status).toBe("stopped");
  });

  it("merges Changes across hidden later reasoning but splits at visible reasoning", () => {
    const rows = [
      reasoning(1),
      toolCall(2, "Write", { file_path: "src/a.ts", content: "a" }),
      reasoning(3),
      toolCall(4, "Edit", { file_path: "src/b.ts", old_string: "b", new_string: "c" }),
    ];
    const hidden = buildRenderItems(rows, {
      messageStreamShowReasoning: false,
      messageStreamFirstReasoningRowId: 1,
    });
    expect(hidden.map((item) => item.kind)).toEqual(["row", "changesGroup"]);
    expect(buildRenderItems(rows).map((item) => item.kind)).toEqual(["row", "row", "row", "row"]);
  });

  it("pairs agent tool calls with subagent rows by parentToolCallId", () => {
    const rows = [
      toolCall(1, "Agent", {
        prompt: "分析当前工作区",
        subagent_type: "Explore",
      }),
      subagent(2, { parentToolCallId: "tool-1" }),
      toolCall(3, "Read", { path: "package.json" }),
    ];

    const items = buildRenderItems(rows);

    expect(items.map((item) => item.kind)).toEqual(["agentToolCall", "row"]);
    const agentItem = items[0];
    expect(agentItem?.kind).toBe("agentToolCall");
    if (agentItem?.kind !== "agentToolCall") {
      throw new Error("expected paired agent item");
    }
    expect(agentItem.row.rowId).toBe(1);
    expect(agentItem.subagentRow.rowId).toBe(2);
    expect(agentItem).not.toHaveProperty("showSubagentOutputPreview");
    expect(items.some((item) => item.kind === "row" && item.row.rowId === 2)).toBe(false);
  });

  it("keeps concurrent agent details bound when subagents spawn in reverse order", () => {
    const rows = [
      toolCall(1, "Agent", { description: "测试 general-purpose agent" }),
      toolCall(2, "Agent", { description: "测试 Explore agent" }),
      toolCall(3, "Agent", { description: "测试 test-hello2 agent" }),
      subagent(4, {
        childSessionId: "child-test-hello2",
        parentToolCallId: "tool-3",
        subagentType: "test-hello2",
      }),
      subagent(5, {
        childSessionId: "child-explore",
        parentToolCallId: "tool-2",
        subagentType: "Explore",
      }),
      subagent(6, {
        childSessionId: "child-general-purpose",
        parentToolCallId: "tool-1",
        subagentType: "general-purpose",
      }),
    ];

    const items = buildRenderItems(rows);
    const pairs = items.flatMap((item) =>
      item.kind === "agentToolCall" ? [[item.row.toolCallId, item.subagentRow.childSessionId]] : [],
    );

    expect(pairs).toEqual([
      ["tool-1", "child-general-purpose"],
      ["tool-2", "child-explore"],
      ["tool-3", "child-test-hello2"],
    ]);
  });

  it("only falls back for one unambiguous legacy pair", () => {
    const onePair = buildRenderItems([
      toolCall(1, "Agent", { description: "旧 Agent" }),
      subagent(2),
    ]);
    expect(onePair).toMatchObject([
      {
        kind: "agentToolCall",
        row: { rowId: 1 },
        subagentRow: { rowId: 2 },
      },
    ]);

    const ambiguous = buildRenderItems([
      toolCall(1, "Agent", { description: "旧 Agent A" }),
      toolCall(2, "Agent", { description: "旧 Agent B" }),
      subagent(3),
      subagent(4),
    ]);
    expect(ambiguous.some((item) => item.kind === "agentToolCall")).toBe(false);
    expect(ambiguous.map((item) => item.kind)).toEqual(["row", "row", "row", "row"]);
  });

  it("keeps background subagents paired without requesting an inline output preview", () => {
    const rows = [
      toolCall(1, "Agent", {
        prompt: "后台分析当前工作区",
        run_in_background: true,
        subagent_type: "Explore",
      }),
      subagent(2, { backgrounded: true, parentToolCallId: "tool-1" }),
    ];

    const items = buildRenderItems(rows);

    expect(items).toHaveLength(1);
    const agentItem = items[0];
    expect(agentItem?.kind).toBe("agentToolCall");
    if (agentItem?.kind !== "agentToolCall") {
      throw new Error("expected paired agent item");
    }
    expect(agentItem.subagentRow.backgrounded).toBe(true);
    expect(agentItem).not.toHaveProperty("showSubagentOutputPreview");
  });
});

function assistantText(rowId: number, text = `text-${rowId}`): AssistantTextRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    text,
    state: "complete",
  };
}

function userInputRow(rowId: number): UserInputRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "userInput",
    text: "继续",
    origin: "realUser",
  };
}

const EN_MESSAGES = LOCALE_MESSAGES["en-US"]!;
const testIntl: IntlInstance = {
  formatMessage({ id }, values) {
    let message = EN_MESSAGES[id] ?? id;
    for (const [key, value] of Object.entries(values ?? {})) {
      message = message.replaceAll(`{${key}}`, String(value));
    }
    return message;
  },
};

function summaryItems(
  rows: Parameters<typeof buildAssistantSummaryWorkRenderItems>[0],
  visibility: Parameters<typeof buildAssistantSummaryWorkRenderItems>[1] = SHOW_ALL_REASONING,
) {
  return buildAssistantSummaryWorkRenderItems(rows, visibility);
}

function singleGroup(
  rows: Parameters<typeof buildAssistantSummaryWorkRenderItems>[0],
  visibility: Parameters<typeof buildAssistantSummaryWorkRenderItems>[1] = SHOW_ALL_REASONING,
) {
  const groups = groupConsecutiveAssistantSummaries(summaryItems(rows, visibility));
  expect(groups).toHaveLength(1);
  return groups[0]!;
}

describe("conversationSummaryGroups classification", () => {
  it("classifies tool families, session tools, and workflow boundaries", () => {
    expect(getAssistantSummaryToolCategory(reasoning(1))).toBeNull();
    expect(getAssistantSummaryToolCategory(toolCall(2, "Read", { path: "a.ts" }))).toBe("explore");
    expect(getAssistantSummaryToolCategory(toolCall(3, "Grep", { pattern: "x" }))).toBe("explore");
    expect(
      getAssistantSummaryToolCategory(toolCall(4, "WebFetch", { url: "https://example.com" })),
    ).toBe("explore");
    expect(getAssistantSummaryToolCategory(toolCall(5, "Bash", { command: "pnpm test" }))).toBe(
      "run",
    );
    expect(getAssistantSummaryToolCategory(toolCall(6, "mcp__node_repl__js", {}))).toBe("run");
    expect(getAssistantSummaryToolCategory(toolCall(7, "mcp__computer-use__list_apps", {}))).toBe(
      "run",
    );
    expect(getAssistantSummaryToolCategory(toolCall(8, "ListSessions", {}))).toBe("session");
    expect(
      getAssistantSummaryToolCategory(
        toolCall(9, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
      ),
    ).toBe("change");
    expect(getAssistantSummaryToolCategory(toolCall(10, "TodoWrite", { todos: [] }))).toBeNull();
    expect(
      getAssistantSummaryToolCategory(toolCall(11, "CreateWorkflow", { name: "wf" })),
    ).toBeNull();
    expect(
      getAssistantSummaryToolCategory(
        toolCall(12, "Bash", { command: "pnpm test" }, { status: "pendingApproval" }),
      ),
    ).toBeNull();
  });

  it("keeps a running shell without a command out of every category until classified", () => {
    const awaiting = toolCall(1, "Bash", {}, { status: "running", inputText: "" });
    expect(summaryItems([awaiting])).toHaveLength(0);
  });
});

describe("conversationSummaryGroups grouping", () => {
  it("merges consecutive reasoning and categorized tools across categories", () => {
    const group = singleGroup([
      reasoning(1),
      toolCall(2, "Read", { path: "a.ts" }),
      toolCall(3, "Bash", { command: "pnpm test" }),
      toolCall(4, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
      reasoning(5),
    ]);
    expect(group.key).toBe("row:1");
    expect(group.items.map((item) => item.row.rowId)).toEqual([1, 2, 3, 4, 5]);
  });

  it("closes a group at assistant text, unclassified tools, and agent tool calls", () => {
    const groups = groupConsecutiveAssistantSummaries(
      summaryItems([
        reasoning(1),
        toolCall(2, "Read", { path: "a.ts" }),
        assistantText(3),
        toolCall(4, "Read", { path: "b.ts" }),
        toolCall(5, "AskUserQuestion", { questions: [] }),
        toolCall(6, "Read", { path: "c.ts" }),
        toolCall(7, "Agent", { description: "探索" }),
        subagent(8, { parentToolCallId: "tool-7" }),
        toolCall(9, "Read", { path: "d.ts" }),
        toolCall(10, "Grep", { pattern: "x" }),
      ]),
    );

    expect(groups.map((group) => group.items.map((item) => item.row.rowId))).toEqual([
      [1, 2],
      [3],
      [4],
      [5],
      [6],
      [7],
      [9, 10],
    ]);
    expect(groups[5]!.items[0]!.kind).toBe("agentToolCall");
  });

  it("uses the first item key for each group and gives single items their own key", () => {
    const groups = groupConsecutiveAssistantSummaries(
      summaryItems([reasoning(1), toolCall(2, "Read", { path: "a.ts" }), assistantText(3)]),
    );
    expect(groups.map((group) => group.key)).toEqual(["row:1", "row:3"]);
    expect(groups.map((group) => group.items.length)).toEqual([2, 1]);
  });
});

describe("conversationSummaryGroups statistics", () => {
  it("counts explore, run with session, unique change paths, and unresolved changes", () => {
    const group = singleGroup([
      reasoning(1),
      toolCall(2, "Read", { path: "a.ts" }),
      toolCall(3, "Grep", { pattern: "x" }),
      toolCall(4, "Bash", { command: "pnpm test" }),
      toolCall(5, "ListSessions", {}),
      toolCall(6, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
      toolCall(7, "Write", { file_path: "src/b.ts", content: "b" }),
      // 同一文件的别名路径必须按词法归一去重。
      toolCall(8, "Write", { file_path: "./src/./a.ts", content: "a2" }),
      // 无路径的写入只能计为未解析，不能伪造文件名。
      toolCall(9, "Write", { content: "x" }),
    ]);

    expect(formatAssistantSummaryStatistics(group.items, testIntl, "/workspace")).toBe(
      "Explore 2 items, Run 2 commands, Change 2 files, Change 1 time (path unknown)",
    );
    expect(formatAssistantSummaryStatistics(group.items, testIntl, "/workspace", true)).toBe(
      "Explored 2 items, Ran 2 commands, Changed 2 files, Changed 1 time (path unknown)",
    );
  });

  it("omits zero categories and falls back to reasoning", () => {
    const reasoningOnly = singleGroup([reasoning(1), reasoning(2)]);
    expect(formatAssistantSummaryStatistics(reasoningOnly.items, testIntl)).toBe("Reasoning");

    const exploreOnly = singleGroup([
      toolCall(1, "Read", { path: "a.ts" }),
      toolCall(2, "Glob", { pattern: "*.ts" }),
    ]);
    expect(formatAssistantSummaryStatistics(exploreOnly.items, testIntl)).toBe("Explore 2 items");
  });

  it("uses the one/other tense keys for singular counts", () => {
    const group = singleGroup([
      toolCall(1, "Read", { path: "a.ts" }),
      toolCall(2, "Bash", { command: "pnpm test" }),
    ]);
    expect(formatAssistantSummaryStatistics(group.items, testIntl)).toBe(
      "Explore 1 item, Run 1 command",
    );
    expect(formatAssistantSummaryStatistics(group.items, testIntl, undefined, true)).toBe(
      "Explored 1 item, Ran 1 command",
    );
  });
});

describe("conversationSummaryGroups activity, tail, and icon", () => {
  it("selects the last active reasoning or tool item", () => {
    const items = summaryItems([
      toolCall(1, "Read", { path: "a.ts" }),
      reasoning(2),
      toolCall(3, "Bash", { command: "pnpm test" }, { status: "running" }),
    ]);
    expect(getActiveAssistantSummaryItem(items)?.row.rowId).toBe(3);

    const streamingReasoning: ReasoningRow = { ...reasoning(4), state: "streaming", text: "思考" };
    const reasoningItems = summaryItems([
      toolCall(5, "Read", { path: "a.ts" }),
      streamingReasoning,
    ]);
    expect(getActiveAssistantSummaryItem(reasoningItems)?.row.rowId).toBe(4);
    expect(
      getActiveAssistantSummaryItem(summaryItems([toolCall(6, "Read", { path: "a.ts" })])),
    ).toBe(undefined);
  });

  it("derives the appendable tail from the whole visible row list", () => {
    const rows: ConversationRow[] = [
      toolCall(1, "Read", { path: "a.ts" }),
      toolCall(2, "Bash", { command: "pnpm test" }),
    ];
    expect(getAssistantSummaryTailRowId(rows, SHOW_ALL_REASONING)).toBe(2);

    expect(
      getAssistantSummaryTailRowId(
        [toolCall(1, "Read", { path: "a.ts" }), userInputRow(2)],
        SHOW_ALL_REASONING,
      ),
    ).toBeUndefined();

    // 关闭思考时，隐藏的 trailing reasoning 不能成为可追加尾部。
    expect(
      getAssistantSummaryTailRowId([toolCall(1, "Read", { path: "a.ts" }), reasoning(2)], {
        messageStreamShowReasoning: false,
      }),
    ).toBe(1);

    // 未分类的 Todo 行也被投影隐藏，同样不能成为尾部。
    expect(
      getAssistantSummaryTailRowId(
        [toolCall(1, "Read", { path: "a.ts" }), toolCall(2, "TodoWrite", { todos: [] })],
        SHOW_ALL_REASONING,
      ),
    ).toBe(1);
  });

  it("prefers CUA, then node-repl, change, run, and explore for the statistics icon", () => {
    const pick = (rows: ToolCallRow[]) =>
      getAssistantSummaryIconItem(summaryItems(rows))?.row.rowId;

    expect(
      pick([
        toolCall(1, "Read", { path: "a.ts" }),
        toolCall(2, "Bash", { command: "pnpm test" }),
        toolCall(3, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
        toolCall(4, "mcp__node_repl__js", {}),
        toolCall(5, "mcp__computer-use__list_apps", {}),
      ]),
    ).toBe(5);
    expect(
      pick([
        toolCall(1, "Read", { path: "a.ts" }),
        toolCall(2, "Bash", { command: "pnpm test" }),
        toolCall(3, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
        toolCall(4, "mcp__node_repl__js", {}),
      ]),
    ).toBe(4);
    expect(
      pick([
        toolCall(1, "Read", { path: "a.ts" }),
        toolCall(2, "Bash", { command: "pnpm test" }),
        toolCall(3, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
      ]),
    ).toBe(3);
    expect(
      pick([toolCall(1, "Read", { path: "a.ts" }), toolCall(2, "Bash", { command: "pnpm test" })]),
    ).toBe(2);
    expect(
      pick([toolCall(1, "Read", { path: "a.ts" }), toolCall(2, "Grep", { pattern: "x" })]),
    ).toBe(1);
  });
});

describe("conversationSummaryGroups change files", () => {
  it("returns deduped files only when every categorized item is a change", () => {
    const group = singleGroup([
      reasoning(1),
      toolCall(2, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
      toolCall(3, "Write", { file_path: "./src/./a.ts", content: "a2" }),
    ]);
    const changes = getAssistantSummaryChangeFiles(group.items, "/workspace");
    expect(changes?.files.map((file) => file.path)).toEqual(["/workspace/src/a.ts"]);
    expect(changes?.unresolved).toBe(0);
  });

  it("returns undefined for mixed categories and unresolved-only changes", () => {
    const mixed = singleGroup([
      toolCall(1, "Edit", { file_path: "src/a.ts", old_string: "a", new_string: "b" }),
      toolCall(2, "Read", { path: "a.ts" }),
    ]);
    expect(getAssistantSummaryChangeFiles(mixed.items)).toBeUndefined();

    const unresolved = singleGroup([
      toolCall(1, "Write", { content: "x" }),
      toolCall(2, "Write", { content: "y" }),
    ]);
    expect(getAssistantSummaryChangeFiles(unresolved.items)).toBeUndefined();
    expect(formatAssistantSummaryStatistics(unresolved.items, testIntl)).toBe(
      "Change 2 times (path unknown)",
    );
  });
});

describe("continuous group keys", () => {
  type Group = { kind: string; rowIds: number[]; key?: string };
  const describeGroup = (group: Group) => ({
    kind: group.kind,
    rowIds: group.rowIds,
    ...(group.key !== undefined ? { key: group.key } : {}),
  });

  it("keeps a group key stable when pagination prepends rows to the left boundary", () => {
    const previous = reconcileContinuousGroupIdentity(
      [
        { kind: "summary", rowIds: [2, 3] },
        { kind: "summary", rowIds: [5] },
      ] as Group[],
      describeGroup,
    );
    const next = reconcileContinuousGroupIdentity(
      [
        { kind: "summary", rowIds: [1, 2, 3] },
        { kind: "summary", rowIds: [5] },
      ] as Group[],
      describeGroup,
      previous,
    );
    expect(next.keys).toEqual(previous.keys);
  });

  it("keeps streaming append identity and reuses a split key only once", () => {
    const initial = reconcileContinuousGroupIdentity(
      [{ kind: "summary", rowIds: [1, 2] }] as Group[],
      describeGroup,
    );
    const grown = reconcileContinuousGroupIdentity(
      [{ kind: "summary", rowIds: [1, 2, 3] }] as Group[],
      describeGroup,
      initial,
    );
    expect(grown.keys).toEqual(initial.keys);

    const split = reconcileContinuousGroupIdentity(
      [
        { kind: "summary", rowIds: [1] },
        { kind: "summary", rowIds: [2, 3] },
      ] as Group[],
      describeGroup,
      grown,
    );
    expect(split.keys[0]).toBe(initial.keys[0]);
    expect(split.keys[1]).not.toBe(initial.keys[0]);
    expect(new Set(split.keys).size).toBe(2);
  });

  it("never lets a new group inherit the identity of a standalone row", () => {
    const previous = reconcileContinuousGroupIdentity(
      [
        { kind: "assistantText", rowIds: [1], key: "assistantText:1" },
        { kind: "summary", rowIds: [2, 3] },
      ] as Group[],
      describeGroup,
    );
    const next = reconcileContinuousGroupIdentity(
      [
        { kind: "assistantText", rowIds: [1], key: "assistantText:1" },
        { kind: "summary", rowIds: [2, 3, 4] },
      ] as Group[],
      describeGroup,
      previous,
    );
    expect(next.keys[1]).toBe(previous.keys[1]);
    expect(next.keys[1]).not.toBe("assistantText:1");
  });
});
