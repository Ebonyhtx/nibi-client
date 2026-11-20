import { describe, expect, it } from "vitest";
import { MARKETPLACE_JSON_TIMEOUT_MS } from "../src/plugins/marketplace.js";

describe("marketplace manifest timeout", () => {
  it("bounds each manifest fetch to 20 seconds", () => {
    expect(MARKETPLACE_JSON_TIMEOUT_MS).toBe(20_000);
    expect(MARKETPLACE_JSON_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
