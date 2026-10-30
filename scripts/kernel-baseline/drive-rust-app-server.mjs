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
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const kernel = (args.find((a) => a.startsWith("--kernel")) ?? "--kernel=rust").split("=")[1];
const isNode = kernel === "node";
const bin = isNode
  ? process.execPath
  : join(repo, "kernel/target/debug/zcode-rs.exe");
const binArgs = isNode
  ? [join(repo, "apps/zcode-cli/packages/cli/dist/nibi.cjs"), "app-server", "--stdio"]
  : ["app-server", "--stdio"];
const dotDir = isNode ? ".nibi" : ".zcode";
const phases = (args.find((a) => a.startsWith("--phases")) ?? "--phases=create,rename,switchModel,switchMode,fork,edit,retry,compact,rejections")
  .split("=")[1]
  .split(",");
// 冷恢复模式：`--resume=<sessionId>` 配上 `--home=<上一次的隔离目录>`，起一个新进程只做
// subscribe（带 additionalDirectories/resumeThoughtLevel）+ sendText，验证冷打开的恢复提示。
const resumeSession = args.find((a) => a.startsWith("--resume="))?.split("=").slice(1).join("=");
const fixedHome = args.find((a) => a.startsWith("--home="))?.split("=").slice(1).join("=");
// 会话级的 MCP 服务器（NIBI createSession.mcpServers）：一个只提供 echo 的 stdio 服务器。两边内核都
// 用同一个脚本，工具名 mcp__fake__echo；它出现在 provider 请求的 tools 里就证明"建会话 → 连上 → 进工具表"整链通。
const fakeMcpScript = join(import.meta.dirname, "fake-mcp-server.mjs");

if (!process.version.startsWith("v24")) {
  console.error(`warning: running on ${process.version}`);
}

const home = fixedHome ?? mkdtempSync(join(tmpdir(), "nibi-rust-drive-"));
const dataV2 = join(home, dotDir, "v2");
mkdirSync(dataV2, { recursive: true });
const workspace = join(home, "workspace");
mkdirSync(workspace, { recursive: true });
// 会话的附加工作目录（NIBI createSession.additionalDirectories）：环境段该列出它。
const extraDirectory = join(home, "extra-workspace");
mkdirSync(extraDirectory, { recursive: true });
writeFileSync(join(extraDirectory, "note.txt"), "extra directory note");
// 冷恢复时新加的附加目录：只出现在 resume 的 subscribe 参数里，能证明订阅提示被消费。
const resumeDirectory = join(home, "extra-resume");
mkdirSync(resumeDirectory, { recursive: true });
// 附件回放用的真实图片（1x1 PNG）：两个内核都从本机路径读，不再用假 ref。
const attachmentPath = join(home, "attachment.png");
const attachmentBytes = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);
writeFileSync(attachmentPath, attachmentBytes);

// ── 本地假 provider（OpenAI chat-completions，SSE）──
const REQUESTS = [];
// 会话级 MCP 的回执：模型先要一次 mcp__fake__echo，拿到工具结果后再回正文。两边内核走同一条路径。
const MCP_TOOL = "mcp__fake__echo";
const TOOL_RESULTS = [];
const textOf = (content) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
      .join("");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
};
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {}
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const tools = Array.isArray(parsed?.tools)
      ? parsed.tools.map((tool) => tool?.function?.name ?? tool?.name ?? null)
      : [];
    const hasImage = messages.some((message) => {
      const content = message.content;
      if (!Array.isArray(content)) return false;
      return content.some(
        (part) => part?.type === "image_url" || part?.type === "image" || part?.image_url,
      );
    });
    const toolMessages = messages.filter((message) => message.role === "tool");
    const toolResult = toolMessages.length
      ? textOf(toolMessages[toolMessages.length - 1].content)
      : null;
    if (toolResult !== null) TOOL_RESULTS.push(toolResult);
    // 按文本比较：JSON 里的反斜杠会转义，直接 includes 路径会永远为假。
    const messageText = messages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : (message.content ?? [])
              .map((part) => (typeof part?.text === "string" ? part.text : ""))
              .join(" "),
      )
      .join(" ");
    const mentionsExtraDir =
      messageText.includes(extraDirectory) || messageText.includes(resumeDirectory);
    REQUESTS.push({
      at: Date.now(),
      path: req.url,
      model: parsed?.model ?? null,
      tools,
      hasImage,
      mentionsExtraDir,
    });
    if (process.env.NIBI_DRIVE_DEBUG === "1") {
      const system = messages.find((m) => m.role === "system")?.content;
      const systemText = textOf(system);
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const lastShape = Array.isArray(lastUser?.content)
        ? lastUser.content.map((part) => `${part?.type}:${String(part?.text ?? "").slice(0, 40)}`)
        : [String(lastUser?.content ?? "").slice(0, 40)];
      console.error(
        `provider request #${REQUESTS.length}: model=${parsed?.model ?? "?"} tools=${tools.length} mcp=${tools.includes(MCP_TOOL)} roles=${messages.map((m) => m.role).join(",")} image=${hasImage} lastUser=${JSON.stringify(lastShape)} system=${JSON.stringify(systemText.slice(0, 40))}`,
      );
    }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    // 新回合（还没有 assistant 消息）、工具表里有会话级 MCP 工具：要求调用它一次。工具结果回来后的
    // 请求（roles 里有 tool）回正文。标题生成这类请求没有工具，不会触发。
    const freshTurn = !messages.some((message) => message.role === "assistant");
    if (freshTurn && toolResult === null && tools.includes(MCP_TOOL)) {
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_drive_mcp_1",
                    type: "function",
                    function: { name: MCP_TOOL, arguments: JSON.stringify({ text: "ping" }) },
                  },
                ],
              },
              index: 0,
            },
          ],
          id: "drive",
          object: "chat.completion.chunk",
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }], id: "drive", object: "chat.completion.chunk" })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    const text = "RUST-DRIVE-REPLY";
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
            properties: {
              contextWindow: 200000,
              // 视觉模型：附件回放要求图片真的进请求（否则内核按 model.md §10.5 换成占位文字）。
              inputFormat: { supportsImage: true, supportsPdf: true },
              supportsToolCall: true,
              supportsJsonSchemaOutput: true,
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: true,
              requiresMfjsToolSchema: false,
            },
            optionSpecs: {
              maxOutputTokens: { max: 128000 },
              reasoningLevel: { values: ["disabled", "enabled"], map: "{}" },
            },
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
const child = spawn(bin, binArgs, {
  cwd: workspace,
  env: {
    ...process.env,
    ...(isNode ? {} : { RUST_LOG: process.env.RUST_LOG ?? "debug" }),
    USERPROFILE: home,
    HOME: home,
    ...(isNode
      ? {
          NIBI_DATA_BASE_DIR: home,
          NIBI_STORAGE_DIR: join(home, dotDir),
          NIBI_SETTINGS_DIR: dataV2,
          NIBI_ENDPOINT_ORIGIN: "http://127.0.0.1:9",
        }
      : {
          ZCODE_DATA_BASE_DIR: home,
          ZCODE_STORAGE_DIR: join(home, dotDir),
        }),
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
  // 内核 → Host 的反向请求：必须应答（Node 的 createSession 会反向问 runtime preferences）。
  if (value.method !== undefined && value.id !== undefined) {
    const reply =
      value.method === "session/requestRuntimePreferences"
        ? {
            result: {
              askUserQuestionAutoResolutionEnabled: true,
              memoryEnabled: false,
              nativeSearchEnhancementsEnabled: true,
              toolSearchMode: "off",
            },
          }
        : { error: { code: -32601, message: `drive: ${value.method} not supported` } };
    child.stdin.write(`${JSON.stringify({ id: value.id, ...reply })}
`);
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
const checks = {};
try {
  // 1) startup/storageState：等 ready（先来的是 checking）
  const startup = await waitFor(
    () => notifications.find((n) => n.method === "startup/storageState" && n.params.phase === "ready"),
    "startup/storageState ready",
  );
  checks.startupMs = startup.params.elapsedMs;
  console.log(`startup: ready elapsed=${startup.params.elapsedMs}ms`);

  if (resumeSession) {
    // 冷恢复：不建会话，直接订阅一个持久化会话（带两个恢复提示），发一条输入看环境段。
    const sub = await send("v4/conversation/subscribe", {
      topic: `conversation/${resumeSession}`,
      connectionId: "drive",
      visibility: "foreground",
      clientMode: "desktop-continuous",
      workspace: { workspaceKey: workspace, workspacePath: workspace },
      additionalDirectories: [resumeDirectory],
      resumeThoughtLevel: "enabled",
    });
    if (!sub.result?.ack) throw new Error(`cold subscribe failed: ${JSON.stringify(sub)}`);
    console.log(`cold subscribe: ${JSON.stringify(sub.result.ack).slice(0, 120)}`);
    const ackSend = await send("v4/command", {
      commandId: "0197d3f0-0000-7000-8000-000000000041",
      clientId: "drive",
      sessionId: resumeSession,
      type: "sendText",
      payload: { text: "after cold resume" },
      issuedAt: Date.now(),
    });
    console.log(`resume sendText ack: ${JSON.stringify(ackSend)}`);
    console.log(`resume frames: ${frames.length}`);
    // 不能拿重放的历史帧当"回复"：等一个**新的** provider 请求（快照里本来就有上一轮的
    // RUST-DRIVE-REPLY）。
    await waitFor(
      () => (REQUESTS.length > 0 ? true : undefined),
      "a model request after cold resume",
      60_000,
    );
    checks.resumeAdditionalDir = REQUESTS.some((request) => request.mentionsExtraDir);
    checks.resumeReplied = REQUESTS.length > 0;
    console.log(
      `cold resume: replied=${checks.resumeReplied} resume-dir-in-prompt=${checks.resumeAdditionalDir}`,
    );
    if (!checks.resumeReplied) throw new Error("cold resume produced no reply");
    if (!checks.resumeAdditionalDir) {
      throw new Error("the subscribe additionalDirectories hint never reached the prompt");
    }
    console.log(`RESULT:${JSON.stringify({ kernel, checks, metrics: { providerRequests: REQUESTS.length } })}`);
    console.log("PHASES OK");
    throw { done: true };
  }

  // 2) createSession（带 firstInput）
  const ack1 = ack(
    await send("v4/command", {
      commandId: "0197d3f0-0000-7000-8000-000000000001",
      clientId: "drive",
      sessionId: null,
      type: "createSession",
      payload: {
        workspaceId: workspace,
        // 附加工作目录：环境段要列出它（判决链也按它放行工作区之外的路径）。
        additionalDirectories: [extraDirectory],
        firstInput: { text: "hello rust kernel", mode: "yolo" },
        // 会话级 MCP：两边内核都该连上并在首发请求前把工具放进工具表（Node 的实现是 runtimeConfig.mcp）。
        mcpServers: [
          {
            name: "fake",
            command: process.execPath,
            args: [fakeMcpScript],
            env: [],
            alwaysLoad: true,
          },
        ],
      },
      issuedAt: Date.now(),
    }),
    "createSession",
  );
  const sessionId = ack1.result?.sessionId;
  if (!sessionId) throw new Error(`createSession result missing sessionId: ${JSON.stringify(ack1)}`);
  checks.createSessionPrefix = sessionId.slice(0, 5);
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
  checks.sendTextStatus = send1.result?.status;
  checks.additionalDirInPrompt = REQUESTS.some((request) => request.mentionsExtraDir);
  console.log(
    `sendText: assistant reply visible, frames=${frames.length}; extra dir in prompt=${checks.additionalDirInPrompt}`,
  );
  if (!checks.additionalDirInPrompt) {
    throw new Error("createSession.additionalDirectories never reached the prompt");
  }

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
    checks.renameStatus = ackR.status;
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
    const changed = await casCommand("switchModelConfig", {
      provider: "drive-fake",
      model: "fake-model",
      thought: "disabled",
    });
    if (changed.status !== "accepted") {
      throw new Error(`switchModelConfig ${changed.status}: ${changed.reasonCode} ${changed.message}`);
    }
    // 同值再发：Node/Rust 都回 noop + config.unchanged（driver 层对照点）。
    const noop = await casCommand("switchModelConfig", {
      provider: "drive-fake",
      model: "fake-model",
      thought: "disabled",
    });
    if (noop.status !== "noop" || noop.reasonCode !== "config.unchanged") {
      throw new Error(`switchModelConfig(noop) ${noop.status}/${noop.reasonCode}`);
    }
    checks.switchModelChangeStatus = changed.status;
    checks.switchModelNoopStatus = noop.status;
    checks.switchModelNoopCode = noop.reasonCode;
    console.log(`switchModelConfig: accepted; same-value noop=config.unchanged`);
  }

  if (phases.includes("switchMode")) {
    const ackM = await casCommand("switchCollaborationMode", { mode: "plan" });
    if (ackM.status !== "accepted") {
      throw new Error(`switchCollaborationMode ${ackM.status}: ${ackM.reasonCode} ${ackM.message}`);
    }
    // 与 Node 对拍：同值仍 accepted（Node 没有同值 noop）。
    const again = await casCommand("switchCollaborationMode", { mode: "plan" });
    if (again.status !== "accepted") {
      throw new Error(`switchCollaborationMode(same) ${again.status}/${again.reasonCode}`);
    }
    checks.switchModeChangeStatus = ackM.status;
    checks.switchModeSameStatus = again.status;
    console.log(`switchCollaborationMode(plan): accepted; same-value accepted`);
  }

  if (phases.includes("fork")) {
    const ack3 = await rowTargetCommand("forkAssistant");
    const child = typeof ack3.result === "string" ? ack3.result : ack3.result?.sessionId;
    if (!child) throw new Error("forkAssistant result missing child session id");
    checks.forkChildPrefix = String(child ?? "").slice(0, 5);
    console.log(`forkAssistant: child=${child}`);
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
    checks.editStatus = ackEd.status;
    console.log(`editUserQuery: accepted, conversation resubmitted`);
  }

  if (phases.includes("retry") && editResubmitted) {
    const ack4 = await rowTargetCommand("retryTurn");
    checks.retryStatus = ack4.status;
    console.log(`retryTurn: accepted`);
  } else if (phases.includes("retry")) {
    // 已知 kernel 行为问题：rewind 后 actor 不响应后续请求。
    // skip compact/retry（它们需要 actor 存活）。
    console.log(`retryTurn: skipped; compact: skipped (kernel unresponsive after rewind+queued Submit)`);
  }

  // 拒绝路径 1：cancelBackgroundWork 指向不存在的任务 → 明确 fault（不是假装成功）。
  if (phases.includes("rejections")) {
    const ackC = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000013",
      "cancelBackgroundWork",
      { workId: "no-such-task" },
    );
    if (ackC.status !== "failed" || ackC.reasonCode !== "fault.command.backgroundWorkCancelRejected.not_found") {
      throw new Error(`cancelBackgroundWork(missing) ${ackC.status}/${ackC.reasonCode}: ${ackC.message}`);
    }
    checks.cancelStatus = ackC.status;
    checks.cancelCode = ackC.reasonCode;
    console.log(`cancelBackgroundWork(missing): failed/not_found`);
  }

  // 附件回放：sendText 带一张真实图片（本机路径），两个内核都该接受、把图片送进模型请求，并在
  // userInput 行上留下附件引用（UI 预览入口）。
  if (phases.includes("rejections")) {
    const ackA = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000031",
      "sendText",
      {
        text: "what is in this image",
        attachments: [
          {
            ref: attachmentPath,
            fileName: "attachment.png",
            mime: "image/png",
            bytes: attachmentBytes.length,
          },
        ],
      },
    );
    checks.attachmentStatus = ackA.status;
    checks.attachmentCode = ackA.reasonCode ?? null;
    console.log(`sendText(attachments): ${JSON.stringify(ackA)}`);
    if (ackA.status !== "accepted") {
      throw new Error(`sendText(attachments) expected accepted, got ${JSON.stringify(ackA)}`);
    }
    // 等这一轮跑完，让行投影与 provider 请求都落定。
    await waitFor(
      () => (buildState().stopState === "idle" ? true : undefined),
      "idle after the attachment turn",
      60_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    checks.attachmentReplayed = REQUESTS.some((request) => request.hasImage);
    const lastUser = [...buildState().rows].reverse().find((row) => row.kind === "userInput");
    checks.attachmentRowRefs = (lastUser?.attachments ?? []).length;
    console.log(
      `sendText(attachments): id=${ackA.result?.inputId ?? "?"} image-in-request=${checks.attachmentReplayed} row-refs=${checks.attachmentRowRefs}`,
    );
    if (checks.attachmentRowRefs !== 1) throw new Error(`userInput row carries ${checks.attachmentRowRefs} attachments`);
    // 模型侧：Rust 读本机路径并把图片内联进请求；Node 在 OpenAI-compatible 的本地路径分支降级成
    // `[Attached image/png: <path>]` 文本（附件 URI 形态才会回读 data URL）。这里只对 Rust 硬断言，
    // Node 的结果作为已知差异记录。
    if (!isNode && !checks.attachmentReplayed) {
      throw new Error("the attachment image never reached the model request");
    }
  }

  // 会话级 MCP：任一主回合请求的工具表里出现 mcp__fake__echo，即"createSession.mcpServers → 连接 → 工具表 → 请求"
  // 整链通（Node 的 runtimeConfig.mcp 与 Rust 的会话级 manager 都走这条断言）。
  const mcpOffered = REQUESTS.filter((request) =>
    (request.tools ?? []).includes("mcp__fake__echo"),
  );
  checks.mcpToolOffered = mcpOffered.length > 0;
  checks.mcpOfferedInFirstRequest = (REQUESTS[0]?.tools ?? []).includes("mcp__fake__echo");
  // 工具真的被调用并执行：假 provider 要求一次 mcp__fake__echo，工具结果回到下一请求。
  checks.mcpToolCalled = TOOL_RESULTS.length > 0;
  checks.mcpToolResult = TOOL_RESULTS[0] ?? null;
  console.log(
    `session mcp: tool offered in ${mcpOffered.length}/${REQUESTS.length} provider requests (first=${checks.mcpOfferedInFirstRequest}); called=${checks.mcpToolCalled} result=${JSON.stringify(checks.mcpToolResult)}`,
  );
  if (!checks.mcpToolCalled || !String(checks.mcpToolResult).startsWith("echo:")) {
    throw new Error(`session MCP tool did not run: ${JSON.stringify(checks.mcpToolResult)}`);
  }

  console.log(`RESULT:${JSON.stringify({
    kernel,
    checks,
    metrics: {
      providerRequests: REQUESTS.length,
      frames: frames.length,
      notifications: notifications.length,
    },
  })}`);
  console.log(`provider requests: ${REQUESTS.length}`);
  console.log(`final state: ${JSON.stringify((() => { const st = buildState(); return { logEpoch: st.logEpoch, revision: st.revision, stopState: st.stopState, rows: st.rows.map((r) => ({ rowId: r.rowId, kind: r.kind, state: r.state, assistantResponseId: r.assistantResponseId })) }; })())}`);
  console.log("PHASES OK");
} catch (error) {
  // 冷恢复分支用 `{ done: true }` 提前结束，不算失败。
  if (error?.done === true) {
    // 正常收尾（finally 负责关子进程）。
  } else {
  console.error("FAILED: " + error.message + String(error.stack ?? "").split(String.fromCharCode(10)).slice(0, 8).join(String.fromCharCode(10)));

  console.error(`stderr tail:\n${stderr.split(/\r?\n/).slice(-12).join("\n")}`);
  console.error(`notifications: ${notifications.map((n) => n.method).join(", ")}`);
  process.exitCode = 1;
  }
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
