import { describe, expect, it } from "vitest";
import {
  convertToNibiAgentMcpServer,
  isNibiCuaMcpCommand,
  isNibiCuaMcpPackageArg,
} from "../src/mcp.js";

describe("nibi-cua MCP matcher (single source of truth for services + CLI bootstrap)", () => {
  it("matches the nibi-cua command by leaf name", () => {
    expect(isNibiCuaMcpCommand("nibi-cua")).toBe(true);
    expect(isNibiCuaMcpCommand("/opt/homebrew/bin/nibi-cua")).toBe(true);
    expect(isNibiCuaMcpCommand("uvx")).toBe(false);
    expect(isNibiCuaMcpCommand("nibi-cua-server")).toBe(false);
  });

  it("matches uvx/pip package spec forms", () => {
    for (const arg of ["nibi-cua", "nibi-cua[macos]", "nibi-cua@v0.1.3", "nibi-cua[macos]@v0.1.3"]) {
      expect(isNibiCuaMcpPackageArg(arg)).toBe(true);
    }
  });

  it("matches git and local-path forms (the drift that broke desktop/services parity)", () => {
    expect(isNibiCuaMcpPackageArg("nibi-cua.git")).toBe(true);
    expect(isNibiCuaMcpPackageArg("git+https://github.com/x/nibi-cua.git@v0.1.3")).toBe(true);
    expect(isNibiCuaMcpPackageArg("/Users/me/src/nibi-cua")).toBe(true);
    expect(isNibiCuaMcpPackageArg("C:\\src\\nibi-cua")).toBe(true);
  });

  it("matches the npm workspace spec", () => {
    expect(isNibiCuaMcpPackageArg("@nibi/cua")).toBe(true);
    expect(isNibiCuaMcpCommand("@nibi/cua")).toBe(true);
  });

  it("does not match unrelated args", () => {
    for (const arg of ["--from", "run", "nibi-cua-server", "not-nibi-cua", "server.js"]) {
      expect(isNibiCuaMcpPackageArg(arg)).toBe(false);
    }
  });

  it("recognizes a package spec placed in COMMAND position (command/arg matchers stay consistent)", () => {
    // 之前 command matcher 只认精确叶子 nibi-cua，会漏判把包规格直接当 command 的配置 → 漏注入 broker。
    for (const command of ["nibi-cua@1.2.3", "nibi-cua[macos]", "nibi-cua.git", "/opt/tools/nibi-cua@1.2.3"]) {
      expect(isNibiCuaMcpCommand(command), command).toBe(true);
    }
  });

  it("recognizes pip == pins and the nibi_cua underscore distribution name (PyPI treats _ == -)", () => {
    for (const arg of ["nibi-cua==1.2.3", "nibi_cua", "nibi_cua==1.2.3", "nibi_cua@v0.1.3"]) {
      expect(isNibiCuaMcpPackageArg(arg), arg).toBe(true);
    }
    expect(isNibiCuaMcpCommand("nibi_cua")).toBe(true);
  });

  it("does not false-positive on sibling packages like nibi-cua-proxy", () => {
    for (const value of ["nibi-cua-proxy", "nibi-cua-proxy@1.0.0", "nibi-cua-helper"]) {
      expect(isNibiCuaMcpCommand(value), value).toBe(false);
      expect(isNibiCuaMcpPackageArg(value), value).toBe(false);
    }
  });

  it("still fails closed for the historical upstream package spec", () => {
    // 旧配置若仍指向历史上游包，同样必须注入 product broker，不能 fail-open。
    expect(isNibiCuaMcpCommand("zcode-cua")).toBe(true);
    expect(isNibiCuaMcpPackageArg("zcode-cua[macos]@v0.1.3")).toBe(true);
    expect(isNibiCuaMcpPackageArg("zcode_cua")).toBe(true);
  });

  it("recognizes `python -m nibi_cua.server` submodule form (M1 fail-open fix)", () => {
    // `python -m nibi_cua.server` → arg 是 `nibi_cua.server`；旧 matcher 漏判 → 不注入 broker → fail-open。
    for (const arg of ["nibi_cua.server", "nibi-cua.server", "nibi_cua.main", "nibi-cua.__main__"]) {
      expect(isNibiCuaMcpPackageArg(arg), arg).toBe(true);
    }
  });

  it("recognizes local paths with a trailing separator (M1 fail-open fix)", () => {
    // `.../nibi-cua/` 直接取叶子会得到空串 → 漏判 → fail-open。
    expect(isNibiCuaMcpPackageArg("/Users/me/src/nibi-cua/")).toBe(true);
    expect(isNibiCuaMcpPackageArg("C:\\src\\nibi-cua\\")).toBe(true);
    expect(isNibiCuaMcpCommand("/opt/homebrew/bin/nibi-cua/")).toBe(true);
    // 但带尾斜杠的 sibling 仍不误判。
    expect(isNibiCuaMcpPackageArg("/Users/me/src/nibi-cua-proxy/")).toBe(false);
  });
});

describe("MCP config helpers", () => {
  it("passes legacy http_headers through to Nibi Agent MCP servers", () => {
    expect(
      convertToNibiAgentMcpServer("web-search-prime", {
        type: "http",
        url: "https://bigmodel.example.test/mcp",
        timeoutMs: 5000,
        http_headers: {
          Authorization: "Bearer token",
        },
      }),
    ).toEqual({
      name: "web-search-prime",
      type: "http",
      url: "https://bigmodel.example.test/mcp",
      headers: [{ name: "Authorization", value: "Bearer token" }],
      timeoutMs: 5000,
    });
  });

  it("preserves timeoutMs when converting stdio MCP servers for Nibi Agent", () => {
    expect(
      convertToNibiAgentMcpServer("context7", {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        timeoutMs: 3,
      }),
    ).toEqual({
      name: "context7",
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: [],
      timeoutMs: 3,
    });
  });

  it("preserves timeoutMs when converting sse MCP servers for Nibi Agent", () => {
    expect(
      convertToNibiAgentMcpServer("stream", {
        type: "sse",
        url: "https://bigmodel.example.test/sse",
        timeoutMs: 8000,
      }),
    ).toEqual({
      name: "stream",
      type: "sse",
      url: "https://bigmodel.example.test/sse",
      headers: [],
      timeoutMs: 8000,
    });
  });

  it("preserves HTTP OAuth client credentials when converting MCP servers for Nibi Agent", () => {
    expect(
      convertToNibiAgentMcpServer("protected", {
        type: "http",
        url: "https://mcp.example.test/mcp",
        oauth: {
          type: "client_credentials",
          clientId: "nibi-client",
          clientSecret: "secret",
          scope: "mcp:tools",
        },
      }),
    ).toMatchObject({
      name: "protected",
      type: "http",
      oauth: {
        type: "client_credentials",
        clientId: "nibi-client",
        clientSecret: "secret",
        scope: "mcp:tools",
      },
    });
  });

  it("preserves HTTP OAuth authorization code config when converting MCP servers for Nibi Agent", () => {
    expect(
      convertToNibiAgentMcpServer("figma", {
        type: "http",
        url: "https://mcp.figma.com/mcp",
        oauth: {
          type: "authorization_code",
          clientName: "Nibi",
          redirectPath: "/oauth/callback/mcp/figma",
          scope: "mcp:connect",
        },
      }),
    ).toMatchObject({
      name: "figma",
      type: "http",
      oauth: {
        type: "authorization_code",
        clientName: "Nibi",
        redirectPath: "/oauth/callback/mcp/figma",
        scope: "mcp:connect",
      },
    });
  });

  it("does not persist implicit OAuth defaults when converting bare HTTP MCP servers", () => {
    expect(
      convertToNibiAgentMcpServer("notion", {
        type: "http",
        url: "https://mcp.notion.com/mcp",
        timeoutMs: 30000,
      }),
    ).toEqual({
      name: "notion",
      type: "http",
      url: "https://mcp.notion.com/mcp",
      headers: [],
      timeoutMs: 30000,
    });
  });

  it("drops invalid timeoutMs when converting MCP servers for Nibi Agent", () => {
    expect(
      convertToNibiAgentMcpServer("zero", {
        type: "stdio",
        command: "npx",
        timeoutMs: 0,
      }),
    ).not.toHaveProperty("timeoutMs");

    expect(
      convertToNibiAgentMcpServer("fractional", {
        type: "http",
        url: "https://bigmodel.example.test/mcp",
        timeoutMs: 1.5,
      }),
    ).not.toHaveProperty("timeoutMs");
  });

  it("keeps headers ahead of legacy http_headers when both are present", () => {
    expect(
      convertToNibiAgentMcpServer("web-reader", {
        type: "sse",
        url: "https://bigmodel.example.test/sse",
        headers: {
          Authorization: "Bearer fresh",
        },
        http_headers: {
          Authorization: "Bearer stale",
        },
      }),
    ).toMatchObject({
      headers: [{ name: "Authorization", value: "Bearer fresh" }],
    });
  });
});
