import { describe, expect, it } from "vitest";
import { MARKETPLACE_JSON_TIMEOUT_MS } from "../src/plugins/marketplace.js";

describe("marketplace manifest timeout", () => {
  it("bounds each manifest fetch to 30 seconds", () => {
    expect(MARKETPLACE_JSON_TIMEOUT_MS).toBe(30_000);
    expect(MARKETPLACE_JSON_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
