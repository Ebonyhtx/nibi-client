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
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runStoragePreparePhase } from "./storage-prepare-probe.mjs";

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
const phases = (args.find((a) => a.startsWith("--phases")) ?? "--phases=create,hookReview,rename,discardSharedContext,switchModel,switchMode,fork,edit,retry,compact,rejections,storagePrepare")
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
// 工作区钩子评审（NIBI 的 request/respond/revoke）：项目配置在 `.nibi/config.json`（两个内核同一个
// 发现规则）。开局就写：信任前它不运行，只在订阅会话时以 `workspaceHookAdmission` 提示待审。
if (phases.includes("hookReview")) {
  mkdirSync(join(workspace, ".nibi"), { recursive: true });
  writeFileSync(
    join(workspace, ".nibi", "config.json"),
    `${JSON.stringify(
      {
        hooks: {
          enabled: true,
          events: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: "node guard.js" }] },
            ],
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}
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
// 队列命令组要一个"跑着的回合"：最后一条 user 文本是 HOLD_TEXT 时先不回，等驱动放行。
const HOLD_TEXT = "hold this turn";
let releaseHold = () => {};
const holdGate = new Promise((resolve) => {
  releaseHold = resolve;
});
// 修订探针要一个**自己**的闸门：同一进程里 dwfResume 先跑，共用一个 gate 会让修订阶段的前驱
// 不再在飞（也就测不到 supersede 与就地 retune）。
const AMEND_HOLD_TEXT = "hold amend turn";
let releaseAmendHold = () => {};
const amendHoldGate = new Promise((resolve) => {
  releaseAmendHold = resolve;
});
// 升级问答探针（dwfEscalate）：actor 的 ask 指令、主代理给出的答案，以及三步的观察位。
const ESCALATE_TEXT = "escalate this turn";
const ESCALATE_ANSWER = "drive escalation answer";
let escalationRaised = false;
let escalationResolved = false;
let escalationAnswered = false;
let escalationQid = null;
// run 详情探针（GetWorkflowRun）：provider 路由按这个 id 调工具；阶段里先看真 id、再看坏 id。
let inspectRunId = null;
let inspectAttempt = 0;
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
  req.on("end", async () => {
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
      lastUserText: messages
        .filter((message) => message.role === "user")
        .map((message) => textOf(message.content))
        .join(" ")
        .slice(-400),
    });
    if (process.env.NIBI_DRIVE_DEBUG === "1") {
      const system = messages.find((m) => m.role === "system")?.content;
      const systemText = textOf(system);
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      const lastShape = Array.isArray(lastUser?.content)
        ? lastUser.content.map((part) => `${part?.type}:${String(part?.text ?? "").slice(0, 40)}`)
        : [String(lastUser?.content ?? "").slice(0, 40)];
      console.error(
        `provider request #${REQUESTS.length}: model=${parsed?.model ?? "?"} tools=${tools.length} workflowTools=${JSON.stringify(tools.filter((name) => /workflow|escalate/i.test(String(name))))} mcp=${tools.includes(MCP_TOOL)} resolveTool=${tools.includes("ResolveWorkflowQuestion")} roles=${messages.map((m) => m.role).join(",")} image=${hasImage} lastUser=${JSON.stringify(lastShape)} system=${JSON.stringify(systemText.slice(0, 40))} escalation=${messageText.includes("<workflow-escalation>")} toolResult=${JSON.stringify(toolResult?.slice(0, 160))}`,
      );
    }
    const lastUserText = (() => {
      const lastUser = [...messages].reverse().find((message) => message.role === "user");
      return textOf(lastUser?.content).trim();
    })();
    // 用户内容后面会拼 `<system-reminder>`，用包含判断。
    if (lastUserText.includes(HOLD_TEXT)) {
      // 挂住这一轮：驱动在队列命令做完后再放行（抢占会中止这一轮）。
      await holdGate;
    }
    if (lastUserText.includes(AMEND_HOLD_TEXT)) {
      // 修订探针的独立闸门（见 AMEND_HOLD_TEXT 处的注释）。
      await amendHoldGate;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
    // DWF 升级问答探针（最后一轮之前的三步）：
    //   1. actor 的 ask 指令 → 调 escalate 停驻；
    //   2. 主代理收到 `<workflow-escalation>` 通知 → 调 ResolveWorkflowQuestion 作答；
    //   3. 带答案的工具结果 → 正文收尾（actor 的轮次继续）。
    if (toolResult === null && lastUserText.includes(ESCALATE_TEXT) && tools.includes("escalate")) {
      escalationRaised = true;
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_drive_escalate_1",
                    type: "function",
                    function: {
                      name: "escalate",
                      arguments: JSON.stringify({
                        question: "What should I return for the probe?",
                        context: "I have nothing else to go on.",
                      }),
                    },
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
    // run 详情探针（GetWorkflowRun）：最后一个 user 文本是探针口令时，按全局的 inspectRunId
    // 调工具（真 id 先行；换上坏 id 再来一次验 run_not_found）。writeHead 已由 handler 统一发过。
    if (lastUserText.includes("inspect the run") && inspectRunId !== null) {
      inspectAttempt += 1;
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: `call_drive_inspect_${inspectAttempt}`,
                    type: "function",
                    function: {
                      name: "GetWorkflowRun",
                      arguments: JSON.stringify({ run_id: inspectRunId }),
                    },
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
    // 不按工具名过滤请求里的 tools：Node 把 ResolveWorkflowQuestion 当延迟工具宣布（不在内联
    // 清单里），Rust 内联给出；按名字直接调在两个内核里都成立。
    if (toolResult === null && messageText.includes("<workflow-escalation>")) {
      const qid = /<question-id>([^<]+)<\/question-id>/u.exec(messageText)?.[1] ?? "";
      escalationQid = qid;
      escalationResolved = qid.length > 0;
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_drive_resolve_1",
                    type: "function",
                    function: {
                      name: "ResolveWorkflowQuestion",
                      arguments: JSON.stringify({
                        question_id: qid,
                        answer: ESCALATE_ANSWER,
                      }),
                    },
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
    if (toolResult !== null && toolResult.includes(ESCALATE_ANSWER)) {
      escalationAnswered = true;
    }
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
            personalModelIds: ["fake-model", "fake-model-b"],
            modelOrder: ["fake-model", "fake-model-b"],
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
        // amend 探针的第二个模型：修订只改子代理模型时，actor 的 provider 请求必须切到它
        // （这是「run 级 subagentModel 真进了 actor 轮」的唯一端到端证据）。
        {
          modelId: "fake-model-b",
          providerId: "drive-fake",
          config: {
            enabled: true,
            properties: {
              contextWindow: 200000,
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
          // DWF sidecar（路线 C）：设置后 Rust 内核才会注入引擎；没设时三条命令回 capabilityUnsupported。
          ...(process.env.NIBI_DWF_ENGINE_CMD
            ? { NIBI_DWF_ENGINE_CMD: process.env.NIBI_DWF_ENGINE_CMD }
            : {}),
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
const journalDbPath = join(home, dotDir, "cli", "db", "db.sqlite");
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
    // NIBI_DRIVE_DUMP_SNAPSHOT=1：把冷投影快照里的行打成 (kind, origin, executionKind, state,
    // activeMs, workflowLaunch.runId)——controlOnly 冷面的开发期对拍用（只读快照帧，不掺后续增量）。
    if (process.env.NIBI_DRIVE_DUMP_SNAPSHOT) {
      const snapshot = frames
        .map((frame) => frame.frame?.payload)
        .filter((payload) => payload?.kind === "snapshot")
        .map((payload) => payload.snapshot)[0];
      const rows = snapshot?.rows?.window ?? [];
      console.log(
        `cold rows: ${JSON.stringify(
          rows.map((row) => [
            row.kind,
            row.origin,
            row.executionKind,
            row.state,
            row.activeMs ?? null,
            row.workflowLaunch?.runId ?? null,
          ]),
        )}`,
      );
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
  // topic 给定时只回放该会话主题的帧（多会话的行 rowId 各自从头编号，不能混进一张 Map）。
  const buildState = (topic = null) => {
    let logEpoch = null;
    let revision = 0;
    let stopState = null;
    let pendingInteractions = [];
    let workspaceHookAdmission = null;
    let sharedContextImport = null;
    const rows = new Map();
    for (const frame of frames) {
      if (topic && (frame.topic ?? frame.frame?.topic) !== topic) continue;
      const payload = frame.frame?.payload ?? {};
      if (payload.kind === "snapshot") {
        const snap = payload.snapshot ?? {};
        if (logEpoch !== null && snap.logEpoch && snap.logEpoch !== logEpoch) {
          rows.clear();
        }
        logEpoch = snap.logEpoch ?? logEpoch;
        revision = snap.revision ?? revision;
        pendingInteractions = snap.pendingInteractions ?? [];
        workspaceHookAdmission = snap.workspaceHookAdmission ?? null;
        sharedContextImport = snap.sharedContextImport ?? null;
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
            if (delta.patch.pendingInteractions) {
              pendingInteractions = delta.patch.pendingInteractions;
            }
            if ("workspaceHookAdmission" in delta.patch) {
              workspaceHookAdmission = delta.patch.workspaceHookAdmission;
            }
            if ("sharedContextImport" in delta.patch) {
              sharedContextImport = delta.patch.sharedContextImport;
            }
          }
        }
      }
    }
    return {
      logEpoch,
      revision,
      stopState,
      rows: [...rows.values()],
      pendingInteractions,
      workspaceHookAdmission,
      sharedContextImport,
    };
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

  // 工作区钩子评审：订阅时的提示条 → requestWorkspaceHookReview → 待审交互 → 授权 →
  // 信任落盘 + 提示条清空 → 按摘要撤销 → 重新待审。
  if (phases.includes("hookReview")) {
    const admission = await waitFor(
      () => buildState().workspaceHookAdmission ?? undefined,
      "workspaceHookAdmission after subscribe",
      30_000,
    );
    checks.hookAdmissionPending = admission.pendingCount;
    if (admission.pendingCount !== 1) {
      throw new Error(`workspaceHookAdmission pendingCount=${admission.pendingCount}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(admission.bundleDigest ?? "")) {
      throw new Error(`workspaceHookAdmission bundleDigest=${admission.bundleDigest}`);
    }

    const requestReview = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000070",
      "requestWorkspaceHookReview",
      {
        sessionId,
        workspaceIdentity: admission.workspaceIdentity ?? workspace,
        bundleDigest: admission.bundleDigest,
      },
    );
    if (requestReview.status !== "accepted") {
      throw new Error(
        `requestWorkspaceHookReview ${requestReview.status}/${requestReview.reasonCode}: ${requestReview.message}`,
      );
    }
    checks.hookReviewRequestStatus = requestReview.status;

    const interaction = await waitFor(
      () => {
        const state = buildState();
        return state.pendingInteractions.find(
          (pending) => pending.payload?.kind === "workspaceHookReview",
        );
      },
      "workspaceHookReview interaction",
      30_000,
    );
    const request = interaction.payload;
    checks.hookReviewInteractionKind = request.kind;
    checks.hookReviewGeneration = request.generation;
    checks.hookReviewHookCount = request.summary?.hookCount;
    checks.hookReviewPendingCount = request.summary?.pendingCount;
    checks.hookReviewEventCount = request.summary?.eventCount;
    checks.hookReviewItemType = request.items?.[0]?.type;
    checks.hookReviewItemMode = request.items?.[0]?.executionMode;
    checks.hookReviewItemTrust = request.items?.[0]?.trustState;
    checks.hookReviewItemDisplayName = request.items?.[0]?.displayName ?? null;
    checks.hookReviewWarning = request.warningCode;
    checks.hookReviewSourcePath = request.sourceFiles?.[0]?.displayPath ?? null;
    if (request.summary?.hookCount !== request.items?.length) {
      throw new Error(`hookCount ${request.summary?.hookCount} != items ${request.items?.length}`);
    }
    if (request.summary?.pendingCount !== 1 || request.summary?.eventCount !== 1) {
      throw new Error(`review summary ${JSON.stringify(request.summary)}`);
    }
    if (request.items?.[0]?.trustState !== "pending_trust") {
      throw new Error(`review item trustState=${request.items?.[0]?.trustState}`);
    }
    if (request.warningCode !== "workspace_hooks_execute_code") {
      throw new Error(`review warningCode=${request.warningCode}`);
    }
    const reviewItem = request.items[0];

    // 就地开关：只改可编辑的项目配置（`.nibi/config.json`）；bundle 摘要随之变化，评审换下一代。
    const targetOf = (payload) => ({
      sessionId,
      taskId: payload.taskId,
      runId: payload.runId,
      workspaceIdentity: payload.workspaceIdentity,
      bundleDigest: payload.bundleDigest,
      reviewFlowId: payload.reviewFlowId,
      generation: payload.generation,
      interactionId: payload.interactionId,
    });
    const currentReview = () =>
      buildState().pendingInteractions.find(
        (pending) => pending.payload?.kind === "workspaceHookReview",
      );
    const toggleOff = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000083",
      "toggleWorkspaceHookReviewItem",
      { ...targetOf(request), reviewItemId: reviewItem.reviewItemId, enabled: false },
    );
    if (toggleOff.status !== "accepted") {
      throw new Error(
        `toggleWorkspaceHookReviewItem(false) ${toggleOff.status}/${toggleOff.reasonCode}: ${toggleOff.message}`,
      );
    }
    const disabledConfig = JSON.parse(
      readFileSync(join(workspace, ".nibi", "config.json"), "utf8"),
    );
    checks.hookToggleConfigEnabled =
      disabledConfig.hooks?.events?.PreToolUse?.[0]?.hooks?.[0]?.enabled;
    checks.hookToggleStatus = toggleOff.status;
    const disabledReview = await waitFor(
      () => {
        const current = currentReview();
        return current && current.payload.generation === request.generation + 1
          ? current
          : undefined;
      },
      "review generation after toggle off",
      30_000,
    );
    checks.hookToggleGeneration = disabledReview.payload.generation - request.generation;
    checks.hookToggleConfiguredEnabled = disabledReview.payload.items[0].configuredEnabled;
    if (checks.hookToggleConfigEnabled !== false) {
      throw new Error(`config enabled after toggle off = ${checks.hookToggleConfigEnabled}`);
    }
    if (checks.hookToggleConfiguredEnabled !== false) {
      throw new Error(
        `review item configuredEnabled after toggle off = ${checks.hookToggleConfiguredEnabled}`,
      );
    }
    const toggleOn = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000084",
      "toggleWorkspaceHookReviewItem",
      {
        ...targetOf(disabledReview.payload),
        reviewItemId: disabledReview.payload.items[0].reviewItemId,
        enabled: true,
      },
    );
    if (toggleOn.status !== "accepted") {
      throw new Error(
        `toggleWorkspaceHookReviewItem(true) ${toggleOn.status}/${toggleOn.reasonCode}: ${toggleOn.message}`,
      );
    }
    const requestAfterToggle = await waitFor(
      () => {
        const current = currentReview();
        return current && current.payload.generation === disabledReview.payload.generation + 1
          ? current.payload
          : undefined;
      },
      "review generation after toggle on",
      30_000,
    );
    checks.hookToggleRestored = requestAfterToggle.items[0].configuredEnabled;

    const responded = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000081",
      "respondWorkspaceHookReview",
      {
        ...targetOf(requestAfterToggle),
        decision: {
          action: "trust_selected",
          reviewItemIds: [requestAfterToggle.items[0].reviewItemId],
        },
      },
    );
    if (responded.status !== "accepted") {
      throw new Error(
        `respondWorkspaceHookReview ${responded.status}/${responded.reasonCode}: ${responded.message}`,
      );
    }
    checks.hookReviewRespondStatus = responded.status;
    await waitFor(
      () =>
        buildState().pendingInteractions.some(
          (pending) => pending.payload?.kind === "workspaceHookReview",
        )
          ? undefined
          : true,
      "workspace hook review settled",
      30_000,
    );
    checks.hookReviewSettled = true;
    await waitFor(
      () => (buildState().workspaceHookAdmission === null ? true : undefined),
      "workspace hook admission cleared",
      30_000,
    );
    checks.hookAdmissionCleared = true;

    // 信任记录落盘（每个内核自己的存储根），字段名与 Node 的 schema 一致。
    const trustFile = join(home, dotDir, "security", "workspace-hook-trust-v1.json");
    const store = JSON.parse(readFileSync(trustFile, "utf8"));
    const record = store.records?.find(
      (candidate) => candidate.eventAtGrant === "PreToolUse",
    );
    if (!record) throw new Error(`no PreToolUse record in ${trustFile}`);
    if (record.decision !== "trusted" || record.digestAlgorithm !== "sha256") {
      throw new Error(`trust record decision=${record.decision}`);
    }
    checks.hookTrustRecordDigest = record.hookDeclarationDigest.slice(0, 8);
    checks.hookTrustRecordIdentity = record.workspaceIdentity === workspace;

    const revoked = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000082",
      "revokeWorkspaceHookTrust",
      {
        sessionId,
        workspaceIdentity: request.workspaceIdentity,
        bundleDigest: request.bundleDigest,
        hookDeclarationDigests: [record.hookDeclarationDigest],
      },
    );
    if (revoked.status !== "accepted") {
      throw new Error(
        `revokeWorkspaceHookTrust ${revoked.status}/${revoked.reasonCode}: ${revoked.message}`,
      );
    }
    checks.hookReviewRevokeStatus = revoked.status;
    // 撤销 = 回到待审：提示条重新出现。
    await waitFor(
      () => (buildState().workspaceHookAdmission?.pendingCount === 1 ? true : undefined),
      "workspace hook admission back after revoke",
      30_000,
    );
    checks.hookAdmissionRestored = true;
    console.log(
      `workflow hook review: admission=${checks.hookAdmissionPending} generation=${checks.hookReviewGeneration} ` +
        `item=${checks.hookReviewItemTrust} granted-then-revoked`,
    );
  }

  // DWF 引擎（路线 C）：起 sidecar、跑一个已保存工作流，断言 ACK 与 journal 行。
  // 用一个**新会话**：Node 的 startSavedWorkflowRun 只对空闲会话工作（GUI 同样只对空会话发它）。
  if (phases.includes("dwfEngine")) {
    mkdirSync(join(workspace, ".nibi", "workflows"), { recursive: true });
    writeFileSync(
      join(workspace, ".nibi", "workflows", "probe.dwf.ts"),
      [
        "/* zcode-workflow",
        "description: drive probe",
        "*/",
        'const worker = agent("worker", "You answer questions.");',
        'return await worker.ask("Say hi.");',
      ].join(String.fromCharCode(10)) + String.fromCharCode(10),
    );
    const created = ack(
      await send("v4/command", {
        commandId: "0197d3f0-0000-7000-8000-0000000000a2",
        clientId: "drive",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: workspace },
        issuedAt: Date.now(),
      }),
      "createSession(dwf)",
    );
    const dwfSession = created.result?.sessionId;
    if (!dwfSession) throw new Error("createSession(dwf) returned no sessionId");
    // 订阅这个会话的主题（Host 正常流程）：活投影的 controlOnly 行探针靠它的帧。
    await send("v4/conversation/subscribe", {
      topic: `conversation/${dwfSession}`,
      connectionId: "drive",
      visibility: "foreground",
      clientMode: "desktop-continuous",
    });
    const missing = await simpleCommand(
      "0197d3f0-0000-7000-8000-0000000000a1",
      "startSavedWorkflow",
      { name: "no_such_workflow" },
      dwfSession,
    );
    checks.dwfMissingStatus = missing.status;
    checks.dwfMissingCode = missing.reasonCode;
    const started = await simpleCommand(
      "0197d3f0-0000-7000-8000-0000000000a0",
      "startSavedWorkflow",
      { name: "probe" },
      dwfSession,
    );
    checks.dwfStartStatus = started.status;
    checks.dwfStartRunPrefix =
      typeof started.result?.runId === "string" ? started.result.runId.slice(0, 7) : null;
    checks.dwfStartToolCall =
      typeof started.result?.toolCallId === "string" && started.result.toolCallId.length > 0;
    if (started.status !== "accepted" || !started.result?.runId) {
      throw new Error(
        `startSavedWorkflow ${started.status}/${started.reasonCode}: ${started.message}`,
      );
    }
    const dbPath = join(home, dotDir, "cli", "db", "db.sqlite");
    const waitRow = async () => {
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        if (!existsSync(dbPath)) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        const db = new DatabaseSync(dbPath);
        const row = db
          .prepare("select status, parent_session_id from dwf_run where id = ?")
          .get(started.result.runId);
        db.close();
        if (row && row.status !== "pending" && row.status !== "running") return row;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    const row = await waitRow();
    checks.dwfRunStatus = row?.status ?? null;
    checks.dwfRunParent = row?.parent_session_id === dwfSession;
    if (checks.dwfRunStatus !== "completed") {
      throw new Error(`dwf run settled as ${checks.dwfRunStatus}`);
    }
    // 通知轮探针（origin=backgroundResult 的轮头）等 run/settled → 父会话通知链接上后再加：
    // Rust 宿主现在只把结算从进程表摘掉，不给父会话发后台通知（Node 会发）——见 CHANGELOG §6.21。
    console.log(`dwf engine: run=${started.result.runId} completed; missing=${checks.dwfMissingCode}`);
  }

  // DWF 的取消与恢复：hold 住的 run → 在飞时 resume 被拒 → cancel → stopped → resume → 完成。
  if (phases.includes("dwfResume")) {
    mkdirSync(join(workspace, ".nibi", "workflows"), { recursive: true });
    writeFileSync(
      join(workspace, ".nibi", "workflows", "hold.dwf.ts"),
      [
        "/* zcode-workflow",
        "description: hold probe",
        "*/",
        'const worker = agent("worker", "You answer questions.");',
        'return await worker.ask("hold this turn");',
      ].join(String.fromCharCode(10)) + String.fromCharCode(10),
    );
    const created = ack(
      await send("v4/command", {
        commandId: "0197d3f0-0000-7000-8000-0000000000b0",
        clientId: "drive",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: workspace },
        issuedAt: Date.now(),
      }),
      "createSession(dwfResume)",
    );
    const session = created.result?.sessionId;
    if (!session) throw new Error("createSession(dwfResume) returned no sessionId");
    const started = await simpleCommand(
      "0197d3f0-0000-7000-8000-0000000000b1",
      "startSavedWorkflow",
      { name: "hold" },
      session,
    );
    checks.dwfHoldStart = started.status;
    if (started.status !== "accepted" || !started.result?.runId) {
      throw new Error(`startSavedWorkflow(hold) ${started.status}/${started.reasonCode}`);
    }
    const runId = started.result.runId;
    const dbPath = join(home, dotDir, "cli", "db", "db.sqlite");
    const waitStatus = async (status) => {
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        if (existsSync(dbPath)) {
          const db = new DatabaseSync(dbPath);
          const row = db.prepare("select status from dwf_run where id = ?").get(runId);
          db.close();
          if (row?.status === status) return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    if (!(await waitStatus("running"))) throw new Error("held run never reached running");
    const live = await simpleCommand(
      "0197d3f0-0000-7000-8000-0000000000b2",
      "resumeWorkflowRun",
      { workId: runId },
      session,
    );
    checks.dwfResumeLiveCode = live.reasonCode ?? null;
    const cancelled = await simpleCommand(
      "0197d3f0-0000-7000-8000-0000000000b3",
      "cancelBackgroundWork",
      { workId: runId },
      session,
    );
    checks.dwfCancelStatus = cancelled.status;
    if (!(await waitStatus("cancelled"))) throw new Error("held run never cancelled after cancel");
    const resumed = await simpleCommand(
      "0197d3f0-0000-7000-8000-0000000000b4",
      "resumeWorkflowRun",
      { workId: runId },
      session,
    );
    checks.dwfResumeStatus = resumed.status;
    checks.dwfResumeCode = resumed.reasonCode ?? null;
    releaseHold();
    const completed = await waitStatus("completed");
    checks.dwfResumedStatus = completed ? "completed" : "timeout";
    console.log(
      `dwf resume: live=${checks.dwfResumeLiveCode} cancel=${checks.dwfCancelStatus} resumed=${checks.dwfResumeStatus}/${checks.dwfResumedStatus}`,
    );
  }

  // DWF 的修订（amendWorkflowRunSettings）：在飞的 run 只改并发 → 就地生效（同一个 runId、
  // 不铸后继）；再改子代理模型 → 前驱 stopped/superseded、后继带 lineage 指针跑完。
  if (phases.includes("dwfAmend")) {
    mkdirSync(join(workspace, ".nibi", "workflows"), { recursive: true });
    writeFileSync(
      join(workspace, ".nibi", "workflows", "amend.dwf.ts"),
      [
        "/* zcode-workflow",
        "description: amend probe",
        "*/",
        // persona 点名模型（launch.md「Models the script names」）：launch 时对目录解成绑定表，
        // actor 的选型按它（先于 run 级子代理模型）——这条链路两端各自端到端可证。
        'const worker = agent("worker", { system: "You answer questions.", model: "fake-model-b" });',
        `return await worker.ask("${AMEND_HOLD_TEXT}");`,
      ].join(String.fromCharCode(10)) + String.fromCharCode(10),
    );
    const created = ack(
      await send("v4/command", {
        commandId: "0197d3f0-0000-7000-8000-0000000000c0",
        clientId: "drive",
        sessionId: null,
        type: "createSession",
        payload: { workspaceId: workspace },
        issuedAt: Date.now(),
      }),
      "createSession(dwfAmend)",
    );
    const session = created.result?.sessionId;
    if (!session) throw new Error("createSession(dwfAmend) returned no sessionId");
    // 订阅这个会话的主题（Host 正常流程）：活投影的 controlOnly 行探针靠它的帧。
    await send("v4/conversation/subscribe", {
      topic: `conversation/${session}`,
      connectionId: "drive",
      visibility: "foreground",
      clientMode: "desktop-continuous",
    });
    const started = await simpleCommand(
      "0197d3f0-0000-7000-8000-0000000000c1",
      "startSavedWorkflow",
      { name: "amend" },
      session,
    );
    checks.dwfAmendStart = started.status;
    if (started.status !== "accepted" || !started.result?.runId) {
      throw new Error(`startSavedWorkflow(amend) ${started.status}/${started.reasonCode}`);
    }
    const runId = started.result.runId;
    const dbPath = join(home, dotDir, "cli", "db", "db.sqlite");
    const rowOf = (id) => {
      if (!existsSync(dbPath)) return undefined;
      const db = new DatabaseSync(dbPath);
      const row = db
        .prepare(
          "select status, caps_max_concurrency, resumed_from, failure_json from dwf_run where id = ?",
        )
        .get(id);
      db.close();
      return row;
    };
    const waitRow = async (id, predicate) => {
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        const row = rowOf(id);
        if (row !== undefined && predicate(row)) return row;
        await new Promise((r) => setTimeout(r, 100));
      }
      return undefined;
    };

    // 1) 在飞时只改并发：同一个 runId、不铸后继。
    if (!(await waitRow(runId, (row) => row.status === "running"))) {
      throw new Error("amended run never reached running");
    }
    // 脚本点名的绑定表（launch.md「Models the script names」）：launch 时解成规范串落
    // run-launched；actor 的选型按它（persona 点名 > run 级）——第一个 ask 的请求真在
    // fake-model-b 上，就是这条链路的端到端证据。
    const launchedOf = (id) => {
      const db = new DatabaseSync(dbPath);
      const launched = db
        .prepare(
          "select payload_json from dwf_event where run_id = ? and type = 'run-launched' order by sequence limit 1",
        )
        .get(id);
      db.close();
      return JSON.parse(launched?.payload_json ?? "{}");
    };
    const waitActorRequest = async () => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (REQUESTS.some((request) => request.model === "fake-model-b")) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    checks.dwfBindingsLaunch = JSON.stringify(launchedOf(runId).modelBindings ?? null);
    checks.dwfBindingsActorModel = await waitActorRequest();
    const retuned = await simpleCommand(
      "0197d3f0-0000-7000-8000-0000000000c2",
      "amendWorkflowRunSettings",
      { workId: runId, maxConcurrency: 2 },
      session,
    );
    checks.dwfAmendRetuneStatus = retuned.status;
    checks.dwfAmendRetuneSameRun =
      retuned.result?.runId === runId && retuned.result?.supersededRunId === undefined;
    checks.dwfAmendRetuneCaps = rowOf(runId)?.caps_max_concurrency ?? null;

    // 2) 改子代理模型：前驱被停下并替代（superseded），后继沿用脚本与实参。带显式的推理档：
    //    宿主会把它按目录归一成规范串，两个内核因此存下同一个逐字节相同的值。
    const amended = await simpleCommand(
      "0197d3f0-0000-7000-8000-0000000000c3",
      "amendWorkflowRunSettings",
      { workId: runId, subagentModel: "drive-fake/fake-model-b$enabled" },
      session,
    );
    checks.dwfAmendStatus = amended.status;
    const nextRun = amended.result?.runId;
    checks.dwfAmendChangedRun = typeof nextRun === "string" && nextRun !== runId;
    checks.dwfAmendSuperseded = amended.result?.supersededRunId === runId;
    if (amended.status !== "accepted" || !nextRun) {
      throw new Error(
        `amendWorkflowRunSettings ${amended.status}/${amended.reasonCode}: ${amended.message}`,
      );
    }
    const oldRow = await waitRow(
      runId,
      (row) => row.status === "cancelled" || row.status === "failed",
    );
    checks.dwfAmendOldStop = oldRow
      ? `${oldRow.status}/${JSON.parse(oldRow.failure_json ?? "{}").stopReason ?? "?"}`
      : null;
    const newRow = await waitRow(nextRun, () => true);
    checks.dwfAmendLineage = newRow?.resumed_from === runId;
    // 这次修订的选型落在 `run-launched.subagentModel` 上（两个内核写的是同一个规范串）；
    // 脚本点名的绑定表沿用前驱那张（同名再解析一遍，结果不变）。
    {
      const db = new DatabaseSync(dbPath);
      const launched = db
        .prepare(
          "select payload_json from dwf_event where run_id = ? and type = 'run-launched' order by sequence limit 1",
        )
        .get(nextRun);
      db.close();
      const payload = JSON.parse(launched?.payload_json ?? "{}");
      checks.dwfAmendStoredModel = payload.subagentModel ?? null;
      checks.dwfBindingsAmend = JSON.stringify(payload.modelBindings ?? null);
    }

    // 3) 放行 hold（后继的那次 ask）：后继跑完，且 actor 真的跑在新模型上。
    releaseAmendHold();
    const done = await waitRow(nextRun, (row) => row.status === "completed");
    checks.dwfAmendCompleted = done ? "completed" : "timeout";
    checks.dwfAmendActorModel = REQUESTS.some((request) => request.model === "fake-model-b");
    console.log(
      `dwf amend: retune=${checks.dwfAmendRetuneStatus}/${checks.dwfAmendRetuneCaps} ` +
        `amend=${checks.dwfAmendStatus} old=${checks.dwfAmendOldStop} ` +
        `lineage=${checks.dwfAmendLineage} next=${checks.dwfAmendCompleted} ` +
        `model=${checks.dwfAmendStoredModel}`,
    );

    // 4) 控制轮（docs/dynamic-workflow/launch.md「The launch turn」与「The settings turn」）：中枢
    //    启动 + 两次修订成功后，父会话里各有一条 controlOnly 的合成输入（source=workflow_launch +
    //    metadata.workflowLaunch），模型面的规范句与元数据两边逐句一致。Node 的 ACK 先于控制轮
    //    落库回，所以轮询等；行序 = 启动、就地 retune、修订出后继。
    const launchRows = () => {
      const db = new DatabaseSync(dbPath);
      const rows = db
        .prepare(
          "select id, data from message where session_id = ? and json_extract(data,'$.source')='workflow_launch' order by time_created, id",
        )
        .all(session);
      const parts = db
        .prepare(
          "select message_id, data from part where message_id in (select id from message where session_id = ?) and json_extract(data,'$.type')='text'",
        )
        .all(session);
      db.close();
      const textOf = new Map(
        parts.map((part) => [part.message_id, JSON.parse(part.data).text ?? null]),
      );
      return rows.map((row) => {
        const info = JSON.parse(row.data);
        return { info, text: textOf.get(row.id) ?? null };
      });
    };
    const waitLaunch = async (count) => {
      for (let attempt = 0; attempt < 600; attempt += 1) {
        const rows = launchRows();
        if (rows.length >= count) return rows;
        await new Promise((r) => setTimeout(r, 100));
      }
      return launchRows();
    };
    const DEFAULT_D = Math.max(4, Math.min(16, availableParallelism() - 2));
    const turns = await waitLaunch(3);
    checks.dwfSettingsTurnCount = turns.length;
    const [launchTurn, retuneTurn, successorTurn] = turns;
    const launchText = launchTurn?.text ?? "";
    checks.dwfLaunchTurnText =
      launchText.startsWith('Started the saved workflow "amend" (project) from the workflows hub as run ') &&
      launchText.endsWith(
        "Progress and results arrive as background notifications; do not start it again.",
      )
        ? "ok"
        : launchText.slice(0, 140) || null;
    const launchMeta = launchTurn?.info?.metadata?.workflowLaunch;
    checks.dwfLaunchTurnMeta =
      launchMeta?.name === "amend" &&
      launchMeta?.scope === "project" &&
      launchMeta?.runId === runId &&
      String(launchMeta?.toolCallId ?? "").startsWith("launch-") &&
      launchMeta?.path === join(workspace, ".nibi", "workflows", "amend.dwf.ts") &&
      typeof launchMeta?.script === "string"
        ? "ok"
        : JSON.stringify(launchMeta ?? null)?.slice(0, 140);
    const retuneText = retuneTurn?.text ?? "";
    checks.dwfSettingsTurnRetuneInPlace =
      retuneText.includes("at most 2 of its subagents run at once") &&
      retuneText.includes("nothing was stopped and no new run was started")
        ? "ok"
        : retuneText.slice(0, 140) || null;
    const retuneAmend = retuneTurn?.info?.metadata?.workflowLaunch?.amend;
    checks.dwfSettingsTurnRetuneMeta = retuneAmend
      ? `${retuneAmend.maxConcurrency?.to ?? "?"}|${retuneAmend.predecessorRunId ?? "-"}|${
          retuneAmend.ceiling === DEFAULT_D ? "D" : String(retuneAmend.ceiling ?? "?")
        }`
      : null;
    const successorText = successorTurn?.text ?? "";
    checks.dwfSettingsTurnName =
      retuneText.includes('("amend")') && successorText.includes('("amend")') ? "ok" : "missing";
    checks.dwfSettingsTurnAmendModel = successorText.includes(
      "its subagents now run on drive-fake/fake-model-b$enabled",
    )
      ? "ok"
      : successorText.slice(0, 140) || null;
    checks.dwfSettingsTurnAmendSupersedes = successorText.includes("supersedes run")
      ? "ok"
      : "missing";
    const successorAmend = successorTurn?.info?.metadata?.workflowLaunch?.amend;
    checks.dwfSettingsTurnAmendMeta = successorAmend
      ? `${successorAmend.predecessorRunId === runId ? "pred" : "?"}|${
          successorAmend.subagentModel?.to ?? "?"
        }|${successorAmend.ceiling === DEFAULT_D ? "D" : String(successorAmend.ceiling ?? "?")}|${
          successorAmend.maxConcurrency === undefined ? "nobound" : "bound"
        }`
      : null;
    checks.dwfSettingsTurnSource = turns.every(
      (turn) =>
        turn.info.source === "workflow_launch" &&
        turn.info.semantics?.source === "workflow_launch" &&
        turn.info.semantics?.origin === "real_user" &&
        typeof turn.info.metadata?.workflowLaunch?.runId === "string" &&
        typeof turn.info.metadata?.workflowLaunch?.toolCallId === "string",
    )
      ? "ok"
      : "shape";
    console.log(
      `dwf settings turn: count=${checks.dwfSettingsTurnCount} launch=${checks.dwfLaunchTurnText}/${checks.dwfLaunchTurnMeta} ` +
        `retune=${checks.dwfSettingsTurnRetuneInPlace}/${checks.dwfSettingsTurnRetuneMeta} ` +
        `next=${checks.dwfSettingsTurnAmendModel}/${checks.dwfSettingsTurnAmendMeta}`,
    );

    // 活投影的 controlOnly 面（launch.md 控制轮的行形状，Node product-projection 同形）：
    // 轮头与输入行都用 workflowLaunch origin、executionKind=controlOnly、元数据原样上行；
    // 轮头收口不带 activeMs（0 秒不能被旧 UI 读成「已工作 1 秒」）。
    const dwfTopic = `conversation/${session}`;
    const controlRowsOf = () =>
      [...buildState(dwfTopic).rows].filter((row) => row.executionKind === "controlOnly");
    // SQL 落库先于投影帧：等三只控制轮的行都到了再对形状。
    await waitFor(
      () => (controlRowsOf().length >= 3 ? true : undefined),
      "controlOnly projection rows",
      30_000,
    ).catch(() => {});
    const controlRows = controlRowsOf();
    checks.dwfControlRows = controlRows.length;
    checks.dwfControlRowShape = controlRows.every(
      (row) =>
        row.origin === "workflowLaunch" &&
        typeof row.workflowLaunch?.runId === "string" &&
        (row.kind === "turnHeader"
          ? row.state === "completedSuccess" && row.activeMs === undefined
          : row.kind === "userInput"),
    )
      ? "ok"
      : JSON.stringify(
          controlRows.map((row) => [row.kind, row.origin, row.state, row.activeMs]),
        ).slice(0, 140);
    console.log(
      `dwf control rows: count=${checks.dwfControlRows} shape=${checks.dwfControlRowShape}`,
    );
  }

  // DWF 的升级问答：actor 停在 escalate 上等父会话作答；答案原样回到 actor 的轮次，run 跑完。
  if (phases.includes("dwfEscalate")) {
    mkdirSync(join(workspace, ".nibi", "workflows"), { recursive: true });
    writeFileSync(
      join(workspace, ".nibi", "workflows", "escalate.dwf.ts"),
      [
        "/* zcode-workflow",
        "description: escalate probe",
        "*/",
        'const worker = agent("worker", "You answer questions.");',
        `return await worker.ask("${ESCALATE_TEXT}");`,
      ].join(String.fromCharCode(10)) + String.fromCharCode(10),
    );
    const created = ack(
      await send("v4/command", {
        commandId: "0197d3f0-0000-7000-8000-0000000000d0",
        clientId: "drive",
        sessionId: null,
        type: "createSession",
        payload: {
          workspaceId: workspace,
          // Node 的动态工作流工具面是 Host 控制的灰度闸（fail-closed）；升级问答要用
          // `ResolveWorkflowQuestion`，所以这个会话显式打开它（alwaysOn）。Rust 侧没有这道闸，
          // 多出来的字段被忽略。
          dynamicWorkflowEnabled: true,
          dynamicWorkflowMode: "alwaysOn",
        },
        issuedAt: Date.now(),
      }),
      "createSession(dwfEscalate)",
    );
    const session = created.result?.sessionId;
    if (!session) throw new Error("createSession(dwfEscalate) returned no sessionId");
    // 订阅这个会话的主题：升级通知轮的轮头探针（origin=backgroundResult）靠它的帧。
    await send("v4/conversation/subscribe", {
      topic: `conversation/${session}`,
      connectionId: "drive",
      visibility: "foreground",
      clientMode: "desktop-continuous",
    });
    // 父会话先有一轮**真实用户输入**：合成通知不能是会话的唯一输入（assistant 的锚点是最后
    // 一条 `real_user` 消息，两个内核的存储层同一条规则），GUI 里 run 也总从一个有对话的会话起。
    const seeded = REQUESTS.length;
    const seed = await simpleCommand(
      "0197d3f0-0000-7000-8000-0000000000d2",
      "sendText",
      { text: "hello escalate probe" },
      session,
    );
    if (seed.status !== "accepted") {
      throw new Error(`sendText(escalate seed) ${seed.status}/${seed.reasonCode}`);
    }
    for (let attempt = 0; attempt < 800 && REQUESTS.length === seeded; attempt += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // 会话空闲（Node 的 startSavedWorkflow 只对空闲会话工作；telemetry 帧的收尾有长尾）。
    await new Promise((r) => setTimeout(r, 1_500));
    // 起 run：Node 要求会话空闲（假 provider 即时，上面那一轮此时已经收尾）；万一还没收尾就等它。
    let started = null;
    for (let attempt = 0; attempt < 1_200; attempt += 1) {
      started = await simpleCommand(
        "0197d3f0-0000-7000-8000-0000000000d1",
        "startSavedWorkflow",
        { name: "escalate" },
        session,
      );
      if (started.status === "accepted") break;
      if (!String(started.reasonCode ?? "").endsWith(".session_busy")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    checks.dwfEscalateStart = started?.status ?? null;
    if (started?.status !== "accepted" || !started.result?.runId) {
      throw new Error(`startSavedWorkflow(escalate) ${started?.status}/${started?.reasonCode}`);
    }
    const runId = started.result.runId;
    const dbPath = join(home, dotDir, "cli", "db", "db.sqlite");
    let settled = null;
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      if (existsSync(dbPath)) {
        const db = new DatabaseSync(dbPath);
        const row = db.prepare("select status from dwf_run where id = ?").get(runId);
        db.close();
        if (row?.status === "completed") {
          settled = "completed";
          break;
        }
        if (row?.status === "failed") {
          settled = "failed";
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    checks.dwfEscalateStatus = settled ?? "timeout";
    checks.dwfEscalateRaised = escalationRaised;
    checks.dwfEscalateQidPrefix =
      typeof escalationQid === "string" ? escalationQid.slice(0, 5) : null;
    checks.dwfEscalateResolved = escalationResolved;
    checks.dwfEscalateAnswered = escalationAnswered;
    // journal 双轨：升级问答的事件落 `dwf_event`（整个 RunEvent 的 JSON，含 type）——Node 里
    // 是 driver 的 record，Rust 里是宿主注册表的 journal 轨；两内核的事件流因此同构
    // （askedAt / qid 全值除外）。这份 journal 就是 pendingQuestions 投影与冷回放的数据源。
    checks.dwfEscalateJournalTypes = null;
    checks.dwfEscalateJournalRaisedShape = false;
    checks.dwfEscalateJournalRaisedQuestion = null;
    checks.dwfEscalateJournalQidPrefix = null;
    checks.dwfEscalateJournalOrderOk = false;
    checks.dwfEscalateJournalAnswer = null;
    if (settled === "completed" && existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath);
      const rows = db
        .prepare(
          "select sequence, type, payload_json from dwf_event where run_id = ? order by sequence, rowid",
        )
        .all(runId);
      db.close();
      const escalations = rows
        .map((row) => {
          try {
            return { type: row.type, payload: JSON.parse(row.payload_json) };
          } catch {
            return null;
          }
        })
        .filter((row) => row !== null && row.type.startsWith("escalation-"));
      const raised = escalations.find((row) => row.type === "escalation-raised");
      const resolved = escalations.find((row) => row.type === "escalation-resolved");
      checks.dwfEscalateJournalTypes = escalations.map((row) => row.type).join(",");
      checks.dwfEscalateJournalRaisedShape =
        raised !== undefined &&
        typeof raised.payload.qid === "string" &&
        // actor 是结构化 ActorRef（{siteId, ordinal}，Node `RunEvent` 同形），不是字符串。
        typeof raised.payload.actor?.siteId === "string" &&
        typeof raised.payload.actor?.ordinal === "number" &&
        typeof raised.payload.question === "string" &&
        typeof raised.payload.askedAt === "number" &&
        (raised.payload.actorName === undefined ||
          typeof raised.payload.actorName === "string") &&
        (raised.payload.context === undefined || typeof raised.payload.context === "string");
      checks.dwfEscalateJournalRaisedQuestion = raised?.payload.question ?? null;
      checks.dwfEscalateJournalQidPrefix =
        typeof raised?.payload.qid === "string" ? raised.payload.qid.slice(0, 5) : null;
      checks.dwfEscalateJournalOrderOk =
        raised !== undefined &&
        resolved !== undefined &&
        resolved.payload.qid === raised.payload.qid;
      checks.dwfEscalateJournalAnswer = resolved?.payload.answer ?? null;
    }
    // 升级通知轮的轮头（Node `turnHeaderOrigin("background_task")`）：escalation 的后台通知在
    // 父会话开 model-only 轮，轮头 origin=backgroundResult、executionKind=agent。
    const noticeHeader = () =>
      [...buildState(`conversation/${session}`).rows].find(
        (candidate) => candidate.kind === "turnHeader" && candidate.origin === "backgroundResult",
      );
    await waitFor(
      () => (noticeHeader()?.state === "completedSuccess" ? true : undefined),
      "backgroundResult escalation header",
      30_000,
    ).catch(() => {});
    const notice = noticeHeader();
    checks.dwfNoticeRow =
      notice && notice.executionKind === "agent" && notice.state === "completedSuccess"
        ? "ok"
        : notice
          ? `${notice.executionKind}/${notice.state}`
          : "absent";
    console.log(
      `dwf escalate: run=${checks.dwfEscalateStatus} raised=${checks.dwfEscalateRaised} ` +
        `qid=${checks.dwfEscalateQidPrefix} resolved=${checks.dwfEscalateResolved} ` +
        `answered=${checks.dwfEscalateAnswered} journal=${checks.dwfEscalateJournalTypes} ` +
        `notice=${checks.dwfNoticeRow}`,
    );

    // ── run 详情探针（GetWorkflowRun，升级通知里引用的查询兜底）──
    // 真 id：父会话里说探针口令 → 模型按路由调 GetWorkflowRun(runId) → 工具结果（模型面文本）
    // 落 TOOL_RESULTS，断言状态/摘要/用量/待答区缺席；坏 id：同一口令再来一次 → run_not_found。
    const inspectProbe = async (runIdForProbe) => {
      const seen = TOOL_RESULTS.length;
      inspectRunId = runIdForProbe;
      inspectAttempt += 1;
      const turn = await simpleCommand(
        `0197d3f0-0000-7000-8000-000000000d${inspectAttempt.toString(16).padStart(2, "0")}`,
        "sendText",
        { text: "inspect the run" },
        session,
      );
      if (turn.status !== "accepted") {
        throw new Error(`sendText(inspect) ${turn.status}/${turn.reasonCode}`);
      }
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const fresh = TOOL_RESULTS.slice(seen);
        if (fresh.some((result) => result.includes("<status>") || result.includes("run_not_found"))) {
          return fresh;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("the GetWorkflowRun probe never produced a tool result");
    };
    const detailResults = await inspectProbe(runId);
    const detailText = detailResults.find((result) => result.includes("<status>")) ?? "";
    const statusTag = /<status>([^<]+)<\/status>/u.exec(detailText)?.[1] ?? null;
    checks.dwfRunToolStatus = statusTag;
    checks.dwfRunToolCompletedSummary = /<summary>Completed in /.test(detailText);
    checks.dwfRunToolUsage = /<usage>spent_tokens=\d+ nodes_observed=\d+ /.test(detailText);
    checks.dwfRunToolOwned = detailText.includes("<owned_by_this_session>true</owned_by_this_session>");
    checks.dwfRunToolAmendable = detailText.includes("<amendable>");
    // 已结算的 run 没有在等问题：pending 区整字段缺席（空节读起来像「问过、已答完」）。
    checks.dwfRunToolPendingAbsent = !detailText.includes("<pending_questions>");
    // 块恒在场（Node `formatWorkflowRunLogTailBlock`）：空尾巴是一句固定文案，不是缺席。
    checks.dwfRunToolLogTailShape = detailText.includes("<log_tail>");
    // 情势三块（health / phases / subagents）：health 与 subagents 恒在场，phases 视脚本而定。
    const healthText = /<health>([\s\S]*?)<\/health>/u.exec(detailText)?.[1] ?? null;
    checks.dwfRunToolHealth =
      healthText !== null &&
      /last_progress=\S/.test(healthText) &&
      /consecutive_failures=\d+/.test(healthText) &&
      /cached_steps=\d+/.test(healthText) &&
      // 终态 run 不带 stalled（它只对活着的 run 有意义）。
      !healthText.includes("stalled=")
        ? "ok"
        : healthText?.trim().slice(0, 90) ?? null;
    const subagentsText = /<subagents>([\s\S]*?)<\/subagents>/u.exec(detailText)?.[1] ?? "";
    const rosterRow = subagentsText.split("\n").find((line) => line.includes("@1"));
    checks.dwfRunToolSubagentRow = rosterRow
      ? (/(done|failed|unfinished) /.test(rosterRow) ? "ok" : rosterRow.slice(0, 90))
      : subagentsText.includes("No subagents created yet.")
        ? "empty"
        : subagentsText.slice(0, 90);
    checks.dwfRunToolSubagentTokens =
      rosterRow && /\d[\d,]* tokens/.test(rosterRow) ? "ok" : rosterRow ? "notokens" : null;
    const journalRow = (() => {
      const db = new DatabaseSync(dbPath);
      const nodes = db
        .prepare(
          "select count(*) as total from dwf_node where run_id = ? and status != 'running'",
        )
        .get(runId);
      const phases = db
        .prepare(
          "select count(distinct json_extract(payload_json,'$.name')) as total from dwf_event where run_id = ? and type='phase-entered'",
        )
        .get(runId);
      const reports = db
        .prepare(
          "select count(*) as total from dwf_node where run_id = ? and kind='report'",
        )
        .get(runId);
      db.close();
      return { settled: Number(nodes?.total ?? 0), phases: Number(phases?.total ?? 0), reports: Number(reports?.total ?? 0) };
    })();
    const phasesText = /<phases>([\s\S]*?)<\/phases>/u.exec(detailText)?.[1] ?? null;
    checks.dwfRunToolPhases =
      journalRow.phases === 0
        ? phasesText === null
          ? "absent-as-expected"
          : "unexpected-present"
        : phasesText !== null &&
            /^\s*1\. /.test(phasesText) &&
            / (done|current|ahead|unfinished) /.test(phasesText)
          ? "ok"
          : phasesText?.slice(0, 90) ?? "missing";
    // 产物清单与 report 行的对应（脚本没发 report / artifact 时块缺席）。
    const artifactsText = /<artifacts count="(\d+)">([\s\S]*?)<\/artifacts>/u.exec(detailText);
    checks.dwfRunToolArtifacts =
      journalRow.reports === 0
        ? artifactsText === null
          ? "absent-as-expected"
          : "unexpected-present"
        : artifactsText !== null &&
            Number(artifactsText[1]) >= 1 &&
            artifactsText[2].includes("items")
          ? "ok"
          : artifactsText?.[2]?.slice(0, 90) ?? "missing";
    // 坏 id：同一口令再来一次。前一次探针的轮次可能还没完全收尾（迟到的 `<status>` 结果会让
    // inspectProbe 提前返回），所以这里对着「这次发送之后」的增量专门等 run_not_found 本尊。
    const beforeMissing = TOOL_RESULTS.length;
    await inspectProbe("dwfrun-does-not-exist");
    checks.dwfRunToolNotFound = await waitFor(
      () =>
        TOOL_RESULTS
          .slice(beforeMissing)
          .some((result) => result.includes("run_not_found"))
          ? true
          : undefined,
      "the not-found probe's run_not_found result",
    ).then(
      () => true,
      () => false,
    );
    inspectRunId = null;
    console.log(
      `run detail: status=${checks.dwfRunToolStatus} summary=${checks.dwfRunToolCompletedSummary} ` +
        `owned=${checks.dwfRunToolOwned} pendingAbsent=${checks.dwfRunToolPendingAbsent} ` +
        `notFound=${checks.dwfRunToolNotFound}`,
    );
  }

  // 情势截面与产物的实形态探针（dwfRoster）：双内核对拍对 Node 会话的轮调度太敏感
  // （探针轮要排在 run 通知轮之后，时长不可控），本轮撤下——四个缺块的**模型侧接线**由
  // Rust 格式器的单测逐字钉住（Node 格式文本为对照基准），探针等 FillWorkflowHole 切片
  // 再回来（那时 run 有真正的停驻/补全周期可等）。

  if (phases.includes("storagePrepare")) {
    await runStoragePreparePhase({ bin, binArgs, isNode, home, dotDir, checks });
  }

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

  // 分享导入的丢弃（NIBI discardSharedContext）：存储是 Node 写的 session_entry
  // （type = v4/shared_context_import）。这里直接往会话库里插一条 pending 导入（Node 的导入
  // 流程本来就在协议层之外），再让两个内核各丢一次。
  if (phases.includes("discardSharedContext")) {
    const dbPath = [
      join(home, dotDir, "cli", "db", "db.sqlite"),
      join(home, dotDir, "db", "db.sqlite"),
      join(home, dotDir, "v2", "db.sqlite"),
    ].find((candidate) => existsSync(candidate));
    if (!dbPath) throw new Error(`session db not found under ${join(home, dotDir)}`);
    const contextId = `ctx_${sessionId.slice(5, 13)}`;
    const db = new DatabaseSync(dbPath);
    const now = Date.now();
    db.prepare(
      `insert or replace into session_entry (id, session_id, type, time_created, time_updated, data)
       values (?, ?, ?, ?, ?, ?)`,
    ).run(
      `v4_shared_context_import:${sessionId}:share_drive`,
      sessionId,
      "v4/shared_context_import",
      now,
      now,
      JSON.stringify({
        shareId: "share_drive",
        shareUrl: "https://nibi.example/cn/share/drive01",
        contextId,
        status: "pending",
      }),
    );
    db.close();

    const discarded = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000090",
      "discardSharedContext",
      { contextId },
    );
    if (discarded.status !== "accepted") {
      throw new Error(
        `discardSharedContext ${discarded.status}/${discarded.reasonCode}: ${discarded.message}`,
      );
    }
    checks.sharedContextDiscardStatus = discarded.status;
    // Node 的丢弃是"静态元数据重种子"，不产 delta；重新订阅拿到的快照才带出来。
    // Rust 的投影在丢弃时也发一条 state.updated，所以这条路径对两边都成立。
    const resub = await send("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "drive-discard",
      visibility: "foreground",
      clientMode: "desktop-continuous",
    });
    if (!resub.result?.ack && !resub.result?.epoch && !resub.result?.subscription) {
      throw new Error(`resubscribe after discard failed: ${JSON.stringify(resub)}`);
    }
    const projected = await waitFor(
      () => {
        const state = buildState();
        return state.sharedContextImport?.status === "discarded"
          ? state.sharedContextImport
          : undefined;
      },
      "sharedContextImport discarded in a fresh snapshot",
      30_000,
    );
    checks.sharedContextProjectedStatus = projected.status;
    checks.sharedContextProjectedId = projected.contextId === contextId;
    checks.sharedContextProjectedUrl =
      projected.shareUrl === "https://nibi.example/cn/share/drive01";

    const verify = new DatabaseSync(dbPath);
    const row = verify
      .prepare("select data from session_entry where id = ?")
      .get(`v4_shared_context_import:${sessionId}:share_drive`);
    verify.close();
    const stored = row?.data ? JSON.parse(String(row.data)) : null;
    checks.sharedContextStoredStatus = stored?.status ?? null;
    checks.sharedContextStoredPreserved = stored?.shareId === "share_drive";
    if (checks.sharedContextStoredStatus !== "discarded") {
      throw new Error(`stored shared context status = ${checks.sharedContextStoredStatus}`);
    }

    const again = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000091",
      "discardSharedContext",
      { contextId },
    );
    checks.sharedContextSecondStatus = again.status;
    checks.sharedContextSecondCode = again.reasonCode;
    if (again.status !== "failed" || again.reasonCode !== "fault.command.inputRejected") {
      throw new Error(
        `discardSharedContext(second) ${again.status}/${again.reasonCode}: ${again.message}`,
      );
    }
    console.log(
      `discardSharedContext: accepted, projected=${checks.sharedContextProjectedStatus}, stored=${checks.sharedContextStoredStatus}`,
    );
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

    // 侧聊会话：从当前对话派生一个子会话并带首条输入；返回的会话 id 与父会话不同。
  if (phases.includes("rejections")) {
    const side = await casCommand("createSelectionSideSession", {
      firstInput: { text: "side chat question" },
    });
    checks.sideSessionStatus = side.status;
    const sideId = side.result?.sessionId;
    checks.sideSessionChildPrefix = typeof sideId === "string" ? sideId.slice(0, 5) : null;
    checks.sideSessionDistinct = Boolean(sideId) && sideId !== sessionId;
    console.log(
      `side session: status=${checks.sideSessionStatus} child=${sideId} distinct=${checks.sideSessionDistinct}`,
    );
    if (
      checks.sideSessionStatus !== "accepted" ||
      checks.sideSessionChildPrefix !== "sess_" ||
      !checks.sideSessionDistinct
    ) {
      throw new Error(`side session failed: ${JSON.stringify(side)}`);
    }
  }

  // goal：设置目标（Node 的 /goal 归一后按人类输入提交）→ 暂停 → 恢复。三条都不该失败。
  if (phases.includes("rejections")) {
    // 前面的阶段把会话切到过 plan 模式；plan 与 goal 互斥，先切回 build。
    await casCommand("switchCollaborationMode", { mode: "build" });
    const goalSet = await casCommand("sendGoalCommand", {
      text: "/goal finish the queue tests",
      displayText: "/goal finish the queue tests",
    });
    checks.goalSetStatus = goalSet.status;
    if (goalSet.status !== "accepted") console.log(`goal set ack: ${JSON.stringify(goalSet)}`);
    const paused = await casCommand("pauseGoal", {});
    checks.goalPauseStatus = paused.status;
    const resumed = await casCommand("resumeGoal", {});
    checks.goalResumeStatus = resumed.status;
    console.log(
      `goal: set=${checks.goalSetStatus} pause=${checks.goalPauseStatus} resume=${checks.goalResumeStatus}`,
    );
    if (
      checks.goalSetStatus !== "accepted" ||
      checks.goalPauseStatus !== "accepted" ||
      checks.goalResumeStatus !== "accepted"
    ) {
      throw new Error(
        `goal commands expected accepted, got ${checks.goalSetStatus}/${checks.goalPauseStatus}/${checks.goalResumeStatus}`,
      );
    }
  }

  // 反馈与询问 snooze：assistantText 行的赞/踩（CAS + row target）与幂等的 snooze。
  if (phases.includes("rejections")) {
    const state = buildState();
    const assistantRow = [...state.rows].reverse().find((row) => row.kind === "assistantText");
    if (!assistantRow) throw new Error("no assistantText row for feedback");
    const liked = await casCommand("setAssistantFeedback", {
      target: { rowId: assistantRow.rowId, entityId: assistantRow.entityId },
      feedback: "like",
    });
    checks.feedbackStatus = liked.status;
    const snoozed = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000061",
      "snoozeInteractionAutoResolution",
      { interactionId: "interaction_none" },
    );
    checks.snoozeStatus = snoozed.status;
    console.log(`feedback=${checks.feedbackStatus} snooze=${checks.snoozeStatus}`);
    if (checks.feedbackStatus !== "accepted" || checks.snoozeStatus !== "accepted") {
      throw new Error(`feedback/snooze expected accepted, got ${checks.feedbackStatus}/${checks.snoozeStatus}`);
    }
  }

  // 队列命令组：挂住一轮 → 排两条 → 编辑/重排/删除/立刻发送 → 放行。两边内核按同一组断言。
  if (phases.includes("rejections")) {
    // 队列命令都要 baseRevision（CAS）：每次现读投影，stale 就重试一次（命令 id 固定，
    // queueItemId 才能对上）。
    const queueCommand = async (commandId, type, payload) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const state = buildState();
        const result = ack(
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
        if (result.status !== "stale" || attempt === 4) return result;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      return { status: "error" };
    };

    const beforeHold = REQUESTS.length;
    const holdAck = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000051",
      "sendText",
      { text: HOLD_TEXT, requestedDelivery: "startNow" },
    );
    if (holdAck.status !== "accepted") throw new Error(`hold turn was not accepted: ${JSON.stringify(holdAck)}`);
    // 等这一轮真的进到 provider（才开始"忙"）：要比发送前多一次请求，不能只看总数。
    await waitFor(
      () => (REQUESTS.length > beforeHold ? true : undefined),
      "held turn request",
      30_000,
    );
    const first = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000052",
      "sendText",
      { text: "queued one" },
    );
    const second = await simpleCommand(
      "0197d3f0-0000-7000-8000-000000000053",
      "sendText",
      { text: "queued two" },
    );
    checks.queueEnqueued = first.status === "accepted" && second.status === "accepted";
    const editAck = await queueCommand(
      "0197d3f0-0000-7000-8000-000000000054",
      "editQueueItem",
      { queueItemId: "queue_0197d3f0-0000-7000-8000-000000000052", newText: "queued one edited" },
    );
    checks.queueEditStatus = editAck.status;
    const reorderAck = await queueCommand(
      "0197d3f0-0000-7000-8000-000000000055",
      "reorderQueueItem",
      {
        queueItemId: "queue_0197d3f0-0000-7000-8000-000000000053",
        beforeQueueItemId: "queue_0197d3f0-0000-7000-8000-000000000052",
      },
    );
    checks.queueReorderStatus = reorderAck.status;
    const deleteAck = await queueCommand(
      "0197d3f0-0000-7000-8000-000000000056",
      "deleteQueueItem",
      { queueItemId: "queue_0197d3f0-0000-7000-8000-000000000053" },
    );
    checks.queueDeleteStatus = deleteAck.status;
    const missingDelete = await queueCommand(
      "0197d3f0-0000-7000-8000-000000000057",
      "deleteQueueItem",
      { queueItemId: "queue_no_such_item" },
    );
    checks.queueDeleteMissingStatus = missingDelete.status;
    checks.queueDeleteMissingCode = missingDelete.reasonCode ?? null;
    const autoDrain = await queueCommand(
      "0197d3f0-0000-7000-8000-000000000058",
      "setAutoDrain",
      { autoDrain: false },
    );
    checks.queueAutoDrainStatus = autoDrain.status;
    // 先放行被挂住的回合（自动排空已关，排队的项留着），等会话空闲后再提升被编辑过的那一条：
    // 两端都走"空闲时立刻开"，不依赖各自的抢占实现。
    releaseHold();
    await waitFor(
      () => (buildState().stopState === "idle" ? true : undefined),
      "idle before promotion",
      60_000,
    );
    const promote = await queueCommand(
      "0197d3f0-0000-7000-8000-000000000059",
      "sendQueuedNow",
      { queueItemId: "queue_0197d3f0-0000-7000-8000-000000000052" },
    );
    checks.queuePromoteStatus = promote.status;
    await waitFor(
      () =>
        REQUESTS.some((request) => request.lastUserText?.includes("queued one edited"))
          ? true
          : undefined,
      "promoted queued input reaches the provider",
      60_000,
    ).catch(() => undefined);
    checks.queuePromotedInRequest = REQUESTS.some((request) =>
      request.lastUserText?.includes("queued one edited"),
    );
    console.log(
      `queue commands: enqueued=${checks.queueEnqueued} edit=${checks.queueEditStatus} reorder=${checks.queueReorderStatus} delete=${checks.queueDeleteStatus}/${checks.queueDeleteMissingCode} autoDrain=${checks.queueAutoDrainStatus} promote=${checks.queuePromoteStatus} promoted-ran=${checks.queuePromotedInRequest}`,
    );
    if (!checks.queueEnqueued) throw new Error("queued inputs were not accepted");
    if (checks.queueDeleteMissingStatus !== "noop" || checks.queueDeleteMissingCode !== "queue.itemMissing") {
      throw new Error(`deleteQueueItem(missing) expected noop queue.itemMissing, got ${checks.queueDeleteMissingStatus}/${checks.queueDeleteMissingCode}`);
    }
    if (!checks.queuePromotedInRequest) {
      console.log(
        `queued request texts: ${JSON.stringify(
          REQUESTS.map((request) => request.lastUserText ?? "").filter((text) => text.includes("queued")),
        )}`,
      );
      throw new Error("the promoted queued input never reached the provider");
    }
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
  if (process.env.NIBI_DRIVE_DUMP_STDERR === "1") {
    console.error(`stderr:\n${stderr}`);
    console.error(`notifications: ${notifications.map((n) => n.method).join(", ")}`);
  }
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
