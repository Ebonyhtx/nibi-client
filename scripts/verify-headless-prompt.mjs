#!/usr/bin/env node
/**
 * 无头提示模式的取证实验（零模型成本）。
 *
 * 回答两个只有实跑才能回答的问题：
 *   ① 数据根与"继承来的 Provider Config 路径"冲突时，到底谁生效？（隔离是否真的成立）
 *   ② `-p "/自定义命令 …"` 的命令正文有没有被展开？（展开后正文会随请求发给模型）
 *
 * 做法：起两个本地假 provider（回复里带各自的标记），把两份 provider 配置分别指过去
 * ——一份放在隔离数据根里，一份模拟桌面端注入的派生路径——然后跑一次 `-p`，
 * 看**哪个假 provider 收到了请求**、以及**模型收到的第一条 user 消息是什么**。
 * 结论全部来自假 provider 的请求日志，不靠推断。
 *
 * 用法：
 *   node scripts/verify-headless-prompt.mjs --command "/probe-cmd hello" [--keep]
 *   node scripts/verify-headless-prompt.mjs --plugin   # 另外用一个真实插件命令试一遍
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const cliEntry = join(repoRoot, "apps/zcode-cli/packages/cli/dist/nibi.cjs");

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined && !args[index + 1].startsWith("--")
    ? args[index + 1]
    : fallback;
}
const command = option("command", "/probe-cmd hello-from-experiment");
const keep = args.includes("--keep");
const usePlugin = args.includes("--plugin");

// Git Bash（MSYS2）会把**任何**以单个 `/` 开头的命令行参数改写成 Windows 路径：
//   node x.mjs --command "/mathmodel 你好"  →  实际收到 "C:/Program Files/Git/mathmodel 你好"
// 后果是把 `/命令名` 当普通文字发下去、命令正文永不展开 —— 曾据此误判成"宿主不展开自定义命令"。
// 这不是宿主的问题，是本机脚本的传参问题。这里显式拦住，并要求用 MSYS2_ARG_CONV_EXCL='*' 跑。
if (/^[A-Za-z]:[\\/]/.test(command)) {
  console.error(
    [
      `参数被 Git Bash 改写成了 Windows 路径：${command}`,
      "请在命令前加 MSYS2_ARG_CONV_EXCL='*' 重跑，例如：",
      `  MSYS2_ARG_CONV_EXCL='*' node scripts/verify-headless-prompt.mjs --command "/mathmodel 你好"`,
    ].join("\n"),
  );
  process.exit(2);
}

const MARKER = "PROBE-BODY-MARKER-8f3c";
const PROBE_COMMAND = "probe-cmd";

function startFakeProvider(reply) {
  return new Promise((resolvePromise) => {
    const log = [];
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
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        // 一条请求里的 user 消息可能不止一条（system-reminder 是独立的 history entry）：
        // 只看第一条会漏掉真正的用户输入，前面就这么误判过一次。
        const userTexts = messages
          .filter((message) => message?.role === "user")
          .map((message) =>
            typeof message?.content === "string"
              ? message.content
              : Array.isArray(message?.content)
                ? message.content.map((part) => part?.text ?? "").join("")
                : "",
          );
        const userText = userTexts.join("\n<<<USER-MESSAGE-BREAK>>>\n");
        log.push({ path: request.url, stream: parsed?.stream === true, userText, userTexts });
        const text = reply;
        if (parsed?.stream === true) {
          response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: text, role: "assistant" }, index: 0 }], id: "x", object: "chat.completion.chunk" })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }], id: "x", object: "chat.completion.chunk" })}\n\n`,
          );
          response.write("data: [DONE]\n\n");
          response.end();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", index: 0, message: { content: text, role: "assistant" } }],
            id: "x",
            object: "chat.completion",
            usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({ log, port: server.address().port, server });
    });
  });
}

/** 用用户真实配置的结构（它一定是合法的），只把 endpoint 与密钥换成本地假服务。 */
function writePatchedProviderConfig(sourcePath, targetPath, baseUrl) {
  const config = JSON.parse(readFileSync(sourcePath, "utf8"));
  const rules = config?.config?.providerConfigRules?.providerRules ?? [];
  for (const rule of rules) {
    if (rule?.config?.api) {
      rule.config.api.baseUrl = baseUrl;
      rule.config.api.type = rule.config.api.type ?? "openai";
    }
    if (rule?.config?.access?.type === "api-key") {
      rule.config.access.apiKey = "fake-key";
    }
  }
  const manualRules = config?.config?.modelConfigRules?.manualProviderModelRules ?? [];
  for (const rule of manualRules) {
    if (rule?.config?.baseUrl) rule.config.baseUrl = baseUrl;
    if (rule?.config?.apiKey) rule.config.apiKey = "fake-key";
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return {
    defaultModelSelection: config?.config?.defaultModelSelection ?? null,
    providerIds: rules.map((rule) => rule?.providerId).filter(Boolean),
  };
}

function runCli(env, cwd) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [cliEntry, "-p", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stderr, stdout });
    });
  });
}

const workRoot = mkdtempSync(join(tmpdir(), "nibi-headless-probe-"));
const dataRoot = join(workRoot, "iso-root");
const workspace = join(workRoot, "workspace");
mkdirSync(join(workspace, ".nibi", "commands"), { recursive: true });
writeFileSync(
  join(workspace, ".nibi", "commands", `${PROBE_COMMAND}.md`),
  [
    "---",
    `description: 取证用自定义命令（${MARKER}）`,
    "---",
    "",
    `命令正文开始 ${MARKER}`,
    "",
    "你收到了这条命令，说明自定义命令的正文已经被展开并送进了模型请求。",
    `参数是：$ARGUMENTS`,
    `命令正文结束 ${MARKER}`,
    "",
  ].join("\n"),
  "utf8",
);

const realProviderConfig =
  process.env.NIBI_PERSONAL_PROVIDER_CONFIG_FILE?.trim() ||
  join(homedir(), ".nibi", "v2", "provider_config.json");

const fakeIsolated = await startFakeProvider("FAKE-ISOLATED-ROOT");
const fakeInjected = await startFakeProvider("FAKE-INJECTED-DESKTOP");

const isolatedConfig = join(dataRoot, ".nibi", "v2", "provider_config.json");
const injectedConfig = join(workRoot, "injected-provider_config.json");
const isolatedShape = writePatchedProviderConfig(
  realProviderConfig,
  isolatedConfig,
  `http://127.0.0.1:${fakeIsolated.port}/v1`,
);
writePatchedProviderConfig(
  realProviderConfig,
  injectedConfig,
  `http://127.0.0.1:${fakeInjected.port}/v1`,
);

// --plugin：把桌面 dev 实例里已安装的插件目录整体拷进隔离数据根，
// 用真实的**插件命令**（/mathmodel）再验一次展开 —— 原始结论就是针对它的。
if (usePlugin) {
  const installedRoot = join(repoRoot, "..", ".nibi-desktop-dev", "cli", "plugins");
  const targetRoot = join(dataRoot, "cli", "plugins");
  if (!existsSync(installedRoot)) {
    console.error(`找不到已安装的插件目录：${installedRoot}`);
    process.exit(2);
  }
  cpSync(installedRoot, targetRoot, { recursive: true });
  // 只拷 cache 是不够的：插件是否**启用**写在用户配置 `<存储根>/cli/config.json` 里
  // （市场安装的插件默认不启用）。不拷这一份，命令探测会报 "Unknown command" ——
  // 那是测试环境不完整，不是宿主的 bug（这次就先误判了一次）。
  const userConfig = join(repoRoot, "..", ".nibi-desktop-dev", "cli", "config.json");
  if (existsSync(userConfig)) {
    mkdirSync(join(dataRoot, "cli"), { recursive: true });
    cpSync(userConfig, join(dataRoot, "cli", "config.json"));
  }
  console.log(`已把插件目录与用户配置拷入隔离数据根：${targetRoot}`);
}

const env = {
  ...process.env,
  NIBI_DATA_BASE_DIR: dataRoot,
  NIBI_STORAGE_DIR: dataRoot,
  // 模拟"从桌面端派生的终端"：这两个派生路径被注入且指向别处（桌面端那份配置）。
  NIBI_PERSONAL_PROVIDER_CONFIG_FILE: injectedConfig,
};
if (process.env.NIBI_BUILTIN_PROVIDER_CONFIG_FILE?.trim()) {
  env.NIBI_BUILTIN_PROVIDER_CONFIG_FILE = process.env.NIBI_BUILTIN_PROVIDER_CONFIG_FILE.trim();
}

console.log(`工作根目录：${workRoot}`);
console.log(`隔离数据根：${dataRoot}`);
console.log(`命令：${command}`);
console.log(`默认模型选择：${JSON.stringify(isolatedShape.defaultModelSelection)}`);
console.log(`provider：${JSON.stringify(isolatedShape.providerIds)}`);

const result = await runCli(env, workspace);

console.log(`\n退出码：${result.code}`);
const stderrTail = result.stderr.trim().split("\n").filter(Boolean);
console.log(`stderr（末 12 行）：\n${stderrTail.slice(-12).join("\n")}`);
if (result.stdout.trim()) {
  console.log(`stdout：\n${result.stdout.trim().slice(0, 1200)}`);
}

const isolatedHit = fakeIsolated.log.length;
const injectedHit = fakeInjected.log.length;
console.log(`\n假 provider 命中：隔离数据根=${isolatedHit} 次，被注入的派生路径=${injectedHit} 次`);

const winner =
  isolatedHit > 0 && injectedHit === 0
    ? "隔离数据根（数据根优先，隔离成立）"
    : injectedHit > 0 && isolatedHit === 0
      ? "被注入的派生路径（数据根被无视，隔离失效）"
      : isolatedHit === 0 && injectedHit === 0
        ? "都没命中（请求没走到模型）"
        : "两边都命中了（异常，需人工看日志）";
console.log(`Provider 解析结果：${winner}`);

const probeLog = isolatedHit > 0 ? fakeIsolated.log : fakeInjected.log;
// 逐条列出来：一条请求里的 user 消息可能不止一条，"第一条"未必是用户输入。
const longestRequest =
  probeLog
    .map((entry) => entry.userTexts ?? [])
    .sort((a, b) => b.join("").length - a.join("").length)[0] ?? [];
const firstText = longestRequest.join("\n");
console.log(`\n模型收到的 user 消息（本次请求共 ${longestRequest.length} 条）：`);
for (const [index, text] of longestRequest.entries()) {
  console.log(`--- user 消息 #${index + 1}（${text.length} 字符）---`);
  console.log(text.length > 1200 ? `${text.slice(0, 600)}\n…（省略）…\n${text.slice(-600)}` : text);
}
const expanded = firstText.includes(MARKER);
const commandCenterStyle = firstText.includes("Run custom command");
console.log(
  `\n自定义命令展开：${expanded ? "已展开（正文进了请求）" : commandCenterStyle ? "走的是 command-center 展开（正文未按 facade 展开）" : "**未展开**（原样把 /命令 当普通文字发下去了）"}`,
);

for (const fake of [fakeIsolated, fakeInjected]) fake.server.close();
if (!keep) rmSync(workRoot, { recursive: true, force: true });
else console.log(`\n（--keep：保留 ${workRoot}）`);
