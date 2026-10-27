import { describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@nibi/shared/nibi-protocol-v4";
import {
  applyExternalTextInsertRequestToComposer,
  restorePersistedComposerDraftIntoInput,
} from "@/v4/ConversationComposer.js";
import { resolveQueuedComposerRestore } from "@/v4/SessionPane.js";

function makeSnapshot(): ConversationSnapshot {
  return {
    protocolVersion: 1,
    sessionId: "session-1",
    logEpoch: "epoch-1",
    seq: 1,
    revision: 7,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "primaryTurn",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: false, reasonCode: "noGoalToPause" },
      resumeGoal: { allowed: false, reasonCode: "noGoalToResume" },
    },
    inputRouting: { mode: "enqueue" },
    meta: { title: "Session", titleSource: "generated" },
    config: { provider: "", model: "", thought: "", followupMode: "queue", mode: "build" },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: {
      autoDrain: true,
      items: [
        {
          queueItemId: "q-1",
          kind: "sendText",
          text: "排队原文",
          sourceCommandId: "cmd-q1",
          clientId: "cli",
          attachments: [
            { ref: "ref-b", fileName: "b.png", mime: "image/png", bytes: 2 },
            { ref: "ref-a", fileName: "a.txt", mime: "text/plain", bytes: 1 },
          ],
          delivery: { requested: "queue", admitted: "queue" },
          order: { admissionSeq: 1, queuePosition: 0 },
          steer: { state: "notRequested" },
          dispatch: { state: "queued" },
          admittedAt: 1,
        },
      ],
    },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  };
}

describe("v4 queue edit extraction", () => {
  it("Workspace 插件页重挂载时从共享草稿恢复结构化 mention", () => {
    const mention = {
      id: "plugin:document-skills@official",
      category: "plugins" as const,
      label: "文档技能",
      value: "document-skills@official",
      markdown: "[@文档技能](plugin://document-skills@official)",
      data: { pluginId: "document-skills@official" },
    };
    const inputApi = {
      getMarkdown: vi.fn(() => "unused"),
      setEditorStateJson: vi.fn(),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const text = `${mention.markdown} 整理文档`;

    expect(
      restorePersistedComposerDraftIntoInput({
        draft: { text, mention, updatedAt: 1 },
        inputApi,
      }),
    ).toBe(text);
    expect(inputApi.setMention).toHaveBeenCalledWith(mention, " 整理文档");
    expect(inputApi.setText).not.toHaveBeenCalled();
  });

  it("商店试用把 canonical 前缀恢复为结构化 Plugin mention", () => {
    const mention = {
      id: "plugin:demo@mkt",
      category: "plugins" as const,
      label: "Demo",
      value: "demo@mkt",
      markdown: "[@Demo](plugin://demo@mkt)",
      data: {
        pluginId: "demo@mkt",
        icon: "https://cdn.example.com/demo.png",
      },
    };
    const inputApi = {
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();
    const text = `${mention.markdown} Diagnose this workspace`;

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: { requestId: 7, text, mention },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(7);
    expect(inputApi.setMention).toHaveBeenCalledWith(mention, " Diagnose this workspace");
    expect(inputApi.setText).not.toHaveBeenCalled();
    expect(updateText).toHaveBeenCalledWith(text);
    expect(scheduleDraftPersist).toHaveBeenCalledTimes(1);
    expect(requestFocus).toHaveBeenCalledTimes(1);
  });

  it("插件安装完成后把唯一 chip 前置到编辑器当前正文而不回放旧 prompt", () => {
    const mention = {
      id: "plugin:document-skills@nibi-official",
      category: "plugins" as const,
      label: "文档技能",
      value: "document-skills@nibi-official",
      markdown: "[@文档技能](plugin://document-skills@nibi-official)",
      data: { pluginId: "document-skills@nibi-official" },
    };
    const inputApi = {
      getMarkdown: vi.fn(() => `${mention.markdown} 用户安装期间编辑后的正文`),
      prependMentionIfMissing: vi.fn(() => true),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: {
          requestId: 8,
          text: mention.markdown,
          mention,
          mode: "prepend-if-missing",
        },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(8);
    expect(inputApi.prependMentionIfMissing).toHaveBeenCalledWith(mention);
    expect(updateText).toHaveBeenCalledWith(`${mention.markdown} 用户安装期间编辑后的正文`);
    expect(inputApi.setMention).not.toHaveBeenCalled();
    expect(inputApi.setText).not.toHaveBeenCalled();
  });

  it("当前草稿已有同一 Plugin canonical 文本时不重复插入 chip", () => {
    const mention = {
      id: "plugin:demo@mkt",
      category: "plugins" as const,
      label: "Demo",
      value: "demo@mkt",
      markdown: "[@Demo](plugin://demo@mkt)",
      data: { pluginId: "demo@mkt" },
    };
    const inputApi = {
      // label 是 display-only；即使语言切换导致 label 不同，同一 stable ID 也不能重复插入。
      getMarkdown: vi.fn(() => "[@旧名称](plugin://demo@mkt) 当前正文"),
      prependMentionIfMissing: vi.fn(() => false),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: {
          requestId: 9,
          text: mention.markdown,
          mention,
          mode: "prepend-if-missing",
        },
        requestFocus: vi.fn(),
        scheduleDraftPersist: vi.fn(),
        updateText,
      }),
    ).toBe(9);
    expect(inputApi.prependMentionIfMissing).toHaveBeenCalledWith(mention);
    expect(inputApi.setMention).not.toHaveBeenCalled();
    expect(updateText).not.toHaveBeenCalled();
  });

  it("PA158 撤回使用队列项自身权限/Plan/模型，不借用当前 Composer 配置", () => {
    const snapshot = makeSnapshot();
    Object.assign(snapshot.queue.items[0]!, {
      mode: "yolo",
      planEnabled: false,
      modelSelection: {
        providerId: "provider",
        modelId: "model",
        options: { reasoningLevel: "high" },
      },
    });
    expect(resolveQueuedComposerRestore(snapshot, "q-1")?.config).toEqual({
      mode: "yolo",
      planEnabled: false,
      modelSelection: {
        providerId: "provider",
        modelId: "model",
        options: { reasoningLevel: "high" },
      },
    });
  });


});
