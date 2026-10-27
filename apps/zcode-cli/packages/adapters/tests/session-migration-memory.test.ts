import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteMigrations } from "@nibi/shared/sqlite-migrations";
import {
  isMemoryDatabasePath,
  runSqliteSessionMigrationsAsync,
} from "../src/storage/session-store/migration-runner.js";

const directories: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("session migrations on in-memory databases", () => {
  it("recognizes every in-memory database path shape", () => {
    expect(isMemoryDatabasePath(":memory:")).toBe(true);
    expect(isMemoryDatabasePath("file::memory:")).toBe(true);
    expect(isMemoryDatabasePath("file:session?mode=memory&cache=shared")).toBe(true);
    expect(isMemoryDatabasePath("D:/data/sessions.sqlite")).toBe(false);
    expect(isMemoryDatabasePath("file:///D:/data/sessions.sqlite")).toBe(false);
  });

  it("asks the shared runner to skip backups for :memory:", async () => {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const migrate = vi.spyOn(sqliteMigrations, "migrate");

    await runSqliteSessionMigrationsAsync(db, ":memory:");

    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate.mock.calls[0]?.[2]).toMatchObject({ skipBackup: true });
  });

  it("keeps regular file-backed databases on the backup path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "session-migration-memory-"));
    directories.push(directory);
    const databasePath = join(directory, "cli", "db", "db.sqlite");
    await mkdir(dirname(databasePath), { recursive: true });
    const db = new DatabaseSync(databasePath);
    databases.push(db);
    const migrate = vi.spyOn(sqliteMigrations, "migrate");

    await runSqliteSessionMigrationsAsync(db, databasePath);

    expect(migrate.mock.calls[0]?.[2]).toMatchObject({
      backupDirectories: [join(directory, "backup")],
      skipBackup: false,
    });
  });
});
