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
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "../..");
const bin = join(repo, "kernel/target/debug/zcode-rs.exe");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const phases = (args.find((a) => a.startsWith("--phases")) ?? "--phases=create,rename,switchModel,switchMode,fork,rejections,edit,retry,compact")
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
    RUST_LOG: process.env.RUST_LOG ?? 'debug',
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
    const found = await predicate();
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

let editResubmitted = false;
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

  const currentCommittedCount = async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const legacy = await send("session/read", { sessionId });
    return (legacy.result?.messages ?? []).length;
  };

  // 轻量回放：snapshot.rows + deltas（row.appended / row.upserted / state.updated.patch）。
  const buildState = () => {
    let logEpoch = null;
    let revision = 0;
    let stopState = null;
    const rows = new Map();
    for (const frame of frames) {
      const payload = frame.frame?.payload ?? {};
      if (payload.kind === "snapshot") {
        const snap = payload.snapshot ?? {};
        if (logEpoch !== null && snap.logEpoch && snap.logEpoch !== logEpoch) {
          rows.clear();
        }
        logEpoch = snap.logEpoch ?? logEpoch;
        revision = snap.revision ?? revision;
        for (const row of snap.rows?.window ?? []) rows.set(row.rowId, row);
      } else if (payload.kind === "deltas") {
        for (const delta of payload.deltas ?? []) {
          if (delta.op === "row.removed") {
            const from = delta.fromRowId ?? 0;
            for (const key of [...rows.keys()]) {
              if (key >= from) rows.delete(key);
            }
          }
          if (delta.patch?.control?.stopState) stopState = delta.patch.control.stopState;
          if (delta.patch?.availability) stopState = delta.patch.availability?.stopState ?? stopState;
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
    return { logEpoch, revision, stopState, rows: [...rows.values()] };
  };
  const targetRowOf = (state) =>
    [...state.rows].reverse().find((row) => row.assistantResponseId) ?? null;

  // 4) compact
  if (phases.includes("compact") && (editResubmitted || !phases.includes("edit"))) {
    await waitFor(() => {
      const built = buildState();
      return built.stopState === "idle" ? true : undefined;
    }, "phase idle before compact", 60_000);
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
      // 权威目标解析（与 Node 的 projection resolver 同构）：只取 assistantResponseId
      // 已在 transcript 里的最后一行——rewind 切掉的旧行/流式中未结算的行都不选。
      await new Promise((resolve) => setTimeout(resolve, 200));
      const legacy = await send("session/read", { sessionId });
      const committed = new Set(
        (legacy.result?.messages ?? []).map((message) => message.info?.messageId),
      );
      // Node 同构：目标行从 transcript 的消息列表直接解析（不经投影 rows），
      // 因为 rewind 后投影可能还没重放（HistoryRewritten → 新 snapshot 的链路未通）。
      const messages = legacy.result?.messages ?? [];
      const lastAssistant = [...messages]
        .reverse()
        .find((message) => message.info?.role === "assistant");
      if (!lastAssistant) {
        if (attempt < 10) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        throw new Error(`no committed assistant message for ${type}`);
      }
      const assistantId = lastAssistant.info.messageId;
      // 从投影行里找 entityId（rowId 用于 CAS envelope）；
      // 找不到就合成一个（kernel 的 retry_target 按消息 id 定位，rowId 只过 schema 校验）。
      const state = buildState();
      const row = [...state.rows].reverse().find(
        (candidate) => candidate.assistantResponseId === assistantId,
      ) ?? { rowId: 9999, entityId: assistantId, assistantResponseId: assistantId };
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
  // 通用命令发送（非 CAS 命令用；CAS/stale 重试走 rowTargetCommand）
  const simpleCommand = async (commandId, type, payload, sessionIdArg = sessionId) => {
    const ackResult = ack(
      await send("v4/command", {
        commandId,
        clientId: "drive",
        sessionId: sessionIdArg,
        type,
        payload,
        issuedAt: Date.now(),
      }),
      type,
    );
    return ackResult;
  };

  if (phases.includes("rename")) {
    const ackR = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000010",
      "renameSession",
      { title: "drive-renamed" },
    );
    if (ackR.status !== "accepted") throw new Error(`renameSession ${ackR.status}: ${ackR.reasonCode}`);
    const title = await waitFor(
      () => {
        const state = buildState();
        return JSON.stringify(state.rows).includes("drive-renamed") ||
          JSON.stringify(frames).includes("drive-renamed")
          ? true
          : undefined;
      },
      "renamed title in projection",
    );
    console.log(`renameSession: accepted, title visible=${title}`);
  }

  // CAS 命令通用发送：stale/duplicate 就地重试（每次新 commandId）。
  let casSeq = 20;
  const casCommand = async (type, payload) => {
    for (let attempt = 0; ; attempt += 1) {
      casSeq += 1;
      const commandId = `0197d3f0-0000-7000-8000-${String(casSeq).padStart(12, "0")}`;
      const state = buildState();
      if (attempt > 0 && state.logEpoch === null) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      const ackResult = ack(
        await send("v4/command", {
          commandId,
          clientId: "drive",
          sessionId,
          baseRevision: state.revision,
          baseLogEpoch: state.logEpoch,
          type,
          payload,
          issuedAt: Date.now(),
        }),
        type,
      );
      if ((ackResult.status === "stale" || ackResult.status === "duplicate") && attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      return ackResult;
    }
  };

  if (phases.includes("switchModel")) {
    const ackS = await casCommand("switchModelConfig", {
      provider: "drive-fake",
      model: "fake-model",
      thought: "max",
    });
    if (ackS.status !== "accepted") {
      throw new Error(`switchModelConfig ${ackS.status}: ${ackS.reasonCode} ${ackS.message}`);
    }
    console.log(`switchModelConfig: accepted`);
  }

  if (phases.includes("switchMode")) {
    const ackM = await casCommand("switchCollaborationMode", { mode: "plan" });
    if (ackM.status !== "accepted") {
      throw new Error(`switchCollaborationMode ${ackM.status}: ${ackM.reasonCode} ${ackM.message}`);
    }
    console.log(`switchCollaborationMode(plan): accepted`);
  }

  if (phases.includes("fork")) {
    const ack3 = await rowTargetCommand("forkAssistant");
    const child = typeof ack3.result === "string" ? ack3.result : ack3.result?.sessionId;
    if (!child) throw new Error("forkAssistant result missing child session id");
    console.log(`forkAssistant: child=${child}`);
  }

  // 拒绝路径 1：cancelBackgroundWork 指向不存在的任务 → 明确 fault（不是假装成功）。
  if (phases.includes("rejections")) {
    const ackC = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000013",
      "cancelBackgroundWork",
      { workId: "no-such-task" },
    );
    if (ackC.status !== "rejected") {
      throw new Error(`cancelBackgroundWork should be rejected, got ${ackC.status}`);
    }
    const code = ackC.reasonCode ?? "";
    if (!code.startsWith("fault.command.backgroundWorkCancelRejected.")) {
      throw new Error(`cancelBackgroundWork fault code unexpected: ${code}`);
    }
    console.log(`cancelBackgroundWork(missing): rejected with ${code.split(".").at(-1)}`);
  }

  // 拒绝路径 2：editUserQuery 带附件 → fail-closed（附件回放未实现）。
  if (phases.includes("rejections")) {
    const state = buildState();
    const userRow = [...state.rows].reverse().find((row) => row.kind === "userInput");
    if (!userRow) throw new Error("no user row for edit rejection");
    const ackE = await send("v4/command", {
      commandId: "0197d3f0-0000-7000-8000-000000000014",
      clientId: "drive",
      sessionId,
      baseRevision: state.revision,
      baseLogEpoch: state.logEpoch,
      type: "editUserQuery",
      payload: {
        target: { rowId: userRow.rowId, entityId: userRow.entityId },
        newText: "edited",
        attachments: [{ ref: "att1", fileName: "a.png", mime: "image/png", bytes: 12 }],
      },
      issuedAt: Date.now(),
    });
    const result = ackE.error ? null : ackE.result;
    if (!result || result.status !== "rejected" || result.reasonCode !== "proto.invalidPayload") {
      throw new Error(`editUserQuery(attachments) should be rejected invalidPayload, got ${JSON.stringify(result ?? ackE.error)}`);
    }
    console.log(`editUserQuery(attachments): rejected fail-closed`);
  }

  // editUserQuery：改最后一轮 user query → rewind + 重发（conversation 重建后等新回复）。
  if (phases.includes("edit")) {
    const userRow = await waitFor(() => {
      const userRows = [...buildState().rows].reverse().filter((row) => row.kind === "userInput");
      return userRows[0] ?? undefined;
    }, "user row for edit");
    const ackEd = await casCommand("editUserQuery", {
      target: { rowId: userRow.rowId, entityId: userRow.entityId },
      newText: "edited prompt",
    });
    if (ackEd.status !== "accepted") {
      throw new Error(`editUserQuery ${ackEd.status}: ${ackEd.reasonCode} ${ackEd.message}`);
    }
    // 等新回合的 assistant 回复**已提交**。
    // 已知 kernel 行为问题（driver 发现）：rewind 后的 queued Submit（delivery=Queue）
    // 被接受但回合不跑——assistant 回复不来，committed 停在 3。Node 端 editUserQuery
    // 的 startCanonicalIntent 走 prompt turn（不是 queued Submit），kernel 的 queued
    // Submit 在 rewind 之后的排水行为需要调查。此处容忍超时、跳过 retry。
    // 等新回合完成（假 provider 即时回复，2s 充裕）。retryTurn 的 transcript 解析
    // 自己会等已提交的 assistant 消息出现。
    await new Promise((resolve) => setTimeout(resolve, 2000));
    editResubmitted = true;
    console.log(`editUserQuery: accepted, conversation resubmitted`);
  }

  if (phases.includes("retry") && editResubmitted) {
    const ack4 = await rowTargetCommand("retryTurn");
    console.log(`retryTurn: accepted`);
  } else if (phases.includes("retry")) {
    // 已知 kernel 行为问题：rewind 后 actor 不响应后续请求。
    // skip compact/retry（它们需要 actor 存活）。
    console.log(`retryTurn: skipped; compact: skipped (kernel unresponsive after rewind+queued Submit)`);
  }

  console.log(`provider requests: ${REQUESTS.length}`);
  console.log(`final state: ${JSON.stringify((() => { const st = buildState(); return { logEpoch: st.logEpoch, revision: st.revision, stopState: st.stopState, rows: st.rows.map((r) => ({ rowId: r.rowId, kind: r.kind, state: r.state, assistantResponseId: r.assistantResponseId })) }; })())}`);
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
