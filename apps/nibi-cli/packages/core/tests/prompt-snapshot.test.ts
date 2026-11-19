import { describe, expect, it, vi } from "vitest";
import {
  SESSION_ENTRY_PROMPT_SNAPSHOT,
  createRootTraceContext,
  type SessionEntryInfo,
  type SessionId,
} from "@nibi/contracts";
import { MessageHistoryImpl, type RuntimeMessageEntry } from "../src/agent/message-history.js";
import { rebuildContextPrefix } from "../src/runtime/methods/context-refresh.js";
import {
  buildForkedPromptSnapshotEntry,
  clearPromptSnapshot,
  copyPromptSnapshotToFork,
  loadPromptSnapshot,
  parsePromptSnapshot,
  promptSnapshotFor,
  recordPromptSnapshot,
  type PromptSnapshot,
} from "../src/runtime/helpers/prompt-snapshot.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

const SESSION_ID = "sess_prompt_snapshot" as SessionId;
const CHILD_SESSION_ID = "sess_prompt_snapshot_child" as SessionId;
const traceContext = createRootTraceContext({ sessionId: SESSION_ID });
const sessionModel = { providerId: "provider-a", modelId: "model-a" };

function systemEntry(text: string, cacheControl?: { type: "ephemeral" }): RuntimeMessageEntry {
  return {
    message: {
      role: "system",
      content: text,
      ...(cacheControl ? { cacheControl } : {}),
    },
  };
}

function attachmentEntry(source = "context_prefix"): RuntimeMessageEntry {
  return {
    kind: "attachment",
    content: "attachment body",
    metadata: { source },
  };
}

function userEntry(text: string): RuntimeMessageEntry {
  return { message: { role: "user", content: text } };
}

function createStore() {
  const entries: SessionEntryInfo[] = [];
  const saveSessionEntry = vi.fn(async (entry: SessionEntryInfo) => {
    const index = entries.findIndex((candidate) => candidate.id === entry.id);
    if (index >= 0) entries[index] = entry;
    else entries.push(entry);
  });
  const sessionEntries = vi.fn(async (input: { sessionID: SessionId; type?: string }) =>
    entries.filter(
      (entry) =>
        entry.sessionID === input.sessionID && (input.type === undefined || entry.type === input.type),
    ),
  );
  return { entries, saveSessionEntry, sessionEntries };
}

function createRuntime(
  overrides: {
    sessionStore?: ReturnType<typeof createStore>;
    selection?: { providerId: string; modelId: string } | undefined;
  } = {},
) {
  const store = overrides.sessionStore ?? createStore();
  const logger = { warn: vi.fn() };
  const runtime = {
    sessionId: SESSION_ID,
    config: { taskType: "interactive" },
    sessionStore: store,
    logger,
    rootTraceContext: traceContext,
    getSessionModelSelection: vi.fn(() => overrides.selection ?? sessionModel),
  } as unknown as AgentRuntimeInternal;
  return { runtime, store, logger };
}

describe("prompt snapshot persistence", () => {
  it("records only leading system messages and reads them back", async () => {
    const { runtime, store } = createRuntime();
    const entries = [
      systemEntry("stable body", { type: "ephemeral" }),
      attachmentEntry(),
      systemEntry("dynamic body"),
      userEntry("hello"),
      systemEntry("not part of the prefix"),
    ];

    await recordPromptSnapshot(runtime, {
      model: sessionModel,
      entries,
      traceContext,
    });

    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]).toMatchObject({
      id: `${SESSION_ID}:runtime-prompt-snapshot`,
      sessionID: SESSION_ID,
      type: SESSION_ENTRY_PROMPT_SNAPSHOT,
      touchSession: false,
    });
    expect(store.entries[0]?.data).toEqual({
      model: sessionModel,
      system: [
        { role: "system", content: "stable body", cacheControl: { type: "ephemeral" } },
        { role: "system", content: "dynamic body" },
      ],
    });

    const { runtime: resumed } = createRuntime({ sessionStore: store });
    expect(resumed.promptSnapshot).toBeUndefined();
    await loadPromptSnapshot(resumed, traceContext);

    expect(resumed.promptSnapshot).toEqual(store.entries[0]?.data);
    expect(promptSnapshotFor(resumed, sessionModel)).toEqual(store.entries[0]?.data);
  });

  it("does not apply or overwrite the snapshot for a different model", async () => {
    const { runtime, store } = createRuntime();
    await recordPromptSnapshot(runtime, {
      model: sessionModel,
      entries: [systemEntry("stable body")],
      traceContext,
    });

    expect(promptSnapshotFor(runtime, { providerId: "provider-b", modelId: "model-b" })).toBeUndefined();
    expect(promptSnapshotFor(runtime, { providerId: "provider-a", modelId: "model-b" })).toBeUndefined();

    await recordPromptSnapshot(runtime, {
      model: { providerId: "provider-b", modelId: "model-b" },
      entries: [systemEntry("other body")],
      traceContext,
    });

    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]?.data).toMatchObject({
      system: [{ role: "system", content: "stable body" }],
    });
  });

  it("skips recording for execution-scoped model selection", async () => {
    const { runtime, store } = createRuntime();
    await recordPromptSnapshot(runtime, {
      model: sessionModel,
      modelSelectionScope: "execution",
      entries: [systemEntry("stable body")],
      traceContext,
    });

    expect(runtime.promptSnapshot).toBeUndefined();
    expect(store.saveSessionEntry).not.toHaveBeenCalled();
  });

  it("writes a tombstone when compaction clears the snapshot", async () => {
    const { runtime, store } = createRuntime();
    await recordPromptSnapshot(runtime, {
      model: sessionModel,
      entries: [systemEntry("stable body")],
      traceContext,
    });

    const hadSnapshot = await clearPromptSnapshot(runtime, traceContext);

    expect(hadSnapshot).toBe(true);
    expect(runtime.promptSnapshot).toBeNull();
    expect(store.entries[0]?.data).toEqual({ cleared: true });

    const { runtime: resumed } = createRuntime({ sessionStore: store });
    await loadPromptSnapshot(resumed, traceContext);
    expect(resumed.promptSnapshot).toBeNull();
    expect(promptSnapshotFor(resumed, sessionModel)).toBeUndefined();
  });

  it("writes the compaction tombstone even when the in-memory snapshot is missing", async () => {
    const { runtime, store } = createRuntime();
    await recordPromptSnapshot(runtime, {
      model: sessionModel,
      entries: [systemEntry("stable body")],
      traceContext,
    });
    // 冷恢复读快照失败后内存为空，库里的旧行仍必须被压缩清掉。
    runtime.promptSnapshot = undefined;

    const hadSnapshot = await clearPromptSnapshot(runtime, traceContext);

    expect(hadSnapshot).toBe(false);
    expect(store.entries[0]?.data).toEqual({ cleared: true });
  });

  it("copies the snapshot row into a forked child session", async () => {
    const { runtime, store } = createRuntime();
    const snapshot: PromptSnapshot = {
      model: sessionModel,
      system: [{ role: "system", content: "stable body" }],
    };
    runtime.promptSnapshot = snapshot;

    const entry = buildForkedPromptSnapshotEntry(runtime, CHILD_SESSION_ID);
    expect(entry).toMatchObject({
      id: `${CHILD_SESSION_ID}:runtime-prompt-snapshot`,
      sessionID: CHILD_SESSION_ID,
      type: SESSION_ENTRY_PROMPT_SNAPSHOT,
      touchSession: false,
      data: snapshot,
    });
    expect(entry?.data).not.toBe(snapshot);

    await copyPromptSnapshotToFork(runtime, CHILD_SESSION_ID, traceContext);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]?.sessionID).toBe(CHILD_SESSION_ID);
    expect(store.entries[0]?.data).toEqual(snapshot);
  });

  it("does not copy a fork snapshot when the parent has none", async () => {
    const { runtime, store } = createRuntime();
    expect(buildForkedPromptSnapshotEntry(runtime, CHILD_SESSION_ID)).toBeUndefined();

    await copyPromptSnapshotToFork(runtime, CHILD_SESSION_ID, traceContext);
    expect(store.saveSessionEntry).not.toHaveBeenCalled();
  });

  it("does not block the turn when the snapshot write fails", async () => {
    const { runtime, store, logger } = createRuntime();
    store.saveSessionEntry.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      recordPromptSnapshot(runtime, {
        model: sessionModel,
        entries: [systemEntry("stable body")],
        traceContext,
      }),
    ).resolves.toBeUndefined();

    expect(runtime.promptSnapshot).toEqual({
      model: sessionModel,
      system: [{ role: "system", content: "stable body" }],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Prompt snapshot write failed",
      expect.objectContaining({ event: "prompt_snapshot.write_failed", error: "disk full" }),
    );
  });

  it("does not use or copy snapshots outside the main session", async () => {
    const { runtime, store } = createRuntime();
    runtime.config.taskType = "subagent_child";
    runtime.promptSnapshot = { model: sessionModel, system: [{ role: "system", content: "x" }] };

    expect(promptSnapshotFor(runtime, sessionModel)).toBeUndefined();
    await recordPromptSnapshot(runtime, {
      model: sessionModel,
      entries: [systemEntry("stable body")],
      traceContext,
    });
    expect(await clearPromptSnapshot(runtime, traceContext)).toBe(false);
    expect(buildForkedPromptSnapshotEntry(runtime, CHILD_SESSION_ID)).toBeUndefined();
    expect(store.saveSessionEntry).not.toHaveBeenCalled();
  });
});

describe("prompt snapshot parsing", () => {
  it("accepts valid snapshots and tombstones", () => {
    expect(
      parsePromptSnapshot({
        model: sessionModel,
        system: [{ role: "system", content: "body", cacheControl: { type: "ephemeral" } }],
      }),
    ).toEqual({
      model: sessionModel,
      system: [{ role: "system", content: "body", cacheControl: { type: "ephemeral" } }],
    });
    expect(parsePromptSnapshot({ cleared: true })).toBeNull();
  });

  it.each([
    undefined,
    null,
    "snapshot",
    [],
    { model: { providerId: "provider-a" }, system: [] },
    { model: sessionModel },
    { model: sessionModel, system: "body" },
    { model: sessionModel, system: [{ role: "user", content: "body" }] },
    { model: sessionModel, system: [{ role: "system", content: 42 }] },
    { model: sessionModel, system: [{ role: "system", content: "body", cacheControl: "bad" }] },
  ])("rejects malformed snapshot data: %j", (data) => {
    expect(parsePromptSnapshot(data)).toBeUndefined();
  });
});

describe("prompt snapshot prefix rebuild", () => {
  function createRebuildRuntime(snapshot: PromptSnapshot | null) {
    const freshContextResult = {
      sections: [],
      totalChars: 0,
      totalTokens: 0,
      systemMessages: [{ role: "system" as const, content: "fresh body" }],
      metaUserAttachments: [{ source: "skills_listing" as const, content: "skills body" }],
    };
    const messageHistory = new MessageHistoryImpl();
    messageHistory.init([
      { message: { role: "system", content: "fresh body" } },
      { kind: "attachment", content: "skills body", metadata: { source: "skills_listing" } },
      { message: { role: "user", content: "hello" } },
    ]);
    const runtime = {
      config: { taskType: "interactive" },
      sessionId: SESSION_ID,
      sessionStore: createStore(),
      contextBuilder: { build: () => freshContextResult },
      contextInitialized: true,
      contextSourceSnapshot: {},
      createContextBuilderFromSnapshot: vi.fn(() => ({ build: () => freshContextResult })),
      latestContextBuildResult: undefined,
      memoryRoot: undefined,
      memoryIndexContent: undefined,
      messageHistory,
      promptSnapshot: snapshot,
    } as unknown as AgentRuntimeInternal;
    return { runtime, freshContextResult };
  }

  it("substitutes the snapshot system bytes and keeps freshly built meta attachments", () => {
    const snapshot: PromptSnapshot = {
      model: sessionModel,
      system: [{ role: "system", content: "snapshot body" }],
    };
    const { runtime, freshContextResult } = createRebuildRuntime(snapshot);

    const entries = rebuildContextPrefix(runtime, { model: sessionModel as never });

    expect(entries).toEqual([
      { message: { role: "system", content: "snapshot body" } },
      expect.objectContaining({ kind: "attachment", metadata: { source: "skills_listing" } }),
      expect.objectContaining({ message: { role: "user", content: "hello" } }),
    ]);
    expect(runtime.latestContextBuildResult).toBe(freshContextResult);
  });

  it("keeps the fresh build when the model does not match the snapshot", () => {
    const snapshot: PromptSnapshot = {
      model: sessionModel,
      system: [{ role: "system", content: "snapshot body" }],
    };
    const { runtime } = createRebuildRuntime(snapshot);

    const entries = rebuildContextPrefix(runtime, {
      model: { providerId: "provider-a", modelId: "model-b" } as never,
    });

    expect(entries[0]).toEqual({ message: { role: "system", content: "fresh body" } });
  });
});
