import { describe, expect, it } from "vitest";
import type { FormState } from "../src/settings/mcpSettingsShared.js";
import { McpJsonDraftError, jsonDraftToForm } from "../src/settings/mcpSettingsShared.js";
import {
  isMcpFormDraftDirty,
  resolveMcpDraftErrorId,
  validateMcpFormDraft,
} from "../src/settings/mcpDraftState.js";

function draft(overrides: Partial<FormState> = {}): FormState {
  return {
    name: "filesystem",
    scope: "zcodeagentmcp",
    storageLevel: "user",
    type: "stdio",
    command: "npx",
    args: "-y server-memory",
    env: "",
    url: "",
    headers: "",
    timeoutMs: "",
    protocolVersion: "",
    ...overrides,
  };
}

describe("MCP 草稿校验", () => {
  it("通过的草稿没有错误", () => {
    expect(validateMcpFormDraft(draft())).toEqual({ valid: true, errors: {} });
    expect(
      validateMcpFormDraft(
        draft({
          type: "http",
          command: "",
          url: "https://mcp.example.com/mcp",
          headers: '{"Authorization": "Bearer token"}',
          timeoutMs: "30000",
        }),
      ),
    ).toEqual({ valid: true, errors: {} });
  });

  it("名称与 stdio 启动命令是必填项", () => {
    const empty = validateMcpFormDraft(draft({ name: "  ", command: "\n" }));

    expect(empty.valid).toBe(false);
    expect(empty.errors.name).toBe("settings.mcp.form.validation.nameRequired");
    expect(empty.errors.command).toBe("settings.mcp.form.validation.commandRequired");
  });

  it("HTTP/SSE 草稿要求合法 URL", () => {
    const missing = validateMcpFormDraft(draft({ type: "http", command: "", url: " " }));
    expect(missing.errors.url).toBe("settings.mcp.form.validation.urlRequired");

    const badScheme = validateMcpFormDraft(
      draft({ type: "sse", command: "", url: "ftp://example.com/mcp" }),
    );
    expect(badScheme.errors.url).toBe("settings.mcp.form.validation.urlInvalid");

    const notUrl = validateMcpFormDraft(draft({ type: "http", command: "", url: "not a url" }));
    expect(notUrl.errors.url).toBe("settings.mcp.form.validation.urlInvalid");

    expect(
      validateMcpFormDraft(draft({ type: "http", command: "", url: "http://127.0.0.1:3000/mcp" }))
        .valid,
    ).toBe(true);
  });

  it("超时时间只接受正整数毫秒", () => {
    for (const timeoutMs of ["0", "-5", "1.5", "abc"]) {
      expect(validateMcpFormDraft(draft({ timeoutMs })).errors.timeoutMs).toBe(
        "settings.mcp.form.validation.timeoutInvalid",
      );
    }
    expect(validateMcpFormDraft(draft({ timeoutMs: "800" })).valid).toBe(true);
  });

  it("env/headers 必须是字符串值对象", () => {
    expect(validateMcpFormDraft(draft({ env: "{oops" })).errors.env).toBe(
      "settings.mcp.form.validation.jsonInvalid",
    );
    expect(validateMcpFormDraft(draft({ env: '["A"]' })).errors.env).toBe(
      "settings.mcp.form.validation.jsonObjectRequired",
    );
    expect(validateMcpFormDraft(draft({ env: '{"A": 1}' })).errors.env).toBe(
      "settings.mcp.form.validation.jsonStringValues",
    );
    expect(validateMcpFormDraft(draft({ env: '{"A": "1"}' })).valid).toBe(true);

    expect(
      validateMcpFormDraft(
        draft({
          type: "http",
          command: "",
          url: "https://example.com/mcp",
          headers: "{oops",
        }),
      ).errors.headers,
    ).toBe("settings.mcp.form.validation.jsonInvalid");
  });

  it("只校验当前传输类型会写盘的字段", () => {
    // stdio 遗留的 headers、http 遗留的 env 都不会进入 config，不能阻止保存。
    expect(validateMcpFormDraft(draft({ headers: "{oops" })).valid).toBe(true);
    expect(
      validateMcpFormDraft(
        draft({
          type: "http",
          command: "",
          url: "https://example.com/mcp",
          env: "{oops",
        }),
      ).valid,
    ).toBe(true);
  });

  it("oauth 必须是 JSON 对象", () => {
    const invalid = validateMcpFormDraft(
      draft({
        type: "http",
        command: "",
        url: "https://example.com/mcp",
        oauth: "{oops",
      }),
    );
    expect(invalid.errors.oauth).toBe("settings.mcp.form.validation.jsonInvalid");
  });
});

describe("MCP 草稿脏检查", () => {
  it("与 baseline 完全一致时不算修改", () => {
    expect(isMcpFormDraftDirty(draft(), draft())).toBe(false);
  });

  const dirtyCases: Array<[string, Partial<FormState>]> = [
    ["名称", { name: "renamed" }],
    ["类型", { type: "http", url: "https://example.com" }],
    ["存储级别", { storageLevel: "workspace" }],
    ["命令", { command: "node" }],
    ["参数", { args: "--flag" }],
    ["env", { env: '{"A":"1"}' }],
    ["超时", { timeoutMs: "800" }],
    ["协议版本", { protocolVersion: "legacy" }],
  ];

  it.each(dirtyCases)("%s 变化会被标记为未保存", (_label, patch) => {
    expect(isMcpFormDraftDirty(draft(patch), draft())).toBe(true);
  });

  it("oauth 从空值变成有值算修改", () => {
    expect(isMcpFormDraftDirty(draft({ oauth: '{"type":"authorization_code"}' }), draft())).toBe(
      true,
    );
  });
});

describe("JSON 草稿错误归一", () => {
  it("JSON 语法错误归为解析失败", () => {
    let error: unknown;
    try {
      jsonDraftToForm("{", draft());
    } catch (caught) {
      error = caught;
    }
    expect(resolveMcpDraftErrorId(error)).toBe("settings.mcp.form.jsonParseError");
  });

  it("多 server / 非对象 / 缺名称使用各自的 i18n messageId", () => {
    const singleServer = (() => {
      try {
        jsonDraftToForm(
          JSON.stringify({
            mcpServers: {
              a: { type: "http", url: "https://a.example" },
              b: { type: "http", url: "https://b.example" },
            },
          }),
          draft(),
        );
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(singleServer).toBeInstanceOf(McpJsonDraftError);
    expect(resolveMcpDraftErrorId(singleServer)).toBe("settings.mcp.form.jsonError.singleServer");

    const invalidConfig = (() => {
      try {
        jsonDraftToForm(JSON.stringify(["x"]), draft());
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(resolveMcpDraftErrorId(invalidConfig)).toBe("settings.mcp.form.jsonError.invalidConfig");

    const missingName = (() => {
      try {
        jsonDraftToForm(JSON.stringify({ type: "http", url: "https://example.com" }), {
          ...draft(),
          name: "",
        });
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(resolveMcpDraftErrorId(missingName)).toBe("settings.mcp.form.jsonError.missingName");
  });
});
