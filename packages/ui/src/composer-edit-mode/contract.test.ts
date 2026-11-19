import { describe, expect, it } from "vitest";

import {
  COMPOSER_EDIT_SCOPE_MARKER,
  buildComposerEditSubmitCommand,
  composerEditInvalidReasonForAck,
  composerEditScopeId,
  composerEditSessionKey,
  composerEditTargetKey,
  isComposerEditScopeId,
  type ComposerEditSubmitInput,
} from "./contract.js";
import { composerEditTargetIdentity, isSameComposerEditTarget } from "./editorIdentity.js";
import { composerEditModeModule } from "./module.js";

const workspaceKey = "/workspace";
const sessionId = "session-a";
const editorId = "editor-1";

const userQueryTarget = {
  kind: "userQuery" as const,
  sessionId,
  workspaceKey,
  rowId: 42,
  entityId: "message-user-42",
};
const queueItemTarget = {
  kind: "queueItem" as const,
  sessionId,
  workspaceKey,
  queueItemId: "queue-1",
};

describe("composer-edit-mode contract", () => {
  it("declares its module manifest", () => {
    expect(composerEditModeModule.id).toBe("composer-edit-mode");
    expect(composerEditModeModule.requires).toEqual(["shared", "ui"]);
    expect(composerEditModeModule.publicEntrypoints).toContain("contract.ts");
  });

  it("edit scope 标记不落到会话草稿 scope", () => {
    const scopeId = composerEditScopeId(userQueryTarget);
    expect(scopeId.startsWith(COMPOSER_EDIT_SCOPE_MARKER)).toBe(true);
    expect(isComposerEditScopeId(scopeId)).toBe(true);
    expect(isComposerEditScopeId(sessionId)).toBe(false);
    expect(scopeId).not.toBe(sessionId);
  });

  it("目标身份稳定且不串 session/workspace", () => {
    expect(composerEditTargetKey(userQueryTarget)).toBe(
      composerEditTargetKey({ ...userQueryTarget }),
    );
    expect(composerEditTargetKey(userQueryTarget)).not.toBe(
      composerEditTargetKey({ ...userQueryTarget, sessionId: "session-b" }),
    );
    expect(composerEditSessionKey(workspaceKey, sessionId)).toContain(sessionId);
    expect(isSameComposerEditTarget(userQueryTarget, { ...userQueryTarget })).toBe(true);
    expect(isSameComposerEditTarget(userQueryTarget, queueItemTarget)).toBe(false);
    expect(composerEditTargetIdentity(queueItemTarget)).toEqual({
      kind: "queueItem",
      id: "queue-1",
      key: composerEditTargetKey(queueItemTarget),
    });
  });

  it("user query 走 editUserQuery，队列项走 editQueueItem", () => {
    const base: Omit<ComposerEditSubmitInput, "target"> = {
      text: "new text",
      attachments: [],
      workspaceMode: "preserve",
      editorId,
    };
    expect(buildComposerEditSubmitCommand({ ...base, target: userQueryTarget })).toEqual({
      type: "editUserQuery",
      payload: {
        target: { rowId: 42, entityId: "message-user-42" },
        newText: "new text",
        workspaceMode: "preserve",
      },
    });
    expect(buildComposerEditSubmitCommand({ ...base, target: queueItemTarget })).toEqual({
      type: "editQueueItem",
      payload: { queueItemId: "queue-1", newText: "new text", editorId },
    });
  });

  it("拒绝码收敛为三种投影失效原因", () => {
    expect(
      composerEditInvalidReasonForAck(userQueryTarget, {
        status: "rejected",
        reasonCode: "guard.latestQueryEditOnly",
      }),
    ).toBe("notLatest");
    expect(
      composerEditInvalidReasonForAck(queueItemTarget, {
        status: "rejected",
        reasonCode: "queue.itemMissing",
      }),
    ).toBe("queueItemRemoved");
    expect(
      composerEditInvalidReasonForAck(queueItemTarget, {
        status: "rejected",
        reasonCode: "queue.editLockMissing",
      }),
    ).toBe("editLockLost");
    expect(
      composerEditInvalidReasonForAck(queueItemTarget, {
        status: "rejected",
        reasonCode: "fault.command.executionFailed",
      }),
    ).toBeNull();
  });
});
