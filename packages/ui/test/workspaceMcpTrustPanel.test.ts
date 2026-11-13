// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NibiIntlProvider } from "../src/i18n/IntlProvider.js";
import { WorkspaceMcpTrustPanel } from "../src/settings/workspaceMcpTrust/panel.js";
import {
  resolveWorkspaceMcpTrustPresentation,
  type WorkspaceMcpTrustPresentation,
} from "../src/settings/workspaceMcpTrust/presentation.js";

const digest = "6781e00d56fceeb639263a7ee238dcfe1c8f6b922616d91337acf85b78304d14";

function presentation(
  overrides: {
    trusted?: boolean;
    declarationChanged?: boolean;
    reasonCode?:
      | "workspace_mcp_declaration_changed"
      | "workspace_mcp_trust_unavailable"
      | "workspace_mcp_workspace_not_registered"
      | "workspace_mcp_workspace_offline";
    unreviewable?: string[];
  } = {},
): WorkspaceMcpTrustPresentation {
  const result = resolveWorkspaceMcpTrustPresentation({
    server: { name: "probe", scope: "workspace", source: "zcodeagentmcp" },
    trustKnown: true,
    ...(overrides.reasonCode || overrides.unreviewable?.length
      ? {}
      : {
          review: {
            declarationDigest: digest,
            configuredEnabled: true,
            transport: "stdio" as const,
            sourcePaths: ["/workspace/.nibi/config.json"],
            display: '{\n  "command": "node"\n}',
            trusted: overrides.trusted ?? false,
            declarationChanged: overrides.declarationChanged,
          },
        }),
    ...(overrides.reasonCode ? { reasonCode: overrides.reasonCode } : {}),
    unreviewable: overrides.unreviewable ?? [],
  });
  if (!result) throw new Error("expected project MCP trust presentation");
  return result;
}

function renderPanel(
  trustPresentation: WorkspaceMcpTrustPresentation,
  options: { locale?: "zh-CN" | "en-US"; busy?: boolean; canDecide?: boolean } = {},
) {
  const onDecide = vi.fn();
  render(
    createElement(
      NibiIntlProvider,
      { initialLocale: options.locale ?? "zh-CN" },
      createElement(WorkspaceMcpTrustPanel, {
        serverName: "probe",
        presentation: trustPresentation,
        busy: options.busy ?? false,
        canDecide: options.canDecide ?? true,
        onDecide,
      }),
    ),
  );
  return onDecide;
}

afterEach(() => {
  cleanup();
});

describe("WorkspaceMcpTrustPanel", () => {
  it("未信任时显示待信任、短指纹、来源和信任按钮", () => {
    const onDecide = renderPanel(presentation());

    expect(screen.getByTestId("mcp-workspace-trust").dataset.workspaceMcpTrustState).toBe(
      "pending",
    );
    expect(screen.getByText("待信任")).toBeTruthy();
    expect(screen.getByText("6781e00d56fc")).toBeTruthy();
    expect(screen.getByText("/workspace/.nibi/config.json")).toBeTruthy();
    expect(screen.getByLabelText("声明摘要").textContent).toContain('"command": "node"');
    expect(screen.getByText("信任后生效")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "信任 MCP 配置 probe" }));
    expect(onDecide).toHaveBeenCalledWith(true);
  });

  it("已信任时显示已信任并提供撤销信任", () => {
    const onDecide = renderPanel(presentation({ trusted: true }));

    expect(screen.getByText("已信任")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "信任 MCP 配置 probe" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "撤销 MCP 配置 probe 的信任" }));
    expect(onDecide).toHaveBeenCalledWith(false);
  });

  it("Host 判定声明变化时提示重新信任", () => {
    renderPanel(presentation({ declarationChanged: true }));
    expect(screen.getByText("配置已变化")).toBeTruthy();
    expect(screen.getByText("配置已变化，需重新信任。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "信任 MCP 配置 probe" })).toBeTruthy();
  });

  it("离线/未登记只读展示 Host reasonCode，信任按钮禁用", () => {
    renderPanel(presentation({ reasonCode: "workspace_mcp_workspace_offline" }));
    expect(screen.getByText("不可审核")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "workspace_mcp_workspace_offline",
    );
    const button = screen.getByRole("button", { name: "信任 MCP 配置 probe" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("不可归一化的声明禁用审核动作并说明原因", () => {
    renderPanel(presentation({ unreviewable: ["probe"] }));
    expect(screen.getByText("不可审核")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("无法审核");
    const button = screen.getByRole("button", { name: "信任 MCP 配置 probe" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("请求进行中时按钮禁用并显示更新文案", () => {
    renderPanel(presentation(), { busy: true });
    const button = screen.getByRole("button", { name: "信任 MCP 配置 probe" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.textContent).toBe("正在更新信任…");
  });

  it("英文界面使用英文文案", () => {
    renderPanel(presentation(), { locale: "en-US" });
    expect(screen.getByText("Pending trust")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Trust MCP configuration probe" })).toBeTruthy();
    expect(screen.getByText("Takes effect after trust")).toBeTruthy();
  });
});
