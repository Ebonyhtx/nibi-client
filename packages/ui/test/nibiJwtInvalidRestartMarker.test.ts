import { describe, expect, it } from "vitest";
import {
  consumeNibiJwtInvalidRestartMarker,
  markNibiJwtInvalidRestart,
} from "../src/root/nibiJwtInvalidRestartMarker.js";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("zcode JWT invalid restart marker", () => {
  it("is consumed exactly once after relaunch", () => {
    const storage = createStorage();
    markNibiJwtInvalidRestart(storage);

    expect(consumeNibiJwtInvalidRestartMarker(storage)).toBe(true);
    expect(consumeNibiJwtInvalidRestartMarker(storage)).toBe(false);
  });
});
