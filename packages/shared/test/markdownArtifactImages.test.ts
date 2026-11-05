import { describe, expect, it } from "vitest";

import {
  decodeMarkdownArtifactImageSource,
  extractMarkdownArtifactImageRefs,
  rewriteMarkdownArtifactImageSources,
} from "../src/markdown-artifact-images.js";

describe("Markdown artifact image references", () => {
  it("extracts only image destinations and deduplicates them", () => {
    expect(
      extractMarkdownArtifactImageRefs(
        [
          "![first](nibi-artifact://session/a)",
          "[download](nibi-artifact://session/not-an-image)",
          '![again](<nibi-artifact://session/a> "preview")',
          "![second](nibi-artifact://session/b 'title')",
        ].join("\n"),
      ),
    ).toEqual(["nibi-artifact://session/a", "nibi-artifact://session/b"]);
  });

  it("does not authorize image-looking text inside fenced code", () => {
    expect(
      extractMarkdownArtifactImageRefs(
        "```md\n![secret](nibi-artifact://session/secret)\n```\n![ok](nibi-artifact://session/ok)",
      ),
    ).toEqual(["nibi-artifact://session/ok"]);
  });

  it("rewrites artifact image destinations to a harden-safe relative source", () => {
    const rewritten = rewriteMarkdownArtifactImageSources(
      "before ![shot](nibi-artifact://session/shot-1) after",
    );
    expect(rewritten).not.toContain("nibi-artifact://");
    const source = rewritten.match(/!\[shot\]\(([^)]+)\)/u)?.[1];
    expect(source).toBeTruthy();
    expect(decodeMarkdownArtifactImageSource(source ?? "")).toBe("nibi-artifact://session/shot-1");
  });

  it("leaves normal images, links, and fenced examples unchanged", () => {
    const markdown = [
      "![web](https://example.com/image.png)",
      "[artifact](nibi-artifact://session/file)",
      "```md",
      "![example](nibi-artifact://session/example)",
      "```",
    ].join("\n");
    expect(rewriteMarkdownArtifactImageSources(markdown)).toBe(markdown);
  });
});
