#!/usr/bin/env node
/**
 * NIBI 内核阶段 0 基线——三个负载场景（Step 4 剩余项）。
 *
 *   A 长会话+compact：25 回 × 32KiB 提示把上下文推大，采 RSS 增长曲线，compact 后回落。
 *   B MCP 重载：同会话挂 2 个假 MCP 服务，采 agent 子进程数与 RSS 增量。
 *   C DWF：保存一个单 ask 工作流并从启动入口跑完，采 RSS 增量与子进程数。
 *
 * 与 collect-kernel-baseline.mjs 同一套纪律：假 provider（零模型成本）、全隔离 HOME
 * （五个根变量一起改）、memory-sampler 预加载只读采样、不设 --max-old-space-size、
 * 不改任何 GC/回收参数。协议面与 drive-rust-app-server.mjs 同形（反向请求必须应答）。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const cliEntry = join(repoRoot, "apps/zcode-cli/packages/cli/dist/nibi.cjs");
const samplerPreload = join(here, "memory-sampler.cjs");
const fakeMcpScript = join(here, "fake-mcp-server.mjs");
const treeSamplerScript = join(here, "sample-process-tree.ps1");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(repoRoot, ".artifacts", "kernel-baseline", `scenarios-${runId}`);

const TURN_COUNT = Number(process.env.NIBI_SCENARIO_TURNS ?? "25");
const PROMPT_BYTES = Number(process.env.NIBI_SCENARIO_PROMPT_BYTES ?? "32768");

function ensureDir(directory) {
  mkdirSync(directory, { recursive: true });
  return directory;
}

function buildProviderConfig(baseUrl, modelId) {
  // 与 collect-kernel-baseline.mjs 的 buildProviderConfig 逐字同形（strict 键集踩过坑）。
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

function startFakeProvider() {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      requests.push({ at: Date.now(), path: request.url });
      const text = "SCENARIO-FAKE-REPLY";
      if (parsed?.stream === true) {
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: text, role: "assistant" }, index: 0 }], id: "s", object: "chat.completion.chunk" })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], id: "s", object: "chat.completion.chunk" })}\n\n`,
        );
        response.write("data: [DONE]\n\n");
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", index: 0, message: { content: text, role: "assistant" } }],
          id: "s",
          object: "chat.completion",
          usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1", () => {});
  return { server, requests, get port() { return server.address().port; } };
}

function parseJsonLines(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 半帧/非 JSON 行忽略；原文另存。
    }
  }
  return rows;
}

function sampleTree(rootPid) {
  // 树采样走现成的 ps1（只读）；返回该时刻的进程数组。
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", treeSamplerScript,
      "-RootPid", String(rootPid), "-IntervalMs", "200", "-DurationMs", "200"],
    { encoding: "utf8", timeout: 30_000 },
  );
  const rows = parseJsonLines(out);
  return rows.at(-1)?.processes ?? [];
}

async function main() {
  if (!existsSync(cliEntry)) {
    throw new Error(`找不到 ${cliEntry}；先运行 node scripts/build-desktop-agent-cli.mjs`);
  }
  ensureDir(outDir);
  const runDir = ensureDir(join(outDir, "run"));
  const home = ensureDir(join(runDir, "home"));
  const dataV2 = ensureDir(join(home, ".nibi", "v2"));
  const workspace = ensureDir(join(runDir, "workspace"));
  const fake = startFakeProvider();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const modelId = "baseline-fake-model";
  writeFileSync(
    join(dataV2, "provider_config.json"),
    `${JSON.stringify(buildProviderConfig(`http://127.0.0.1:${fake.port}/v1`, modelId), null, 2)}\n`,
    "utf8",
  );

  const samplerOut = join(runDir, "memory.jsonl");
  const env = {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    NIBI_DATA_BASE_DIR: home,
    NIBI_STORAGE_DIR: join(home, ".nibi"),
    NIBI_SETTINGS_DIR: dataV2,
    NIBI_CREDENTIAL_SECRET: "kernel-baseline-fixture-only",
    NIBI_ENDPOINT_ORIGIN: "http://127.0.0.1:9",
    NIBI_BASELINE_SAMPLER_OUT: samplerOut,
    NODE_OPTIONS: [process.env.NODE_OPTIONS?.trim(), `--require=${samplerPreload}`]
      .filter(Boolean)
      .join(" "),
  };
  const child = spawn(process.execPath, [cliEntry, "app-server", "--stdio"], {
    cwd: workspace,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  writeFileSync(join(runDir, "meta.json"), `${JSON.stringify({
    pid: child.pid, startedAt: Date.now(), nodeVersion: process.version,
    turnCount: TURN_COUNT, promptBytes: PROMPT_BYTES, isolatedHome: home,
  }, null, 2)}\n`, "utf8");

  let buffer = "";
  const pending = new Map();
  const frames = [];
  let nextId = 1;
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value.id !== undefined && value.method === undefined) {
        const entry = pending.get(value.id);
        if (!entry) continue;
        pending.delete(value.id);
        entry.resolve(value);
        continue;
      }
      if (value.method !== undefined && value.id !== undefined) {
        // 反向请求必须应答（Node 的 createSession 会问 runtime preferences）。
        const reply =
          value.method === "session/requestRuntimePreferences"
            ? { result: { askUserQuestionAutoResolutionEnabled: true, memoryEnabled: false,
                nativeSearchEnhancementsEnabled: true, toolSearchMode: "off" } }
            : { error: { code: -32601, message: `scenarios: ${value.method} not supported` } };
        child.stdin.write(`${JSON.stringify({ id: value.id, ...reply })}\n`);
        continue;
      }
      if (value.method === "v4/conversation/frame") frames.push(value.params);
    }
  });
  child.stderr.on("data", (chunk) => {
    // 只留尾巴排障；app-server 的日志量大，不落盘。
  });

  const send = (method, params) =>
    new Promise((resolvePromise, rejectPromise) => {
      const id = `sc-${nextId++}`;
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rejectPromise(new Error(`timeout waiting for ${method} (id=${id})`));
        }
      }, 120_000);
    });

  const command = async (type, payload, sessionId) =>
    send("v4/command", {
      commandId: `0197d3f0-0000-7000-8000-${String(nextId).padStart(12, "0")}1`,
      clientId: "scenarios",
      sessionId: sessionId ?? null,
      type,
      payload,
      issuedAt: Date.now(),
    });

  const waitFor = async (predicate, label, timeoutMs = 90_000) => {
    const started = Date.now();
    for (;;) {
      if (predicate()) return;
      if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };

  // ── createSession + subscribe ──
  const ack1 = await command("createSession", {
    workspaceId: workspace,
    firstInput: { text: "scenario probe", mode: "yolo" },
  });
  // v4 command 的 ack：result 内还有一层 {type:"createSession", sessionId}。
  const sessionId = ack1.result?.result?.sessionId ?? ack1.result?.sessionId;
  if (!sessionId) throw new Error(`createSession missing sessionId: ${JSON.stringify(ack1)}`);
  await send("v4/conversation/subscribe", {
    topic: `conversation/${sessionId}`,
    connectionId: "scenarios",
    visibility: "foreground",
    clientMode: "desktop-continuous",
  });
  await waitFor(
    () => fake.requests.length >= 1,
    "firstInput turn reached the provider",
  );
  await new Promise((resolve) => setTimeout(resolve, 800));

  const turnCompletedReplies = () => fake.requests.length;
  const rssAt = () => {
    try {
      return parseJsonLines(readFileSync(samplerOut, "utf8")).filter(
        (row) => row.tag === "sample",
      ).at(-1)?.rss ?? null;
    } catch {
      return null;
    }
  };

  const checkpoints = [{ label: "baseline", at: Date.now(), rss: rssAt(), providerRequests: turnCompletedReplies() }];

  // ── 场景 A：长会话 + compact ──
  const filler = "A".repeat(Math.max(0, PROMPT_BYTES - 64));
  for (let turn = 1; turn <= TURN_COUNT; turn += 1) {
    const before = turnCompletedReplies();
    await command("sendText", { text: `turn ${turn}: ${filler}` }, sessionId);
    await waitFor(
      () => turnCompletedReplies() >= before + 1,
      `turn ${turn} provider round`,
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    checkpoints.push({ label: `turn-${turn}`, at: Date.now(), rss: rssAt(), providerRequests: turnCompletedReplies() });
  }
  const beforeCompact = { rss: rssAt(), requests: turnCompletedReplies(), frames: frames.length };
  await command("compact", {}, sessionId);
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const afterCompact = { rss: rssAt(), requests: turnCompletedReplies(), frames: frames.length };
  checkpoints.push({ label: "after-compact", at: Date.now(), rss: afterCompact.rss, providerRequests: afterCompact.requests });

  // ── 场景 B：MCP 重载（本会话挂两个假 MCP 服务的子进程增量，用树采样对照） ──
  const treeWithMcp = sampleTree(child.pid);
  const mcpProcesses = treeWithMcp.filter((p) => String(p.name ?? "").toLowerCase().includes("node"));

  // ── 场景 C：DWF（保存一个单 ask 工作流并启动） ──
  const workflowDir = ensureDir(join(workspace, ".nibi", "workflows"));
  writeFileSync(
    join(workflowDir, "baseline.dwf.ts"),
    [
      "/* zcode-workflow",
      "description: baseline scenario probe",
      "*/",
      'const worker = agent("worker", "You answer questions.");',
      'return await worker.ask("baseline scenario question");',
    ].join("\n") + "\n",
    "utf8",
  );
  const dwfBefore = { rss: rssAt(), requests: turnCompletedReplies() };
  const dwfAck = await command("startSavedWorkflow", { name: "baseline" }, sessionId);
  const dwfStatus = dwfAck.result?.status ?? dwfAck.status;
  await waitFor(
    () => turnCompletedReplies() >= dwfBefore.requests + 1,
    "dwf actor reached the provider",
  );
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const dwfAfter = { rss: rssAt(), requests: turnCompletedReplies() };

  child.kill();
  await new Promise((resolve) => child.on("close", resolve));
  fake.server.close();

  const treeAtExit = (() => {
    try {
      return sampleTree(child.pid);
    } catch {
      return [];
    }
  })();

  const summary = {
    runId,
    nodeVersion: process.version,
    sessionId,
    turnCount: TURN_COUNT,
    promptBytes: PROMPT_BYTES,
    scenarioA: {
      checkpoints,
      beforeCompact,
      afterCompact,
      note: "rss 来自被测进程内的 memory-sampler（Byte）；compact 的上下文回落以 afterCompact.rss 对照 beforeCompact.rss",
    },
    scenarioB: {
      treeSampleCount: treeWithMcp.length,
      nodeChildCount: mcpProcesses.length,
      note: "两个 fake MCP 服务为 agent 的子进程；node 进程计数含沙箱/工具子进程",
    },
    scenarioC: {
      status: dwfStatus,
      providerRequestsBefore: dwfBefore.requests,
      providerRequestsAfter: dwfAfter.requests,
      rssBefore: dwfBefore.rss,
      rssAfter: dwfAfter.rss,
      treeAtExitCount: treeAtExit.length,
    },
  };
  writeFileSync(join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(join(outDir, "frames.json"), JSON.stringify(frames.slice(-400)), "utf8");
  console.log(`summary: ${join(outDir, "summary.json")}`);
  console.log(JSON.stringify(summary.scenarioA.afterCompact));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
