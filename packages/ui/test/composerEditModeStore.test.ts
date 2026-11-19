import { describe, expect, it } from "vitest";
import type { QueueItem } from "@nibi/shared/nibi-protocol-v4";

import type { ComposerEditTarget } from "@/composer-edit-mode/contract.js";
import {
  applyQueueEditConfigToComposerDraft,
  resolveQueueItemEditDraft,
} from "@/composer-edit-mode/queueConfigApply.js";
import { createComposerEditStore } from "@/composer-edit-mode/store.js";

const userTarget: ComposerEditTarget = {
  kind: "userQuery",
  sessionId: "session-a",
  workspaceKey: "/workspace",
  rowId: 42,
  entityId: "message-user-42",
};

describe("composer edit store", () => {
  it("opening 先占目标，确认草稿后才进入 editing 并请求聚焦", () => {
    const store = createComposerEditStore();
    store.open(userTarget);
    expect(store.getSnapshot()).toMatchObject({
      status: "opening",
      target: userTarget,
      draft: null,
      focusRequest: null,
    });

    store.confirmOpen({ text: "原来的问题" });
    const state = store.getSnapshot();
    expect(state.status).toBe("editing");
    expect(state.originalDraft?.text).toBe("原来的问题");
    expect(state.draft?.text).toBe("原来的问题");
    expect(state.focusRequest?.targetKey).toContain("session-a");
    expect(store.isDirty()).toBe(false);
  });

  it("正文变化只改编辑副本，dirty 与 focus/submit 请求单调递增", () => {
    const store = createComposerEditStore();
    store.open(userTarget);
    store.confirmOpen({ text: "原始" });
    const firstFocus = store.getSnapshot().focusRequest!.requestId;

    store.updateText("改过");
    expect(store.getSnapshot().draft?.text).toBe("改过");
    expect(store.getSnapshot().originalDraft?.text).toBe("原始");
    expect(store.isDirty()).toBe(true);

    store.requestFocus();
    expect(store.getSnapshot().focusRequest!.requestId).toBeGreaterThan(firstFocus);

    store.requestSubmit("rewind");
    expect(store.getSnapshot().submitRequest).toMatchObject({
      workspaceMode: "rewind",
      targetKey: expect.stringContaining("session-a"),
    });
    store.updateText("原始");
    expect(store.isDirty()).toBe(false);
  });

  it("提交、失效与结束是互斥状态，结束清空全部编辑事实", () => {
    const store = createComposerEditStore();
    store.open(userTarget);
    store.confirmOpen({ text: "原始" });

    store.setSubmitting(true);
    expect(store.getSnapshot().status).toBe("submitting");
    // 提交中不接受新的正文写入，避免 ACK 等待期间的编辑被静默吞掉。
    store.updateText("等待中追加");
    expect(store.getSnapshot().draft?.text).toBe("原始");
    store.setSubmitting(false);
    expect(store.getSnapshot().status).toBe("editing");

    store.invalidate("notLatest");
    expect(store.getSnapshot()).toMatchObject({
      status: "invalid",
      invalidReason: "notLatest",
    });

    store.end();
    expect(store.getSnapshot()).toMatchObject({
      status: "idle",
      target: null,
      originalDraft: null,
      draft: null,
      invalidReason: null,
    });
  });

  it("队列项草稿沿用冻结配置，compact 不可编辑", () => {
    const item = {
      kind: "sendText",
      text: "队列消息",
      attachments: [{ bytes: 1, fileName: "a.txt", mime: "text/plain", ref: "/workspace/a.txt" }],
      mode: "yolo",
      planEnabled: false,
      modelSelection: { providerId: "p", modelId: "m" },
    } as unknown as QueueItem;
    expect(resolveQueueItemEditDraft(item)).toMatchObject({
      text: "队列消息",
      attachments: [expect.objectContaining({ fileName: "a.txt" })],
      config: {
        mode: "yolo",
        planEnabled: false,
        modelSelection: { providerId: "p", modelId: "m" },
      },
    });
    expect(resolveQueueItemEditDraft({ ...item, kind: "compact" } as QueueItem)).toBeNull();
    expect(
      applyQueueEditConfigToComposerDraft(
        { text: "x", updatedAt: 0 },
        { mode: "plan", planEnabled: true, modelSelection: { providerId: "p", modelId: "m" } },
      ),
    ).toMatchObject({
      text: "x",
      mode: "plan",
      planEnabled: true,
      modelSelection: { providerId: "p", modelId: "m" },
    });
  });
});
