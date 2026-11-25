#!/usr/bin/env node
// E2E fixture: dependency-free MCP stdio server backing the nibi.ui.view panel.
// Mirrors the deterministic server shape used by plugin-management-lifecycle.ts.

import readline from "node:readline";

const PANEL_URI = "ui://e2e-ui-view/panel.html";
const PANEL_HTML =
  '<!doctype html><html><body><div id="e2e-ui-view">ok</div><script>window.nibi.ready().then(() => { const el = document.getElementById("e2e-ui-view"); if (el) el.textContent = "E2E_UI_VIEW_READY"; });</script></body></html>';

const input = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

input.on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!request || typeof request !== "object") return;
  if (request.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "e2e-ui-view", version: "1.0.0" },
      },
    });
    return;
  }
  if (request.method === "tools/list") {
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    return;
  }
  if (request.method === "resources/list") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        resources: [
          { uri: PANEL_URI, name: "E2E UI View", mimeType: "text/html;profile=mcp-app" },
        ],
      },
    });
    return;
  }
  if (request.method === "resources/read") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        contents: [
          {
            uri: request.params && request.params.uri ? request.params.uri : PANEL_URI,
            mimeType: "text/html;profile=mcp-app",
            text: PANEL_HTML,
          },
        ],
      },
    });
    return;
  }
  if (request.id !== undefined) send({ jsonrpc: "2.0", id: request.id, result: {} });
});
