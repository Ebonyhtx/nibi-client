import { describe, expect, it } from "vitest";
import { nibiRuntimeCapabilitiesSchema } from "../src/nibi-protocol/index.js";

describe("runtime capabilities schema", () => {
  it("accepts conversationQuoteComment from new CLIs", () => {
    expect(
      nibiRuntimeCapabilitiesSchema.parse({
        independentPlanState: true,
        historyFirst: true,
        conversationQuoteComment: true,
      }),
    ).toMatchObject({ conversationQuoteComment: true });
  });

  it("keeps the field optional for old CLIs", () => {
    expect(nibiRuntimeCapabilitiesSchema.parse({ historyFirst: true })).toEqual({
      historyFirst: true,
    });
  });

  it("rejects non-boolean declarations", () => {
    expect(
      nibiRuntimeCapabilitiesSchema.safeParse({ conversationQuoteComment: "yes" }).success,
    ).toBe(false);
  });
});
