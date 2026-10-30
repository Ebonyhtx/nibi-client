/**
 * 最小的 stdio MCP 服务器（JSON-RPC 2.0，一行一条消息）：给双内核驱动当"会话级 MCP"的被测端。
 *
 * 只实现握手、`tools/list`、`tools/call` 与 `ping`；工具 `echo` 原样回显 `text` 参数。
 * 协议版本回显客户端给的（Node 与 Rust 的握手版本不同），并带 `serverInfo`。
 */
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const tools = [
  {
    name: "echo",
    description: "Echo the given text",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
];

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  // 通知没有 id，不回。
  if (message.id === undefined || message.id === null) return;
  const { id, method, params } = message;
  const reply = (result) => send({ jsonrpc: "2.0", id, result });
  const fail = (code, text) => send({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize":
      reply({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      });
      return;
    case "ping":
      reply({});
      return;
    case "tools/list":
      reply({ tools });
      return;
    case "tools/call": {
      const name = params?.name;
      if (name !== "echo") {
        fail(-32602, `unknown tool: ${name}`);
        return;
      }
      const text = params?.arguments?.text ?? "";
      reply({
        content: [{ type: "text", text: `echo:${text}` }],
        isError: false,
      });
      return;
    }
    default:
      fail(-32601, `method not found: ${method}`);
  }
});
