import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectId, createSessionId, type WorkspaceId } from "@nibi/contracts";
import { createSqliteSessionStore, type SqliteSessionStore } from "@nibi/adapters";
import {
  executeSessionDeletion,
  previewSessionDeletion,
} from "../src/nibi-protocol/session-data/permanent-deletion.js";
import type { NibiProtocolAgentServerContext } from "../src/nibi-protocol/server-types.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(options: { workspaceID?: string; directory?: string } = {}) {
  const cliRoot = await mkdtemp(join(tmpdir(), "nibi-deletion-protocol-"));
  roots.push(cliRoot);
  const store = await createSqliteSessionStore({ dbPath: ":memory:" });
  const sessionID = createSessionId("root");
  await store.createSession({
    id: sessionID,
    projectID: createProjectId("project"),
    ...(options.workspaceID ? { workspaceID: options.workspaceID as WorkspaceId } : {}),
    slug: "root",
    directory: options.directory ?? "/workspace",
    title: "root",
    version: "1.0.0",
    time: { created: 1, updated: 1 },
  });
  const context = {
    deps: { sessionStore: store, cliStorageRoot: cliRoot },
  } as unknown as NibiProtocolAgentServerContext;
  return { cliRoot, context, sessionID, store };
}

function workspace(workspacePath = "/workspace", workspaceIdentity?: string) {
  return {
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  };
}

describe("v4 session deletion protocol", () => {
  it("rejects a workspace identity mismatch before touching the store", async () => {
    const { context, sessionID } = await setup({ workspaceID: "remote-a" });
    await expect(
      previewSessionDeletion(context, {
        sessionId: sessionID,
        workspace: workspace("/workspace", "remote-b"),
      }),
    ).rejects.toMatchObject({ code: "session-data.identity-mismatch" });
  });

  it("reports a running session as blocked", async () => {
    const { context, sessionID, store } = await setup();
    await store.registerSessionRuntimePresence!(sessionID, "owner", 1);
    const preview = await previewSessionDeletion(context, {
      sessionId: sessionID,
      workspace: workspace(),
    });
    expect(preview.blockedReason).toBe("running");
    expect(preview.incomplete).toBe(false);
    expect(preview.completed).toBe(false);
    store.close();
  });

  it("treats a live protocol session as blocked without a presence row", async () => {
    const { context, sessionID, store } = await setup();
    (context as unknown as { sessions: Map<string, unknown> }).sessions = new Map([
      [sessionID, {}],
    ]);
    const preview = await previewSessionDeletion(context, {
      sessionId: sessionID,
      workspace: workspace(),
    });
    expect(preview.blockedReason).toBe("running");
    store.close();
  });

  it("reports deleting as incomplete and deleted as completed", async () => {
    const { context, sessionID, store } = await setup();
    const scope = await store.inspectSessionDeletion!(sessionID);
    await store.beginSessionDeletion!(sessionID, {
      operationID: "op-1",
      stamps: scope.stamps,
      retained: [],
    });
    const deleting = await previewSessionDeletion(context, {
      sessionId: sessionID,
      workspace: workspace(),
    });
    expect(deleting.incomplete).toBe(true);
    expect(deleting.completed).toBe(false);

    await store.completeSessionDeletion!(sessionID);
    const deleted = await previewSessionDeletion(context, {
      sessionId: sessionID,
      workspace: workspace(),
    });
    expect(deleted.completed).toBe(true);
    expect(deleted.incomplete).toBe(false);
    expect(deleted.sessionIds).toEqual([sessionID]);
    store.close();
  });

  it("blocks a stale revision as changed and deletes on the confirmed revision", async () => {
    const { context, sessionID, store } = await setup();
    const preview = await previewSessionDeletion(context, {
      sessionId: sessionID,
      workspace: workspace(),
    });
    expect(preview.blockedReason).toBeUndefined();
    await store.updateSession({ id: sessionID, title: "changed", timeUpdated: 99 });
    const stale = await executeSessionDeletion(context, {
      sessionId: sessionID,
      workspace: workspace(),
      revision: preview.revision,
      operationId: "op-stale",
    });
    expect(stale).toMatchObject({ status: "blocked", reason: "changed" });

    const current = await previewSessionDeletion(context, {
      sessionId: sessionID,
      workspace: workspace(),
    });
    const deleted = await executeSessionDeletion(context, {
      sessionId: sessionID,
      workspace: workspace(),
      revision: current.revision,
      operationId: "op-ok",
    });
    expect(deleted).toMatchObject({ status: "deleted", sessionIds: [sessionID] });
    expect(await store.getSession(sessionID)).toBeNull();
    expect(await store.listSessions()).toEqual([]);
    store.close();
  });

  it("rejects unknown keys and empty values like the strict wire schema", async () => {
    const { context, sessionID } = await setup();
    await expect(
      previewSessionDeletion(context, {
        sessionId: sessionID,
        workspace: workspace(),
        extra: true,
      }),
    ).rejects.toThrow(/unrecognized|invalid/iu);
    await expect(
      executeSessionDeletion(context, {
        sessionId: sessionID,
        workspace: workspace(),
        revision: "",
        operationId: "op",
      }),
    ).rejects.toThrow(/invalid|too small/iu);
  });
});
