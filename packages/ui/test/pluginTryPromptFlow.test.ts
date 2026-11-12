import { describe, expect, it, vi } from "vitest";
import {
  resolvePluginTryPromptIntent,
  resolvePluginTryPromptAccess,
  runPluginTryPromptFlow,
} from "../src/settings/pluginTryPromptFlow.js";
import type { StorePluginItem } from "../src/settings/pluginStoreListing.js";

// 运营者实机 BUG 回归：非会员 + 已安装的付费插件处于停用态时，点「立即试用」曾直接
// 建草稿并把试用消息发进会话（模型随后去调不存在的 MCP）。门禁必须与「启用」一致：
// 无权限 → 会员引导；未启用 → 先启用；只有真正可用才允许启动草稿。
type ItemFacts = Pick<StorePluginItem, "installed" | "paid" | "info">;

function item(overrides: Partial<ItemFacts> = {}): ItemFacts {
  return {
    installed: true,
    paid: false,
    info: { enabled: true } as StorePluginItem["info"],
    ...overrides,
  };
}

function deps(overrides: Partial<Parameters<typeof runPluginTryPromptFlow>[1]> = {}) {
  return {
    canUsePaidPlugins: true,
    install: vi.fn(),
    requireMembership: vi.fn(async () => false),
    enable: vi.fn(async () => true),
    start: vi.fn(),
    canStart: vi.fn(() => true),
    ...overrides,
  };
}

describe("resolvePluginTryPromptIntent", () => {
  it("按 未安装 → 会员 → 未启用 → 可用 的优先级判定", () => {
    expect(resolvePluginTryPromptIntent(resolvePluginTryPromptAccess(item({ installed: false })), true)).toBe("install");
    expect(
      resolvePluginTryPromptIntent(
        resolvePluginTryPromptAccess(
          item({ paid: true, info: { enabled: false } as StorePluginItem["info"] }),
        ),
        false,
      ),
    ).toBe("membership");
    expect(
      resolvePluginTryPromptIntent(
        resolvePluginTryPromptAccess(item({ info: { enabled: false } as StorePluginItem["info"] })),
        true,
      ),
    ).toBe("enable");
    expect(resolvePluginTryPromptIntent(resolvePluginTryPromptAccess(item()), true)).toBe("start");
  });

  it("已安装但没有运行时 info 时按未启用处理（fail closed）", () => {
    expect(
      resolvePluginTryPromptAccess(item({ info: undefined })),
    ).toMatchObject({ installed: true, enabled: false });
  });
});

describe("runPluginTryPromptFlow", () => {
  it("付费插件无权限：弹会员引导，不启用、不启动草稿", async () => {
    const flow = deps({ canUsePaidPlugins: false });
    const result = await runPluginTryPromptFlow(
      item({ paid: true, info: { enabled: false } as StorePluginItem["info"] }),
      flow,
    );
    expect(result).toBe("membership");
    expect(flow.requireMembership).toHaveBeenCalledTimes(1);
    expect(flow.enable).not.toHaveBeenCalled();
    expect(flow.start).not.toHaveBeenCalled();
  });

  it("免费插件未启用：先启用再启动草稿", async () => {
    const flow = deps();
    const result = await runPluginTryPromptFlow(
      item({ info: { enabled: false } as StorePluginItem["info"] }),
      flow,
    );
    expect(result).toBe("started");
    expect(flow.enable).toHaveBeenCalledTimes(1);
    expect(flow.start).toHaveBeenCalledTimes(1);
  });

  it("启用失败：不启动草稿（消息绝不进入会话）", async () => {
    const flow = deps({ enable: vi.fn(async () => false) });
    const result = await runPluginTryPromptFlow(
      item({ info: { enabled: false } as StorePluginItem["info"] }),
      flow,
    );
    expect(result).toBe("enable_failed");
    expect(flow.start).not.toHaveBeenCalled();
  });

  it("已启用：行为不变，直接启动草稿", async () => {
    const flow = deps();
    const result = await runPluginTryPromptFlow(item(), flow);
    expect(result).toBe("started");
    expect(flow.enable).not.toHaveBeenCalled();
    expect(flow.requireMembership).not.toHaveBeenCalled();
    expect(flow.start).toHaveBeenCalledTimes(1);
  });

  it("未安装：只引导安装，不启动草稿", async () => {
    const flow = deps();
    const result = await runPluginTryPromptFlow(item({ installed: false }), flow);
    expect(result).toBe("install");
    expect(flow.install).toHaveBeenCalledTimes(1);
    expect(flow.start).not.toHaveBeenCalled();
  });

  it("缺少新建任务能力时不标记为已启动", async () => {
    const flow = deps({ canStart: vi.fn(() => false) });
    const result = await runPluginTryPromptFlow(item(), flow);
    expect(result).toBe("blocked");
    expect(flow.start).not.toHaveBeenCalled();
  });
});
