import { describe, expect, it } from "vitest";
import { annotationVariant } from "./AnnotationNumber.js";
import { exampleSelectionCommentEditorProps } from "./contract.example.js";
import { selectionCommentModule } from "./module.js";
import { normalizeSelectionText } from "./textAnchor.js";

describe("selection-comment contract", () => {
  it("declares its module manifest", () => {
    expect(selectionCommentModule.id).toBe("selection-comment");
    expect(selectionCommentModule.requires).toEqual(["ui"]);
    expect(selectionCommentModule.publicEntrypoints).toContain("index.ts");
    expect(selectionCommentModule.publicEntrypoints).toContain("contract.ts");
  });

  it("编号形态只由评论与已发送状态决定", () => {
    expect(annotationVariant(undefined)).toBe("quote");
    expect(annotationVariant("   ")).toBe("quote");
    expect(annotationVariant("note")).toBe("comment");
    expect(annotationVariant(undefined, true)).toBe("sent-quote");
    expect(annotationVariant("note", true)).toBe("sent-comment");
  });

  it("标准调用冻结原文与位置，保存回调沿用调用方结果", () => {
    const saved: string[] = [];
    const props = exampleSelectionCommentEditorProps(
      { center: 10, top: 20, bottom: 30 },
      "quoted text",
      3,
      (comment) => {
        saved.push(comment);
        return true;
      },
      () => undefined,
    );
    expect(props).toMatchObject({
      mode: "add",
      number: 3,
      quote: "quoted text",
      center: 10,
      top: 20,
      bottom: 30,
    });
    expect(props.onSave("note")).toBe(true);
    expect(saved).toEqual(["note"]);
  });

  it("文字锚点比较忽略空白", () => {
    expect(normalizeSelectionText("a b\n\tc")).toBe("abc");
  });
});
