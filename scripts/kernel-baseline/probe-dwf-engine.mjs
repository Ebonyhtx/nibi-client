/**
 * 探针：DWF 引擎能否脱离 CLI runtime 独立跑（路线 C 的前提验证）。
 *
 * 只 import 两个包（`@nibi/dynamic-workflow` 与 `@nibi/dynamic-workflow-runtime`）——这两个包
 * 的注释明确保证 app-free（不 import core/contracts/bootstrap/adapters）。driver 由本脚本扮演
 * （真实 driver 在 bootstrap 里；这里只需要证明"引擎 + journal + 沙箱子进程"这条管线能独立
 * 装配并产出可读的结算与事件）。
 *
 *   node scripts/kernel-baseline/probe-dwf-engine.mjs
 *
 * 两个用例：无 ask 的脚本、一次 untyped ask。都不落真实 ~/.nibi（cwd 是临时目录）。
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const packages = resolve(import.meta.dirname, "../../apps/nibi-cli/packages");
const dwf = await import(pathToFileURL(join(packages, "dynamic-workflow/dist/index.js")).href);
const { runWorkflowScript } = await import(
  pathToFileURL(join(packages, "dynamic-workflow-runtime/dist/index.js")).href
);
// 真实 journal 适配器（app-free：只 import @nibi/dynamic-workflow 的类型与 node:sqlite）。
const { createDwfJournalStore } = await import(
  pathToFileURL(
    join(packages, "adapters/dist/storage/session-store/repositories/dwf-journal.js"),
  ).href
);

const validateFn = (schema, value) => dwf.validate(schema, value);

function askSpecsFor(scriptText) {
  const workflow = dwf.createWorkflowProgram(scriptText);
  const table = dwf.collectSites(workflow);
  const { schemas } = dwf.synthesizeAskSchemas(workflow, table);
  return dwf.buildAskSpecs(table, schemas);
}

/** 最小 driver：建会话、异步回一句最终文本、记录事件。 */
class ProbeDriver {
  constructor(journal) {
    this.journal = journal;
    this.sink = undefined;
    this.events = [];
    this.asks = 0;
  }

  attach(sink) {
    this.sink = sink;
  }

  createActorSession(actor) {
    return Promise.resolve({ id: `session:${dwf.refToString(actor)}` });
  }

  startAsk(_session, instance) {
    this.asks += 1;
    queueMicrotask(() => this.sink?.askTurnEnded(instance, "42"));
  }

  respondToSubmit() {}

  cancelAsk() {}

  executeWorldRead(op) {
    return Promise.resolve(op === "glob" ? [] : "");
  }

  emit(event) {
    this.events.push(event);
  }
}

/** 用内核自己的迁移 SQL 建一份空库（0019 建 dwf_*；与 Rust 逐字节同一批文件）。 */
function migratedDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "nibi-dwf-db-"));
  const path = join(dir, "db.sqlite");
  const db = new DatabaseSync(path);
  // 账本表由内核的 open 建（不在迁移文件里）；之后 0024 之类的迁移会往里写。
  db.exec(
    "create table if not exists schema_migration (id text primary key, checksum text not null, app_version text, time_applied integer not null)",
  );
  const migrations = resolve(import.meta.dirname, "../../kernel/crates/node-store/src/repo/migrations");
  for (const file of readdirSync(migrations).sort()) {
    if (!file.endsWith(".sql")) continue;
    db.exec(readFileSync(join(migrations, file), "utf8"));
  }
  return { db, path };
}

async function run(label, scriptText, makeJournal = () => new dwf.InMemoryJournalStore()) {
  const journal = makeJournal();
  const driver = new ProbeDriver(journal);
  const cwd = mkdtempSync(join(tmpdir(), "nibi-dwf-probe-"));
  const settlement = await runWorkflowScript({
    scriptText,
    cwd,
    runId: `run-${label}`,
    caps: { maxConcurrency: 4 },
    askSpecs: askSpecsFor(scriptText),
    validate: validateFn,
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    parentSessionId: "sess_probe",
    timeoutMs: 30000,
  });
  const events = driver.events.map((event) => event.type);
  return { label, settlement, eventCount: events.length, sample: events.slice(0, 6), asks: driver.asks };
}

const cases = [
  ["plain", "return [1, 2, 3];"],
  [
    "ask",
    [
      'const worker = agent("worker", "You answer questions.");',
      'const answer = await worker.ask("What is the answer?");',
      "return answer;",
    ].join("\n"),
  ],
];

const results = [];
for (const [label, script] of cases) results.push(await run(label, script));
for (const result of results) {
  console.log(JSON.stringify(result));
}

// 第三段：真实 sqlite journal（引擎写 dwf_*，Rust 的只读端口读同一批行列）。
const { db, path } = migratedDatabase();
const journal = createDwfJournalStore(db);
const sqliteRun = await run("sqlite", cases[0][1], () => journal);
console.log(JSON.stringify({ label: "sqlite", ...sqliteRun }));
const row = db
  .prepare("select id, status, parent_session_id, spent_tokens from dwf_run where id = ?")
  .get("run-sqlite");
const runCount = db.prepare("select count(*) as n from dwf_run").get()?.n;
db.close();
console.log(`journal db: ${path}`);
console.log(`dwf_run row: ${JSON.stringify(row)} (rows=${runCount})`);

const ok =
  results.length === 2 &&
  results[0].settlement.status === "completed" &&
  JSON.stringify(results[0].settlement.artifact) === "[1,2,3]" &&
  results[1].settlement.status === "completed" &&
  results[1].settlement.artifact === "42" &&
  results[1].asks === 1 &&
  sqliteRun.settlement.status === "completed" &&
  row?.status === "completed" &&
  runCount === 1;
console.log(`RESULT: ${ok ? "OK" : "FAILED"}`);
process.exit(ok ? 0 : 1);
