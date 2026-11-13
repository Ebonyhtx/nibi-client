// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const addScopedMcpServer = vi.fn(async () => {});
  const updateScopedMcpServer = vi.fn(async () => {});
  const deleteScopedMcpServer = vi.fn();
  const ensureLoadedForWorkspace = vi.fn(async () => true);
  const requestConfirmation = vi.fn(async () => true);
  const listWorkspaceMcpServerStatuses = vi.fn(async () => ({ statuses: {} }));
  const initializePlugins = vi.fn(async () => {});
  const servers = [
    {
      id: "server-filesystem",
      name: "filesystem",
      source: "nibiagentmcp" as const,
      scope: "workspace" as const,
      projectPath: "/workspace",
      enabled: true,
      config: { type: "stdio", command: "node", args: ["server.mjs"] },
    },
    {
      id: "server-memory",
      name: "memory",
      source: "nibiagentmcp" as const,
      scope: "workspace" as const,
      projectPath: "/workspace",
      enabled: true,
      config: { type: "stdio", command: "node", args: ["memory.mjs"] },
    },
  ];
  const mcpState = {
    servers,
    statusSnapshots: {},
    workspaceTrust: {},
    workspaceTrustKnown: false,
    workspaceTrustReasonCode: undefined as string | undefined,
    workspaceTrustUnreviewable: [],
    currentProjectPath: "/workspace",
    currentWorkspaceIdentity: undefined as string | undefined,
    currentAuthorityKey: undefined as string | undefined,
    isConfigLoaded: true,
    ensureLoadedForWorkspace,
    toggleServer: vi.fn(async () => {}),
    addScopedMcpServer,
    updateScopedMcpServer,
    deleteScopedMcpServer,
    updateServerStatus: vi.fn(),
    decideWorkspaceTrust: vi.fn(),
    beginServerStatusListRefresh: vi.fn(() => 1),
    markServerStatusListRefreshFailed: vi.fn(),
    mergeServerStatusSnapshots: vi.fn(),
    getEnabledMcpServersForNibi: () => [],
  };
  const pluginState = {
    plugins: [],
    availablePlugins: [],
    installedPlugins: [],
    workspacePath: "/workspace",
    workspaceIdentity: undefined as string | undefined,
    authorityKey: undefined as string | undefined,
    configScope: "workspace",
    initialize: initializePlugins,
  };
  // 分区的 effect 以服务对象身份作为依赖；mock 必须复用同一引用，
  // 否则每次 render 都触发 ensure/初始化 effect，把 ready key 反复清空。
  const workspaceServices = {
    mcpSyncService: {
      listWorkspaceMcpServerStatuses,
    },
    pluginManagementService: {},
    settingsSyncService: {},
  };
  return {
    addScopedMcpServer,
    deleteScopedMcpServer,
    ensureLoadedForWorkspace,
    initializePlugins,
    listWorkspaceMcpServerStatuses,
    mcpState,
    pluginState,
    requestConfirmation,
    updateScopedMcpServer,
    workspaceServices,
  };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
    locale: "en-US",
  }),
}));

vi.mock("@/store/mcpStore.js", () => ({
  useMcpStore: Object.assign(
    (selector: (state: typeof h.mcpState) => unknown) => selector(h.mcpState),
    { getState: () => h.mcpState },
  ),
}));

vi.mock("@/store/pluginManagementStore.js", () => ({
  usePluginManagementStore: Object.assign(
    (selector: (state: typeof h.pluginState) => unknown) => selector(h.pluginState),
    { getState: () => h.pluginState },
  ),
}));

vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => h.requestConfirmation,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ openExternal: vi.fn() }),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ mcpSyncService: null }),
}));

vi.mock("@/workspace-config-catalog/index.js", () => ({
  useConfigWorkspaceServices: () => h.workspaceServices,
}));

vi.mock("@/settings/PluginScopeMenu.js", () => ({
  PluginScopeMenu: () => null,
  getPluginWorkspaceKey: (target: { workspacePath?: string }) =>
    `workspace:${target.workspacePath ?? ""}`,
}));

vi.mock("@/settings/ExternalAgentImportDialog.js", () => ({
  McpServersImportDialog: () => null,
}));

vi.mock("@/settings/DataSyncEntry.js", () => ({
  DataSyncEntryButton: () => null,
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

import { TooltipProvider } from "@/components/ui/tooltip.js";
import { SettingsBreadcrumbProvider } from "@/settings/SettingsHeaderBreadcrumb.js";
import { McpSettingsSection } from "@/settings/McpSettingsSection.js";

interface CollectedBreadcrumbItem {
  label: string;
  onSelect?: () => void;
}

function renderSection() {
  let breadcrumbItems: CollectedBreadcrumbItem[] = [];
  const result = render(
    createElement(
      TooltipProvider,
      null,
      createElement(
        SettingsBreadcrumbProvider,
        {
          sectionLabel: "Plugins",
          onItemsChange: (items: readonly CollectedBreadcrumbItem[]) => {
            breadcrumbItems = [...items];
          },
        },
        createElement(McpSettingsSection, {
          workspacePath: "/workspace",
          scopeFilter: "workspace",
          parentScopeKey: "workspace:/workspace",
          workspaceTabs: [],
          searchQuery: "",
        }),
      ),
    ),
  );
  return {
    ...result,
    getBreadcrumbItems: () => breadcrumbItems,
  };
}

async function waitForListReady() {
  await waitFor(() => {
    expect(screen.queryByText("common.loading")).toBeNull();
  });
  await waitFor(() => {
    expect(screen.getByTestId("mcp-server-row-filesystem")).toBeTruthy();
  });
}

function fillCreateDraft(name = "draft-server", command = "node") {
  fireEvent.change(screen.getByPlaceholderText("my-mcp-server"), {
    target: { value: name },
  });
  fireEvent.change(screen.getByPlaceholderText("npx"), {
    target: { value: command },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requestConfirmation.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

describe("McpSettingsSection 草稿守卫", () => {
  it("新建草稿不落盘，取消确认后丢弃草稿且不产生记录", async () => {
    const section = renderSection();
    await waitForListReady();

    fireEvent.click(screen.getByRole("button", { name: "settings.create.action" }));
    fillCreateDraft();

    // 输入阶段：既没有写 store，也没有触发保存。
    expect(h.addScopedMcpServer).not.toHaveBeenCalled();
    expect(h.updateScopedMcpServer).not.toHaveBeenCalled();
    expect(screen.getByTestId("mcp-draft-unsaved-indicator")).toBeTruthy();

    fireEvent.click(screen.getByText("common.cancel"));

    await waitFor(() => expect(h.requestConfirmation).toHaveBeenCalledTimes(1));
    expect(h.requestConfirmation.mock.calls[0]?.[0]).toMatchObject({
      title: "settings.mcp.draft.discardTitle",
      description: "settings.mcp.draft.discardDescription",
      confirmLabel: "settings.mcp.draft.discardConfirm",
      cancelLabel: "settings.mcp.draft.keepEditing",
      confirmVariant: "destructive",
    });

    await waitFor(() => {
      expect(screen.queryByPlaceholderText("my-mcp-server")).toBeNull();
    });
    expect(h.addScopedMcpServer).not.toHaveBeenCalled();
    // 丢弃后回到列表，脏标记不会残留。
    expect(screen.queryByTestId("mcp-draft-unsaved-indicator")).toBeNull();
    expect(section.getBreadcrumbItems()).toHaveLength(0);
  });

  it("草稿输入不会触发 MCP 状态刷新或重载", async () => {
    renderSection();
    await waitForListReady();
    // 列表就绪后可能还有一次自动状态请求；等它落地再取基线。
    await new Promise((resolve) => setTimeout(resolve, 50));
    const statusCallsBefore = h.listWorkspaceMcpServerStatuses.mock.calls.length;
    const ensureCallsBefore = h.ensureLoadedForWorkspace.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "settings.create.action" }));
    fillCreateDraft("no-reload", "node");
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(h.listWorkspaceMcpServerStatuses.mock.calls.length).toBe(statusCallsBefore);
    expect(h.ensureLoadedForWorkspace.mock.calls.length).toBe(ensureCallsBefore);
  });

  it("选择继续编辑时保留草稿与表单", async () => {
    h.requestConfirmation.mockResolvedValue(false);
    renderSection();
    await waitForListReady();

    fireEvent.click(screen.getByRole("button", { name: "settings.create.action" }));
    fillCreateDraft("keep-me", "node");

    fireEvent.click(screen.getByText("common.cancel"));
    await waitFor(() => expect(h.requestConfirmation).toHaveBeenCalledTimes(1));

    expect((screen.getByPlaceholderText("my-mcp-server") as HTMLInputElement).value).toBe(
      "keep-me",
    );
    expect(screen.getByTestId("mcp-draft-unsaved-indicator")).toBeTruthy();
    expect(h.addScopedMcpServer).not.toHaveBeenCalled();
  });

  it("保存草稿才写配置，成功后关闭表单", async () => {
    renderSection();
    await waitForListReady();

    fireEvent.click(screen.getByRole("button", { name: "settings.create.action" }));
    fillCreateDraft("saved-server", "node");

    fireEvent.click(screen.getByTestId("mcp-server-form-save"));

    await waitFor(() => expect(h.addScopedMcpServer).toHaveBeenCalledTimes(1));
    expect(h.addScopedMcpServer).toHaveBeenCalledWith(
      "nibiagentmcp",
      "saved-server",
      expect.objectContaining({ type: "stdio", command: "node" }),
      "/workspace",
    );
    // 保存路径不弹丢弃确认。
    expect(h.requestConfirmation).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("my-mcp-server")).toBeNull();
    });
  });

  it("无效草稿禁用保存且不会写配置", async () => {
    renderSection();
    await waitForListReady();

    fireEvent.click(screen.getByRole("button", { name: "settings.create.action" }));
    fireEvent.change(screen.getByPlaceholderText("my-mcp-server"), {
      target: { value: "invalid-name-only" },
    });
    fireEvent.change(screen.getByPlaceholderText("30000"), {
      target: { value: "0" },
    });

    const save = screen.getByTestId("mcp-server-form-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByTestId("mcp-server-form-command-error").textContent).toContain(
      "settings.mcp.form.validation.commandRequired",
    );
    expect(screen.getByTestId("mcp-server-form-timeout-error").textContent).toContain(
      "settings.mcp.form.validation.timeoutInvalid",
    );

    fireEvent.click(save);
    expect(h.addScopedMcpServer).not.toHaveBeenCalled();
  });

  it("编辑已有 server：取消可回滚，保存才提交更新", async () => {
    renderSection();
    await waitForListReady();

    fireEvent.click(screen.getByTestId("mcp-server-row-filesystem"));
    await waitFor(() => {
      expect(screen.getByPlaceholderText("npx")).toBeTruthy();
    });

    fireEvent.change(screen.getByPlaceholderText("npx"), {
      target: { value: "node-v2" },
    });
    expect(h.updateScopedMcpServer).not.toHaveBeenCalled();
    expect(screen.getByTestId("mcp-draft-unsaved-indicator")).toBeTruthy();

    fireEvent.click(screen.getByText("common.cancel"));
    await waitFor(() => expect(h.requestConfirmation).toHaveBeenCalledTimes(1));
    // 丢弃草稿后回到列表，原 server 配置没有被改写。
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("npx")).toBeNull();
    });
    expect(h.updateScopedMcpServer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("mcp-server-row-filesystem"));
    await waitFor(() => expect(screen.getByPlaceholderText("npx")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("npx"), {
      target: { value: "node-v3" },
    });
    fireEvent.click(screen.getByTestId("mcp-server-form-save"));

    await waitFor(() => expect(h.updateScopedMcpServer).toHaveBeenCalledTimes(1));
    expect(h.updateScopedMcpServer).toHaveBeenCalledWith(
      "nibiagentmcp",
      "filesystem",
      expect.objectContaining({ command: "node-v3" }),
      "/workspace",
    );
  });

  it("离开分区时有未保存修改会提示，并可在确认后切换到另一个 server", async () => {
    const section = renderSection();
    await waitForListReady();

    fireEvent.click(screen.getByTestId("mcp-server-row-filesystem"));
    await waitFor(() => expect(screen.getByPlaceholderText("npx")).toBeTruthy());
    fireEvent.change(screen.getByPlaceholderText("npx"), {
      target: { value: "dirty-edit" },
    });

    // 面包屑「Plugins」= 离开 MCP 分区；有草稿必须先确认。
    const pluginBreadcrumb = section.getBreadcrumbItems().find((item) => item.label === "Plugins");
    expect(pluginBreadcrumb?.onSelect).toBeTypeOf("function");

    await act(async () => {
      pluginBreadcrumb?.onSelect?.();
    });
    await waitFor(() => expect(h.requestConfirmation).toHaveBeenCalledTimes(1));
    // 默认确认丢弃后回到列表，才能继续选中另一个 server。
    await waitFor(() => {
      expect(screen.queryByPlaceholderText("npx")).toBeNull();
    });

    fireEvent.click(screen.getByTestId("mcp-server-row-memory"));
    await waitFor(() => expect(screen.getByPlaceholderText("npx")).toBeTruthy());
    const commandInput = screen.getByPlaceholderText("npx") as HTMLInputElement;
    expect(commandInput.value).toBe("node");
    expect(screen.queryByTestId("mcp-draft-unsaved-indicator")).toBeNull();
  });
});
