import { describe, expect, it } from "vitest";
import { botCurrentOptionsSchema, botDraftOptionsSchema } from "../src/bots.js";

describe("Bot agent provider schema", () => {
  it("accepts the only current agent provider", () => {
    expect(botDraftOptionsSchema.parse({ provider: "nibi-agent" }).provider).toBe("nibi-agent");
  });

  it("rejects removed lane values and unknown providers", () => {
    for (const provider of ["glm", "claude", "codex", "opencode", "gemini", "unknown"]) {
      expect(() => botDraftOptionsSchema.parse({ provider })).toThrow();
    }
  });

  it("no longer accepts the removed legacy cli field", () => {
    expect(() => botCurrentOptionsSchema.parse({ cli: "nibi-agent" })).toThrow();
    expect(botCurrentOptionsSchema.parse({})).toEqual({});
  });
});
