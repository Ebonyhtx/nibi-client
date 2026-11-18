import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteMigrations } from "../../src/sqlite-migrations/index.js";

const root = process.argv[2]!;
const payload = "x".repeat(4096);
const rowCount = 16 * 1024;
const path = join(root, "source.sqlite");
const started = Date.now();
let db: DatabaseSync | undefined = new DatabaseSync(path);
try {
  db.exec("pragma cache_size=-2048; create table part(id integer primary key, data text); begin");
  const insert = db.prepare("insert into part values (?, ?)");
  for (let id = 0; id < rowCount; id++) insert.run(id, payload);
  db.exec("commit");
  const result = await sqliteMigrations.migrate(
    db,
    [
      {
        id: "0001_large",
        appVersion: "test",
        touchedTables: ["part"],
        sql: "update part set data='migrated' where id=0",
      },
    ],
    {
      database: "cli",
      backupDirectories: [join(root, "backup")],
      fallbackBackupDirectories: async () => [],
    },
  );
  assert.ok(result.backupPath);
  const metadata = JSON.parse(await readFile(join(result.backupPath, "backup.json"), "utf8")) as {
    version: number;
    tables: { rows: number; hash: string }[];
  };
  assert.equal(metadata.version, 2);
  assert.equal(metadata.tables[0]!.rows, rowCount);
  assert.match(metadata.tables[0]!.hash, /^[0-9a-f]{64}$/);
  assert.equal(db.prepare("select data from part where id=0").get()!.data, "migrated");
  db.close();
  db = new DatabaseSync(path);
  db.exec("pragma cache_size=-2048");
  await sqliteMigrations.restore(db, result.backupPath);
  assert.equal(db.prepare("select count(*) as n from part").get()!.n, rowCount);
  assert.equal(db.prepare("select count(*) as n from part where data<>?").get(payload)!.n, 0);
  assert.equal(db.prepare("select count(*) as n from schema_migration").get()!.n, 0);
  console.log(
    JSON.stringify({
      version: metadata.version,
      rows: rowCount,
      bytes: rowCount * payload.length,
      elapsedMs: Date.now() - started,
      maxRssKiB: process.resourceUsage().maxRSS,
    }),
  );
} finally {
  db?.close();
}
