#!/usr/bin/env node
/**
 * 假的模型服务：给宿主侧的无头实验提供一个**零成本、确定性**的 provider。
 *
 * 为什么需要它：凡是"跑一遍 `zcode -p ...` 看它会怎样"的验证，真调模型既花钱又有随机性
 * （而且一旦 provider 配置解析错了，花的还是用户的额度 —— 这个坑真的踩过）。
 * 有了它，请求打到本地，应答是我写死的，于是可以拿"回复里有没有这个标记"当作
 * **可判定的证据**：哪个配置生效、命令正文有没有被展开、走没走到模型……
 *
 * 用法：
 *   node scripts/fake-provider.mjs --reply "FAKE-ONE" --log <文件>
 *   输出一行 `PORT=<端口>` 后持续服务，直到被 kill。
 *
 * 兼容三种常见协议（按路径判别），未知路径按 OpenAI 处理：
 *   /v1/chat/completions   OpenAI Chat Completions（含 stream=true 的 SSE）
 *   /v1/messages           Anthropic Messages
 *   /v1/responses          OpenAI Responses
 * 请求体与路径都写进 --log，供"模型到底收到了什么"取证。
 */

import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}

const reply = option("reply", "FAKE-REPLY");
const logPath = option("log", "");
const port = Number(option("port", "0"));

function record(entry) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* 取证失败不该影响应答 */
  }
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => resolve(raw));
  });
}

function openAiPayload(text) {
  return {
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: { content: text, role: "assistant" },
      },
    ],
    created: Math.floor(Date.now() / 1000),
    id: "chatcmpl-fake",
    model: "fake-model",
    object: "chat.completion",
    usage: { completion_tokens: 4, prompt_tokens: 4, total_tokens: 8 },
  };
}

function streamOpenAi(response, text, includeUsage) {
  const chunks = [
    { choices: [{ delta: { content: text, role: "assistant" }, index: 0 }], id: "chatcmpl-fake", object: "chat.completion.chunk" },
    { choices: [{ delta: {}, finish_reason: "stop", index: 0 }], id: "chatcmpl-fake", object: "chat.completion.chunk" },
  ];
  if (includeUsage) {
    chunks.push({
      choices: [],
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      usage: { completion_tokens: 4, prompt_tokens: 4, total_tokens: 8 },
    });
  }
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

function anthropicPayload(text) {
  return {
    content: [{ text, type: "text" }],
    id: "msg_fake",
    model: "fake-model",
    role: "assistant",
    stop_reason: "end_turn",
    type: "message",
    usage: { input_tokens: 4, output_tokens: 4 },
  };
}

const server = createServer(async (request, response) => {
  const body = await readBody(request);
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const path = request.url ?? "/";
  // 取出"模型实际看到的第一条 user 文本"，让取证能直接回答"命令正文有没有被展开"。
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const firstUser = messages.find((message) => message?.role === "user");
  const userText =
    typeof firstUser?.content === "string"
      ? firstUser.content
      : Array.isArray(firstUser?.content)
        ? firstUser.content.map((part) => part?.text ?? "").join("")
        : "";
  record({
    at: new Date().toISOString(),
    bodyKeys: parsed && typeof parsed === "object" ? Object.keys(parsed) : [],
    path,
    stream: parsed?.stream === true,
    userTextChars: userText.length,
    userTextHead: userText.slice(0, 4000),
  });

  if (parsed?.stream === true && path.includes("messages")) {
    // Anthropic 的 SSE：message_start → content_block_delta → message_stop
    response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "text/event-stream; charset=utf-8" });
    const events = [
      { message: anthropicPayload(""), type: "message_start" },
      { content_block: { text: reply, type: "text" }, index: 0, type: "content_block_start" },
      { delta: { text: reply, type: "text_delta" }, index: 0, type: "content_block_delta" },
      { index: 0, type: "content_block_stop" },
      { delta: { stop_reason: "end_turn" }, type: "message_delta" },
      { type: "message_stop" },
    ];
    for (const event of events) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
    return;
  }
  if (parsed?.stream === true) {
    streamOpenAi(response, reply, path.includes("responses"));
    return;
  }
  const payload = path.includes("messages") ? anthropicPayload(reply) : openAiPayload(reply);
  response.writeHead(200, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});
