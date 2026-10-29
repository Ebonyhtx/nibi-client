#!/usr/bin/env node
/**
 * NIBI 内核阶段 0 基线采集（只测量，不改运行时参数）。
 *
 * 背景：Rust 内核改造的 Step 0 要求先拿到 Node 内核的真实数字，否则“改造前”
 * 无法对照。该脚本把测量做成可复跑的两条路径：
 *
 *   agent   零模型成本：起本地假 provider + 全隔离 HOME，跑 `nibi -p`，采集
 *           冷启动、首事件、首 token、回合完成、峰值 RSS、V8 堆上限。
 *   attach  对一个已在运行的 Electron 进程树采样（Host/renderer/Agent/MCP），
 *           输出按角色归类的 RSS/私有内存时间序列。
 *
 * 硬约束：不写真实 ~/.nibi；不设置 --max-old-space-size；不改任何 GC/回收参数。
 * 隔离靠同时重定向 USERPROFILE/HOME、NIBI_DATA_BASE_DIR、NIBI_STORAGE_DIR、
 * NIBI_SETTINGS_DIR；只设其中一部分会被 CLI 的派生路径绕开（实测踩过）。
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const cliEntry = join(repoRoot, "apps/zcode-cli/packages/cli/dist/nibi.cjs");
const samplerPreload = join(here, "memory-sampler.cjs");
const treeSamplerScript = join(here, "sample-process-tree.ps1");

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args[0] : "agent";

function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? fallback : value;
}
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}
function percentile(values, p) {
  const sorted = values.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

/**
 * 自包含的合法 Personal Provider Config。
 * 注意：providerConfigRules 只能是 { providerRules }（strict），多一个键整份配置被拒，
 * 表现是“Select a model before sending a message”，而不是配置错误——踩过一次。
 */
function buildProviderConfig(baseUrl, modelId) {
  return {
    schemaVersion: 1,
    config: {
      providerOrder: ["baseline-fake"],
      providerConfigRules: {
        providerRules: [
          {
            providerId: "baseline-fake",
            providerName: "Baseline Fake",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "fake-key" },
              api: { type: "openai-chat-completions", baseUrl },
              personalModelIds: [modelId],
              modelOrder: [modelId],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {
            modelId,
            providerId: "baseline-fake",
            config: {
              enabled: true,
              properties: {
                supportsJsonSchemaOutput: true,
                supportsMidConversationSystem: true,
              },
            },
          },
        ],
        manualProviderModelRules: [],
      },
      defaultModelSelection: { providerId: "baseline-fake", modelId },
    },
  };
}

function startFakeProvider(marker) {
  return new Promise((resolvePromise) => {
    const requests = [];
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        requests.push({
          at: Date.now(),
          path: request.url,
          stream: parsed?.stream === true,
          model: parsed?.model ?? null,
        });
        const text = marker;
        if (parsed?.stream === true) {
          response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: text, role: "assistant" }, index: 0 }], id: "baseline", object: "chat.completion.chunk" })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], id: "baseline", object: "chat.completion.chunk" })}\n\n`,
          );
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [
              { finish_reason: "stop", index: 0, message: { content: text, role: "assistant" } },
            ],
            id: "baseline",
            object: "chat.completion",
            usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({ server, requests, port: server.address().port });
    });
  });
}

function parseJsonLines(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 忽略半帧/非 JSON 行；stdout 原文另存。
    }
  }
  return rows;
}

function summarizeSamples(samples) {
  const rss = samples.map((s) => s.rss).filter((v) => Number.isFinite(v));
  const heapUsed = samples.map((s) => s.heapUsed).filter((v) => Number.isFinite(v));
  return {
    sampleCount: samples.length,
    peakRssBytes: rss.length ? Math.max(...rss) : null,
    peakHeapUsedBytes: heapUsed.length ? Math.max(...heapUsed) : null,
    firstRssBytes: rss[0] ?? null,
    lastRssBytes: rss.at(-1) ?? null,
    heapSizeLimitBytes: samples[0]?.heapSizeLimit ?? null,
  };
}

async function runAgentOnce({ runIndex, outDir, prompt, modelId, timeoutMs }) {
  if (!existsSync(cliEntry)) {
    throw new Error(
      `找不到 ${cliEntry}；先运行 node scripts/build-desktop-agent-cli.mjs 生成 CLI bundle`,
    );
  }
  const runDir = ensureDir(join(outDir, "agent", `run-${String(runIndex + 1).padStart(2, "0")}`));
  const home = ensureDir(join(runDir, "home"));
  const dataV2 = ensureDir(join(home, ".nibi", "v2"));
  const workspace = ensureDir(join(runDir, "workspace"));
  const marker = `BASELINE-FAKE-REPLY-${runIndex + 1}`;
  const fake = await startFakeProvider(marker);
  const configPath = join(dataV2, "provider_config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(buildProviderConfig(`http://127.0.0.1:${fake.port}/v1`, modelId), null, 2)}\n`,
    "utf8",
  );

  const samplerOut = join(runDir, "memory.jsonl");
  const stdoutPath = join(runDir, "events.ndjson");
  const stderrPath = join(runDir, "stderr.log");
  const startedAt = Date.now();
  const env = {
    ...process.env,
    // 强制所有派生路径落到本次 run 的 home 下；只设 NIBI_* 不够（实测 CLI 的
    // storage preparation 子进程仍会写真实 ~/.nibi）。
    USERPROFILE: home,
    HOME: home,
    NIBI_DATA_BASE_DIR: home,
    NIBI_STORAGE_DIR: join(home, ".nibi"),
    NIBI_SETTINGS_DIR: dataV2,
    NIBI_CREDENTIAL_SECRET: "kernel-baseline-fixture-only",
    // 阶段 0 不碰生产端点；让内置 provider 刷新快速失败而不是等待网络。
    NIBI_ENDPOINT_ORIGIN: "http://127.0.0.1:9",
    NIBI_BASELINE_SAMPLER_OUT: samplerOut,
    NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), `--require=${samplerPreload}`]
      .filter(Boolean)
      .join(" "),
  };
  const child = spawn(
    process.execPath,
    [cliEntry, "-p", prompt, "--output-format", "stream-json", "--mode", "yolo"],
    { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  writeFileSync(join(runDir, "meta.json"), `${JSON.stringify({
    runIndex: runIndex + 1,
    pid: child.pid,
    startedAt,
    execPath: process.execPath,
    nodeVersion: process.version,
    cliEntry,
    prompt,
    modelId,
    isolatedHome: home,
    env: {
      NIBI_DATA_BASE_DIR: env.NIBI_DATA_BASE_DIR,
      NIBI_STORAGE_DIR: env.NIBI_STORAGE_DIR,
      NIBI_SETTINGS_DIR: env.NIBI_SETTINGS_DIR,
      NODE_OPTIONS: env.NODE_OPTIONS,
    },
  }, null, 2)}\n`, "utf8");

  let stdout = "";
  let stderr = "";
  let firstStdoutMs = null;
  child.stdout.on("data", (chunk) => {
    if (firstStdoutMs === null) firstStdoutMs = Date.now() - startedAt;
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    appendFileSync(stderrPath, chunk);
  });
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);
  const exit = await new Promise((resolvePromise) => {
    child.on("close", (code, signal) => resolvePromise({ code, signal }));
    child.on("error", (error) => resolvePromise({ code: null, signal: null, error: String(error) }));
  });
  clearTimeout(timer);
  const exitedAt = Date.now();
  fake.server.close();
  writeFileSync(stdoutPath, stdout, "utf8");

  const events = parseJsonLines(stdout);
  const memorySamples = existsSync(samplerOut) ? parseJsonLines(readFileSync(samplerOut, "utf8")) : [];
  const samples = memorySamples.filter((row) => row.tag === "sample" || row.tag === "start" || row.tag === "exit");
  const firstEvent = events.find((event) => typeof event?.timestamp === "number");
  const firstStreamingEvent = events.find(
    (event) =>
      typeof event?.type === "string" &&
      (event.type === "model.streaming" || event.type === "model.streaming.delta") &&
      Boolean(event?.payload?.delta),
  );
  const firstAssistantTextEvent = events.find((event) => {
    const delta = event?.payload?.delta;
    return typeof delta === "string" ? delta.length > 0 : Boolean(delta?.text);
  });
  const turnCompleted = events.find((event) => event?.type === "turn.completed");
  const firstProviderRequest = fake.requests[0];

  return {
    run: runIndex + 1,
    exitCode: exit.code,
    signal: exit.signal,
    error: exit.error ?? null,
    spawnToFirstStdoutMs: firstStdoutMs,
    spawnToFirstEventMs: firstEvent ? firstEvent.timestamp - startedAt : null,
    spawnToFirstStreamingEventMs: firstStreamingEvent
      ? firstStreamingEvent.timestamp - startedAt
      : null,
    spawnToFirstAssistantTextMs: firstAssistantTextEvent
      ? firstAssistantTextEvent.timestamp - startedAt
      : null,
    spawnToTurnCompletedMs: turnCompleted ? turnCompleted.timestamp - startedAt : null,
    totalMs: exitedAt - startedAt,
    eventCount: events.length,
    eventTypes: events.reduce((acc, event) => {
      const key = String(event?.type ?? "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    providerRequestCount: fake.requests.length,
    spawnToFirstProviderRequestMs: firstProviderRequest
      ? firstProviderRequest.at - startedAt
      : null,
    markerSeen: stdout.includes(marker),
    stderrTail: stderr.trim().split(/\r?\n/).slice(-8).join("\n"),
    memory: summarizeSamples(samples),
    rssAtFirstAssistantTextBytes: firstAssistantTextEvent
      ? nearestSampleAt(samples, firstAssistantTextEvent.timestamp)?.rss ?? null
      : null,
    isolatedDbCreated: existsSync(join(home, ".nibi", "cli", "db", "db.sqlite")),
    runDir,
  };
}

function nearestSampleAt(samples, at) {
  if (!samples.length) return null;
  let best = samples[0];
  let bestDistance = Math.abs(best.at - at);
  for (const sample of samples) {
    const distance = Math.abs(sample.at - at);
    if (distance < bestDistance) {
      best = sample;
      bestDistance = distance;
    }
  }
  return best;
}

async function runAgentMode() {
  const runs = Number(option("runs", "5"));
  const prompt = option("prompt", "baseline probe: reply with the marker only");
  const modelId = option("model", "baseline-fake-model");
  const timeoutMs = Number(option("timeout-ms", "180000"));
  const outDir = resolve(
    option("out", join(repoRoot, ".artifacts", "kernel-baseline", `agent-${stamp()}`)),
  );
  ensureDir(outDir);
  const results = [];
  for (let index = 0; index < runs; index += 1) {
    process.stderr.write(`[kernel-baseline] agent run ${index + 1}/${runs}\n`);
    results.push(await runAgentOnce({ runIndex: index, outDir, prompt, modelId, timeoutMs }));
  }
  const numeric = (key) =>
    results
      .map((result) => (key === "peakRssBytes" ? result.memory.peakRssBytes : result[key]))
      .filter((value) => typeof value === "number");
  const summary = {
    kind: "agent",
    generatedAt: new Date().toISOString(),
    repoRoot,
    gitHead: readGitHead(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    totalMemoryBytes: totalmem(),
    runs,
    prompt,
    modelId,
    metrics: {
      spawnToFirstStdoutMs: describe(numeric("spawnToFirstStdoutMs")),
      spawnToFirstEventMs: describe(numeric("spawnToFirstEventMs")),
      spawnToFirstStreamingEventMs: describe(numeric("spawnToFirstStreamingEventMs")),
      spawnToFirstAssistantTextMs: describe(numeric("spawnToFirstAssistantTextMs")),
      spawnToTurnCompletedMs: describe(numeric("spawnToTurnCompletedMs")),
      totalMs: describe(numeric("totalMs")),
      peakRssBytes: describe(numeric("peakRssBytes")),
      rssAtFirstAssistantTextBytes: describe(numeric("rssAtFirstAssistantTextBytes")),
    },
    heapSizeLimitBytes: results.find((result) => result.memory.heapSizeLimitBytes)?.memory
      .heapSizeLimitBytes ?? null,
    runsDetail: results,
  };
  writeFileSync(join(outDir, "runs.json"), `${JSON.stringify(results, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "summary.md"), renderAgentSummary(summary), "utf8");
  process.stdout.write(`${join(outDir, "summary.md")}\n`);
  if (results.some((result) => result.exitCode !== 0)) process.exitCode = 1;
}

function describe(values) {
  if (!values.length) return null;
  return {
    count: values.length,
    min: Math.min(...values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: Math.max(...values),
  };
}

function readGitHead() {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function renderAgentSummary(summary) {
  const rows = [
    ["spawn → 首条 stdout", "spawnToFirstStdoutMs"],
    ["spawn → 首条事件", "spawnToFirstEventMs"],
    ["spawn → 首个流式事件", "spawnToFirstStreamingEventMs"],
    ["spawn → 首段助手文本", "spawnToFirstAssistantTextMs"],
    ["spawn → turn.completed", "spawnToTurnCompletedMs"],
    ["spawn → 进程退出", "totalMs"],
    ["峰值 RSS (MiB)", "peakRssBytes"],
    ["首段文本时 RSS (MiB)", "rssAtFirstAssistantTextBytes"],
  ];
  const lines = [
    "# 内核阶段 0 基线（agent 无头模式）",
    "",
    `- 生成时间：${summary.generatedAt}`,
    `- 仓库：${summary.repoRoot}`,
    `- Node：${summary.node}（${summary.platform}）`,
    `- runs：${summary.runs}；prompt：${summary.prompt}`,
    `- V8 heap_size_limit：${summary.heapSizeLimitBytes ? `${(summary.heapSizeLimitBytes / 1024 / 1024).toFixed(0)} MiB` : "unknown"}`,
    "",
    "| 指标 | min | p50 | p95 | max |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const [label, key] of rows) {
    const metric = summary.metrics[key];
    if (!metric) continue;
    const isBytes = /rss/i.test(key);
    const scale = isBytes ? 1024 * 1024 : 1;
    const format = (value) =>
      value === null ? "-" : isBytes ? (value / scale).toFixed(1) : String(Math.round(value));
    lines.push(`| ${label} | ${format(metric.min)} | ${format(metric.p50)} | ${format(metric.p95)} | ${format(metric.max)} |`);
  }
  lines.push("");
  lines.push("说明：本地假 provider 立即返回，因此首段文本时间主要反映内核/进程启动开销；");
  lines.push("这不是真实模型的首字延迟。真实 provider 的首字必须另测，见报告未验证项。");
  return `${lines.join("\n")}\n`;
}

async function runAttachMode() {
  const pid = Number(option("pid", "0"));
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("attach 需要 --pid <Electron 主进程 PID>");
  }
  const seconds = Number(option("seconds", "30"));
  const intervalMs = Number(option("interval", "1000"));
  const outDir = resolve(
    option("out", join(repoRoot, ".artifacts", "kernel-baseline", `attach-${stamp()}`)),
  );
  ensureDir(outDir);
  const jsonlPath = join(outDir, "tree.jsonl");
  if (process.platform !== "win32") {
    throw new Error("attach 目前只实现 win32（PowerShell CIM 采样）");
  }
  const child = spawn(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      treeSamplerScript,
      "-RootPid",
      String(pid),
      "-IntervalMs",
      String(intervalMs),
      "-DurationMs",
      String(seconds * 1000),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let buffer = "";
  const samples = [];
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const sample = JSON.parse(line);
        samples.push(sample);
        appendFileSync(jsonlPath, `${line}\n`);
      } catch {
        // 忽略 PowerShell 的非 JSON 输出。
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolvePromise) => child.on("close", resolvePromise));
  const rows = samples.flatMap((sample) =>
    (sample.processes ?? []).map((row) => ({
      ...row,
      ts: sample.ts,
      role: classifyProcess(row.name, row.commandLine),
    })),
  );
  const roles = [...new Set(rows.map((row) => row.role))].sort();
  const summary = {
    kind: "attach",
    generatedAt: new Date().toISOString(),
    rootPid: pid,
    seconds,
    intervalMs,
    sampleCount: samples.length,
    roles: Object.fromEntries(
      roles.map((role) => {
        const roleRows = rows.filter((row) => row.role === role);
        const peakWorkingSet = Math.max(
          0,
          ...roleRows.map((row) => row.workingSetBytes ?? 0).filter(Number.isFinite),
        );
        const peakPrivate = Math.max(
          0,
          ...roleRows.map((row) => row.privateBytes ?? 0).filter(Number.isFinite),
        );
        const uniquePids = [...new Set(roleRows.map((row) => row.pid))];
        return [
          role,
          {
            uniqueProcessCount: uniquePids.length,
            peakWorkingSetBytes: peakWorkingSet,
            peakPrivateBytes: peakPrivate,
            lastWorkingSetBytes:
              roleRows.at(-1)?.workingSetBytes ?? null,
          },
        ];
      }),
    ),
    stderrTail: stderr.trim().split(/\r?\n/).slice(-5).join("\n"),
  };
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${join(outDir, "summary.json")}\n`);
}

function classifyProcess(name, commandLine) {
  const text = `${name ?? ""} ${commandLine ?? ""}`.toLowerCase();
  if (text.includes("--type=renderer")) return "renderer";
  if (text.includes("--type=gpu-process")) return "gpu";
  if (text.includes("--type=utility")) return "host-utility";
  if (text.includes("app-server")) return "agent";
  if (text.includes("node_repl") || text.includes("node-repl")) return "mcp-node-repl";
  if (text.includes("browser-use") || text.includes("computer-use")) return "mcp-cua";
  if (text.includes("electron")) return "electron-main";
  if (text.includes("node")) return "node-other";
  return "other";
}

function runInventoryMode() {
  const outDir = resolve(
    option("out", join(repoRoot, ".artifacts", "kernel-baseline", `inventory-${stamp()}`)),
  );
  ensureDir(outDir);
  const inventory = {
    generatedAt: new Date().toISOString(),
    gitHead: readGitHead(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    homedir: homedir(),
    totalMemoryBytes: null,
    runtimeParameters: {
      agentMaxOldSpaceSize: "unset（Agent 子进程未注入 --max-old-space-size）",
      agentHeapLimitObservation: "由 memory-sampler 的 v8.heap_size_limit 实测",
      mainAgentIdleReclaim: "unset（主 Agent 进程管理器未传 idleTimeoutMs）",
      mcpStatusLaneIdleTimeoutMs: 300000,
      dwfChildMaxOldSpaceSizeMb: 256,
      v4ToolOutputFinalHeadBytes: 32768,
      v4ToolOutputFinalTailBytes: 32768,
      workspaceHookMaxOutputBytes: 32768,
    },
    sourceAnchors: {
      agentSpawnEnv: "packages/services/src/node.ts:2206",
      agentProcessManager: "packages/services/src/zcode-agent/zcodeAgentProcessManager.ts:601",
      mcpStatusLane: "packages/services/src/zcode-agent/zcodeAgentService.ts:380,1089",
      dwfChildHeap: "apps/zcode-cli/packages/dynamic-workflow-runtime/src/harness.ts:122",
      v4ToolOutputBudget: "packages/shared/src/nibi-protocol-v4/core.ts:77-78",
      workspaceHookBudget: "packages/shared/src/workspace-hook-config.ts:8",
    },
  };
  writeFileSync(join(outDir, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  process.stdout.write(`${join(outDir, "inventory.json")}\n`);
}

try {
  if (command === "agent") await runAgentMode();
  else if (command === "attach") await runAttachMode();
  else if (command === "inventory") runInventoryMode();
  else {
    process.stderr.write(
      [
        "用法：",
        "  node scripts/kernel-baseline/collect-kernel-baseline.mjs agent [--runs 5] [--out <dir>]",
        "  node scripts/kernel-baseline/collect-kernel-baseline.mjs attach --pid <pid> [--seconds 30]",
        "  node scripts/kernel-baseline/collect-kernel-baseline.mjs inventory",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
}
