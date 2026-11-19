import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type ModelId,
  type ModelProviderId,
  type SessionId,
  type WorkspaceId,
} from "@nibi/contracts";
import { SQLITE_MIGRATIONS } from "../src/storage/session-store/migrations.js";
import {
  createSqliteSessionStore,
  listSessionFiles,
  removeSession,
  type SqliteSessionStore,
} from "../src/storage/index.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const ROOT_ID = "0026_session_permanent_deletion";
const ROOT_CHECKSUM = "bc44f9f485ff4fb6362bd1ae5b51d2597c95b823ecf75899988f32cc181ad2bd";

function migration() {
  const found = SQLITE_MIGRATIONS.find((entry) => entry.id === ROOT_ID);
  if (!found) throw new Error("0026 migration is not registered");
  return found;
}

async function createSession(
  store: SqliteSessionStore,
  id: string,
  options: {
    parentID?: string;
    taskType?: string;
    workspaceID?: string;
    directory?: string;
  } = {},
): Promise<SessionId> {
  const sessionID = createSessionId(id);
  await store.createSession({
    id: sessionID,
    projectID: createProjectId("project"),
    ...(options.workspaceID ? { workspaceID: options.workspaceID as WorkspaceId } : {}),
    ...(options.parentID ? { parentID: createSessionId(options.parentID) } : {}),
    ...(options.taskType ? { taskType: options.taskType as never } : {}),
    slug: id,
    directory: options.directory ?? "/workspace",
    title: id,
    version: "1.0.0",
    time: { created: 1, updated: 1 },
  });
  return sessionID;
}

async function write(path: string, body: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, body);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("0026 session permanent deletion migration", () => {
  it("registers the prepared SQL with the stable checksum", () => {
    const entry = migration();
    expect(entry.sql.trim().startsWith("create table if not exists session_purge")).toBe(true);
    expect(createHash("sha256").update(entry.sql.trim()).digest("hex")).toBe(ROOT_CHECKSUM);
    expect(entry.touchedTables).toEqual(["session_purge", "session_runtime_presence"]);
  });

  it("fills in a partial structure without dropping what already exists", () => {
    const db = new DatabaseSync(":memory:");
    try {
      // 先建出 0026 之前的所有表：0026 的触发器引用 session/message/part 等。
      db.exec(
        "create table schema_migration (id text primary key, checksum text not null, app_version text, time_applied integer not null)",
      );
      for (const entry of SQLITE_MIGRATIONS.filter((item) => item.id < ROOT_ID)) {
        if (entry.apply) entry.apply(db);
        else db.exec(entry.sql);
      }
      // 表已经存在（旧基线或半途升级），触发器还没建：apply 必须补齐而不是整体失败。
      db.exec(`
        create table session_purge (
          session_id text primary key,
          root_id text not null,
          operation_id text not null,
          retained_artifacts text not null,
          workspace_path text not null,
          workspace_identity text,
          state text not null check(state in ('deleting', 'deleted'))
        );
      `);
      migration().apply?.(db);
      const tables = db
        .prepare(
          "select name from sqlite_schema where type = 'table' and name in ('session_purge', 'session_runtime_presence') order by name",
        )
        .all() as Array<{ name: string }>;
      expect(tables.map((row) => row.name)).toEqual(["session_purge", "session_runtime_presence"]);
      const triggers = db
        .prepare(
          "select count(*) as count from sqlite_schema where type = 'trigger' and name like 'session_purge_%'",
        )
        .get() as { count: number };
      expect(triggers.count).toBe(74);
      const indexes = db
        .prepare(
          "select name from sqlite_schema where type = 'index' and name = 'session_purge_root_idx'",
        )
        .all();
      expect(indexes).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("session deletion repository", () => {
  it("blocks session and message writes after the deletion receipt", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      const rootID = await createSession(store, "root");
      const scope = await store.inspectSessionDeletion!(rootID);
      expect(
        await store.beginSessionDeletion!(rootID, {
          operationID: "op-1",
          stamps: scope.stamps,
          retained: [],
        }),
      ).toBe("admitted");
      await expect(store.updateSession({ id: rootID, title: "again" })).rejects.toMatchObject({
        code: "session-data.deleting",
      });
      await expect(
        store.registerSessionRuntimePresence!(rootID, "late-owner", 2),
      ).rejects.toMatchObject({ code: "session-data.deleting" });
      await expect(
        store.saveMessage({
          id: createMessageId("blocked-message"),
          sessionID: rootID,
          role: "user",
          time: { created: 2 },
          agent: "nibi-agent",
          model: {
            providerID: "test-provider" as ModelProviderId,
            modelID: "test-model" as ModelId,
          },
        }),
      ).rejects.toThrow(/session-data\.deleting/u);
    } finally {
      store.close();
    }
  });

  it("deletes the owned tree and keeps an independent fork", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      const rootID = await createSession(store, "root");
      const childID = await createSession(store, "child", {
        parentID: "root",
        taskType: "subagent_child",
      });
      const forkID = await createSession(store, "fork", { parentID: "root", taskType: "fork" });
      const otherID = await createSession(store, "other");
      expect((await store.listOwnedSessionTrees!([rootID])).get(rootID)).toEqual([rootID, childID]);
      const scope = await store.inspectSessionDeletion!(rootID);
      expect(scope.forks.map((fork) => fork.sessionID)).toEqual([forkID]);
      expect(
        await store.beginSessionDeletion!(rootID, {
          operationID: "op-tree",
          stamps: scope.stamps,
          retained: [],
        }),
      ).toBe("admitted");
      // 凭据插下后列表立刻不返回删除中的会话，独立的 fork 与无关会话还在。
      expect((await store.listSessions()).map((session) => session.id).sort()).toEqual(
        [forkID, otherID].sort(),
      );
      await store.completeSessionDeletion!(rootID);
      expect(await store.getSession(rootID)).toBeNull();
      expect(await store.getSession(childID)).toBeNull();
      expect(await store.getSession(forkID)).not.toBeNull();
      expect(await store.getSession(otherID)).not.toBeNull();
      expect((await store.inspectSessionDeletion!(rootID)).receipt).toBe("deleted");
    } finally {
      store.close();
    }
  });

  it("finds artifact referrers, including the legacy zcode scheme", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      const rootID = await createSession(store, "root");
      const forkID = await createSession(store, "fork", { parentID: "root", taskType: "fork" });
      const messageID = createMessageId("referrer-message");
      await store.saveMessage({
        id: messageID,
        sessionID: forkID,
        role: "user",
        time: { created: 2 },
        agent: "nibi-agent",
        model: {
          providerID: "test-provider" as ModelProviderId,
          modelID: "test-model" as ModelId,
        },
      });
      await store.savePart({
        id: createPartId("referrer-part"),
        sessionID: forkID,
        messageID,
        type: "file",
        mime: "image/png",
        url: "zcode-artifact://sess_root/shared",
      });
      expect((await store.listArtifactReferrers!([rootID])).get(rootID)).toEqual([forkID]);
      const scope = await store.inspectSessionDeletion!(rootID);
      expect(scope.references).toEqual([
        {
          sessionID: rootID,
          artifactID: "shared",
          referrers: [{ sessionID: forkID, title: "fork" }],
        },
      ]);
    } finally {
      store.close();
    }
  });

  it("reports a stale revision as changed", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      const rootID = await createSession(store, "root");
      const scope = await store.inspectSessionDeletion!(rootID);
      await store.updateSession({ id: rootID, title: "changed", timeUpdated: 99 });
      expect(
        await store.beginSessionDeletion!(rootID, {
          operationID: "op-stale",
          stamps: scope.stamps,
          retained: [],
        }),
      ).toBe("changed");
      expect((await store.inspectSessionDeletion!(rootID)).receipt).toBeNull();
    } finally {
      store.close();
    }
  });

  it("completes twice idempotently and refuses to recreate the same id", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      const rootID = await createSession(store, "root");
      const scope = await store.inspectSessionDeletion!(rootID);
      await store.beginSessionDeletion!(rootID, {
        operationID: "op-twice",
        stamps: scope.stamps,
        retained: [],
      });
      await store.completeSessionDeletion!(rootID);
      await expect(store.completeSessionDeletion!(rootID)).resolves.toBeUndefined();
      const done = await store.inspectSessionDeletion!(rootID);
      expect(done.receipt).toBe("deleted");
      await expect(
        store.createSession({
          id: rootID,
          projectID: createProjectId("project"),
          slug: "root",
          directory: "/workspace",
          title: "root",
          version: "1.0.0",
          time: { created: 2, updated: 2 },
        }),
      ).rejects.toMatchObject({ code: "session-data.deleting" });
    } finally {
      store.close();
    }
  });

  it("treats pending inputs and runtime presence as running", async () => {
    const store = await createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      const rootID = await createSession(store, "root");
      await store.registerSessionRuntimePresence!(rootID, "owner", 1234);
      expect(await store.hasSessionRuntimePresence!([rootID])).toBe(true);
      const scope = await store.inspectSessionDeletion!(rootID);
      expect(
        await store.beginSessionDeletion!(rootID, {
          operationID: "op-running",
          stamps: scope.stamps,
          retained: [],
        }),
      ).toBe("running");
      await store.unregisterSessionRuntimePresence!(rootID, "owner");
      expect(await store.hasSessionRuntimePresence!([rootID])).toBe(false);
    } finally {
      store.close();
    }
  });
});

describe("session data files", () => {
  it("lists artifacts and model traces and keeps only referenced attachments", async () => {
    const cliRoot = await temporaryRoot("nibi-deletion-files-");
    await write(join(cliRoot, "artifacts", "sess", "shared.png"), "shared");
    await write(join(cliRoot, "artifacts", "sess", "private.png"), "private");
    await write(join(cliRoot, "artifacts", "fork", "own.png"), "fork");
    await write(join(cliRoot, "exec", "sess", "out.txt"), "out");
    await write(join(cliRoot, "rollout", "model-io-sess.jsonl"), "{}");

    const files = await listSessionFiles(cliRoot, "sess");
    expect(
      files.map((file) => [file.relativePath.replaceAll("\\", "/"), file.artifact, file.bytes]),
    ).toEqual([
      ["artifacts/sess/private.png", true, 7],
      ["artifacts/sess/shared.png", true, 6],
      ["exec/sess/out.txt", false, 3],
      ["rollout/model-io-sess.jsonl", false, 2],
    ]);

    await removeSession(cliRoot, "sess", ["shared"]);
    expect(await exists(join(cliRoot, "artifacts", "sess", "shared.png"))).toBe(true);
    expect(await exists(join(cliRoot, "artifacts", "sess", "private.png"))).toBe(false);
    expect(await exists(join(cliRoot, "exec", "sess", "out.txt"))).toBe(false);
    expect(await exists(join(cliRoot, "rollout", "model-io-sess.jsonl"))).toBe(false);
    expect(await exists(join(cliRoot, "artifacts", "fork", "own.png"))).toBe(true);
    // 幂等：再删一次不抛错。
    await expect(removeSession(cliRoot, "sess", ["shared"])).resolves.toBeUndefined();
  });

  it("refuses an unsafe session id and a symlinked category root", async () => {
    const cliRoot = await temporaryRoot("nibi-deletion-symlink-");
    await expect(listSessionFiles(cliRoot, "../escape")).rejects.toMatchObject({
      code: "session-data.invalid-session-id",
    });
    const target = await temporaryRoot("nibi-deletion-target-");
    try {
      await symlink(target, join(cliRoot, "artifacts"), "junction");
    } catch (error) {
      // Windows 无权限时跳过；有权限的 CI 必须拒绝。
      if ((error as { code?: string }).code === "EPERM") return;
      throw error;
    }
    await expect(listSessionFiles(cliRoot, "sess")).rejects.toMatchObject({
      code: "session-data.symlink-root",
    });
  });
});
