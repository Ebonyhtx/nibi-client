/**
 * 探针：DWF sidecar 控制面（路线 C 的跨进程版本）。
 *
 *   node scripts/kernel-baseline/probe-dwf-sidecar.mjs
 *
 * 父进程扮演"Rust 宿主"（建 actor、回 ask、答世界读取），子进程是 sidecar：真实引擎
 * （`@nibi/dynamic-workflow-runtime` 的 `runWorkflowScript`，含沙箱子进程）+ 真实 sqlite
 * journal（`createDwfJournalStore`，`dwf_*` 表）。driver 在 sidecar 里，每个方法都是一条到宿主的
 * RPC —— 这正是 C1 的形态（模型与工具留在 Rust，引擎与沙箱在 Node）。
 *
 * 断言：
 * 1. actor 由宿主建（`actor/create` 走过）；
 * 2. typed ask 的提交被引擎校验：先提交错误形状 → 引擎走 repair（`ask/verdict` reject）→
 *    宿主重提正确形状 → 结算；
 * 3. run 事件流到宿主；journal 行是 completed。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const packages = resolve(import.meta.dirname, "../../apps/zcode-cli/packages");
const migrations = resolve(import.meta.dirname, "../../kernel/crates/node-store/src/repo/migrations");

const SCRIPT = [
  'const worker = agent("worker", "You answer questions.");',
  'const answer = await worker.ask<{ answer: number }>("Give me the answer.");',
  "return answer;",
].join("\n");

async function load() {
  const dwf = await import(pathToFileURL(join(packages, "dynamic-workflow/dist/index.js")).href);
  const { runWorkflowScript } = await import(
    pathToFileURL(join(packages, "dynamic-workflow-runtime/dist/index.js")).href
  );
  const { createDwfJournalStore } = await import(
    pathToFileURL(join(packages, "adapters/dist/storage/session-store/repositories/dwf-journal.js")).href
  );
  return { dwf, runWorkflowScript, createDwfJournalStore };
}

function migratedDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "nibi-dwf-sidecar-"));
  const path = join(dir, "db.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "create table if not exists schema_migration (id text primary key, checksum text not null, app_version text, time_applied integer not null)",
  );
  for (const file of readdirSync(migrations).sort()) {
    if (file.endsWith(".sql")) db.exec(readFileSync(join(migrations, file), "utf8"));
  }
  return { db, path };
}

function askSpecsFor(dwf, scriptText) {
  const workflow = dwf.createWorkflowProgram(scriptText);
  const table = dwf.collectSites(workflow);
  const { schemas } = dwf.synthesizeAskSchemas(workflow, table);
  return dwf.buildAskSpecs(table, schemas);
}

// ───────────────────────────── engine（子进程）─────────────────────────────
async function engine() {
  const { dwf, runWorkflowScript, createDwfJournalStore } = await load();
  const lines = createInterface({ input: process.stdin });
  let nextRequest = 1;
  const pending = new Map();
  const drivers = new Map();

  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const request = (method, params) =>
    new Promise((resolveRequest, rejectRequest) => {
      const id = `e${nextRequest++}`;
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      send({ id, method, params });
    });
  const notify = (method, params) => send({ method, params });

  class RemoteDriver {
    constructor(journal) {
      // 引擎直接读 driver.journal（JournalStorePort）；写归引擎，driver 只是持有它。
      this.journal = journal;
      this.sink = undefined;
      this.session = new Map();
    }

    attach(sink) {
      this.sink = sink;
    }

    async createActorSession(actor) {
      if (process.env.PROBE_DEBUG) console.error("[engine] createActorSession", JSON.stringify(actor));
      const reply = await request("actor/create", { actor });
      if (process.env.PROBE_DEBUG) console.error("[engine] actor session", JSON.stringify(reply));
      return { id: reply.session };
    }

    startAsk(session, instance, message) {
      if (process.env.PROBE_DEBUG) console.error("[engine] startAsk", JSON.stringify({ session, instance, typed: message.typed }));
      const key = `${instance.siteId}@${instance.ordinal}`;
      this.session.set(key, { session, instance });
      notify("ask/start", { key, session, instance, typed: message.typed === true });
    }

    respondToSubmit(instance, verdict) {
      const key = `${instance.siteId}@${instance.ordinal}`;
      notify("ask/verdict", { key, verdict });
    }

    cancelAsk(instance) {
      notify("ask/cancel", { key: `${instance.siteId}@${instance.ordinal}` });
    }

    async executeWorldRead(op, args) {
      return request("world/read", { op, args });
    }

    emit(event) {
      notify("run/event", { type: event.type });
    }
  }

  for await (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (process.env.PROBE_DEBUG) console.error(`[engine->host] ${line.slice(0, 200)}`);
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
      continue;
    }
    if (message.method === "ask/reply") {
      const driver = drivers.get(message.params.runId);
      if (!driver) continue;
      const { instance, kind, payload, text } = message.params;
      if (kind === "submit") driver.sink?.askSubmitAttempted(instance, payload);
      else if (kind === "text") driver.sink?.askTurnEnded(instance, text ?? "");
      else if (kind === "fail") driver.sink?.askFailed(instance, payload);
      continue;
    }
    if (message.method === "submit") {
      // 不能在这个读循环里 await：run 期间的 RPC 响应也走这条 stdin，阻塞读循环会死锁。
      void (async () => {
      const { runId, parentSessionId, cwd, scriptText, args, caps, dbPath } = message.params;
      const db = new DatabaseSync(dbPath);
      const journal = createDwfJournalStore(db);
      const driver = new RemoteDriver(journal);
      drivers.set(runId, driver);
      const settlement = await runWorkflowScript({
        scriptText,
        cwd,
        runId,
        parentSessionId,
        args: args ?? {},
        caps: caps ?? { maxConcurrency: 4 },
        askSpecs: askSpecsFor(dwf, scriptText),
        validate: (schema, value) => dwf.validate(schema, value),
        makeDriver: (sink) => {
          driver.attach(sink);
          return driver;
        },
        timeoutMs: 30000,
      }).catch((error) => ({ status: "errored", error: { message: String(error) } }));
      db.close();
      send({ id: message.id, result: { ok: true, settlement } });
      })();
    }
  }
}

// ───────────────────────────── host（父进程，扮演 Rust）─────────────────────────────
async function host() {
  // 默认起本文件的 engine 模式；PROBE_ENGINE_CMD='["node","dist/nibi.cjs","__nibi-dwf-engine"]'
  // 可以换成产品入口（Node CLI 的隐藏子命令）。
  const override = process.env.PROBE_ENGINE_CMD;
  const command = override ? JSON.parse(override) : [process.execPath, import.meta.filename, "--engine"];
  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  const events = [];
  let asks = 0;
  let repairs = 0;
  let resolved = null;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const reply = (id, result) => send({ id, result });

  lines.on("line", (line) => {
    if (!line.trim()) return;
    const message = JSON.parse(line);
    if (process.env.PROBE_DEBUG) console.error(`[engine->host] ${line.slice(0, 200)}`);
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        entry(message.error ? { error: message.error } : message.result);
      }
      return;
    }
    switch (message.method) {
      case "actor/create":
        reply(message.id, { session: `session:${message.params.actor.siteId ?? "actor"}` });
        break;
      case "world/read":
        reply(message.id, message.params.op === "glob" ? [] : "");
        break;
      case "run/event":
        events.push(message.params.type);
        break;
      case "ask/verdict":
        if (message.params.verdict?.kind !== "accept") {
          repairs += 1;
          // 引擎拒绝后重提正确形状（repair 一轮）。
          send({
            method: "ask/reply",
            params: {
              runId: "run-sidecar",
              instance: message.params.instance ?? { siteId: "ask#1", ordinal: 1 },
              kind: "submit",
              payload: { answer: 42 },
            },
          });
        }
        break;
      case "ask/start":
        asks += 1;
        // 第一次故意提交错误形状（字符串而不是数字），让引擎走 repair。
        send({
          method: "ask/reply",
          params: {
            runId: "run-sidecar",
            instance: message.params.instance,
            kind: "submit",
            payload: { answer: "not a number" },
          },
        });
        break;
      default:
        break;
    }
  });

  const { db: hostDb, path: hostDbPath } = migratedDatabase();
  hostDb.close();
  const submitted = await new Promise((resolveSubmit, rejectSubmit) => {
    const id = "h1";
    pending.set(id, resolveSubmit);
    send({
      id,
      method: "submit",
      params: {
        runId: "run-sidecar",
        parentSessionId: "sess_parent",
        cwd: mkdtempSync(join(tmpdir(), "nibi-dwf-sidecar-cwd-")),
        dbPath: hostDbPath,
        scriptText: SCRIPT,
        caps: { maxConcurrency: 4 },
      },
    });
    setTimeout(() => rejectSubmit(new Error("submit timed out")), 40_000);
  });

  resolved = submitted;
  child.stdin.end();
  child.kill();

  const settlement = resolved?.settlement;
  const verify = new DatabaseSync(hostDbPath);
  const journal = verify
    .prepare("select status, parent_session_id from dwf_run where id = ?")
    .get("run-sidecar");
  verify.close();
  const ok =
    settlement?.status === "completed" &&
    JSON.stringify(settlement.artifact) === '{"answer":42}' &&
    journal?.status === "completed" &&
    journal?.parent_session_id === "sess_parent" &&
    asks === 1 &&
    repairs >= 1 &&
    events.includes("run-started") &&
    events.includes("run-settled");
  console.log(
    JSON.stringify({
      settlement,
      journal,
      eventCount: events.length,
      events: [...new Set(events)],
      asks,
      repairs,
    }),
  );
  console.log(`RESULT: ${ok ? "OK" : "FAILED"}`);
  process.exit(ok ? 0 : 1);
}

if (process.argv.includes("--engine")) {
  await engine();
} else {
  await host();
}
