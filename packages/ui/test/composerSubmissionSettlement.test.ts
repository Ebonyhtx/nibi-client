import { describe, expect, it, vi } from "vitest";
import type {
  CommandAck,
  CommandEnvelope,
  ConversationSnapshot,
} from "@nibi/shared/nibi-protocol-v4";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";
import {
  subscribeComposerSubmissionSettled,
  trackUnsettledComposerSubmission,
} from "@/v4/composer/composerSubmissionSettlement.js";

let scopeSeq = 0;
function uniqueScope(): string {
  scopeSeq += 1;
  return `/workspace\u0000sess_${scopeSeq}`;
}

function authoritativeSnapshot(sessionId: string, commandId: string): ConversationSnapshot {
  return {
    sessionId,
    queue: { items: [] },
    rows: {
      window: [{ kind: "userInput", rowId: "row-1", sourceCommandId: commandId, text: "x" }],
    },
  } as unknown as ConversationSnapshot;
}

describe("composerSubmissionSettlement", () => {
  it("订阅者存在时，权威结算立即投递并只投递一次", () => {
    const scopeKey = uniqueScope();
    const settled = vi.fn();
    const unsubscribe = subscribeComposerSubmissionSettled(scopeKey, settled);
    trackUnsettledComposerSubmission(scopeKey, { commandId: "cmd-a", text: "hello" });

    pendingCommandRegistry.reconcileSnapshot(authoritativeSnapshot("sess", "cmd-a"));
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith({ commandId: "cmd-a", text: "hello" });

    // 同一 commandId 再次出现在后续 snapshot 里不会重复投递。
    pendingCommandRegistry.reconcileSnapshot(authoritativeSnapshot("sess", "cmd-a"));
    expect(settled).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("结算先于订阅到达时（composer 卸载期间），新订阅者同步收到并消费该结算", () => {
    const scopeKey = uniqueScope();
    trackUnsettledComposerSubmission(scopeKey, { commandId: "cmd-b", text: "hello" });
    pendingCommandRegistry.reconcileSnapshot(authoritativeSnapshot("sess", "cmd-b"));

    const late = vi.fn();
    const unsubscribeLate = subscribeComposerSubmissionSettled(scopeKey, late);
    expect(late).toHaveBeenCalledWith({ commandId: "cmd-b", text: "hello" });
    unsubscribeLate();

    // 已被消费：再来一个订阅者不能再拿到旧结算。
    const later = vi.fn();
    subscribeComposerSubmissionSettled(scopeKey, later)();
    expect(later).not.toHaveBeenCalled();
  });

  it("失败终态不产生结算，正文应留在草稿里", () => {
    const scopeKey = uniqueScope();
    const settled = vi.fn();
    const unsubscribe = subscribeComposerSubmissionSettled(scopeKey, settled);
    const envelope = {
      commandId: "cmd-c",
      clientId: "client-1",
      sessionId: "sess",
      type: "sendText",
      payload: { text: "hello" },
      issuedAt: Date.now(),
    } as unknown as CommandEnvelope;
    pendingCommandRegistry.record(envelope);
    trackUnsettledComposerSubmission(scopeKey, { commandId: "cmd-c", text: "hello" });

    pendingCommandRegistry.applyAck(envelope, {
      commandId: "cmd-c",
      status: "failed",
      reasonCode: "guard.rejected",
      revisionAtDecision: 1,
    } as unknown as CommandAck);
    expect(settled).not.toHaveBeenCalled();
    // 失败后该提交已从账本移除：即使权威投影迟到，也不会再清空正文。
    pendingCommandRegistry.reconcileSnapshot(authoritativeSnapshot("sess", "cmd-c"));
    expect(settled).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("同一 scope 再次登记会替换旧提交，旧 commandId 的结算不再投递", () => {
    const scopeKey = uniqueScope();
    const settled = vi.fn();
    const unsubscribe = subscribeComposerSubmissionSettled(scopeKey, settled);
    trackUnsettledComposerSubmission(scopeKey, { commandId: "cmd-old", text: "one" });
    trackUnsettledComposerSubmission(scopeKey, { commandId: "cmd-new", text: "two" });

    pendingCommandRegistry.reconcileSnapshot(authoritativeSnapshot("sess", "cmd-old"));
    expect(settled).not.toHaveBeenCalled();
    pendingCommandRegistry.reconcileSnapshot(authoritativeSnapshot("sess", "cmd-new"));
    expect(settled).toHaveBeenCalledWith({ commandId: "cmd-new", text: "two" });
    unsubscribe();
  });

  it("scope 之间互不串写", () => {
    const scopeA = uniqueScope();
    const scopeB = uniqueScope();
    const settledB = vi.fn();
    const unsubscribe = subscribeComposerSubmissionSettled(scopeB, settledB);
    trackUnsettledComposerSubmission(scopeA, { commandId: "cmd-d", text: "hello" });
    pendingCommandRegistry.reconcileSnapshot(authoritativeSnapshot("sess", "cmd-d"));
    expect(settledB).not.toHaveBeenCalled();
    unsubscribe();
  });
});
