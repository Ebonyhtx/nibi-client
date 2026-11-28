import { describe, expect, it } from "vitest";
import {
  createRawCodeTokens,
  highlightCode,
  shouldUseSyntaxHighlighting,
  type TokenizedCode,
} from "@/lib/shikiHighlighter.js";

describe("shikiHighlighter", () => {
  it("keeps plain text code fences out of the async highlighter", () => {
    expect(shouldUseSyntaxHighlighting("text")).toBe(false);
    expect(shouldUseSyntaxHighlighting("plaintext")).toBe(false);
    expect(shouldUseSyntaxHighlighting("log")).toBe(false);
    expect(shouldUseSyntaxHighlighting("not-a-real-language")).toBe(false);
  });

  it("allows known languages and aliases to use syntax highlighting", () => {
    expect(shouldUseSyntaxHighlighting("json")).toBe(true);
    expect(shouldUseSyntaxHighlighting("typescript")).toBe(true);
    expect(shouldUseSyntaxHighlighting("tsx")).toBe(true);
  });

  it("returns raw tokens for plain text without registering async callbacks", () => {
    let callbackCount = 0;
    const code = [
      '"next start" does not work with "output: standalone" configuration.',
      'Use "node .next/standalone/server.js" instead.',
    ].join("\n");

    const tokenized = highlightCode(code, "text", "github-light", () => {
      callbackCount += 1;
    });

    expect(tokenized).toEqual(createRawCodeTokens(code));
    expect(callbackCount).toBe(0);
  });

  it("loads the shiki core lazily and reports colored tokens through the callback", async () => {
    const code = "const answer: number = 42;";
    const tokenized = await new Promise<TokenizedCode>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("shiki lazy highlight timed out"));
      }, 25_000);
      const immediate = highlightCode(code, "typescript", "github-light", (result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      if (immediate) {
        clearTimeout(timeout);
        resolve(immediate);
      }
    });

    const flatTokens = tokenized.tokens.flat();
    expect(flatTokens.map((token) => token.content).join("")).toContain("answer");
    expect(flatTokens.some((token) => token.color && token.color !== "inherit")).toBe(true);
  }, 30_000);

  it("reuses a single highlighter instance across languages/themes and deduplicates concurrent calls", async () => {
    const tsCode = "export const value: string = 'hello';";
    const pyCode = "def greet(name):\n  return f'hi {name}'";
    const results = await Promise.all([
      new Promise<TokenizedCode>((resolve) => {
        const immediate = highlightCode(tsCode, "typescript", "github-dark", resolve);
        if (immediate) resolve(immediate);
      }),
      new Promise<TokenizedCode>((resolve) => {
        const immediate = highlightCode(tsCode, "typescript", "github-dark", resolve);
        if (immediate) resolve(immediate);
      }),
      new Promise<TokenizedCode>((resolve) => {
        const immediate = highlightCode(pyCode, "python", "github-light", resolve);
        if (immediate) resolve(immediate);
      }),
    ]);

    expect(results[0].tokens.flat().map((t) => t.content).join("")).toContain("value");
    expect(results[1]).toBe(results[0]);
    expect(results[2].tokens.flat().map((t) => t.content).join("")).toContain("greet");
  }, 30_000);
});
