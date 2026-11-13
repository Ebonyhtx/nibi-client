// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NibiMcpServer } from "@nibi/shared";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "en-US",
  }),
}));

// Scope 菜单依赖设置页的设备上下文；本文件只验证草稿与校验，不覆盖 Scope 选择。
vi.mock("@/settings/PluginScopeMenu.js", () => ({
  PluginScopeMenu: () => null,
}));

import { McpServerForm } from "@/settings/McpServerForm.js";

function renderForm(overrides: Record<string, unknown> = {}) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const onDirtyChange = vi.fn();
  const result = render(
    createElement(McpServerForm, {
      editorMode: "form",
      onEditorModeChange: vi.fn(),
      onSave,
      onCancel,
      onDirtyChange,
      scopeKey: "user",
      workspaceTabs: [],
      onScopeKeyChange: vi.fn(),
      ...overrides,
    }),
  );
  return { ...result, onSave, onCancel, onDirtyChange };
}

function saveButton(): HTMLButtonElement {
  return screen.getByTestId("mcp-server-form-save") as HTMLButtonElement;
}

function fillCreateDraft(name = "draft-server", command = "node") {
  fireEvent.change(screen.getByPlaceholderText("my-mcp-server"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByPlaceholderText("npx"), {
    target: { value: command },
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("McpServerForm 草稿态", () => {
  it("新建草稿只改本地状态，保存前不提交", () => {
    const { onSave, onDirtyChange } = renderForm();

    expect(saveButton().disabled).toBe(true);
    fillCreateDraft();

    // 输入过程不调用 onSave，也不触碰任何 store：草稿只在内存里。
    expect(onSave).not.toHaveBeenCalled();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(saveButton());

    expect(onSave).toHaveBeenCalledTimes(1);
    const [form, prev] = onSave.mock.calls[0] as [
      { name: string; command: string; type: string },
      NibiMcpServer | undefined,
    ];
    expect(form).toMatchObject({ name: "draft-server", command: "node", type: "stdio" });
    expect(prev).toBeUndefined();
  });

  it("无效草稿禁用保存并显示 i18n 校验错误", () => {
    renderForm();

    fireEvent.change(screen.getByPlaceholderText("my-mcp-server"), {
      target: { value: "only-name" },
    });

    expect(saveButton().disabled).toBe(true);
    expect(screen.getByTestId("mcp-server-form-command-error").textContent).toContain(
      "settings.mcp.form.validation.commandRequired",
    );
    expect(screen.getByPlaceholderText("npx").getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(screen.getByPlaceholderText("npx"), {
      target: { value: "node" },
    });
    expect(saveButton().disabled).toBe(false);
  });

  it("env JSON 无效时禁用保存，错误提示在折叠区外也可见", () => {
    renderForm();
    fillCreateDraft();

    fireEvent.click(screen.getByText("settings.mcp.form.envOptional"));
    const textarea = document.querySelector("textarea");
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea as HTMLTextAreaElement, {
      target: { value: "{oops" },
    });

    expect(saveButton().disabled).toBe(true);
    expect(screen.getByTestId("mcp-server-form-optional-config-error").textContent).toContain(
      "settings.mcp.form.validation.jsonInvalid",
    );

    // 收起高级选项后错误仍然可见，用户能找到保存按钮变灰的原因。
    fireEvent.click(screen.getByText("settings.mcp.form.envOptional"));
    expect(screen.getByTestId("mcp-server-form-optional-config-error").textContent).toContain(
      "settings.mcp.form.validation.jsonInvalid",
    );
  });

  it("取消只回传取消事件，不保存草稿", () => {
    const { onSave, onCancel } = renderForm();
    fillCreateDraft();

    fireEvent.click(screen.getByText("common.cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("编辑草稿保存时把原 server 一并回传，取消可回滚", () => {
    const initial: NibiMcpServer = {
      id: "server-1",
      name: "filesystem",
      source: "zcodeagentmcp",
      scope: "user",
      enabled: true,
      config: { type: "stdio", command: "node", args: ["server.mjs"] },
    };
    const { onSave, onCancel } = renderForm({ initial, editingId: initial.id });

    expect((screen.getByPlaceholderText("my-mcp-server") as HTMLInputElement).disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("npx"), {
      target: { value: "node-v2" },
    });
    fireEvent.click(saveButton());

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "filesystem", command: "node-v2" }),
      initial,
    );

    // 取消路径不会再提交一次。
    fireEvent.click(screen.getByText("common.cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("JSON 模式草稿无效时禁用保存并显示解析错误", () => {
    const { onSave } = renderForm({ editorMode: "json" });
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "{oops" } });

    expect(saveButton().disabled).toBe(true);
    expect(screen.getByTestId("mcp-server-form-json-mode-error").textContent).toContain(
      "settings.mcp.form.jsonParseError",
    );
    expect(onSave).not.toHaveBeenCalled();
    expect(saveButton().disabled).toBe(true);
  });

  it("JSON 模式草稿合法时可以保存解析后的配置", () => {
    const { onSave } = renderForm({ editorMode: "json" });
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement;

    fireEvent.change(textarea, {
      target: {
        value: JSON.stringify({
          "json-server": { type: "stdio", command: "node", args: ["server.mjs"] },
        }),
      },
    });

    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "json-server", command: "node" }),
      undefined,
    );
  });
});
