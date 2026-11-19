import { describe, expect, it, vi } from "vitest";
import type { CommandAck, CommandEnvelope } from "@nibi/shared/nibi-protocol-v4";
import type { GitWorktreeRepo } from "../src/git/managed-worktree/contract.js";
import type { ManagedWorktreeServicePorts } from "../src/managed-worktree-tasks/ports.js";
import { createManagedWorktreeService } from "../src/managed-worktree-tasks/index.js";
import {
  WORKTREE_REMOVING_ERROR,
  createWorktreeRemovalGate,
} from "../src/managed-worktree-tasks/removal-gate.js";

const project = {
  id: "project-1",
  hostId: "local",
  name: "repo",
  nameOverridden: false,
  roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
  position: 0,
  pinned: false,
  deleted: false,
  createdAt: 0,
  updatedAt: 0,
};

function accepted(sessionId: string): CommandAck {
  return {
    commandId: "cmd",
    status: "accepted",
    revisionAtDecision: 0,
    result: { type: "createSession", sessionId },
  } as CommandAck;
}

function createEnvelope(commandId: string, sessionId: string): CommandEnvelope {
  return {
    clientId: "client",
    commandId,
    type: "createSession",
    payload: { workspaceId: "w", sessionId, firstInput: { text: "hello" } },
  } as CommandEnvelope;
}

function createHarness(overrides: {
  createResult?: Awaited<ReturnType<GitWorktreeRepo["create"]>>;
  tasks?: Array<{
    taskId: string;
    workspacePath: string;
    projectId: string | null;
    title: string;
    archived: boolean;
  }>;
  dirty?: boolean | null;
  terminals?: boolean;
  busy?: string[];
}) {
  const settleEvents: unknown[] = [];
  const reserveCreatedTask = vi.fn(() => ({
    workspacePath: "/wt/repo",
    projectId: "project-1",
    additionalDirectories: [],
  }));
  const releaseReservedTask = vi.fn(() => "released" as const);
  const repository = {
    readTree: () => ({ projects: [project], tasks: [] }),
    reserveCreatedTask,
    releaseReservedTask,
    listTasksByWorktree: () => overrides.tasks ?? [],
    resolveSessionDirectories: () => ({
      workspacePath: "/wt/parent-cwd",
      projectId: "project-1",
      additionalDirectories: [],
    }),
  };
  const git: GitWorktreeRepo = {
    list: vi.fn(async () => ({ sourceRoot: "/repo", worktrees: [] })),
    create: vi.fn(
      async () =>
        overrides.createResult ?? {
          ok: true,
          worktree: {
            path: "/wt/repo",
            bucket: "abcd",
            sourceRoot: "/repo",
            head: "abc",
            branchName: null,
            state: "ok",
            dirty: false,
          },
          cwd: "/wt/repo",
        },
    ),
    remove: vi.fn(async () => ({ ok: true as const })),
    prune: vi.fn(async () => undefined),
    listStartRefs: vi.fn(async () => null),
    isDirty: vi.fn(async () => overrides.dirty ?? false),
    resolveManagedWorktree: vi.fn(async () => ({
      worktreeRoot: "/wt",
      sourceRoot: "/repo",
    })),
  };
  const sendCommand = vi.fn(async (command: { envelope: CommandEnvelope }) =>
    accepted(
      (command.envelope.payload as { sessionId?: string }).sessionId ??
        "sess_created",
    ),
  );
  const gate = createWorktreeRemovalGate();
  const ports: ManagedWorktreeServicePorts = {
    isLocalHost: true,
    repository: async () => repository as never,
    git,
    removalGate: gate,
    runtime: {
      hasTerminalsUnder: async () => overrides.terminals ?? false,
      releaseSessionsUnder: async () => ({
        released: [],
        busy: overrides.busy ?? [],
      }),
    },
    agent: {
      supportsWorktreeCwd: async () => true,
      sendCommand,
      queryCommandResult: async () => "unknown",
    },
    reportCreatingCount: vi.fn(),
  };
  const service = createManagedWorktreeService(ports);
  const dispose = service.onDidSettleCreation((event) => settleEvents.push(event));
  return {
    service,
    git,
    gate,
    reserveCreatedTask,
    releaseReservedTask,
    sendCommand,
    settleEvents,
    dispose,
  };
}

async function waitFor(
  assertion: () => void | Promise<void>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe("managed worktree task service", () => {
  it("creates a worktree, reserves the task cwd and sends createSession with host-only fields", async () => {
    const harness = createHarness({});
    const result = await harness.service.startNewTask({
      workspacePath: "/repo",
      projectId: "project-1",
      ref: null,
      envelope: createEnvelope("cmd-1", "sess_1"),
    });
    expect(result.ok).toBe(true);
    await waitFor(() => expect(harness.sendCommand).toHaveBeenCalledTimes(1));

    expect(harness.reserveCreatedTask).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/wt/repo", worktreeRoot: "/wt/repo" }),
    );
    const sent = harness.sendCommand.mock.calls[0]![0].envelope;
    expect(sent.payload).toMatchObject({
      sessionId: "sess_1",
      cwd: "/wt/repo",
      worktreeCreation: { path: "/wt/repo", sha: "abc", ref: null, output: expect.any(String) },
    });
    await waitFor(() => expect(harness.settleEvents).toHaveLength(1));
    expect(await harness.service.listCreations()).toEqual([]);
  });

  it("forks from the parent task cwd, carries changes and sends targetCwd", async () => {
    const harness = createHarness({});
    const envelope = {
      clientId: "client",
      commandId: "cmd-2",
      type: "forkAssistant",
      sessionId: "parent-1",
      payload: { target: { messageId: "m", partId: "p" } },
    } as unknown as CommandEnvelope;
    const result = await harness.service.forkToWorktree({
      workspacePath: "/repo",
      envelope,
    });
    expect(result.ok).toBe(true);
    await waitFor(() => expect(harness.sendCommand).toHaveBeenCalledTimes(1));
    expect(harness.git.create).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: "/wt/parent-cwd", carryChanges: true }),
      expect.any(Object),
    );
    const sent = harness.sendCommand.mock.calls[0]![0].envelope;
    expect(sent.payload).toMatchObject({
      targetCwd: {
        cwd: "/wt/repo",
        childSessionId: expect.stringMatching(/^sess_/),
        worktreeCreation: expect.objectContaining({ path: "/wt/repo" }),
      },
    });
  });

  it("keeps the creation failed when the CLI rejects the command and cleans up on dismiss", async () => {
    const harness = createHarness({});
    harness.sendCommand.mockResolvedValueOnce({
      commandId: "cmd-3",
      status: "rejected",
      reasonCode: "guard.test",
      revisionAtDecision: 0,
    } as CommandAck);
    const started = await harness.service.startNewTask({
      workspacePath: "/repo",
      projectId: "project-1",
      ref: null,
      envelope: createEnvelope("cmd-3", "sess_3"),
    });
    expect(started.ok).toBe(true);
    await waitFor(async () =>
      expect(await harness.service.listCreations()).toMatchObject([
        { phase: "failed", error: { code: "session-failed" } },
      ]),
    );
    const [creation] = await harness.service.listCreations();
    await harness.service.dismissCreation({ creationId: creation!.id });
    expect(harness.releaseReservedTask).toHaveBeenCalled();
    expect(harness.git.remove).toHaveBeenCalledWith({ path: "/wt/repo", force: true });
    await waitFor(() => expect(harness.settleEvents).toContainEqual(
      expect.objectContaining({ outcome: "dismissed", promptText: "hello" }),
    ));
  });

  it("rejects removal while the worktree is already being removed", async () => {
    const harness = createHarness({});
    harness.gate.acquire("/wt");
    await expect(
      harness.service.removeWorktree({ projectId: "project-1", path: "/wt" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "worktree-in-use", detail: "removing" } });
    harness.gate.release("/wt");
    expect(harness.git.remove).not.toHaveBeenCalled();
  });

  it("refuses dirty, terminal-busy, task-busy and CLI-busy removals before touching git", async () => {
    const dirty = createHarness({ dirty: true });
    await expect(
      dirty.service.removeWorktree({ projectId: "project-1", path: "/wt" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "worktree-dirty" } });

    const terminal = createHarness({ terminals: true });
    await expect(
      terminal.service.removeWorktree({ projectId: "project-1", path: "/wt" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "worktree-in-use", detail: "terminal" } });

    const tasks = createHarness({
      tasks: [{ taskId: "t", workspacePath: "/repo", projectId: "project-1", title: "", archived: false }],
    });
    await expect(
      tasks.service.removeWorktree({ projectId: "project-1", path: "/wt", force: true }),
    ).resolves.toMatchObject({ ok: false, error: { code: "worktree-in-use", detail: "tasks" } });

    const busy = createHarness({ busy: ["sess-1"] });
    await expect(
      busy.service.removeWorktree({ projectId: "project-1", path: "/wt" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "worktree-in-use", detail: "running" } });
  });

  it("removes a clean unused worktree after releasing CLI sessions", async () => {
    const harness = createHarness({});
    await expect(
      harness.service.removeWorktree({ projectId: "project-1", path: "/wt" }),
    ).resolves.toEqual({ ok: true });
    expect(harness.git.remove).toHaveBeenCalledWith({ path: "/wt" });
    expect(harness.gate.isRemoving("/wt/child")).toBe(false);
  });
});

describe("worktree removal gate", () => {
  it("blocks session operations whose cwd is inside a leased worktree and settles in-flight operations", async () => {
    const gate = createWorktreeRemovalGate();
    expect(gate.acquire("/wt")).toBe(true);
    expect(gate.acquire("/wt/child")).toBe(false);
    expect(gate.isRemoving("/wt/pkg")).toBe(true);
    await expect(
      gate.runSessionOperation("s1", async () => "/wt/pkg", async () => "ran"),
    ).rejects.toThrow(WORKTREE_REMOVING_ERROR);
    await expect(gate.runSessionOperation("s2", async () => null, async () => "ran")).rejects.toThrow(
      WORKTREE_REMOVING_ERROR,
    );

    let release!: () => void;
    const inFlight = gate.runSessionOperation(
      "s3",
      async () => "/outside",
      () => new Promise<string>((resolve) => {
        release = () => resolve("done");
      }),
    );
    let settled = false;
    const settle = gate.settle().then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await expect(inFlight).resolves.toBe("done");
    await settle;
    expect(settled).toBe(true);
    gate.release("/wt");
    expect(gate.isRemoving("/wt/pkg")).toBe(false);
  });
});