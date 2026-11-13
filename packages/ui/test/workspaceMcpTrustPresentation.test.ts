import { describe, expect, it } from "vitest";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  resolveWorkspaceMcpTrustPresentation,
  shortenDeclarationDigest,
  WORKSPACE_MCP_TRUST_UNKNOWN_MESSAGE_ID,
  WORKSPACE_MCP_TRUST_UNREVIEWABLE_MESSAGE_ID,
  workspaceMcpTrustReasonMessageId,
} from "../src/settings/workspaceMcpTrust/presentation.js";
import type { WorkspaceMcpTrustReviewView } from "../src/store/mcpStoreDesktop.js";

const digest = "6781e00d56fceeb639263a7ee238dcfe1c8f6b922616d91337acf85b78304d14";
const projectServer = { name: "probe", scope: "workspace", source: "nibiagentmcp" };

function review(overrides: Partial<WorkspaceMcpTrustReviewView> = {}): WorkspaceMcpTrustReviewView {
  return {
    declarationDigest: digest,
    configuredEnabled: true,
    transport: "stdio",
    sourcePaths: ["/workspace/.nibi/config.json"],
    display: '{\n  "command": "node"\n}',
    trusted: false,
    ...overrides,
  };
}

describe("workspace MCP trust presentation", () => {
  it("截断 Host digest 生成短指纹，不重算摘要", () => {
    expect(shortenDeclarationDigest(digest)).toBe("6781e00d56fc");
    expect(shortenDeclarationDigest("abc")).toBe("abc");
    expect(shortenDeclarationDigest("  ")).toBe("");
  });

  it("未信任的项目 MCP 展示待信任、短指纹、来源和脱敏摘要", () => {
    expect(
      resolveWorkspaceMcpTrustPresentation({
        server: projectServer,
        trustKnown: true,
        review: review(),
        unreviewable: [],
      }),
    ).toEqual({
      state: "pending",
      badgeMessageId: "settings.mcp.workspaceTrust.badge.pending",
      hintMessageId: "settings.mcp.workspaceTrust.effectiveAfterTrust",
      canTrust: true,
      canRevoke: false,
      fingerprint: "6781e00d56fc",
      declarationDigest: digest,
      sourcePaths: ["/workspace/.nibi/config.json"],
      display: '{\n  "command": "node"\n}',
    });
  });

  it("已信任的项目 MCP 展示已信任并可撤销", () => {
    const presentation = resolveWorkspaceMcpTrustPresentation({
      server: projectServer,
      trustKnown: true,
      review: review({ trusted: true }),
      unreviewable: [],
    });
    expect(presentation).toMatchObject({
      state: "trusted",
      badgeMessageId: "settings.mcp.workspaceTrust.badge.trusted",
      hintMessageId: "settings.mcp.workspaceTrust.trustedHint",
      canTrust: false,
      canRevoke: true,
    });
  });

  it("Host 判定声明已变化时提示重新信任", () => {
    const presentation = resolveWorkspaceMcpTrustPresentation({
      server: projectServer,
      trustKnown: true,
      review: review({ declarationChanged: true }),
      unreviewable: [],
    });
    expect(presentation).toMatchObject({
      state: "changed",
      badgeMessageId: "settings.mcp.workspaceTrust.badge.changed",
      hintMessageId: "settings.mcp.workspaceTrust.changedHint",
      reasonMessageId: "settings.mcp.workspaceTrust.reason.declarationChanged",
      reasonCode: "workspace_mcp_declaration_changed",
      canTrust: true,
      canRevoke: false,
    });
  });

  it("不可审核/离线/未登记只读展示原因且不提供动作", () => {
    expect(
      resolveWorkspaceMcpTrustPresentation({
        server: projectServer,
        trustKnown: true,
        unreviewable: ["probe"],
      }),
    ).toMatchObject({
      state: "unavailable",
      reasonMessageId: WORKSPACE_MCP_TRUST_UNREVIEWABLE_MESSAGE_ID,
      canTrust: false,
      canRevoke: false,
      fingerprint: "",
    });

    for (const reasonCode of [
      "workspace_mcp_workspace_offline",
      "workspace_mcp_workspace_not_registered",
      "workspace_mcp_trust_unavailable",
    ] as const) {
      const presentation = resolveWorkspaceMcpTrustPresentation({
        server: projectServer,
        trustKnown: true,
        reasonCode,
        unreviewable: [],
      });
      expect(presentation).toMatchObject({
        state: "unavailable",
        reasonMessageId: workspaceMcpTrustReasonMessageId(reasonCode),
        reasonCode,
        canTrust: false,
        canRevoke: false,
      });
      expect(presentation?.badgeMessageId).toBe("settings.mcp.workspaceTrust.badge.unavailable");
    }

    expect(
      resolveWorkspaceMcpTrustPresentation({
        server: projectServer,
        trustKnown: true,
        unreviewable: [],
      }),
    ).toMatchObject({
      state: "unavailable",
      reasonMessageId: WORKSPACE_MCP_TRUST_UNKNOWN_MESSAGE_ID,
      canTrust: false,
      canRevoke: false,
    });
  });

  it("用户级 MCP 或旧 Host 不显示信任控件", () => {
    expect(
      resolveWorkspaceMcpTrustPresentation({
        server: { ...projectServer, scope: "user" },
        trustKnown: true,
        review: review(),
        unreviewable: [],
      }),
    ).toBeNull();
    expect(
      resolveWorkspaceMcpTrustPresentation({
        server: projectServer,
        trustKnown: false,
        review: review(),
        unreviewable: [],
      }),
    ).toBeNull();
  });

  it("中英文 workspaceTrust 文案键齐全且非空", () => {
    const zhKeys = Object.keys(zhCN).filter((key) =>
      key.startsWith("settings.mcp.workspaceTrust."),
    );
    const enKeys = Object.keys(enUS).filter((key) =>
      key.startsWith("settings.mcp.workspaceTrust."),
    );
    expect(zhKeys.length).toBeGreaterThan(0);
    expect(enKeys.sort()).toEqual(zhKeys.sort());
    for (const key of zhKeys) {
      expect(zhCN[key]?.trim()).not.toBe("");
      expect(enUS[key]?.trim()).not.toBe("");
    }
    expect(zhKeys).toEqual(
      expect.arrayContaining([
        "settings.mcp.workspaceTrust.badge.pending",
        "settings.mcp.workspaceTrust.badge.trusted",
        "settings.mcp.workspaceTrust.badge.changed",
        "settings.mcp.workspaceTrust.trust",
        "settings.mcp.workspaceTrust.revoke",
        "settings.mcp.workspaceTrust.reason.offline",
        "settings.mcp.workspaceTrust.reason.notRegistered",
        "settings.mcp.workspaceTrust.reason.unreviewable",
      ]),
    );
  });
});
