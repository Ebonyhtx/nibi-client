import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { MigrationBackup, SqliteMigration } from "../src/sqlite-migrations/contract.js";
import { sqliteMigrations } from "../src/sqlite-migrations/index.js";

const exec = promisify(execFile);
const directories: string[] = [];
const databases: DatabaseSync[] = [];

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "nibi-migration-v2-"));
  directories.push(directory);
  return directory;
}

function database() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  return db;
}

function options(directory: string) {
  return {
    database: "cli",
    backupDirectories: [directory],
    fallbackBackupDirectories: async () => [],
  };
}

function migration(touchedTables: string[], sql: string): SqliteMigration {
  return { id: "0001_change", appVersion: "test", touchedTables, sql };
}

async function migrate(db: DatabaseSync, directory: string, touchedTables: string[], sql: string) {
  return sqliteMigrations.migrate(db, [migration(touchedTables, sql)], options(directory));
}

async function readMetadata(backupPath: string): Promise<MigrationBackup> {
  return JSON.parse(await readFile(join(backupPath, "backup.json"), "utf8")) as MigrationBackup;
}

/** v1 备份的旧哈希口径：行 JSON 按 UTF-16 码元排序后整体 JSON 编码。 */
function legacyHash(rows: readonly SQLInputValue[][]): string {
  const encoded = rows
    .map((row) =>
      JSON.stringify(row, (_key, value: unknown) => {
        if (typeof value === "bigint") return { integer: value.toString() };
        if (value instanceof Uint8Array) return { blob: Buffer.from(value).toString("hex") };
        return value;
      }),
    )
    .sort();
  return createHash("sha256").update(JSON.stringify(encoded)).digest("hex");
}

describe("sqlite-migrations v2 backup", () => {
  it("writes version 2 metadata, hashes rows order-independently and keeps duplicates", async () => {
    const hashes: string[] = [];
    for (const values of [
      ["a", "b", "a"],
      ["b", "a", "a"],
      ["a", "b"],
    ]) {
      const directory = await fixture();
      const db = database();
      db.exec("create table item(value text)");
      const insert = db.prepare("insert into item values (?)");
      for (const value of values) insert.run(value);
      const result = await migrate(db, directory, ["item"], "update item set value='changed'");
      const metadata = await readMetadata(result.backupPath!);
      expect(metadata.version).toBe(2);
      expect(metadata.tables).toEqual([
        {
          name: "item",
          columns: ["value"],
          rows: values.length,
          hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]);
      hashes.push(metadata.tables[0]!.hash);
      await sqliteMigrations.restore(db, result.backupPath!);
      expect(
        db
          .prepare("select value from item order by value")
          .all()
          .map((row) => row.value),
      ).toEqual([...values].sort());
    }
    // 行顺序不影响表哈希；重复行参与哈希，减少一行就改变哈希。
    expect(hashes[0]).toBe(hashes[1]);
    expect(hashes[0]).not.toBe(hashes[2]);
  });

  it("restores legacy version 1 backups with UTF-16 ordering, exact integers, BLOB and NULL", async () => {
    const directory = await fixture();
    const backupPath = join(directory, "legacy");
    await mkdir(backupPath);
    const values: SQLInputValue[][] = [
      ["\uE000", null],
      ["😀", 9223372036854775807n],
      ['a"\\\n', new Uint8Array([0, 255])],
      ['a"\\\n', new Uint8Array([0, 255])],
      ["real", 1.25],
    ];
    const backup = new DatabaseSync(join(backupPath, "tables.sqlite"));
    backup.exec("create table item(value, detail)");
    for (const row of values) backup.prepare("insert into item values (?, ?)").run(...row);
    backup.close();
    await writeFile(
      join(backupPath, "backup.json"),
      JSON.stringify({
        version: 1,
        database: "cli",
        migrations: ["0001_change"],
        tables: [
          {
            name: "item",
            columns: ["value", "detail"],
            rows: values.length,
            hash: legacyHash(values),
          },
        ],
      }),
    );
    const db = database();
    db.exec(
      "create table item(value, detail, added text default 'default');" +
        "create table schema_migration(id text);" +
        "insert into schema_migration values ('0001_change'),('unknown');" +
        "insert into item(value) values ('changed')",
    );
    await sqliteMigrations.restore(db, backupPath);
    const statement = db.prepare("select value, detail from item");
    statement.setReadBigInts(true);
    expect(statement.all().map((row) => [row.value, row.detail])).toEqual(values);
    expect(db.prepare("select distinct added from item").all()).toEqual([{ added: "default" }]);
    expect(db.prepare("select id from schema_migration").all()).toEqual([{ id: "unknown" }]);
  });

  it("restores an empty declared table without inventing rows", async () => {
    const directory = await fixture();
    const db = database();
    db.exec("create table empty(id integer primary key, value text)");
    const result = await migrate(db, directory, ["empty"], "insert into empty values (1,'after')");
    const metadata = await readMetadata(result.backupPath!);
    expect(metadata.version).toBe(2);
    expect(metadata.tables).toEqual([
      { name: "empty", columns: ["id", "value"], rows: 0, hash: expect.any(String) },
    ]);
    expect(db.prepare("select count(*) as n from empty").get()).toEqual({ n: 1 });
    await sqliteMigrations.restore(db, result.backupPath!);
    expect(db.prepare("select count(*) as n from empty").get()).toEqual({ n: 0 });
    expect(db.prepare("pragma table_info(empty)").all().map((row) => row.name)).toEqual([
      "id",
      "value",
    ]);
  });

  it("round-trips large text and BLOB values without converting types", async () => {
    const directory = await fixture();
    const db = database();
    const body = "文".repeat(128 * 1024);
    const raw = Uint8Array.from({ length: 64 * 1024 }, (_, index) => index % 256);
    db.exec("create table payload(id integer primary key, body text, raw blob, exact integer)");
    db.prepare("insert into payload values (1, ?, ?, ?)").run(
      body,
      raw,
      9223372036854775807n,
    );
    db.prepare("insert into payload values (2, null, null, null)").run();
    const result = await migrate(db, directory, ["payload"], "update payload set body='changed'");
    expect((await readMetadata(result.backupPath!)).tables[0]!.rows).toBe(2);
    await sqliteMigrations.restore(db, result.backupPath!);
    const statement = db.prepare("select body, raw, exact from payload order by id");
    statement.setReadBigInts(true);
    const rows = statement.all();
    expect(rows[0]).toMatchObject({ body, exact: 9223372036854775807n });
    expect(Buffer.from(rows[0]!.raw as Uint8Array)).toEqual(Buffer.from(raw));
    expect(rows[1]).toEqual({ body: null, raw: null, exact: null });
  });

  it("rejects a backup whose stored rows no longer match the recorded hash before touching the target", async () => {
    const directory = await fixture();
    const db = database();
    db.exec(
      "create table parent(id text primary key, value text);" +
        "create table child(id text primary key, value text);" +
        "insert into parent values ('p','original');" +
        "insert into child values ('c','original')",
    );
    const result = await migrate(
      db,
      directory,
      ["parent", "child"],
      "update parent set value='migrated'; update child set value='migrated'",
    );
    const before = {
      parent: db.prepare("select * from parent order by id").all(),
      child: db.prepare("select * from child order by id").all(),
    };
    // 只破坏第二张表：第一张表校验通过后仍不能开始恢复。
    const backup = new DatabaseSync(join(result.backupPath!, "tables.sqlite"));
    backup.exec("delete from child");
    backup.close();
    await expect(sqliteMigrations.restore(db, result.backupPath!)).rejects.toThrow(
      "Backup row count/hash mismatch: child",
    );
    expect(db.prepare("select * from parent order by id").all()).toEqual(before.parent);
    expect(db.prepare("select * from child order by id").all()).toEqual(before.child);
    expect(db.prepare("select id from schema_migration order by id").all()).toEqual([
      { id: "0001_change" },
    ]);
    expect(db.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("rejects corrupted metadata hashes instead of silently restoring partial data", async () => {
    const directory = await fixture();
    const db = database();
    db.exec("create table item(value text); insert into item values ('original')");
    const result = await migrate(db, directory, ["item"], "update item set value='migrated'");
    const path = join(result.backupPath!, "backup.json");
    const metadata = await readMetadata(result.backupPath!);
    metadata.tables[0]!.hash = "0".repeat(64);
    await writeFile(path, JSON.stringify(metadata));
    await expect(sqliteMigrations.restore(db, result.backupPath!)).rejects.toThrow(
      "Backup row count/hash mismatch: item",
    );
    expect(db.prepare("select value from item").all()).toEqual([{ value: "migrated" }]);
    expect(db.prepare("select count(*) as n from schema_migration").get()).toEqual({ n: 1 });
  });

  it("rolls back when the restored rows do not reproduce the recorded hash", async () => {
    const directory = await fixture();
    const db = database();
    db.exec("create table item(value text); insert into item values ('original')");
    const result = await migrate(db, directory, ["item"], "update item set value='migrated'");
    db.exec(
      "create trigger mangle after insert on item begin update item set value='mangled' where rowid=new.rowid; end",
    );
    await expect(sqliteMigrations.restore(db, result.backupPath!)).rejects.toThrow(
      "Restored row count/hash mismatch: item",
    );
    expect(db.prepare("select value from item").all()).toEqual([{ value: "migrated" }]);
    expect(db.prepare("select count(*) as n from schema_migration").get()).toEqual({ n: 1 });
    expect(db.prepare("pragma foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it("backs up and restores a large table under a 96 MiB V8 heap", async () => {
    const directory = await fixture();
    const { stdout } = await exec(
      process.execPath,
      [
        "--max-old-space-size=96",
        "--import",
        "tsx",
        fileURLToPath(new URL("./fixtures/sqliteMigrationLargeBackupProcess.ts", import.meta.url)),
        directory,
      ],
      { timeout: 240_000, maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(stdout.trim()) as {
      version: number;
      rows: number;
      bytes: number;
      elapsedMs: number;
      maxRssKiB: number;
    };
    console.info("large sqlite migration backup:", report);
    expect(report.version).toBe(2);
    expect(report.rows).toBe(16 * 1024);
    expect(report.bytes).toBe(64 * 1024 * 1024);
    // 旧实现把整表数组、行 JSON 和整体 JSON 都留在堆里；96 MiB 堆下这些表会 OOM。
    expect(report.maxRssKiB).toBeLessThan(320 * 1024);
    expect(report.elapsedMs).toBeLessThan(180_000);
  }, 260_000);
});
