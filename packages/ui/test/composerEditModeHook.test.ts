// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "@nibi/shared/nibi-protocol-v4";

import {
  COMPOSER_EDIT_SCOPE_MARKER,
  type ComposerEditSubmitResult,
  type ComposerQueueItemEditTarget,
  type ComposerUserQueryEditTarget,
} from "@/composer-edit-mode/contract.js";
import {
  resolveComposerEditInvalidReason,
  useComposerEditMode,
  type UseComposerEditModeOptions,
} from "@/composer-edit-mode/useComposerEditMode.js";

const userTarget: ComposerUserQueryEditTarget = {
  kind: "userQuery",
  sessionId: "session-a",
  workspaceKey: "/workspace",
  rowId: 42,
  entityId: "message-user-42",
};
const queueTarget: ComposerQueueItemEditTarget = {
  kind: "queueItem",
  sessionId: "session-a",
  workspaceKey: "/workspace",
  queueItemId: "queue-1",
};
const otherUserTarget: ComposerUserQueryEditTarget = {
  ...userTarget,
  rowId: 43,
  entityId: "message-user-43",
};

function snapshotWith({
  canEdit = true,
  queueItems = [],
}: {
  canEdit?: boolean;
  queueItems?: Array<Record<string, unknown>>;
} = {}): ConversationSnapshot {
  return {
    sessionId: "session-a",
    rows: {
      window: [
        {
          kind: "userInput",
          rowId: 42,
          entityId: "message-user-42",
          turnId: "turn-1",
          createdAt: 1,
          createdAtSeq: 1,
          origin: "realUser",
          text: "original",
          ...(canEdit ? { actions: { canEdit: true } } : { actions: {} }),
        },
        {
          kind: "userInput",
          rowId: 43,
          entityId: "message-user-43",
          turnId: "turn-2",
          createdAt: 2,
          createdAtSeq: 2,
          origin: "realUser",
          text: "other",
          actions: { canEdit: true },
        },
      ],
      totalCount: 2,
      firstRowId: 1,
    },
    queue: { items: queueItems, autoDrain: true },
  } as unknown as ConversationSnapshot;
}

function makeOptions(overrides: Partial<UseComposerEditModeOptions> = {}) {
  const lock = vi.fn<UseComposerEditModeOptions["queueLock"]["lock"]>(async () => "locked");
  const release = vi.fn(async () => {});
  const submit = vi.fn<UseComposerEditModeOptions["submit"]["submit"]>(async () => ({
    status: "accepted",
  }));
  const options: UseComposerEditModeOptions = {
    enabled: true,
    sessionId: "session-a",
    workspaceKey: "/workspace",
    snapshot: snapshotWith(),
    editorId: "editor-1",
    queueLock: { lock, release },
    submit: { submit },
    confirmDiscard: vi.fn(() => true),
    ...overrides,
  };
  return { options, lock, release, submit };
}

describe("useComposerEditMode", () => {
  it("user query 直接进入编辑 scope 并请求聚焦", async () => {
    const { options } = makeOptions();
    const { result } = renderHook(() => useComposerEditMode(options));

    await act(async () => {
      await result.current.beginUserQuery(userTarget, { text: "original" });
    });

    expect(result.current.state.status).toBe("editing");
    expect(result.current.draftScopeId).toContain(COMPOSER_EDIT_SCOPE_MARKER);
    expect(result.current.focusRequest?.targetKey).toContain("session-a");
    expect(result.current.editingUserQueryRowId).toBe(42);
  });

  it("queue item 等待 lock ACK 后才切 Composer scope", async () => {
    let resolveLock!: (value: "locked") => void;
    const lockPromise = new Promise<"locked">((resolve) => {
      resolveLock = resolve;
    });
    const { options, lock } = makeOptions();
    lock.mockReturnValueOnce(lockPromise);
    const { result } = renderHook(() => useComposerEditMode(options));

    let begin!: Promise<string>;
    await act(async () => {
      begin = result.current.beginQueueItem(queueTarget, { text: "queued" });
      await Promise.resolve();
    });
    expect(result.current.state.status).toBe("opening");
    expect(result.current.draftScopeId).toBeNull();

    await act(async () => {
      resolveLock("locked");
      await begin;
    });
    expect(result.current.state.status).toBe("editing");
    expect(result.current.draftScopeId).toContain(COMPOSER_EDIT_SCOPE_MARKER);
  });

  it("取消释放队列锁并恢复 idle（会话草稿由 scope 切换恢复）", async () => {
    const { options, release } = makeOptions();
    const { result } = renderHook(() => useComposerEditMode(options));
    await act(async () => {
      await result.current.beginQueueItem(queueTarget, { text: "queued" });
    });

    await act(async () => {
      result.current.cancel();
      await Promise.resolve();
    });

    expect(release).toHaveBeenCalledWith(queueTarget);
    expect(result.current.state.status).toBe("idle");
  });

  it("切换目标：正文改过先确认，确认后释放旧队列锁", async () => {
    const confirmDiscard = vi.fn(() => false);
    const { options, release } = makeOptions({ confirmDiscard });
    const { result } = renderHook(() => useComposerEditMode(options));

    await act(async () => {
      await result.current.beginQueueItem(queueTarget, { text: "queued" });
    });
    act(() => result.current.updateText("changed"));

    let blockedResult = "";
    await act(async () => {
      blockedResult = await result.current.beginUserQuery(otherUserTarget, {
        text: "other",
      });
    });
    expect(blockedResult).toBe("cancelled");
    expect(release).not.toHaveBeenCalled();
    expect(result.current.state.target).toEqual(queueTarget);

    confirmDiscard.mockReturnValue(true);
    await act(async () => {
      await result.current.beginUserQuery(otherUserTarget, { text: "other" });
    });
    expect(release).toHaveBeenCalledWith(queueTarget);
    expect(result.current.state.target).toEqual(otherUserTarget);
    expect(result.current.state.draft?.text).toBe("other");
  });

  it("投影把目标行变成不可编辑时进入 notLatest", async () => {
    let snapshot = snapshotWith();
    const { options } = makeOptions();
    const { result, rerender } = renderHook(() => useComposerEditMode({ ...options, snapshot }));
    await act(async () => {
      await result.current.beginUserQuery(userTarget, { text: "original" });
    });
    expect(result.current.isInvalid).toBe(false);

    snapshot = snapshotWith({ canEdit: false });
    await act(async () => {
      rerender();
    });

    expect(result.current.state.status).toBe("invalid");
    expect(result.current.state.invalidReason).toBe("notLatest");
  });

  it("队列项消失/编辑锁丢失由同一投影函数裁决", () => {
    const target: ComposerQueueItemEditTarget = queueTarget;
    expect(
      resolveComposerEditInvalidReason(snapshotWith({ queueItems: [] }), target, "editor-1"),
    ).toBe("queueItemRemoved");
    expect(
      resolveComposerEditInvalidReason(
        snapshotWith({
          queueItems: [
            { queueItemId: "queue-1", kind: "sendText", text: "x", dispatch: { state: "queued" } },
          ],
        }),
        target,
        "editor-1",
      ),
    ).toBeNull();
    expect(
      resolveComposerEditInvalidReason(
        snapshotWith({
          queueItems: [
            { queueItemId: "queue-1", kind: "sendText", text: "x", dispatch: { state: "queued" } },
          ],
        }),
        target,
        "editor-1",
        { queueLockObserved: true },
      ),
    ).toBe("editLockLost");
  });

  it("提交把目标与正文交给宿主端口，settled=sent 后退出编辑", async () => {
    const { options, submit } = makeOptions();
    const { result } = renderHook(() => useComposerEditMode(options));
    await act(async () => {
      await result.current.beginUserQuery(userTarget, { text: "original" });
      result.current.updateText("edited");
    });

    let outcome: ComposerEditSubmitResult | undefined;
    await act(async () => {
      outcome = await result.current.submitComposer({
        text: "edited",
        attachments: [],
      });
    });
    expect(outcome).toEqual({ status: "accepted" });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        target: userTarget,
        text: "edited",
        workspaceMode: "preserve",
        editorId: "editor-1",
      }),
    );
    expect(result.current.state.status).toBe("submitting");

    act(() => result.current.onComposerSubmissionSettled("sent"));
    expect(result.current.state.status).toBe("idle");
  });

  it("宿主返回 editLockLost 时保留编辑正文并进入 invalid", async () => {
    const { options, submit } = makeOptions();
    submit.mockResolvedValueOnce({ status: "rejected", reason: "editLockLost" });
    const { result } = renderHook(() => useComposerEditMode(options));
    await act(async () => {
      await result.current.beginQueueItem(queueTarget, { text: "queued" });
    });

    let outcome: ComposerEditSubmitResult | undefined;
    await act(async () => {
      outcome = await result.current.submitComposer({ text: "edited", attachments: [] });
    });
    expect(outcome).toEqual({ status: "rejected", reason: "editLockLost" });
    expect(result.current.state.status).toBe("invalid");
    expect(result.current.state.invalidReason).toBe("editLockLost");
    expect(result.current.state.draft?.text).toBe("queued");
  });
});
