// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeSelectionTextAnchor,
  getSelectionLineRects,
  normalizeSelectionText,
  resolveSelectionTextAnchor,
} from "@/selection-comment/textAnchor.js";

function mountRow(texts: readonly string[]): {
  row: HTMLElement;
  regions: HTMLElement[];
} {
  const row = document.createElement("div");
  row.dataset.rowId = "7";
  const regions = texts.map((text) => {
    const region = document.createElement("div");
    region.dataset.conversationSelectable = "true";
    region.append(document.createTextNode(text));
    row.append(region);
    return region;
  });
  document.body.append(row);
  return { row, regions };
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("selection text anchor", () => {
  it("records region index and text offsets, then restores the same range", () => {
    const { row, regions } = mountRow(["hello world", "second region"]);
    const region = regions[0]!;
    const textNode = region.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 2);
    range.setEnd(textNode, 8);

    const anchor = describeSelectionTextAnchor(range, row);
    expect(anchor).toEqual({ regionIndex: 0, start: 2, end: 8, rangeText: "llowo" });
    expect(resolveSelectionTextAnchor(row, anchor!, "hello world")?.toString()).toBe("llo wo");
  });

  it("points at the correct region when a row has several selectable blocks", () => {
    const { row, regions } = mountRow(["first", "second region"]);
    const textNode = regions[1]!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 7);
    range.setEnd(textNode, 13);

    const anchor = describeSelectionTextAnchor(range, row);
    expect(anchor).toMatchObject({ regionIndex: 1, start: 7, end: 13, rangeText: "region" });
    expect(resolveSelectionTextAnchor(row, anchor!, "second region")?.toString()).toBe("region");
  });

  it("refuses anchors outside one selectable region", () => {
    const { row, regions } = mountRow(["first", "second"]);
    const range = document.createRange();
    range.setStart(regions[0]!.firstChild as Text, 0);
    range.setEnd(regions[1]!.firstChild as Text, 2);
    expect(describeSelectionTextAnchor(range, row)).toBeNull();
  });

  it("does not restore when the quoted text changed", () => {
    const { row, regions } = mountRow(["hello world"]);
    const textNode = regions[0]!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const anchor = describeSelectionTextAnchor(range, row)!;
    regions[0]!.replaceChildren(document.createTextNode("goodbye world"));
    expect(resolveSelectionTextAnchor(row, anchor, "hello")).toBeNull();
  });

  it("uses rangeText instead of Selection text, ignoring whitespace", () => {
    const { row, regions } = mountRow(["hello world"]);
    const textNode = regions[0]!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 5);
    const anchor = { regionIndex: 0, start: 0, end: 5, rangeText: "hello" };
    expect(resolveSelectionTextAnchor(row, anchor, "different")?.toString()).toBe("hello");
    expect(normalizeSelectionText("a\n\tb c")).toBe("abc");
  });

  it("returns one underline rect per text line and drops container-height boxes", () => {
    if (typeof Range.prototype.getClientRects !== "function") {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        writable: true,
        value: () => [],
      });
    }
    const range = document.createRange();
    const rects = [
      { left: 10, right: 80, top: 20, bottom: 36, width: 70, height: 16 },
      { left: 10, right: 40, top: 38, bottom: 54, width: 30, height: 16 },
      { left: 10, right: 200, top: 20, bottom: 120, width: 190, height: 100 },
      { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 },
    ] as DOMRect[];
    vi.spyOn(range, "getClientRects").mockReturnValue(rects as unknown as DOMRectList);
    expect(getSelectionLineRects(range)).toEqual([
      { left: 10, right: 80, top: 20, bottom: 36 },
      { left: 10, right: 40, top: 38, bottom: 54 },
    ]);
  });
});
