import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const capturedSwitches: Array<Record<string, unknown>> = [];
const capturedSelects: Array<Record<string, unknown>> = [];
const servicesState = vi.hoisted(() => ({ value: {} as Record<string, unknown> | null }));

vi.mock("@/components/lib/utils.js", () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" "),
}));

vi.mock("@/components/ui/switch.js", () => ({
  Switch: (props: Record<string, unknown>) => {
    capturedSwitches.push(props);
    return createElement("input", { type: "checkbox", ...props });
  },
}));

vi.mock("@/components/ui/select.js", () => ({
  Select: (props: Record<string, unknown> & { children: unknown }) => {
    capturedSelects.push(props);
    return createElement("div", null, props.children);
  },
  SelectContent: ({ children }: { children: unknown }) => createElement("div", null, children),
  SelectItem: ({ children }: { children: unknown }) => createElement("div", null, children),
  SelectTrigger: ({ children }: { children: unknown }) => createElement("button", null, children),
  SelectValue: () => createElement("span"),
}));

vi.mock("@/components/ui/card.js", () => ({
  Card: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("div", props, children),
  CardContent: ({ children, ...props }: { children: unknown; [key: string]: unknown }) =>
    createElement("div", props, children),
}));

vi.mock("@/settings/SettingsPageParts.js", () => ({
  SettingsBadge: ({ children }: { children: unknown }) => createElement("span", null, children),
  SettingsGroupCard: ({ children }: { children: unknown }) =>
    createElement("section", { "data-settings-group": true }, children),
  SettingsRow: ({
    control,
    description,
    detail,
    searchTarget,
  }: {
    control: unknown;
    description?: unknown;
    detail?: unknown;
    searchTarget?: string;
  }) =>
    createElement(
      "div",
      { "data-settings-search-target": searchTarget },
      description,
      control,
      detail,
    ),
}));

vi.mock("@/settings/DynamicWorkflowModeSetting.js", () => ({
  DynamicWorkflowModeSetting: () =>
    createElement("div", { "data-testid": "dynamic-workflow-setting" }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => servicesState.value,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => {
        const messages: Record<string, string> = {
          "settings.toolSearch": "工具搜索",
          "settings.toolSearchDescription": "desc",
          "settings.toolSearchExperimentalNotice": "desc",
          "settings.toolSearch.auto": "自动",
          "settings.toolSearch.local": "本地",
          "settings.toolSearch.off": "关闭",
          "settings.nativeSearchEnhancements": "增强 Find 和 Grep",
          "settings.nativeSearchEnhancementsDescription": "desc",
          "settings.nibiInteractionBehavior": "交互行为",
          "settings.nibiInteractionBehaviorDescription": "desc",
          "settings.nibiInteractionBehavior.option.queue": "队列",
          "settings.nibiInteractionBehavior.option.guide": "引导",
          "settings.askUserQuestionAutoResolution": "提问自动继续",
          "settings.askUserQuestionAutoResolutionDescription": "desc",
          "settings.modelIoFullRetention": "完整保留模型 I/O",
          "settings.modelIoFullRetentionDescription": "desc",
          "settings.messageStreamShowReasoning": "显示思考过程",
          "settings.messageStreamShowReasoningDescription": "desc",
          "settings.messageStreamShowTodos": "显示待办",
          "settings.messageStreamShowTodosDescription": "desc",
        };
        return messages[id] ?? id;
      },
    },
  }),
}));

async function renderAgentBehaviorSection(
  overrides: Partial<
    Parameters<typeof import("../src/settingsPageHelpers.js").AgentBehaviorSectionContent>[0]
  > = {},
) {
  const { AgentBehaviorSectionContent } = await import("../src/settingsPageHelpers.js");

  return renderToStaticMarkup(
    createElement(AgentBehaviorSectionContent, {
      toolSearchMode: "auto",
      nativeSearchEnhancementsEnabled: true,
      nibiInteractionBehavior: "queue",
      askUserQuestionAutoResolutionEnabled: true,
      modelIoFullRetentionEnabled: false,
      messageStreamShowReasoning: true,
      messageStreamShowTodos: false,
      onToolSearchModeChange: vi.fn(async () => {}),
      onNativeSearchEnhancementsEnabledChange: vi.fn(async () => {}),
      onNibiInteractionBehaviorChange: vi.fn(async () => {}),
      onAskUserQuestionAutoResolutionEnabledChange: vi.fn(async () => {}),
      onModelIoFullRetentionEnabledChange: vi.fn(async () => {}),
      onMessageStreamShowReasoningChange: vi.fn(async () => {}),
      onMessageStreamShowTodosChange: vi.fn(async () => {}),
      ...overrides,
    }),
  );
}

function findSwitch(label: string) {
  return capturedSwitches.find((item) => item["aria-label"] === label);
}

function toggleSwitch(label: string, checked: boolean) {
  (findSwitch(label)?.["onCheckedChange"] as ((next: boolean) => void) | undefined)?.(checked);
}

describe("AgentBehaviorSectionContent", () => {
  beforeEach(() => {
    capturedSwitches.length = 0;
    capturedSelects.length = 0;
    servicesState.value = {};
  });

  it("工具搜索读取持久值并通过标准模式枚举写回", async () => {
    const onToolSearchModeChange = vi.fn(async () => {});

    await renderAgentBehaviorSection({ toolSearchMode: "local", onToolSearchModeChange });

    const toolSearchSelect = capturedSelects.find((select) => select.value === "local");
    expect(toolSearchSelect).toBeDefined();
    (toolSearchSelect?.onValueChange as ((value: string) => void) | undefined)?.("auto");
    expect(onToolSearchModeChange).toHaveBeenCalledWith("auto");
  });

  it("增强 Find/Grep 读取持久值并写回切换", async () => {
    const onNativeSearchEnhancementsEnabledChange = vi.fn(async () => {});

    await renderAgentBehaviorSection({
      nativeSearchEnhancementsEnabled: false,
      onNativeSearchEnhancementsEnabledChange,
    });

    expect(findSwitch("增强 Find 和 Grep")?.checked).toBe(false);
    toggleSwitch("增强 Find 和 Grep", true);
    expect(onNativeSearchEnhancementsEnabledChange).toHaveBeenCalledWith(true);
  });

  it("交互行为读取持久值并写回选择", async () => {
    const onNibiInteractionBehaviorChange = vi.fn(async () => {});

    await renderAgentBehaviorSection({
      nibiInteractionBehavior: "queue",
      onNibiInteractionBehaviorChange,
    });

    const interactionSelect = capturedSelects.find((select) => select.value === "queue");
    expect(interactionSelect).toBeDefined();
    expect(interactionSelect?.onValueChange).toBeTypeOf("function");
    (interactionSelect?.onValueChange as ((value: string) => void) | undefined)?.("guide");
    expect(onNibiInteractionBehaviorChange).toHaveBeenCalledWith("guide");
  });

  it("提问自动继续、模型 I/O、思考过程与待办读取持久值并写回选择", async () => {
    const onAskUserQuestionAutoResolutionEnabledChange = vi.fn(async () => {});
    const onModelIoFullRetentionEnabledChange = vi.fn(async () => {});
    const onMessageStreamShowReasoningChange = vi.fn(async () => {});
    const onMessageStreamShowTodosChange = vi.fn(async () => {});

    await renderAgentBehaviorSection({
      askUserQuestionAutoResolutionEnabled: false,
      modelIoFullRetentionEnabled: true,
      messageStreamShowReasoning: false,
      messageStreamShowTodos: true,
      onAskUserQuestionAutoResolutionEnabledChange,
      onModelIoFullRetentionEnabledChange,
      onMessageStreamShowReasoningChange,
      onMessageStreamShowTodosChange,
    });

    expect(findSwitch("提问自动继续")?.checked).toBe(false);
    expect(findSwitch("完整保留模型 I/O")?.checked).toBe(true);
    expect(findSwitch("显示思考过程")?.checked).toBe(false);
    expect(findSwitch("显示待办")?.checked).toBe(true);

    toggleSwitch("提问自动继续", true);
    toggleSwitch("完整保留模型 I/O", false);
    toggleSwitch("显示思考过程", true);
    toggleSwitch("显示待办", false);

    expect(onAskUserQuestionAutoResolutionEnabledChange).toHaveBeenCalledWith(true);
    expect(onModelIoFullRetentionEnabledChange).toHaveBeenCalledWith(false);
    expect(onMessageStreamShowReasoningChange).toHaveBeenCalledWith(true);
    expect(onMessageStreamShowTodosChange).toHaveBeenCalledWith(false);
  });

  it("动态工作流有服务端能力时排序在提问自动继续与模型 I/O 之间", async () => {
    servicesState.value = {};

    const markup = await renderAgentBehaviorSection();

    expect(markup).toContain('data-testid="dynamic-workflow-setting"');
    expect(markup.indexOf("提问自动继续")).toBeLessThan(
      markup.indexOf('data-testid="dynamic-workflow-setting"'),
    );
    expect(markup.indexOf('data-testid="dynamic-workflow-setting"')).toBeLessThan(
      markup.indexOf("完整保留模型 I/O"),
    );
  });

  it("没有服务端能力时不渲染动态工作流行", async () => {
    servicesState.value = null;

    const markup = await renderAgentBehaviorSection();

    expect(markup).not.toContain('data-testid="dynamic-workflow-setting"');
  });

  it("搬迁后的控件使用新的分区搜索锚点", async () => {
    const markup = await renderAgentBehaviorSection();

    for (const target of [
      "agentBehavior.toolSearch",
      "agentBehavior.nativeSearchEnhancements",
      "agentBehavior.interaction",
      "agentBehavior.askUserQuestionAutoResolution",
      "agentBehavior.modelIoFullRetention",
      "agentBehavior.reasoning",
      "agentBehavior.todos",
    ]) {
      expect(markup).toContain(`data-settings-search-target="${target}"`);
    }
  });
});
