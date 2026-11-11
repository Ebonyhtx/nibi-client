// @vitest-environment jsdom
// 根 Vitest 只收集 .test.ts；本文件使用 createElement，不需要 TSX 扩展名。

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeMcpServer } from "@nibi/shared";
import {
  TID_V4_WORKSPACE_MCP_TRUST_PENDING_BANNER,
  TID_V4_WORKSPACE_MCP_TRUST_PENDING_DISMISS,
  TID_V4_WORKSPACE_MCP_TRUST_PENDING_REVIEW,
} from "@nibi/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { useMcpStore } from "@/store/mcpStore.js";
import {
  resolveWorkspaceMcpTrustPending,
  WorkspaceMcpTrustPendingBanner,
  workspaceMcpTrustPendingDismissStore,
} from "@/settings/workspaceMcpTrust/index.js";

const settingsIntentMock = vi.hoisted(() => ({
  setPendingSettingsSectionIntent: vi.fn(),
}));

vi.mock("@/lib/settingsNavigation.js", () => ({
  setPendingSettingsSectionIntent: settingsIntentMock.setPendingSettingsSectionIntent,
}));

const openSettingsTabMock = vi.hoisted(() => vi.fn());

vi.mock("@/store/TabStoreProvider.js", () => ({
  useOptionalTabStore: (selector: (state: { openSettingsTab: () => void }) => unknown) =>
    selector({ openSettingsTab: openSettingsTabMock }),
}));

const digest = "a".repeat(64);

function review(trusted: boolean, declarationDigest = digest) {
  return {
    declarationDigest,
    configuredEnabled: true,
    transport: "stdio" as const,
    sourcePaths: ["/workspace/.nibi/config.json"],
    display: "{}",
    trusted,
  };
}

function projectServer(overrides: Partial<ZCodeMcpServer> = {}): ZCodeMcpServer {
  return {
    id: "zcodeagentmcp-workspace-probe",
    name: "probe",
    config: { type: "stdio", command: "node" },
    enabled: true,
    source: "zcodeagentmcp",
    scope: "workspace",
    projectPath: "/workspace",
    ...overrides,
  };
}

function setStoreState(input: {
  servers?: ZCodeMcpServer[];
  trust?: Record<string, { trusted: boolean; declarationDigest: string }>;
  trustKnown?: boolean;
  enabledStates?: Record<string, boolean>;
}) {
  useMcpStore.setState({
    currentProjectPath: "/workspace",
    currentWorkspaceIdentity: undefined,
    currentDirectoryService: null,
    workspaceTrustKnown: input.trustKnown ?? true,
    workspaceTrust: input.trust ?? {},
    workspaceTrustUnreviewable: [],
    workspaceTrustReasonCode: undefined,
    enabledStates: input.enabledStates ?? {},
    servers: input.servers ?? [projectServer()],
  });
}

function renderBanner() {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(WorkspaceMcpTrustPendingBanner, { workspacePath: "/workspace" }),
    ),
  );
}

function renderInteractive() {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(WorkspaceMcpTrustPendingBanner, { workspacePath: "/workspace" }),
    ),
  );
}

describe("workspace MCP trust pending banner（A5 会话内提示）", () => {
  beforeEach(() => {
    workspaceMcpTrustPendingDismissStore.clear();
    settingsIntentMock.setPendingSettingsSectionIntent.mockClear();
    openSettingsTabMock.mockClear();
  });

  afterEach(() => cleanup());

  it("只统计当前工作区已启用且未信任的项目 MCP；用户级/停用/已信任不计数", () => {
    const info = resolveWorkspaceMcpTrustPending({
      workspacePath: "/workspace",
      currentProjectPath: "/workspace",
      trustKnown: true,
      trust: {
        probe: review(false),
        trustedOne: review(true),
      },
      unreviewable: [],
      enabledStates: { "zcodeagentmcp-workspace-probe": false },
      servers: [
        projectServer({ id: "zcodeagentmcp-workspace-probe", enabled: false }),
        projectServer({ id: "zcodeagentmcp-workspace-disabled", name: "disabled", enabled: false }),
        projectServer({ id: "zcodeagentmcp-workspace-trusted", name: "trustedOne" }),
        projectServer({
          id: "zcodeagentmcp-workspace-user",
          name: "userProbe",
          scope: "user",
          projectPath: undefined,
        }),
        projectServer({
          id: "zcodeagentmcp-workspace-other",
          name: "otherWorkspace",
          projectPath: "/other",
        }),
      ],
    });
    // probe 由 enabledStates 显式停用；trustedOne 已信任；其余不是当前工作区的项目 server。
    expect(info).toBeNull();

    const pending = resolveWorkspaceMcpTrustPending({
      workspacePath: "/workspace",
      currentProjectPath: "/workspace",
      trustKnown: true,
      trust: { probe: review(false) },
      unreviewable: [],
      enabledStates: {},
      servers: [projectServer()],
    });
    expect(pending).toEqual({ count: 1, signature: `probe:${digest}` });
  });

  it("旧 Host 没有 trust 元数据时不误报", () => {
    const info = resolveWorkspaceMcpTrustPending({
      workspacePath: "/workspace",
      currentProjectPath: "/workspace",
      trustKnown: false,
      trust: {},
      unreviewable: [],
      enabledStates: {},
      servers: [projectServer()],
    });
    expect(info).toBeNull();
  });

  it("待信任时渲染提示条，[去审核] 打开 MCP 设置分区", () => {
    setStoreState({ trust: { probe: { declarationDigest: digest, trusted: false } } });
    renderInteractive();

    expect(screen.getByTestId(TID_V4_WORKSPACE_MCP_TRUST_PENDING_BANNER)).toBeTruthy();
    expect(screen.getByText(/1 个项目 MCP 服务器待审核/)).toBeTruthy();

    fireEvent.click(screen.getByTestId(TID_V4_WORKSPACE_MCP_TRUST_PENDING_REVIEW));
    expect(settingsIntentMock.setPendingSettingsSectionIntent).toHaveBeenCalledWith("mcp");
    expect(openSettingsTabMock).toHaveBeenCalledTimes(1);
  });

  it("已信任时不渲染", () => {
    setStoreState({ trust: { probe: { declarationDigest: digest, trusted: true } } });
    const html = renderBanner();
    expect(html).not.toContain(TID_V4_WORKSPACE_MCP_TRUST_PENDING_BANNER);
  });

  it("点击忽略后立即隐藏；声明摘要变化后重新出现", () => {
    setStoreState({ trust: { probe: { declarationDigest: digest, trusted: false } } });
    const view = renderInteractive();
    fireEvent.click(screen.getByTestId(TID_V4_WORKSPACE_MCP_TRUST_PENDING_DISMISS));
    expect(screen.queryByTestId(TID_V4_WORKSPACE_MCP_TRUST_PENDING_BANNER)).toBeNull();

    const nextDigest = "b".repeat(64);
    setStoreState({ trust: { probe: { declarationDigest: nextDigest, trusted: false } } });
    view.rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(WorkspaceMcpTrustPendingBanner, { workspacePath: "/workspace" }),
      ),
    );
    expect(screen.getByTestId(TID_V4_WORKSPACE_MCP_TRUST_PENDING_BANNER)).toBeTruthy();
  });
});
