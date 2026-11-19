// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup as cleanupDom, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectTree } from "@/project-sidebar/contract.js";
import {
  readConversationRowSessionSource,
  resolveConversationSessionSourceHint,
} from "@/lib/conversationSessionSource.js";
import { onTaskNavigationRequested } from "@/lib/taskNavigationRequest.js";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationSessionSourceHint } from "@/v4/ConversationSessionSourceHint.js";

const directoryState: { tree: Pick<ProjectTree, "tasks"> } | null = {
  tree: {
    tasks: [
      {
        taskId: "sess_source",
        title: "研究助手",
        workspacePath: "/workspace/source",
        workspaceIdentity: "remote:ssh:host:/workspace/source",
      } as ProjectTree["tasks"][number],
    ],
  },
};

vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  useOptionalProjectDirectory: () => directoryState,
}));

const cleanup: Array<{ dispose(): void }> = [];
afterEach(() => {
  cleanupDom();
  const disposers = cleanup.splice(0);
  for (const subscription of disposers) subscription.dispose();
});

function renderHint(sessionId: string) {
  return render(
    createElement(
      NibiIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationSessionSourceHint, { source: { sessionId } }),
    ),
  );
}

describe("readConversationRowSessionSource", () => {
  it("没有结构化来源时返回 null", () => {
    expect(readConversationRowSessionSource({})).toBeNull();
  });

  it("读取 source.kind=session，并保留旧快照标题", () => {
    expect(
      readConversationRowSessionSource({
        source: { kind: "session", sessionId: "sess_source", title: "旧标题" },
      }),
    ).toEqual({ sessionId: "sess_source", title: "旧标题" });
  });

  it("originMeta.senderSessionId 是 mailbox 消息的同一来源事实", () => {
    expect(
      readConversationRowSessionSource({
        originMeta: { senderSessionId: "sess_mailbox", senderLabel: "子会话" },
      }),
    ).toEqual({ sessionId: "sess_mailbox", title: "子会话" });
  });
});

describe("resolveConversationSessionSourceHint", () => {
  it("目录里仍存在来源会话时可跳转，标题用当前标题", () => {
    expect(
      resolveConversationSessionSourceHint(
        { sessionId: "sess_source", title: "旧标题" },
        {
          title: "当前标题",
          workspacePath: "/workspace/source",
          workspaceIdentity: "remote:ssh:host:/workspace/source",
        },
        "未知会话",
      ),
    ).toEqual({
      name: "当前标题",
      navigable: true,
      workspacePath: "/workspace/source",
      workspaceIdentity: "remote:ssh:host:/workspace/source",
    });
  });

  it("来源已删除/不可达时不可点击且不泄露 sessionId", () => {
    const model = resolveConversationSessionSourceHint(
      { sessionId: "sess_deleted" },
      undefined,
      "未知会话",
    );
    expect(model).toEqual({ name: "未知会话", navigable: false });
    expect(JSON.stringify(model)).not.toContain("sess_deleted");
  });
});

describe("ConversationSessionSourceHint", () => {
  it("点击可跳转来源会话（复用现有导航意图通道）", () => {
    const received: Array<{ taskId: string; workspacePath: string }> = [];
    cleanup.push(onTaskNavigationRequested((target) => received.push(target)));
    renderHint("sess_source");
    expect(screen.getByText("来自会话 研究助手")).toBeTruthy();
    fireEvent.click(screen.getByText("来自会话 研究助手"));
    expect(received).toEqual([
      {
        taskId: "sess_source",
        workspacePath: "/workspace/source",
        workspaceIdentity: "remote:ssh:host:/workspace/source",
      },
    ]);
  });

  it("来源不可达时渲染不可点击的轻提示", () => {
    renderHint("sess_deleted");
    expect(screen.getByText("来自会话 另一个会话")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTitle("来源会话已删除或不可用")).toBeTruthy();
    expect(document.body.textContent).not.toContain("sess_deleted");
  });
});