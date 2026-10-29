/**
 * 0020–0024 迁移 SQL 逐字节比对（Rust 规划 §6 阶段 1 / R2）。
 *
 * 用法：
 *   pnpm exec tsx scripts/kernel-baseline/compare-migration-sql.ts \
 *     [--db <Node 生成的 db.sqlite>] [--out <报告.json>]
 *
 * 比较三方：
 *   1. Node 的 SQLITE_MIGRATIONS（TS 单一来源，SQL 在模块里程序化拼出）
 *   2. Rust kernel/crates/node-store/src/repo/migrations/00NN_*.sql
 *   3. （可选）Node 库 schema_migration.checksum（sha256(sql.trim())）
 *
 * 只读：不写 db，不修改任何迁移文件。
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { SQLITE_MIGRATIONS } from "../../apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const rustDir = join(repoRoot, "kernel", "crates", "node-store", "src", "repo", "migrations");

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const wanted = [20, 21, 22, 23, 24];
const databasePath = option("db");
const outPath = option("out");

function migrationNumber(id: string): number {
  const prefix = id.split("_")[0];
  return Number.parseInt(prefix ?? "", 10);
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function firstDifference(a: string, b: string): string | null {
  if (a === b) return null;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if (a[index] !== b[index]) {
      const line = a.slice(0, index).split("\n").length;
      return `char ${index} (line ${line}): node=${JSON.stringify(a.slice(index, index + 40))} rust=${JSON.stringify(b.slice(index, index + 40))}`;
    }
  }
  return `length differs: node=${a.length} rust=${b.length}`;
}

const rustFiles = new Map<number, { file: string; sql: string }>();
for (const file of readdirSync(rustDir)) {
  const match = /^(\d{4})_.*\.sql$/.exec(file);
  if (!match) continue;
  const number = Number.parseInt(match[1]!, 10);
  if (!wanted.includes(number)) continue;
  rustFiles.set(number, {
    file: join("kernel/crates/node-store/src/repo/migrations", file),
    sql: readFileSync(join(rustDir, file), "utf8"),
  });
}

const nodeMigrations = new Map<number, { id: string; sql: string }>();
for (const migration of SQLITE_MIGRATIONS) {
  const number = migrationNumber(migration.id);
  if (!wanted.includes(number)) continue;
  nodeMigrations.set(number, { id: migration.id, sql: migration.sql });
}

const dbChecksums = new Map<number, string>();
if (databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    for (const row of db
      .prepare("select id, checksum from schema_migration order by id")
      .all() as Array<{ id: string; checksum: string }>) {
      const number = migrationNumber(row.id);
      if (wanted.includes(number)) dbChecksums.set(number, String(row.checksum));
    }
  } finally {
    db.close();
  }
}

const results = wanted.map((number) => {
  const node = nodeMigrations.get(number);
  const rust = rustFiles.get(number);
  const nodeTrimmed = node?.sql.trim() ?? "";
  const rustTrimmed = rust?.sql.trim() ?? "";
  const nodeChecksum = node ? sha256(nodeTrimmed) : null;
  const rustChecksum = rust ? sha256(rustTrimmed) : null;
  const dbChecksum = dbChecksums.get(number) ?? null;
  return {
    number,
    nodeId: node?.id ?? null,
    rustFile: rust?.file ?? null,
    identical: Boolean(node && rust) && nodeTrimmed === rustTrimmed,
    difference: node && rust ? firstDifference(nodeTrimmed, rustTrimmed) : "missing side",
    nodeBytes: Buffer.byteLength(nodeTrimmed, "utf8"),
    rustBytes: Buffer.byteLength(rustTrimmed, "utf8"),
    nodeChecksum,
    rustChecksum,
    dbChecksum,
    checksumMatchesDb:
      dbChecksum === null ? null : nodeChecksum === dbChecksum && rustChecksum === dbChecksum,
  };
});

const ok = results.every(
  (result) => result.identical && (result.checksumMatchesDb === null || result.checksumMatchesDb),
);
const report = {
  generatedAt: new Date().toISOString(),
  repoHead: readHead(),
  databasePath: databasePath ?? null,
  ok,
  results,
};
const text = `${JSON.stringify(report, null, 2)}\n`;
if (outPath) writeFileSync(outPath, text, "utf8");
process.stdout.write(
  [
    `0020-0024 SQL 逐字节比对：${ok ? "OK" : "FAILED"}`,
    ...results.map(
      (result) =>
        `  ${result.number}: identical=${result.identical} checksumDb=${result.checksumMatchesDb ?? "-"} bytes=${result.rustBytes}${result.difference ? `\n    ${result.difference}` : ""}`,
    ),
    "",
  ].join("\n"),
);
if (!ok) process.exitCode = 1;

function readHead(): string | null {
  try {
    return readFileSync(join(repoRoot, ".git", "HEAD"), "utf8").trim();
  } catch {
    return null;
  }
}
