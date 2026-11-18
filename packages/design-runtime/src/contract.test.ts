import { describe, expect, it } from "vitest";
import {
  locateSourceCssVariable,
  locateSourceElement,
  mergeStyleDeclarations,
  rewriteSourceCssVariable,
  rewriteSourceElement,
} from "./sourceEdit.js";
import { parseDesignRuntimeEvents } from "./hostScripts.js";
import { DESIGN_PAGE_LIMITS, type DesignSourcePath } from "./contract.js";
import { designRuntimeModule } from "./module.js";

// Managed 模块契约测试：源码改写只能动目标元素 / 目标变量，其余字节必须原样保留；
// 页面伪造的事件在宿主侧解析时被截断或丢弃。

const SOURCE = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Demo</title>
    <style>
      :root { --brand: #112233; --space: 8px; }
      .card { --brand-alt: #ff0000; }
    </style>
    <script>const template = "<div class='keep'>";</script>
  </head>
  <body>
    <!-- keep this comment -->
    <section id="hero" class="hero">
      <h1 class="title">Hello <em>world</em></h1>
      <p class="lead" style="color: red">Text</p>
    </section>
  </body>
</html>
`;

const PARAGRAPH_PATH: DesignSourcePath = {
  steps: [
    { tag: "body", index: 1, siblings: 2 },
    { tag: "section", index: 0, siblings: 1 },
    { tag: "p", index: 1, siblings: 2 },
  ],
  id: null,
  className: "lead",
};

const SECTION_PATH: DesignSourcePath = {
  steps: [
    { tag: "body", index: 1, siblings: 2 },
    { tag: "section", index: 0, siblings: 1 },
  ],
  id: "hero",
  className: "hero",
};

describe("design-runtime contract", () => {
  it("declares its module manifest", () => {
    expect(designRuntimeModule.id).toBe("design-runtime");
    expect(designRuntimeModule.requires).toEqual([]);
    expect(designRuntimeModule.publicEntrypoints).toContain("contract.ts");
  });

  it("rewrites one style declaration and leaves unrelated markup byte-identical", () => {
    const location = locateSourceElement(SOURCE, PARAGRAPH_PATH);
    if (!location?.style) throw new Error("paragraph style attribute not located");
    const next = rewriteSourceElement(SOURCE, location, {
      styles: { color: "blue", "font-size": "14px" },
    });
    if (next === null) throw new Error("style rewrite unexpectedly refused");

    expect(next).toContain('style="color: blue; font-size: 14px"');
    expect(next).not.toContain("color: red");
    // head、脚本、注释、兄弟元素一字未动
    expect(next.slice(0, next.indexOf("<body>"))).toBe(SOURCE.slice(0, SOURCE.indexOf("<body>")));
    expect(next).toContain("<!-- keep this comment -->");
    expect(next).toContain("<script>const template = \"<div class='keep'>\";</script>");
    expect(next).toContain('<h1 class="title">Hello <em>world</em></h1>');
    expect(next.slice(next.indexOf("</body>"))).toBe(SOURCE.slice(SOURCE.indexOf("</body>")));
  });

  it("rewrites text only for text-only elements and refuses when children exist", () => {
    const paragraph = locateSourceElement(SOURCE, PARAGRAPH_PATH);
    if (!paragraph) throw new Error("paragraph not located");
    const next = rewriteSourceElement(SOURCE, paragraph, { text: "Hello <NIBI> & friends" });
    expect(next).toContain("Hello &lt;NIBI&gt; &amp; friends");
    expect(next).toContain('<h1 class="title">Hello <em>world</em></h1>');

    const section = locateSourceElement(SOURCE, SECTION_PATH);
    if (!section) throw new Error("section not located");
    expect(rewriteSourceElement(SOURCE, section, { text: "replaced" })).toBeNull();
  });

  it("refuses a stale source path instead of editing a different element", () => {
    const wrongSiblings: DesignSourcePath = {
      ...PARAGRAPH_PATH,
      steps: [
        { tag: "body", index: 1, siblings: 1 },
        { tag: "section", index: 0, siblings: 1 },
        { tag: "p", index: 1, siblings: 2 },
      ],
    };
    expect(locateSourceElement(SOURCE, wrongSiblings)).toBeNull();
    expect(locateSourceElement(SOURCE, { ...PARAGRAPH_PATH, className: "other" })).toBeNull();
  });

  it("merges declarations without disturbing comments or unrelated properties", () => {
    const merged = mergeStyleDeclarations("/* lead */ color: red; margin: 0; color: blue", {
      color: "green",
    });
    expect(merged).toBe("/* lead */ color: green; margin: 0");
  });

  it("preserves !important when rewriting an existing declaration", () => {
    expect(mergeStyleDeclarations("color: red !important; margin: 0", { color: "blue" })).toBe(
      "color: blue !important; margin: 0",
    );
  });

  it("rewrites only an unambiguous :root variable", () => {
    const range = locateSourceCssVariable(SOURCE, "--brand");
    expect(range).not.toBeNull();
    const next = rewriteSourceCssVariable(SOURCE, "--brand", "#aabbcc");
    expect(next).toContain(":root { --brand: #aabbcc; --space: 8px; }");
    // 非 :root 规则里的声明与其它变量都保持原样
    expect(next).toContain(".card { --brand-alt: #ff0000; }");
    // 两处声明无法判断改哪一处：拒绝
    expect(rewriteSourceCssVariable(SOURCE, "--missing", "1px")).toBeNull();
  });

  it("keeps forged page events bounded and drops out-of-scope shapes", () => {
    const selection = {
      element: { tagName: "DIV", selector: "#x", text: "x" },
      editable: { text: "x" },
      kind: "text",
      source: { steps: [{ tag: "body", index: 0, siblings: 1 }], id: null, className: null },
      size: { width: 10, height: 10 },
      styleAttribute: null,
    };
    const events = parseDesignRuntimeEvents([
      { type: "selection-changed", selections: Array.from({ length: 40 }, () => selection) },
      { type: "drive-by-write", path: "/etc/passwd" },
      { type: "mode-changed", mode: "select" },
      { type: "selection-changed", selections: [] },
    ]);

    expect(events).toEqual([
      {
        type: "selection-changed",
        selections: Array.from({ length: DESIGN_PAGE_LIMITS.selection }, () => ({
          element: expect.objectContaining({ tagName: "DIV", selector: "#x" }),
          editable: expect.objectContaining({ text: "x" }),
          kind: "text",
          source: { steps: [{ tag: "body", index: 0, siblings: 1 }], id: null, className: null },
          size: { width: 10, height: 10 },
          styleAttribute: null,
        })),
      },
      { type: "mode-changed", mode: "select" },
      { type: "selection-changed", selections: [] },
    ]);

    // 路径里有一级读不出时整条作废，写回必然找不到，不会按半条路径命中别的元素。
    const invalid = parseDesignRuntimeEvents([
      {
        type: "selection-changed",
        selections: [{ ...selection, source: { steps: [{ tag: "body" }], id: null } }],
      },
    ]);
    expect(invalid[0]).toMatchObject({
      type: "selection-changed",
      selections: [{ source: { steps: [{ tag: "#invalid", index: -1, siblings: -1 }] } }],
    });
  });

  it("clips forged strings to the published limits", () => {
    const huge = "x".repeat(DESIGN_PAGE_LIMITS.shortText + 50);
    const [event] = parseDesignRuntimeEvents([
      {
        type: "selection-changed",
        selections: [
          {
            element: { tagName: huge, pageUrl: "https://example.com" },
            editable: { text: null },
            kind: "container",
            source: { steps: [], id: null, className: null },
            size: { width: 1, height: 1 },
            styleAttribute: null,
          },
        ],
      },
    ]);
    expect(event).toMatchObject({
      type: "selection-changed",
      selections: [{ element: { tagName: huge.slice(0, DESIGN_PAGE_LIMITS.token) } }],
    });
  });
});
