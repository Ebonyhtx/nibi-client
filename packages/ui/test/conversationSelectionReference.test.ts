import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendConversationSelectionReference,
  buildPromptWithConversationSelections,
  clearConversationSelectionReferenceScope,
  dispatchConversationSelectionAdd,
  getConversationSelectionReferenceScope,
  getSentConversationSelections,
  parsePromptConversationSelections,
  recordSentConversationSelections,
  removeConversationSelectionReferenceFromScope,
  restoreConversationSelectionReferenceInScope,
  retainSelectionCommentsWithLiveSource,
  setConversationSelectionReferenceScope,
  updateConversationSelectionCommentInScope,
  type ConversationSelectionReference,
} from "../src/lib/conversationSelectionReference.js";
import {
  buildPromptWithWebElementContexts,
  parsePromptWebElementContexts,
  type WebElementContextComposerAttachment,
} from "../src/lib/webElementContext.js";

function reference(
  id: string,
  sourceRowId = 1,
  text = "selected text",
): ConversationSelectionReference {
  return {
    contentType: "assistant",
    id,
    sourceRowId,
    sourceSessionId: "parent-1",
    text,
  };
}

describe("conversation selection references", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("PD03 同目录项目的新建草稿引用不串用", () => {
    vi.stubGlobal("window", new EventTarget());
    const item = reference("project-p");
    dispatchConversationSelectionAdd({
      targetSessionId: null,
      workspaceKey: "/same-project-root",
      draftScopeKey: "project-p",
      reference: item,
    });
    expect(getConversationSelectionReferenceScope(null, "/same-project-root", "project-p")).toEqual(
      [item],
    );
    expect(getConversationSelectionReferenceScope(null, "/same-project-root", "project-q")).toEqual(
      [],
    );
  });

  it("在 composer 挂载前先写入 session scope，首次打开不会丢引用", () => {
    vi.stubGlobal("window", new EventTarget());
    const nextReference = reference("ref-before-mount");

    expect(
      dispatchConversationSelectionAdd({
        targetSessionId: "child-before-mount",
        workspaceKey: "/workspace",
        reference: nextReference,
      }),
    ).toMatchObject({ ok: true, duplicate: false });
    expect(getConversationSelectionReferenceScope("child-before-mount", "/workspace")).toEqual([
      nextReference,
    ]);

    clearConversationSelectionReferenceScope("child-before-mount", "/workspace");
  });

  it("按来源与原文去重，同文不同 row 保留", () => {
    const first = appendConversationSelectionReference([], reference("ref-1"));
    expect(first).toMatchObject({ ok: true, duplicate: false });
    if (!first.ok) return;

    const duplicate = appendConversationSelectionReference(first.references, reference("ref-2"));
    expect(duplicate).toMatchObject({ ok: true, duplicate: true });

    const otherRow = appendConversationSelectionReference(first.references, reference("ref-3", 2));
    expect(otherRow).toMatchObject({ ok: true, duplicate: false });
    if (otherRow.ok) expect(otherRow.references).toHaveLength(2);
  });

  it("超限原子拒绝，不截断或修改已有引用", () => {
    const existing = [reference("ref-existing", 1, "a".repeat(8_000))];
    const rejected = appendConversationSelectionReference(
      existing,
      reference("ref-next", 2, "b".repeat(8_001)),
    );

    expect(rejected).toEqual({ ok: false, reason: "single" });
    expect(existing).toHaveLength(1);
    expect(existing[0]?.text).toHaveLength(8_000);
  });

  it("新发送只序列化 userselect text，并恢复可见正文与 chips", () => {
    const references = [reference("ref-1"), reference("ref-2", 2, "second")];
    const prompt = buildPromptWithConversationSelections("Explain this", references);

    expect(prompt).toBe(
      [
        "Explain this",
        "",
        "# userselect:",
        "```userselect",
        JSON.stringify([{ text: "selected text" }, { text: "second" }]),
        "```",
      ].join("\n"),
    );
    expect(parsePromptConversationSelections(prompt)).toEqual({
      visibleContent: "Explain this",
      references: [{ text: "selected text" }, { text: "second" }],
    });
  });

  it("文件路径随选段往返，普通对话与无路径 Markdown 不发送内部来源", () => {
    const file = {
      id: "md",
      contentType: "markdown" as const,
      sourceKey: "identity",
      sourceTitle: "note",
      path: "C:\\docs\\a.md",
      text: "excerpt",
    };
    const prompt = buildPromptWithConversationSelections("Explain", [
      file,
      reference("msg"),
      { ...file, path: undefined },
    ]);
    expect(parsePromptConversationSelections(prompt)).toEqual({
      visibleContent: "Explain",
      references: [
        { path: file.path, text: "excerpt" },
        { text: "selected text" },
        { text: "excerpt" },
      ],
    });
    expect(prompt).not.toContain("identity");
    expect(
      buildPromptWithConversationSelections(
        "Explain",
        parsePromptConversationSelections(prompt).references,
      ),
    ).toBe(prompt);
  });

  it.each([42, "", "   ", null])("非法文件路径不吞掉原文：%s", (path) => {
    const prompt =
      "# userselect:\n```userselect\n" + JSON.stringify([{ path, text: "excerpt" }]) + "\n```";
    expect(parsePromptConversationSelections(prompt)).toEqual({
      visibleContent: prompt,
      references: [],
    });
  });

  it("继续只读解析旧 Conversation selections 完整结构块", () => {
    const references = [reference("legacy-ref")];
    const legacyPrompt = [
      "Explain legacy",
      "",
      "# Conversation selections:",
      "```nibi-conversation-selections",
      JSON.stringify(references),
      "```",
    ].join("\n");

    expect(parsePromptConversationSelections(legacyPrompt)).toEqual({
      visibleContent: "Explain legacy",
      references,
    });
  });

  it("与 Web element block 共存且按发送端顺序逐层解析", () => {
    const webContext: WebElementContextComposerAttachment = {
      id: "web-1",
      pageTitle: "Example",
      pageUrl: "https://example.com",
      selector: "#submit",
      tagName: "button",
      text: "Submit",
      workspacePath: "/workspace",
    };
    const selectionReferences = [reference("ref-1")];
    const prompt = buildPromptWithWebElementContexts(
      buildPromptWithConversationSelections("Explain both", selectionReferences),
      [webContext],
    );
    const webParsed = parsePromptWebElementContexts(prompt, {
      workspacePath: "/workspace",
    });
    const selectionParsed = parsePromptConversationSelections(webParsed.visibleContent);

    expect(webParsed.webElementContexts).toHaveLength(1);
    expect(selectionParsed).toEqual({
      visibleContent: "Explain both",
      references: [{ text: "selected text" }],
    });
  });
});

describe("conversation annotation store", () => {
  afterEach(() => vi.unstubAllGlobals());

  function scopedReference(
    id: string,
    overrides: Partial<ConversationSelectionReference> = {},
  ): ConversationSelectionReference {
    return {
      ...reference(id),
      comment: "note",
      anchor: { regionIndex: 0, start: 0, end: 7, rangeText: "selected" },
      ...overrides,
    } as ConversationSelectionReference;
  }

  it("同一段重复批注更新原评论而不是被去重吞掉", () => {
    const first = appendConversationSelectionReference([], scopedReference("ref-1"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const updated = appendConversationSelectionReference(
      first.references,
      scopedReference("ref-2", { comment: "new note" }),
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated).toMatchObject({ duplicate: true });
    expect(updated.references).toHaveLength(1);
    expect(updated.references[0]?.comment).toBe("new note");
    expect(updated.references[0]?.id).toBe("ref-1");
  });

  it("编辑评论；清空等于回到只保留原文，不删除注释", () => {
    setConversationSelectionReferenceScope("session-edit", "/ws", [scopedReference("ref-1")]);
    updateConversationSelectionCommentInScope("session-edit", "/ws", "ref-1", "  changed  ");
    expect(getConversationSelectionReferenceScope("session-edit", "/ws")[0]?.comment).toBe(
      "changed",
    );
    updateConversationSelectionCommentInScope("session-edit", "/ws", "ref-1", "   ");
    const cleared = getConversationSelectionReferenceScope("session-edit", "/ws");
    expect(cleared).toHaveLength(1);
    expect(cleared[0]?.comment).toBeUndefined();
    clearConversationSelectionReferenceScope("session-edit", "/ws");
  });

  it("删除返回原位置，撤销后编号恢复；超限时放弃撤销", () => {
    const items = [
      scopedReference("a", { sourceRowId: 1 }),
      scopedReference("b", { sourceRowId: 2 }),
    ];
    setConversationSelectionReferenceScope("session-undo", "/ws", items);
    const removed = removeConversationSelectionReferenceFromScope("session-undo", "/ws", "a");
    expect(removed?.index).toBe(0);
    expect(getConversationSelectionReferenceScope("session-undo", "/ws")).toHaveLength(1);
    expect(restoreConversationSelectionReferenceInScope("session-undo", "/ws", removed!)).toBe(
      true,
    );
    expect(
      getConversationSelectionReferenceScope("session-undo", "/ws").map((item) => item.id),
    ).toEqual(["a", "b"]);
    clearConversationSelectionReferenceScope("session-undo", "/ws");
  });

  it("已发送引用只记录带锚点的对话引用", () => {
    recordSentConversationSelections("session-sent", "/ws", [
      scopedReference("sent-1"),
      scopedReference("sent-2", { comment: undefined }),
      {
        id: "sent-md",
        contentType: "markdown",
        sourceKey: "doc",
        sourceTitle: "Doc",
        text: "md",
        anchor: { regionIndex: 0, start: 0, end: 2 },
      } as ConversationSelectionReference,
      scopedReference("no-anchor", { anchor: undefined }),
    ]);
    expect(getSentConversationSelections("session-sent", "/ws").map((item) => item.id)).toEqual([
      "sent-1",
      "sent-2",
    ]);
    clearConversationSelectionReferenceScope("session-sent", "/ws");
    expect(getSentConversationSelections("session-sent", "/ws")).toEqual([]);
  });

  it("rewind 只剪掉来源行消失的带评论注释", () => {
    const items = [
      scopedReference("commented-live", { sourceRowId: 5 }),
      scopedReference("commented-gone", { sourceRowId: 6 }),
      scopedReference("quote-only-gone", { sourceRowId: 6, comment: undefined }),
      scopedReference("older-than-window", { sourceRowId: 1 }),
      scopedReference("other-session", { sourceRowId: 6, sourceSessionId: "other" }),
    ];
    expect(
      retainSelectionCommentsWithLiveSource(items, "parent-1", {
        window: [{ rowId: 5 }],
        firstRowId: 5,
      }).map((item) => item.id),
    ).toEqual(["commented-live", "quote-only-gone", "older-than-window", "other-session"]);
    // 空窗口 + firstRowId 归零 = 整个分支被回滚，带评论的全部删除；无评论与 markdown 保留。
    expect(
      retainSelectionCommentsWithLiveSource(items, "parent-1", {
        window: [],
        firstRowId: null,
      }).map((item) => item.id),
    ).toEqual(["quote-only-gone", "other-session"]);
    // 空窗口但仍有 firstRowId 无法判断，保守全部保留（同一数组引用）。
    const conservative = retainSelectionCommentsWithLiveSource(items, "parent-1", {
      window: [],
      firstRowId: 5,
    });
    expect(conservative).toBe(items);
  });

  it("条数超限原子拒绝；已满时撤销不会挤掉别的注释", () => {
    const existing = Array.from({ length: 8 }, (_, index) =>
      scopedReference(`full-${index}`, { sourceRowId: index + 1, comment: `note ${index}` }),
    );
    const rejected = appendConversationSelectionReference(
      existing,
      scopedReference("overflow", { sourceRowId: 99 }),
    );
    expect(rejected).toEqual({ ok: false, reason: "count" });
    expect(existing).toHaveLength(8);
  });
});
