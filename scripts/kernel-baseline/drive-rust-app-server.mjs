/**
 * 无头驱动 Rust app-server（Step 2 的第一次 Node/Rust 行为对照预演）。
 *
 *   node scripts/kernel-baseline/drive-rust-app-server.mjs [--keep] [--phases create,compact,fork,retry]
 *
 * 做法：隔离 HOME + 本地假 provider（与 collect-kernel-baseline.mjs 同款），起
 * `kernel/target/debug/zcode-rs.exe app-server --stdio`，按 LF-JSON 协议驱动：
 *   startup/storageState → v4/command createSession → sendText →（流式帧）→ turn 完成
 *   → compact → forkAssistant → retryTurn，每步断言 ACK。
 * 不写真实 ~/.zcode / ~/.nibi；不调用真实模型。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = "D:/NIBI/NIBI-Client";
const bin = join(repo, "kernel/target/debug/zcode-rs.exe");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const phases = (args.find((a) => a.startsWith("--phases")) ?? "--phases=create,fork,retry,compact")
  .split("=")[1]
  .split(",");

if (!process.version.startsWith("v24")) {
  console.error(`warning: running on ${process.version}`);
}

const home = mkdtempSync(join(tmpdir(), "nibi-rust-drive-"));
const dataV2 = join(home, ".zcode", "v2");
mkdirSync(dataV2, { recursive: true });
const workspace = join(home, "workspace");
mkdirSync(workspace, { recursive: true });

// ── 本地假 provider（OpenAI chat-completions，SSE）──
const REQUESTS = [];
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {}
    REQUESTS.push({ at: Date.now(), path: req.url, model: parsed?.model ?? null });
    const text = "RUST-DRIVE-REPLY";
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text, role: "assistant" }, index: 0 }], id: "drive", object: "chat.completion.chunk" })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], id: "drive", object: "chat.completion.chunk" })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const providerConfig = {
  schemaVersion: 1,
  config: {
    providerOrder: ["drive-fake"],
    providerConfigRules: {
      providerRules: [
        {
          providerId: "drive-fake",
          providerName: "Drive Fake",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "fake-key" },
            api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1` },
            personalModelIds: ["fake-model"],
            modelOrder: ["fake-model"],
          },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [
        {
          modelId: "fake-model",
          providerId: "drive-fake",
          config: {
            enabled: true,
            properties: { supportsJsonSchemaOutput: true, supportsMidConversationSystem: true },
          },
        },
      ],
      manualProviderModelRules: [],
    },
    defaultModelSelection: { providerId: "drive-fake", modelId: "fake-model" },
  },
};
writeFileSync(join(dataV2, "provider_config.json"), JSON.stringify(providerConfig, null, 2));

// ── 进程与协议 ──
const child = spawn(bin, ["app-server", "--stdio"], {
  cwd: workspace,
  env: {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    ZCODE_DATA_BASE_DIR: home,
    ZCODE_STORAGE_DIR: join(home, ".zcode"),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));

const frames = [];
const notifications = [];
const pending = new Map();
let nextId = 1;
let buffer = "";

function send(method, params) {
  const id = nextId++;
  const line = JSON.stringify({ id, method, params });
  child.stdin.write(`${line}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method} (id=${id})`));
    }, 60_000);
    pending.set(id, { resolve: (value) => {
      clearTimeout(timer);
      resolve(value);
    }, method });
  });
}

function parseLine(line) {
  if (!line.trim()) return;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    console.error(`[non-json] ${line.slice(0, 200)}`);
    return;
  }
  if (value.method !== undefined && value.id === undefined) {
    notifications.push(value);
    if (value.method === "v4/conversation/frame") {
      frames.push(value.params);
    }
    return;
  }
  if (value.id !== undefined && value.method === undefined && pending.has(value.id)) {
    const entry = pending.get(value.id);
    pending.delete(value.id);
    entry.resolve(value);
    return;
  }
  console.error(`[unmatched] ${line.slice(0, 200)}`);
}

child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) parseLine(line);
});

const exit = new Promise((resolve) => child.on("close", (code) => resolve(code)));

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = predicate();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) {
      throw new Error(`timeout waiting for ${label}; frames=${frames.length} notifications=${notifications.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function ack(value, label) {
  if (value.error) {
    throw new Error(`${label} got error: ${JSON.stringify(value.error)}`);
  }
  return value.result;
}

try {
  // 1) startup/storageState：等 ready（先来的是 checking）
  const startup = await waitFor(
    () => notifications.find((n) => n.method === "startup/storageState" && n.params.phase === "ready"),
    "startup/storageState ready",
  );
  console.log(`startup: ready elapsed=${startup.params.elapsedMs}ms`);

  // 2) createSession（带 firstInput）
  const ack1 = ack(
    await send("v4/command", {
      commandId: "0197d3f0-0000-7000-8000-000000000001",
      clientId: "drive",
      sessionId: null,
      type: "createSession",
      payload: {
        workspaceId: workspace,
        firstInput: { text: "hello rust kernel", mode: "yolo" },
      },
      issuedAt: Date.now(),
    }),
    "createSession",
  );
  const sessionId = ack1.result?.sessionId;
  if (!sessionId) throw new Error(`createSession result missing sessionId: ${JSON.stringify(ack1)}`);
  console.log(`createSession: ${sessionId}`);

  // 2.4) 订阅会话主题（Host 正常流程：订阅后泵才会发帧）
  const sub = await send("v4/conversation/subscribe", {
    topic: `conversation/${sessionId}`,
    connectionId: "drive",
    visibility: "foreground",
    clientMode: "desktop-continuous",
  });
  const epoch = sub.result?.epoch;
  console.log(`subscribe: sub=${sub.result?.subscription} epoch=${epoch}`);

  // 2.5) sendText
  const send1 = await send("v4/command", {
    commandId: "0197d3f0-0000-7000-8000-00000000000a",
    clientId: "drive",
    sessionId,
    type: "sendText",
    payload: { text: "hello rust kernel" },
    issuedAt: Date.now(),
  });
  console.log(`sendText ack: ${JSON.stringify(send1)}`);

  // 3) 等 assistant 回复（假 provider 即时返回）
  await waitFor(
    () => (JSON.stringify(frames).includes("RUST-DRIVE-REPLY") ? true : undefined),
    "assistant reply frame",
    60_000,
  );
  console.log(`sendText: assistant reply visible, frames=${frames.length}`);

  // 轻量回放：snapshot.rows + deltas（row.appended / row.upserted / state.updated.patch）。
  const buildState = () => {
    let logEpoch = null;
    let revision = 0;
    const rows = new Map();
    for (const frame of frames) {
      const payload = frame.frame?.payload ?? {};
      if (payload.kind === "snapshot") {
        const snap = payload.snapshot ?? {};
        logEpoch = snap.logEpoch ?? logEpoch;
        revision = snap.revision ?? revision;
        for (const row of snap.rows?.window ?? []) rows.set(row.rowId, row);
      } else if (payload.kind === "deltas") {
        for (const delta of payload.deltas ?? []) {
          if (delta.op === "row.appended") {
            rows.set(delta.row.rowId, { ...rows.get(delta.row.rowId), ...delta.row });
          } else if (delta.op === "row.upserted") {
            rows.set(delta.row.rowId, { ...rows.get(delta.row.rowId), ...delta.row });
          } else if (delta.op === "state.updated" && delta.patch) {
            if (Number.isFinite(delta.patch.revision)) revision = delta.patch.revision;
            if (delta.patch.meta?.logEpoch) logEpoch = delta.patch.meta.logEpoch;
          }
        }
      }
    }
    return { logEpoch, revision, rows: [...rows.values()] };
  };
  const targetRowOf = (state) =>
    [...state.rows].reverse().find((row) => row.assistantResponseId) ?? null;

  // 4) compact
  if (phases.includes("compact")) {
    const ack2 = ack(
      await send("v4/command", {
        commandId: "0197d3f0-0000-7000-8000-000000000002",
        clientId: "drive",
        sessionId,
        type: "compact",
        payload: {},
        issuedAt: Date.now(),
      }),
      "compact",
    );
    if (ack2.status !== "accepted") throw new Error(`compact status=${ack2.status}: ${ack2.reasonCode} ${ack2.message}`);
    console.log(`compact: accepted`);
  }

  // 5/6) forkAssistant + retryTurn：CAS stale 就地重试（协议设计的用法）。
  let rowTargetSeq = 0;
  const rowTargetCommand = async (type) => {
    for (let attempt = 0; ; attempt += 1) {
      rowTargetSeq += 1;
      const commandId = `0197d3f0-0000-7000-8000-${String(rowTargetSeq).padStart(12, "0")}`;
      const state = buildState();
      const row = targetRowOf(state);
      if (!row) throw new Error(`no assistant row for ${type}`);
      const ackResult = ack(
        await send("v4/command", {
          commandId,
          clientId: "drive",
          sessionId,
          baseRevision: state.revision,
          baseLogEpoch: state.logEpoch,
          type,
          payload: { target: { rowId: row.rowId, entityId: row.entityId } },
          issuedAt: Date.now(),
        }),
        type,
      );
      if ((ackResult.status === "stale" || ackResult.status === "duplicate") && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      if (ackResult.status !== "accepted") {
        throw new Error(`${type} ${ackResult.status}: ${ackResult.reasonCode} ${ackResult.message} raw=${JSON.stringify(ackResult)}`);
      }
      return ackResult;
    }
  };
  if (phases.includes("fork")) {
    const ack3 = await rowTargetCommand("forkAssistant");
    const child = typeof ack3.result === "string" ? ack3.result : ack3.result?.sessionId;
    console.log(`forkAssistant: child=${child}`);
  }
  if (phases.includes("retry")) {
    const legacy = await send("session/read", { sessionId });
    console.log();
    const ack4 = await rowTargetCommand("retryTurn");
    console.log(`retryTurn: accepted`);
  }

  console.log(`provider requests: ${REQUESTS.length}`);
  console.log("PHASES OK");
} catch (error) {
  console.error("FAILED: " + error.message + String(error.stack ?? "").split(String.fromCharCode(10)).slice(0, 8).join(String.fromCharCode(10)));

  console.error(`stderr tail:\n${stderr.split(/\r?\n/).slice(-12).join("\n")}`);
  console.error(`notifications: ${notifications.map((n) => n.method).join(", ")}`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
  server.close();
  await exit;
  if (!keep) {
    // 隔离目录留 temp 自清理；--keep 时打印路径
  } else {
    console.log(`home: ${home}`);
  }
}
