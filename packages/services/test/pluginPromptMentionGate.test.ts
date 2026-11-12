import { describe, expect, it, vi } from "vitest";
import { nibiProtocolMethods } from "@nibi/shared";
import { V4_METHODS } from "@nibi/shared/nibi-protocol-v4";
import { modelSelectionViewFixture } from "./fixtures/modelSelectionViewFixture.js";
import {
  PLUGIN_PROMPT_MENTION_BLOCKED_CODE,
  PluginPromptMentionBlockedError,
  assertPluginPromptMentionsUsable,
  extractPluginMentionIds,
  resolvePluginPromptMentionGate,
} from "../src/plugins/pluginPromptMentionGate.js";

// 商店「立即试用」预填的是 canonical Plugin mention；插件未启用（含付费插件无会员）时
// 消息绝不能进入会话。UI 层负责体验，这里覆盖 host/service 发送入口的兜底门禁。
const WORKSPACE_PATH = "/workspace/app";
const ENABLED_ENTRY = {
  pluginId: "demo@market",
  name: "demo",
  marketplace: "market",
  enabled: true,
  conflictingPluginIds: [] as string[],
  skillQualifiedNames: [] as string[],
  mcpServerNames: [] as string[],
};
const DISABLED_ENTRY = { ...ENABLED_ENTRY, enabled: false };

function sendTextEnvelope(text: string) {
  return {
    commandId: "cmd-plugin-try",
    clientId: "client-plugin-try",
    sessionId: "session-plugin-try",
    type: "sendText" as const,
    payload: { text },
    issuedAt: 1700000000000,
  };
}

class MockProcessManagerBase {
  onRuntimeLifecycle() {
    return { dispose() {} };
  }
  onRuntimeRestarted() {
    return { dispose() {} };
  }
  markReady() {}
}

async function setup(catalog: readonly unknown[] | "unsupported") {
  const request = vi.fn(async (method: string, requestParams?: unknown) => {
    if (method === nibiProtocolMethods.pluginsReferenceCatalogWithCategory) {
      if (catalog === "unsupported") {
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      }
      return { authority: "workspace", plugins: catalog };
    }
    if (method === nibiProtocolMethods.pluginsReferenceCatalog) {
      if (catalog === "unsupported") {
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      }
      return { authority: "workspace", plugins: catalog };
    }
    if (method === V4_METHODS.command) {
      return {
        status: "accepted",
        commandId: (requestParams as { commandId: string }).commandId,
        revisionAtDecision: 0,
      };
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const getClient = vi.fn(async () => ({
    request,
    transportKind: "stdio" as const,
    onNotification: () => ({ dispose() {} }),
    onRequest: () => ({ dispose() {} }),
    onClose: () => ({ dispose() {} }),
  }));
  vi.resetModules();
  vi.doMock("../src/zcode-agent/zcodeAgentProcessManager.js", () => ({
    ZCodeAgentProcessManager: class extends MockProcessManagerBase {
      getClient = getClient;
      disposeAll() {}
    },
  }));
  const { createZCodeAgentService } = await import("../src/zcode-agent/zcodeAgentService.js");
  const service = createZCodeAgentService({
    modelSelectionReadinessSource: { getView: async () => modelSelectionViewFixture() },
  });
  return { service, request };
}

function commandCalls(request: ReturnType<typeof vi.fn>) {
  return request.mock.calls.filter(([method]) => method === V4_METHODS.command);
}

describe("plugin prompt mention gate (pure)", () => {
  it("只提取合法 stable id，去重且保持顺序", () => {
    expect(
      extractPluginMentionIds(
        "[@A](plugin://a@market) 正文 [@A again](plugin://a@market) [@B](plugin://b@other)",
      ),
    ).toEqual(["a@market", "b@other"]);
    expect(extractPluginMentionIds("普通文本，没有插件引用")).toEqual([]);
    expect(extractPluginMentionIds("[bad](plugin://not-a-stable-id)")).toEqual([]);
  });

  it("未启用与未安装都拒绝；enabled 同时覆盖付费插件无会员（发现层已合并判定）", () => {
    expect(
      resolvePluginPromptMentionGate({ pluginIds: ["demo@market"], entries: [DISABLED_ENTRY] }),
    ).toMatchObject({
      allowed: false,
      blockers: [{ pluginId: "demo@market", name: "demo", reason: "plugin_not_enabled" }],
    });
    expect(
      resolvePluginPromptMentionGate({ pluginIds: ["missing@market"], entries: [ENABLED_ENTRY] }),
    ).toMatchObject({
      allowed: false,
      blockers: [{ pluginId: "missing@market", reason: "plugin_not_installed" }],
    });
    expect(
      resolvePluginPromptMentionGate({ pluginIds: ["demo@market"], entries: [ENABLED_ENTRY] }),
    ).toEqual({ allowed: true });
  });

  it("拒绝错误写明插件与恢复路径，并带机器码", async () => {
    await expect(
      assertPluginPromptMentionsUsable({
        content: "[@Demo](plugin://demo@market) 试试",
        requestCatalog: async () => ({ plugins: [DISABLED_ENTRY] }),
      }),
    ).rejects.toMatchObject({
      code: PLUGIN_PROMPT_MENTION_BLOCKED_CODE,
      message: expect.stringContaining("未启用"),
    });
    const error = await assertPluginPromptMentionsUsable({
      content: "[@Demo](plugin://demo@market) 试试",
      requestCatalog: async () => ({ plugins: [DISABLED_ENTRY] }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginPromptMentionBlockedError);
    expect((error as PluginPromptMentionBlockedError).message).toContain("消息未发送");
  });

  it("无引用时零请求；catalog 读取失败时放行（观测面缺失不能阻断发送）", async () => {
    const requestCatalog = vi.fn(async () => ({ plugins: [] as [] }));
    await expect(
      assertPluginPromptMentionsUsable({ content: "普通文本", requestCatalog }),
    ).resolves.toBeUndefined();
    expect(requestCatalog).not.toHaveBeenCalled();

    const onCatalogError = vi.fn();
    await expect(
      assertPluginPromptMentionsUsable({
        content: "[@Demo](plugin://demo@market)",
        requestCatalog: async () => {
          throw new Error("runtime unavailable");
        },
        onCatalogError,
      }),
    ).resolves.toBeUndefined();
    expect(onCatalogError).toHaveBeenCalledTimes(1);
  });
});

describe("plugin prompt mention gate at the host send entry", () => {
  it("sendText 引用未启用插件时拒绝发送，命令不会下发到 Agent", async () => {
    const { service, request } = await setup([DISABLED_ENTRY]);
    try {
      await expect(
        service.sendConversationCommandV4({
          workspacePath: WORKSPACE_PATH,
          envelope: sendTextEnvelope("[@Demo](plugin://demo@market) 试用一下"),
        }),
      ).rejects.toMatchObject({
        code: PLUGIN_PROMPT_MENTION_BLOCKED_CODE,
        message: expect.stringContaining("未启用"),
      });
      expect(commandCalls(request)).toHaveLength(0);
    } finally {
      service.disposeAll();
    }
  });

  it("sendText 引用已启用插件时按原样下发", async () => {
    const { service, request } = await setup([ENABLED_ENTRY]);
    try {
      await expect(
        service.sendConversationCommandV4({
          workspacePath: WORKSPACE_PATH,
          envelope: sendTextEnvelope("[@Demo](plugin://demo@market) 试用一下"),
        }),
      ).resolves.toMatchObject({ status: "accepted" });
      expect(commandCalls(request)).toHaveLength(1);
      expect(commandCalls(request)[0]?.[1]).toMatchObject({
        payload: { text: "[@Demo](plugin://demo@market) 试用一下" },
      });
    } finally {
      service.disposeAll();
    }
  });

  it("旧 Agent 不支持引用 catalog 时不阻断发送", async () => {
    const { service, request } = await setup("unsupported");
    try {
      await expect(
        service.sendConversationCommandV4({
          workspacePath: WORKSPACE_PATH,
          envelope: sendTextEnvelope("[@Demo](plugin://demo@market) 试用一下"),
        }),
      ).resolves.toMatchObject({ status: "accepted" });
      expect(commandCalls(request)).toHaveLength(1);
    } finally {
      service.disposeAll();
    }
  });
});
